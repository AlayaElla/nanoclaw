import { describe, it, expect } from 'vitest';

import { escapeRegex, TIMEZONE } from './config.js';
import { escapeXml, formatMessages } from './router.js';
import { NewMessage, getTextContent } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  const tz = 'UTC';

  it('formats a single message as XML with context header', () => {
    const msg = makeMsg();
    const result = formatMessages([msg], tz);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<messages>');
    expect(result).toContain('</messages>');
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender_id="123@s.whatsapp.net"');
    expect(result).toContain('message_id="1"');
    expect(result).toContain('>hello</message>');
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
      makeMsg({
        id: '2',
        sender: '456@s.whatsapp.net',
        sender_name: 'Bob',
        content: 'hey',
        timestamp: '2024-01-01T00:01:00.000Z',
      }),
    ];
    const result = formatMessages(msgs, tz);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('message_id="1"');
    expect(result).toContain('message_id="2"');
    expect(result).toContain('sender_id="456@s.whatsapp.net"');
  });

  it('handles empty array', () => {
    const result = formatMessages([], tz);
    expect(result).toContain('<messages>');
    expect(result).toContain('</messages>');
  });

  it('escapes XML special characters in content', () => {
    const msg = makeMsg({ content: 'a & b < c' });
    const result = formatMessages([msg], tz);
    expect(result).toContain('a &amp; b &lt; c</message>');
  });
});

// --- Trigger gating with requiresTrigger flag ---

describe('trigger gating (requiresTrigger interaction)', () => {
  // Replicates the exact logic from processGroupMessages and startMessageLoop:
  //   if (!isMainGroup && group.requiresTrigger !== false) { check trigger }
  function shouldRequireTrigger(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
  ): boolean {
    return !isMainGroup && requiresTrigger !== false;
  }

  function shouldProcess(
    isMainGroup: boolean,
    requiresTrigger: boolean | undefined,
    messages: NewMessage[],
    trigger: string = '@TestBot',
    assistantName: string = 'TestBot',
  ): boolean {
    if (!shouldRequireTrigger(isMainGroup, requiresTrigger)) return true;

    const username = trigger.startsWith('@') ? trigger.slice(1) : trigger;
    const pattern = `@(${escapeRegex(username)}|${escapeRegex(assistantName)})(?=[\\s\\p{P}]|$)`;
    const triggerRegex = new RegExp(pattern, 'iu');

    return messages.some((m) => triggerRegex.test(getTextContent(m.content)));
  }

  it('main group always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, undefined, msgs)).toBe(true);
  });

  it('main group processes even with requiresTrigger=true', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(true, true, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=undefined requires trigger (defaults to true)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, undefined, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true requires trigger', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, true, msgs)).toBe(false);
  });

  it('non-main group with requiresTrigger=true processes when trigger present', () => {
    const msgs = [makeMsg({ content: '@TestBot do something' })];
    expect(shouldProcess(false, true, msgs)).toBe(true);
  });

  it('non-main group with requiresTrigger=false always processes (no trigger needed)', () => {
    const msgs = [makeMsg({ content: 'hello no trigger' })];
    expect(shouldProcess(false, false, msgs)).toBe(true);
  });

  it('processes when mentioned by username', () => {
    const msgs = [makeMsg({ content: '@BotUser hello' })];
    expect(shouldProcess(false, true, msgs, '@BotUser', 'AssistantName')).toBe(
      true,
    );
  });

  it('processes when mentioned by assistant name', () => {
    const msgs = [makeMsg({ content: '@AssistantName hello' })];
    expect(shouldProcess(false, true, msgs, '@BotUser', 'AssistantName')).toBe(
      true,
    );
  });

  it('processes with punctuation separator', () => {
    const msgs = [makeMsg({ content: '@AssistantName，你好' })];
    expect(shouldProcess(false, true, msgs, '@BotUser', 'AssistantName')).toBe(
      true,
    );
  });

  it('does not process on partial name match', () => {
    const msgs = [makeMsg({ content: '@AssistantNameXY' })];
    expect(shouldProcess(false, true, msgs, '@BotUser', 'AssistantName')).toBe(
      false,
    );
  });

  it('processes when trigger is in the middle of text', () => {
    const msgs = [makeMsg({ content: 'hey @AssistantName check this' })];
    expect(shouldProcess(false, true, msgs, '@BotUser', 'AssistantName')).toBe(
      true,
    );
  });
});
