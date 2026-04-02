import { Channel, NewMessage, getTextContent } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const text = getTextContent(m.content);
    return `<message sender="${escapeXml(m.sender_name)}" sender_id="${escapeXml(m.sender)}" message_id="${escapeXml(m.id)}" time="${escapeXml(displayTime)}">${escapeXml(text)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  const placeholders: string[] = [];

  // Protect fenced code blocks (```...```)
  let protectedText = text.replace(/```[\s\S]*?(```|$)/g, (match) => {
    placeholders.push(match);
    return `__NC_CBLK_${placeholders.length - 1}__`;
  });

  // Protect inline code blocks (`...`)
  protectedText = protectedText.replace(/`[^`]*`/g, (match) => {
    placeholders.push(match);
    return `__NC_CBLK_${placeholders.length - 1}__`;
  });

  // Strip internal tags on the unprotected text
  let strippedText = protectedText
    .replace(/<internal>[\s\S]*?(<\/internal>|$)/g, '');

  // If the string contains an orphaned </internal>, it means the model leaked
  // its internal reasoning into the normal text block without an opening tag.
  // We strip everything up to and including the orphaned </internal>.
  if (strippedText.includes('</internal>')) {
    strippedText = strippedText.replace(/^[\s\S]*?<\/internal>/, '');
  }

  strippedText = strippedText.trim();

  // Restore placeholders
  for (let i = 0; i < placeholders.length; i++) {
    strippedText = strippedText.replace(`__NC_CBLK_${i}__`, placeholders[i]);
  }

  return strippedText.trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
