import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import { getAgentStatusFiles, readWorkspaceFile } from '../data.js';
import { getAllChats, getRecentMessages } from '../../db.js';

export class MemoryPage extends Page<{ query: URLSearchParams }> {
  render(props: { query: URLSearchParams }, lang: Lang): string {
    const chats = getAllChats();
    const selectedChat = props.query.get('chat') || '';
    let html = pageHeader(
      t(lang, 'Memory', '记忆'),
      t(
        lang,
        'Messages, conversations, and agent memory files',
        '消息、会话和 Agent 记忆文件',
      ),
    );
    html += `<div class="section-group"><div class="section-label">${t(lang, 'Messages', '消息')}</div><div class="card"><div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">`;
    for (const ch of chats.slice(0, 20)) {
      const cls = selectedChat === ch.jid ? 'btn btn-primary' : 'btn';
      html += `<a class="${cls}" href="/?section=memory&chat=${encodeURIComponent(ch.jid)}&lang=${lang}">${esc(ch.name || ch.jid.slice(0, 20))}</a>`;
    }
    html += `</div>`;
    if (selectedChat) {
      const messages = getRecentMessages(selectedChat, 30);
      if (messages.length > 0) {
        html += `<div style="max-height:500px;overflow-y:auto;padding:8px">`;
        for (const msg of [...messages].reverse()) {
          const isBot = msg.is_from_me || msg.is_bot_message;
          const cls = isBot ? 'msg-bubble msg-bot' : 'msg-bubble msg-user';
          const contentStr =
            typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content);
          html += `<div class="msg-meta">${esc(msg.sender_name || msg.sender)} · ${(msg.timestamp || '').slice(0, 16).replace('T', ' ')}</div><div class="${cls}">${esc((contentStr || '').slice(0, 500))}</div>`;
        }
        html += `</div>`;
      } else
        html += `<div class="empty-state">${t(lang, 'No messages', '暂无消息')}</div>`;
    } else
      html += `<div class="empty-state">${t(lang, 'Select a chat', '选择一个聊天查看消息')}</div>`;
    html += `</div></div>`;
    const agents = getAgentStatusFiles();
    html += `<div class="section-group"><div class="section-label">${t(lang, 'Agent Memory Files', 'Agent 记忆文件')}</div><div class="grid grid-2">`;
    for (const agent of agents) {
      const content = readWorkspaceFile(agent.name, 'CLAUDE.md');
      html += `<div class="card"><div class="card-title">${esc(agent.name)} / CLAUDE.md</div>`;
      if (content)
        html += `<pre style="font-size:12px;white-space:pre-wrap;max-height:200px;overflow-y:auto;color:var(--muted)">${esc(content.slice(0, 2000))}</pre>`;
      else
        html += `<div style="color:var(--muted);font-size:12px">${t(lang, 'Not found', '未找到')}</div>`;
      html += `</div>`;
    }
    html += `</div></div>`;
    return html;
  }
}
