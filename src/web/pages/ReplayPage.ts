import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import { getTaskRunLogs } from '../data.js';

export class ReplayPage extends Page<any> {
  render(_: any, lang: Lang): string {
    const logs = getTaskRunLogs(undefined, 100);
    let html = pageHeader(
      t(lang, 'Replay & Audit', '回放与审计'),
      t(lang, 'Task execution history and timeline', '任务执行历史与时间线'),
    );
    const total = logs.length,
      success = logs.filter((l: any) => l.status === 'success').length,
      failed = total - success;
    const avgDuration =
      total > 0
        ? Math.round(
            logs.reduce((s: number, l: any) => s + (l.duration_ms || 0), 0) /
              total /
              1000,
          )
        : 0;
    html += `<div class="grid grid-4" style="margin-bottom:20px"><div class="card"><div class="card-title">${t(lang, 'Total Runs', '总执行')}</div><div class="card-value">${total}</div></div><div class="card"><div class="card-title">${t(lang, 'Success', '成功')}</div><div class="card-value" style="color:var(--green)">${success}</div></div><div class="card"><div class="card-title">${t(lang, 'Failed', '失败')}</div><div class="card-value" style="color:var(--red)">${failed}</div></div><div class="card"><div class="card-title">${t(lang, 'Avg Duration', '平均耗时')}</div><div class="card-value">${avgDuration}s</div></div></div>`;
    html += `<div class="section-group"><div class="section-label">${t(lang, 'Execution Timeline', '执行时间线')}</div><div class="card"><table><thead><tr><th>${t(lang, 'Time', '时间')}</th><th>${t(lang, 'Task', '任务')}</th><th>${t(lang, 'Duration', '耗时')}</th><th>${t(lang, 'Status', '状态')}</th><th>${t(lang, 'Result / Error', '结果 / 错误')}</th></tr></thead><tbody>`;
    for (const log of logs.slice(0, 50)) {
      const badge = log.status === 'success' ? 'badge-green' : 'badge-red';
      const detail =
        log.status === 'success'
          ? ((log.result || '') + '').slice(0, 80)
          : ((log.error || '') + '').slice(0, 80);
      html += `<tr><td style="font-size:12px;white-space:nowrap">${esc((log.run_at || '').replace('T', ' ').slice(0, 19))}</td><td style="font-family:monospace;font-size:11px">${esc((log.task_id || '').slice(0, 8))}</td><td>${((log.duration_ms || 0) / 1000).toFixed(1)}s</td><td><span class="badge ${badge}">${log.status}</span></td><td style="font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(detail)}</td></tr>`;
    }
    if (logs.length === 0)
      html += `<tr><td colspan="5" class="empty-state">${t(lang, 'No execution history', '暂无执行历史')}</td></tr>`;
    html += `</tbody></table></div></div>`;
    return html;
  }
}
