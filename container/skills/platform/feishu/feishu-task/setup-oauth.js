#!/usr/bin/env node
/**
 * setup-oauth.js - 一次性 OAuth 授权，获取飞书 user_access_token 的 refresh_token
 *
 * 使用步骤：
 * 1. 确保 .env 中有 FEISHU_APP_ID 和 FEISHU_APP_SECRET
 * 2. 在飞书开放平台 → 应用设置 → 安全设置 中添加重定向 URL
 * 3. 运行: node setup-oauth.js
 * 4. 浏览器访问打印的 URL 并授权
 * 5. 从重定向 URL 中复制 code 参数
 * 6. 运行: node setup-oauth.js --code=<CODE>
 * 7. 将输出的 FEISHU_USER_REFRESH_TOKEN 添加到 .env
 */

const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const REDIRECT_URI = process.env.FEISHU_REDIRECT_URI || 'https://example.com/callback';

function request(method, urlPath, data = null, accessToken = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'open.feishu.cn',
      path: urlPath,
      method: method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      }
    };

    if (accessToken) {
      options.headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Response parse error: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => reject(new Error(`Request error: ${e.message}`)));
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function getAppAccessToken() {
  const result = await request('POST', '/open-apis/auth/v3/app_access_token/internal', {
    app_id: APP_ID,
    app_secret: APP_SECRET
  });

  if (result.code !== 0) {
    throw new Error(`Failed to get app_access_token: ${result.msg}`);
  }

  return result.app_access_token;
}

async function exchangeCodeForTokens(code) {
  const appToken = await getAppAccessToken();

  const result = await request(
    'POST',
    '/open-apis/authen/v1/oidc/access_token',
    {
      grant_type: 'authorization_code',
      code: code
    },
    appToken
  );

  if (result.code !== 0) {
    throw new Error(`Failed to exchange code: ${result.msg} (code: ${result.code})`);
  }

  return result.data;
}

async function main() {
  if (!APP_ID || !APP_SECRET) {
    console.error('ERROR: FEISHU_APP_ID and FEISHU_APP_SECRET must be set in .env');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const codeArg = args.find(a => a.startsWith('--code='));

  if (!codeArg) {
    // Step 1: Print authorization URL
    // Include all task-related scopes needed by this skill
    const scopes = [
      'task:task'
    ].join(' ');
    const authUrl = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&state=nanoclaw&scope=${encodeURIComponent(scopes)}`;

    console.log('=== 飞书 OAuth 授权 ===\n');
    console.log('步骤 1: 在浏览器中访问以下 URL 并授权：\n');
    console.log(authUrl);
    console.log('\n步骤 2: 授权后，浏览器会跳转到类似这样的 URL：');
    console.log(`  ${REDIRECT_URI}?code=XXXXX&state=nanoclaw`);
    console.log('\n步骤 3: 复制 URL 中的 code 参数值，然后运行：');
    console.log(`  node setup-oauth.js --code=<CODE>\n`);
    console.log(`注意：redirect_uri 使用的是 "${REDIRECT_URI}"，`);
    console.log('请确保已在飞书开放平台 → 应用设置 → 安全设置 中配置了此 URL。');
    return;
  }

  // Step 2: Exchange code for tokens
  const code = codeArg.split('=').slice(1).join('='); // handle code with = signs
  console.log(`Exchanging code for tokens...`);

  try {
    const tokens = await exchangeCodeForTokens(code);

    console.log('\n✅ 授权成功！\n');
    console.log(`用户名: ${tokens.name || 'unknown'}`);
    console.log(`open_id: ${tokens.open_id || 'unknown'}`);
    console.log(`access_token 有效期: ${tokens.expires_in}s`);
    console.log(`refresh_token 有效期: ${tokens.refresh_expires_in}s (~${Math.round(tokens.refresh_expires_in / 86400)}天)`);
    console.log('\n请将以下内容添加到 .env 文件中：\n');
    console.log(`FEISHU_USER_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\n提示：refresh_token 会在每次使用时自动更新并持久化到容器中。');
    console.log('只要 agent 在有效期内至少运行一次，token 就会自动续期。');
  } catch (err) {
    console.error(`\n❌ 授权失败: ${err.message}`);
    console.error('\n常见原因：');
    console.error('  - code 已过期（5分钟有效，只能使用一次）');
    console.error('  - redirect_uri 不匹配（必须与飞书应用设置中的完全一致）');
    console.error('  - FEISHU_APP_ID 或 FEISHU_APP_SECRET 不正确');
    process.exit(1);
  }
}

main();
