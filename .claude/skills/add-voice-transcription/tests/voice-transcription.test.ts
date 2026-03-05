import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('voice-transcription skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: voice-transcription');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('DASHSCOPE_API_KEY');
    expect(content).toContain('depends:');
    expect(content).toContain('telegram');
  });

  it('has all files declared in adds', () => {
    const transcriptionFile = path.join(skillDir, 'add', 'src', 'transcription.ts');
    expect(fs.existsSync(transcriptionFile)).toBe(true);

    const content = fs.readFileSync(transcriptionFile, 'utf-8');
    expect(content).toContain('transcribeAudioMessage');
    expect(content).toContain('transcribeWithDashScope');
    expect(content).toContain('readEnvFile');
    // Should NOT contain WhatsApp-specific imports
    expect(content).not.toContain('downloadMediaMessage');
    expect(content).not.toContain('WAMessage');
    expect(content).not.toContain('WASocket');
    expect(content).not.toContain('isVoiceMessage');
  });

  it('has all files declared in modifies', () => {
    const telegramFile = path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts');
    expect(fs.existsSync(telegramFile)).toBe(true);
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts.intent.md'))).toBe(true);
  });

  it('modified telegram.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts'),
      'utf-8',
    );

    // Core class and methods preserved
    expect(content).toContain('class TelegramChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async setTyping(');

    // Core imports preserved
    expect(content).toContain('ASSISTANT_NAME');
    expect(content).toContain('TRIGGER_PATTERN');
    expect(content).toContain('registerChannel');
  });

  it('modified telegram.ts includes transcription integration', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts'),
      'utf-8',
    );

    // Transcription import
    expect(content).toContain("import { transcribeAudioMessage } from '../transcription.js'");

    // Voice message handling with transcription
    expect(content).toContain("this.bot.on('message:voice'");
    expect(content).toContain('ctx.getFile()');
    expect(content).toContain('transcribeAudioMessage(buffer)');
    expect(content).toContain('[Voice:');
    expect(content).toContain('[Voice Message - transcription unavailable]');
    expect(content).toContain('[Voice Message - transcription failed]');
  });

  it('modified telegram.ts preserves all non-text handlers', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts'),
      'utf-8',
    );

    expect(content).toContain("'message:photo'");
    expect(content).toContain("'message:video'");
    expect(content).toContain("'message:audio'");
    expect(content).toContain("'message:document'");
    expect(content).toContain("'message:sticker'");
    expect(content).toContain("'message:location'");
    expect(content).toContain("'message:contact'");
  });
});
