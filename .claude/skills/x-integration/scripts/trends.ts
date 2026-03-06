#!/usr/bin/env npx tsx
/**
 * X Integration - Read Global Trending Tweets
 * Usage: echo '{}' | npx tsx trends.ts
 *
 * Fetches trending tweets from https://x.com/i/jf/global-trending/home
 * Returns structured tweet data (author, handle, text, time).
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface TrendsInput {
    count?: number; // Number of tweets to fetch (default: 10)
}

interface TweetData {
    author: string;
    handle: string;
    text: string;
    time: string;
}

async function readTrends(input: TrendsInput): Promise<ScriptResult> {
    const maxTweets = Math.min(input.count || 10, 20);

    let context = null;
    try {
        context = await getBrowserContext();
        const page = context.pages()[0] || await context.newPage();

        await page.goto('https://x.com/i/jf/global-trending/home', {
            timeout: config.timeouts.navigation,
            waitUntil: 'domcontentloaded',
        });
        await page.waitForTimeout(config.timeouts.pageLoad);

        // Check if logged in
        const isLoggedIn = await page
            .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
            .isVisible()
            .catch(() => false);
        if (!isLoggedIn) {
            const onLoginPage = await page
                .locator('input[autocomplete="username"]')
                .isVisible()
                .catch(() => false);
            if (onLoginPage) {
                return { success: false, message: 'X login expired. Run setup to re-authenticate.' };
            }
        }

        // Wait for tweets to load
        await page
            .locator('article[data-testid="tweet"]')
            .first()
            .waitFor({ timeout: config.timeouts.elementWait * 2 })
            .catch(() => { });

        // Scroll down a bit to load more tweets
        await page.evaluate(() => window.scrollBy(0, 800));
        await page.waitForTimeout(2000);

        // Extract tweets
        const tweets: TweetData[] = await page.evaluate((max: number) => {
            const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            return articles.slice(0, max).map((article) => {
                const textEl = article.querySelector('[data-testid="tweetText"]');
                const userNameEl = article.querySelector('[data-testid="User-Name"]');

                // Parse author info from User-Name element
                let author = '';
                let handle = '';
                let time = '';
                if (userNameEl) {
                    const fullText = userNameEl.textContent || '';
                    // Format: "DisplayName@handle·time"
                    const handleMatch = fullText.match(/@([\w]+)/);
                    const timeMatch = fullText.match(/·(.+)$/);
                    handle = handleMatch ? `@${handleMatch[1]}` : '';
                    time = timeMatch ? timeMatch[1].trim() : '';
                    // Author is everything before @
                    author = fullText.split('@')[0]?.trim() || '';
                }

                return {
                    author,
                    handle,
                    text: textEl ? (textEl.textContent || '').trim() : '',
                    time,
                };
            });
        }, maxTweets);

        if (tweets.length === 0) {
            return { success: false, message: 'No trending tweets found on the page.' };
        }

        // Format output as readable text
        const formatted = tweets
            .map(
                (t, i) =>
                    `[${i + 1}] ${t.author} (${t.handle}) · ${t.time}\n${t.text}`,
            )
            .join('\n\n---\n\n');

        return {
            success: true,
            message: `Fetched ${tweets.length} trending tweets:\n\n${formatted}`,
            data: tweets,
        };
    } finally {
        if (context) await context.close();
    }
}

runScript<TrendsInput>(readTrends);
