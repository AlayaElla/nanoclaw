import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import {
  getAgentStatusFiles,
  getAgentsConfig,
  readAgentFile,
  getAgentSteps,
  getGroupTodos,
} from '../data.js';
import { getRecentMessages } from '../../db.js';

export class AgentPage extends Page<{ query: URLSearchParams }> {
  render(props: { query: URLSearchParams }, lang: Lang): string {
    const agents = getAgentStatusFiles();
    const botsConfig = getAgentsConfig();

    let html = pageHeader(
      t(lang, 'Agent', 'Agent'),
      t(
        lang,
        'Agent status, groups, messages, and role definitions.',
        'Agent 状态、群组信息、消息与角色定义一览。',
      ),
    );

    // Collect modals to render outside cards (avoid transform stacking context)
    let modals = '';

    html += `<div class="agent-grid">`;

    for (const agent of agents) {
      const bot = botsConfig.find((b: any) => b.name === agent.name);

      const colors = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#db6d28'];
      const colorHash =
        agent.name
          .split('')
          .reduce((s: number, c: string) => s + c.charCodeAt(0), 0) %
        colors.length;
      const borderColor = colors[colorHash];

      html += `
      <div class="agent-card" data-agent="${esc(agent.name)}">
        <div class="color-strip" style="background: var(--card-color-${esc(agent.name)}, ${borderColor})"></div>
        <div class="agent-card-header">
          <div>
            <div class="agent-card-title">${esc(agent.name)}</div>
            <div class="agent-card-model">${esc(bot?.model || 'Unknown Model')}</div>
          </div>
          <button class="card-color-btn" onclick="cycleCardColor('${esc(agent.name)}')" title="${t(lang, 'Change color', '切换颜色')}">🎨</button>
        </div>`;

      // Groups section
      const groups = agent.groups || [];
      if (groups.length > 0) {
        html += `<div class="agent-groups">`;
        for (const group of groups) {
          const isActive = group.container?.active === true;
          const hasContainer =
            group.container !== null && group.container !== undefined;
          const activeTool = group.activeTool;
          const sdkTasks: any[] = group.sdkTasks || [];

          // 3-state status
          let statusBadge: string;
          if (!hasContainer || !isActive) {
            statusBadge = `<span class="badge badge-gray">○ ${t(lang, 'Hibernating', '休眠')}</span>`;
          } else if (activeTool) {
            statusBadge = `<span class="badge badge-green">● ${t(lang, 'Executing', '执行中')} <span style="font-size:11px;opacity:0.8">(${esc(activeTool)})</span></span>`;
          } else {
            statusBadge = `<span class="badge badge-blue">◉ ${t(lang, 'Standby', '待命')}</span>`;
          }

          const groupId = `${agent.name}-${group.jid}`.replace(
            /[^a-zA-Z0-9]/g,
            '_',
          );

          html += `
          <div class="agent-group-section">
            <div class="agent-group-header">
              <span class="agent-group-name">${esc(group.name || group.jid)}</span>
              ${statusBadge}
            </div>`;

          // Scheduled Tasks + SDK Tasks inline
          const scheduledTasks: any[] = group.scheduledTasks || [];
          const allTasks = [
            ...scheduledTasks.map((t: any) => ({ ...t, _type: 'scheduled' })),
            ...sdkTasks.map((t: any) => ({ ...t, _type: 'sdk' })),
          ];

          if (allTasks.length > 0) {
            html += `<div class="agent-sdk-tasks">`;
            for (const task of allTasks) {
              if (task._type === 'scheduled') {
                const sBadge =
                  task.status === 'active'
                    ? 'badge-blue'
                    : task.status === 'running'
                      ? 'badge-yellow'
                      : 'badge-gray';
                html += `<span class="badge ${sBadge}" style="font-size:11px;padding:4px 10px">
                  ⏰ ${esc((task.prompt || task.id || '').slice(0, 40))}
                  <span style="opacity:0.7;font-size:10px">${esc(task.status)}</span>
                </span>`;
              } else {
                const taskBadge =
                  task.status === 'running'
                    ? 'badge-yellow'
                    : task.status === 'completed'
                      ? 'badge-green'
                      : 'badge-gray';
                html += `<span class="badge ${taskBadge}" style="font-size:11px;padding:4px 10px">
                  🔄 ${esc(task.summary || task.task_id).slice(0, 50)}
                  <span style="opacity:0.7;font-size:10px">${esc(task.status)}</span>
                </span>`;
              }
            }
            html += `</div>`;
          }

          // Todo list from SDK's TodoWrite
          const todos = (() => {
            try {
              return getGroupTodos(group.folder);
            } catch {
              return [];
            }
          })();

          if (todos.length > 0) {
            html += `<div class="agent-todo-list">`;
            html += `<div style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">📋 ${t(lang, 'Todo List', '待办列表')}</div>`;
            for (const todo of todos) {
              const icon =
                todo.status === 'completed'
                  ? '✅'
                  : todo.status === 'in_progress'
                    ? '🔄'
                    : '⬜';
              const opacity =
                todo.status === 'completed'
                  ? 'opacity:0.6;text-decoration:line-through'
                  : '';
              html += `<div class="agent-todo-item" style="${opacity}">${icon} ${esc(todo.content)}</div>`;
            }
            html += `</div>`;
          }

          // Group CLAUDE.md based on type
          const groupContext = group.isMain ? 'main' : 'group';
          const groupClaudeContent = readAgentFile(
            agent.name,
            'CLAUDE.md',
            groupContext as 'main' | 'group',
          );
          if (groupClaudeContent) {
            html += `
            <details class="agent-claude-md">
              <summary>${t(lang, 'Role Definition', '角色定义')} (${groupContext}/CLAUDE.md)</summary>
              <pre class="agent-claude-content">${esc(groupClaudeContent)}</pre>
            </details>`;
          }

          // Action buttons row
          html += `
            <div class="agent-group-actions">
              <button class="btn agent-modal-btn" onclick="document.getElementById('msg-${groupId}').showModal()">
                💬 ${t(lang, 'Messages', '消息')}
              </button>
              <button class="btn agent-modal-btn" onclick="document.getElementById('audit-${groupId}').showModal()">
                🔄 ${t(lang, 'Audit', '审计')}
              </button>
            </div>`;

          html += `</div>`; // close agent-group-section

          // Messages modal (collected to render outside cards)
          const messages = (() => {
            try {
              return getRecentMessages(group.jid, 10);
            } catch {
              return [];
            }
          })();

          modals += `
          <dialog id="msg-${groupId}" class="agent-modal">
            <div class="agent-modal-header">
              <span>💬 ${esc(group.name || group.jid)} — ${t(lang, 'Recent Messages', '最近消息')}</span>
              <button class="btn" onclick="closeModal(this)">✕</button>
            </div>
            <div class="agent-modal-body">`;

          if (messages.length > 0) {
            modals += `<div class="msg-list">`;
            for (const msg of [...messages].reverse()) {
              const isBot = msg.is_from_me || msg.is_bot_message;
              const cls = isBot ? 'msg-bubble msg-bot' : 'msg-bubble msg-user';
              const contentStr =
                typeof msg.content === 'string'
                  ? msg.content
                  : JSON.stringify(msg.content);
              modals += `<div class="msg-item"><div class="msg-meta">${esc(msg.sender_name || msg.sender || '')} · ${(msg.timestamp || '').slice(0, 16).replace('T', ' ')}</div><div class="${cls}">${esc(contentStr || '')}</div></div>`;
            }
            modals += `</div>`;
          } else {
            modals += `<div class="empty-state">${t(lang, 'No messages', '暂无消息')}</div>`;
          }

          modals += `</div></dialog>`;

          // Audit modal (collected to render outside cards)
          const steps = (() => {
            try {
              return getAgentSteps(group.folder, 30);
            } catch {
              return [];
            }
          })();

          modals += `
          <dialog id="audit-${groupId}" class="agent-modal">
            <div class="agent-modal-header">
              <span>🔄 ${esc(group.name || group.jid)} — ${t(lang, 'Execution Trace', '执行轨迹')}</span>
              <button class="btn" onclick="closeModal(this)">✕</button>
            </div>
            <div class="agent-modal-body">`;

          if (steps.length > 0) {
            modals += `<div class="audit-steps">`;
            for (const step of steps) {
              const preview = step.summary.slice(0, 70);
              const hasMore = step.summary.length > 70;
              if (hasMore) {
                modals += `<details class="audit-step">
                  <summary>
                    <span class="audit-ts">${esc(step.timestamp.replace('T', ' '))}</span>
                    <span class="badge badge-blue" style="font-size:10px;padding:2px 6px">${esc(step.tool)}</span>
                    <span class="audit-preview">${esc(preview)}…</span>
                  </summary>
                  <pre class="audit-full">${esc(step.summary)}</pre>
                </details>`;
              } else {
                modals += `<div class="audit-step audit-step-inline">
                  <span class="audit-ts">${esc(step.timestamp.replace('T', ' '))}</span>
                  <span class="badge badge-blue" style="font-size:10px;padding:2px 6px">${esc(step.tool)}</span>
                  <span class="audit-preview">${esc(step.summary)}</span>
                </div>`;
              }
            }
            modals += `</div>`;
          } else {
            modals += `<div class="empty-state">${t(lang, 'No execution trace', '暂无执行记录')}</div>`;
          }

          modals += `</div></dialog>`;
        }
        html += `</div>`; // close agent-groups
      } else {
        html += `<div class="empty-state" style="font-size:13px">${t(lang, 'No groups registered', '无已注册群组')}</div>`;
      }

      html += `</div>`; // close agent-card
    }

    if (agents.length === 0) {
      html += `<div class="empty-state" style="grid-column: 1/-1">${t(lang, 'No agents found', '未找到 Agent')}</div>`;
    }

    html += `</div>`;

    // Render modals at page root level (outside cards to avoid transform stacking context)
    html += modals;

    // Color cycling script
    html += `
    <script>
    const _cardColors = ['#58a6ff','#3fb950','#d29922','#bc8cff','#db6d28','#f778ba','#79c0ff','#7ee787'];
    function cycleCardColor(name) {
      const key = 'card-color-' + name;
      let idx = parseInt(localStorage.getItem(key) || '0', 10);
      idx = (idx + 1) % _cardColors.length;
      localStorage.setItem(key, idx);
      const card = document.querySelector('[data-agent="' + name + '"]');
      if (card) card.querySelector('.color-strip').style.background = _cardColors[idx];
    }
    // Restore saved colors on load
    document.querySelectorAll('.agent-card').forEach(card => {
      const name = card.dataset.agent;
      const idx = localStorage.getItem('card-color-' + name);
      if (idx !== null) {
        const strip = card.querySelector('.color-strip');
        if (strip) strip.style.background = _cardColors[parseInt(idx, 10)] || _cardColors[0];
      }
    });
    </script>`;

    return html;
  }
}
