---
name: add-voice-transcription
description: Add voice message transcription to NanoClaw using Alibaba Qwen3 ASR (DashScope). Automatically transcribes Telegram voice notes so the agent can read and respond to them.
---

# Add Voice Transcription

This skill adds automatic voice message transcription to NanoClaw's Telegram channel using Alibaba's Qwen3 ASR via DashScope API. When a voice note arrives, it is downloaded via the Telegram Bot API, transcribed, and delivered to the agent as `[Voice: <transcript>]`.

**Prerequisite**: Telegram must already be set up via the `/add-telegram` skill.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `voice-transcription` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect information:

AskUserQuestion: Do you have a DashScope API key for Qwen3 ASR transcription?

If yes, collect it now. If no, direct them to create one at https://bailian.console.aliyun.com/.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-voice-transcription
```

This deterministically:
- Adds `src/transcription.ts` (voice transcription module using Qwen3 ASR via DashScope)
- Three-way merges voice handling into `src/channels/telegram.ts` (download + transcribe voice messages)
- Updates `.env.example` with `DASHSCOPE_API_KEY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/telegram.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

### Get DashScope API key (if needed)

If the user doesn't have an API key:

> I need you to create a DashScope API key:
>
> 1. Go to https://bailian.console.aliyun.com/
> 2. Open API Key management
> 3. Click "Create new API key"
> 4. Copy the key (starts with `sk-`)
>
> Cost: Qwen3 ASR Flash is very affordable, see https://help.aliyun.com/zh/model-studio/pricing for details.

Wait for the user to provide the key.

### Add to environment

Add to `.env`:

```bash
DASHSCOPE_API_KEY=<their-key>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test with a voice note

Tell the user:

> Send a voice note in any registered Telegram chat. The agent should receive it as `[Voice: <transcript>]` and respond to its content.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i voice
```

Look for:
- `Transcribed Telegram voice message` — successful transcription with character count
- `DASHSCOPE_API_KEY not set` — key missing from `.env`
- `DashScope transcription failed` — API error (check key validity, billing)
- `Failed to download Telegram voice file` — file download issue

## Troubleshooting

### Voice notes show "[Voice Message - transcription unavailable]"

1. Check `DASHSCOPE_API_KEY` is set in `.env` AND synced to `data/env/env`
2. Verify key works: `curl -s https://dashscope.aliyuncs.com/compatible-mode/v1/models -H "Authorization: Bearer $DASHSCOPE_API_KEY" | head -c 200`
3. Check DashScope billing — ensure the account is active and funded

### Voice notes show "[Voice Message - transcription failed]"

Check logs for the specific error. Common causes:
- Network timeout — transient, will work on next message
- Invalid API key — regenerate at https://bailian.console.aliyun.com/
- Rate limiting — wait and retry

### Agent doesn't respond to voice notes

Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups.
