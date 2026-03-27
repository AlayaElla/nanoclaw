import { Page, t, esc, fmtNum, fmtDuration, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import { getAgentStatusFiles, getUsageSummary } from '../data.js';
import { getFullStatus } from '../../status.js';
import { getAllTasks } from '../../db.js';

export class OverviewPage extends Page<any> {
  render(_: any, lang: Lang): string {
    const status = getFullStatus();
    const agents = getAgentStatusFiles();
    const tasks = getAllTasks();
    const spend1d = getUsageSummary(1);
    const spend7d = getUsageSummary(7);
    const spend30d = getUsageSummary(30);

    const activeContainers = agents.reduce(
      (n: number, a: any) =>
        n + (a.groups || []).filter((g: any) => g.container?.active).length,
      0,
    );
    const totalGroups = agents.reduce(
      (n: number, a: any) => n + (a.groups || []).length,
      0,
    );

    let html = pageHeader(
      t(lang, 'Overview', '概览'),
      t(lang, 'System health at a glance', '系统健康一览'),
    );
    html += `<div class="grid grid-4" style="margin-bottom:20px">`;
    html += `<div class="card"><div class="card-title">${t(lang, 'Uptime', '运行时间')}</div><div class="card-value">${status ? fmtDuration(status.uptime) : '—'}</div><div class="card-detail">v${esc(status?.version || '?')}</div></div>`;
    html += `<div class="card"><div class="card-title">${t(lang, 'Active Containers', '活跃容器')}</div><div class="card-value">${activeContainers}</div><div class="card-detail">${t(lang, 'of max', '最大')} ${status?.system?.maxConcurrentContainers || '?'}</div></div>`;
    html += `<div class="card"><div class="card-title">${t(lang, 'Groups', '群组')}</div><div class="card-value">${totalGroups}</div><div class="card-detail">${agents.length} ${t(lang, 'agents', '个 Agent')}</div></div>`;
    html += `<div class="card"><div class="card-title">${t(lang, 'Tasks', '任务')}</div><div class="card-value">${tasks.filter((x: any) => x.status === 'active').length}</div><div class="card-detail">${tasks.length} ${t(lang, 'total', '总计')}</div></div>`;
    html += `</div>`;

    html += `<div class="section-group">`;
    html += `<div class="section-label">${t(lang, 'Token Usage', 'Token 用量')}</div>`;
    html += `<div class="grid grid-3">`;

    const renderUsageCard = (label: string, d: any) =>
      `<div class="card">` +
      `<div class="card-title">${label}</div>` +
      `<div class="card-value" style="font-size:28px; margin-bottom: 8px;">${fmtNum(d.total_tokens)}</div>` +
      `<div class="card-detail" style="margin-top:0">${t(lang, 'Input', '输入')}: ${fmtNum(d.input_tokens)} · ${t(lang, 'Output', '输出')}: ${fmtNum(d.output_tokens)}</div>` +
      `<div class="card-detail" style="margin-top:4px">${fmtNum(d.request_count)} ${t(lang, 'requests', '次请求')}</div>` +
      `</div>`;

    html += renderUsageCard(t(lang, 'Today', '今日'), spend1d);
    html += renderUsageCard(t(lang, '7 Days', '7 天'), spend7d);
    html += renderUsageCard(t(lang, '30 Days', '30 天'), spend30d);
    html += `</div></div>`;

    html += `<div class="section-group">`;
    html += `<div class="section-label">${t(lang, 'Agent Overview', 'Agent 概览')}</div>`;
    html += `<div class="card"><table style="width:100%"><thead><tr><th>Agent</th><th>Channel</th><th>${t(lang, 'Model', '模型')}</th><th>${t(lang, 'Groups', '群组')}</th><th>${t(lang, 'Status', '状态')}</th></tr></thead><tbody>`;

    const channels = status?.channels || [];
    for (const agent of agents) {
      const activeG = (agent.groups || []).filter(
        (g: any) => g.container?.active,
      ).length;
      const badge =
        activeG > 0
          ? `<span class="badge badge-green">● ${t(lang, 'Active', '活跃')}</span>`
          : `<span class="badge badge-gray">○ ${t(lang, 'Idle', '空闲')}</span>`;

      // Fix channel matching logic: 'agent.channel' is likely the specific ID vs 'ch.name'
      // Some agent.channel strings might include the platform e.g. 'telegram:bot1', handle accordingly
      const agentCh = agent.channel || '';
      let ch = channels.find(
        (c) =>
          c.name === agentCh ||
          agentCh.includes(c.name) ||
          c.name.includes(agentCh),
      );
      // Fallback: If no exact match and there's only one channel connected, assume it's the default
      if (!ch && agentCh && channels.length > 0) {
        ch =
          channels.find(
            (c) =>
              agentCh.toLowerCase().includes('telegram') &&
              c.name.toLowerCase().includes('tele'),
          ) || undefined;
      }

      const dot = ch ? (ch.connected ? 'green' : 'red') : 'gray';
      const chLabel = ch
        ? ch.connected
          ? t(lang, 'Connected', '已连接')
          : t(lang, 'Disconnected', '断开')
        : '—';

      html +=
        `<tr>` +
        `<td><strong>${esc(agent.name)}</strong></td>` +
        `<td><div style="display:flex;align-items:center;gap:6px"><span class="status-dot ${dot}"></span><span>${esc(agent.channel || '—')}</span><span style="font-size:11px;color:var(--text-muted)">(${chLabel})</span></div></td>` +
        `<td><span class="badge badge-purple">${esc(agent.model || '—')}</span></td>` +
        `<td>${(agent.groups || []).length}</td>` +
        `<td>${badge}</td>` +
        `</tr>`;
    }
    html += `</tbody></table></div></div>`;
    return html;
  }
}
