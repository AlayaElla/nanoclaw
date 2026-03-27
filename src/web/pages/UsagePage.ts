import { Page, t, esc, fmtNum, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import {
  getSpendSummary,
  getSpendByModel,
  getSpendTimeline,
  getRecentSpendLogs,
} from '../data.js';

export class UsagePage extends Page<any> {
  render(_: any, lang: Lang): string {
    const spend1d = getSpendSummary(1),
      spend7d = getSpendSummary(7),
      spend30d = getSpendSummary(30);
    const byModel = getSpendByModel(30);
    const timeline = getSpendTimeline(14);
    const recentLogs = getRecentSpendLogs(15);
    let html = pageHeader(
      t(lang, 'Usage', '用量'),
      t(lang, 'Token usage and request statistics', 'Token 用量与请求统计'),
    );
    html += `<div class="grid grid-3" style="margin-bottom:20px">`;
    for (const [label, d] of [
      [t(lang, 'Today', '今日'), spend1d],
      [t(lang, '7 Days', '7 天'), spend7d],
      [t(lang, '30 Days', '30 天'), spend30d],
    ] as const) {
      html += `<div class="card"><div class="card-title">${label}</div><div class="card-value">${fmtNum(d.total_tokens)}</div><div class="card-detail">${t(lang, 'Prompt', '输入')}: ${fmtNum(d.prompt_tokens)} · ${t(lang, 'Completion', '输出')}: ${fmtNum(d.completion_tokens)} · ${fmtNum(d.request_count)} ${t(lang, 'requests', '次请求')}</div></div>`;
    }
    html += `</div>`;
    html += `<div class="section-group"><div class="section-label">${t(lang, 'By Model (30d)', '按模型 (30天)')}</div><div class="card"><table><thead><tr><th>${t(lang, 'Model', '模型')}</th><th>${t(lang, 'Total Tokens', '总 Token')}</th><th>${t(lang, 'Requests', '请求数')}</th><th>${t(lang, 'Avg Tokens', '平均 Token')}</th></tr></thead><tbody>`;
    for (const row of byModel) {
      const avg =
        row.request_count > 0
          ? Math.round(row.total_tokens / row.request_count)
          : 0;
      html += `<tr><td><span class="badge badge-purple">${esc(row.model)}</span></td><td>${fmtNum(row.total_tokens)}</td><td>${fmtNum(row.request_count)}</td><td>${fmtNum(avg)}</td></tr>`;
    }
    if (byModel.length === 0)
      html += `<tr><td colspan="4" class="empty-state">${t(lang, 'No spend data yet', '暂无用量数据')}</td></tr>`;
    html += `</tbody></table></div></div>`;
    if (timeline.length > 0) {
      html += `<div class="section-group"><div class="section-label">${t(lang, 'Daily Timeline (14d)', '每日趋势 (14天)')}</div><div class="card">`;
      const maxT = Math.max(...timeline.map((r) => r.total_tokens), 1);
      for (const row of timeline) {
        const pct = Math.round((row.total_tokens / maxT) * 100);
        html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span style="width:80px;font-size:12px;color:var(--muted)">${row.date}</span><div style="flex:1;height:20px;background:var(--panel);border-radius:4px;overflow:hidden"><div style="width:${pct}%;height:100%;background:linear-gradient(90deg,var(--accent),var(--purple));border-radius:4px"></div></div><span style="width:90px;font-size:12px;text-align:right">${fmtNum(row.total_tokens)}</span></div>`;
      }
      html += `</div></div>`;
    }
    if (recentLogs.length > 0) {
      html += `<div class="section-group"><div class="section-label">${t(lang, 'Recent Requests', '最近请求')}</div><div class="card"><table><thead><tr><th>${t(lang, 'Time', '时间')}</th><th>${t(lang, 'Model', '模型')}</th><th>Tokens</th><th>${t(lang, 'Duration', '耗时')}</th><th>${t(lang, 'Status', '状态')}</th></tr></thead><tbody>`;
      for (const log of recentLogs) {
        const badge = log.status === 'success' ? 'badge-green' : 'badge-red';
        html += `<tr><td style="font-size:12px">${esc((log.timestamp || '').replace('T', ' ').slice(0, 19))}</td><td><span class="badge badge-purple">${esc(log.model)}</span></td><td>${fmtNum(log.total_tokens)}</td><td>${(log.duration_s || 0).toFixed(1)}s</td><td><span class="badge ${badge}">${log.status}</span></td></tr>`;
      }
      html += `</tbody></table></div></div>`;
    }
    return html;
  }
}
