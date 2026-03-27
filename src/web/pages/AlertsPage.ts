import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import { getAgentStatusFiles, getTaskRunLogs } from '../data.js';

export class AlertsPage extends Page<any> {
  render(_: any, lang: Lang): string {
    const agents = getAgentStatusFiles();
    const logs = getTaskRunLogs(undefined, 50);
    let html = pageHeader(
      t(lang, 'Alerts', '告警'),
      t(lang, 'System alerts and issues', '系统告警与异常'),
    );
    const alerts: {
      level: string;
      badge: string;
      message: string;
      time: string;
    }[] = [];
    for (const agent of agents) {
      for (const g of agent.groups || []) {
        if (
          g.lastEvent?.type === 'container_stop' &&
          g.lastEvent.detail?.includes('error')
        )
          alerts.push({
            level: 'error',
            badge: 'badge-red',
            message: `${agent.name}/${g.name}: ${t(lang, 'Container error', '容器错误')} — ${g.lastEvent.detail || ''}`,
            time: g.lastEvent.timestamp,
          });
      }
    }
    for (const run of logs
      .filter((l: any) => l.status === 'error')
      .slice(0, 10))
      alerts.push({
        level: 'warning',
        badge: 'badge-yellow',
        message: `${t(lang, 'Task failed', '任务失败')}: ${(run.task_id || '').slice(0, 8)} — ${((run.error || '') + '').slice(0, 80)}`,
        time: run.run_at,
      });
    if (alerts.length === 0) {
      html += `<div class="card" style="text-align:center;padding:60px"><div style="font-size:48px;margin-bottom:16px">✅</div><div style="font-size:16px;font-weight:600">${t(lang, 'All Clear', '一切正常')}</div><div style="color:var(--muted);margin-top:8px">${t(lang, 'No active alerts', '没有活跃告警')}</div></div>`;
    } else {
      html += `<div class="card"><table><thead><tr><th>${t(lang, 'Level', '级别')}</th><th>${t(lang, 'Message', '消息')}</th><th>${t(lang, 'Time', '时间')}</th></tr></thead><tbody>`;
      for (const a of alerts)
        html += `<tr><td><span class="badge ${a.badge}">${a.level}</span></td><td>${esc(a.message)}</td><td style="font-size:12px">${esc((a.time || '').replace('T', ' ').slice(0, 19))}</td></tr>`;
      html += `</tbody></table></div>`;
    }
    return html;
  }
}
