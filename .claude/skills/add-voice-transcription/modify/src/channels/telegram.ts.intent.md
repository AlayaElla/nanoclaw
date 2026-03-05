# Intent: src/channels/telegram.ts modifications

## What changed
Added voice message transcription support. When a Telegram voice note arrives, it is downloaded via the Telegram Bot API and transcribed via Qwen3 ASR (DashScope) before being stored as message content.

## Key sections

### Imports (top of file)
- Added: `transcribeAudioMessage` from `../transcription.js`

### message:voice handler (inside connect)
- Replaced: simple `storeNonText(ctx, '[Voice message]')` call
- Added: async handler that downloads voice file via `ctx.getFile()` + `fetch`
- Added: try/catch block calling `transcribeAudioMessage(buffer)`
  - Success: `finalContent = '[Voice: <transcript>]'`
  - Download fail: `finalContent = '[Voice Message - transcription unavailable]'`
  - Error: `finalContent = '[Voice Message - transcription failed]'`
- Added: stores message with `finalContent` via `this.opts.onMessage()`

## Invariants (must-keep)
- All existing text message handling unchanged
- All existing non-text handlers (photo, video, audio, document, sticker, location, contact) unchanged
- Connection lifecycle (connect, disconnect) unchanged
- sendMessage, setTyping, ownsJid, isConnected — all unchanged
- Channel registration via registerChannel unchanged
