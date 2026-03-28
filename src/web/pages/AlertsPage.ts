import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import { getAgentStatusFiles, getTaskRunLogs } from '../data.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read persisted system alerts from data/system-alerts.jsonl (last N lines, deduped by hourKey). */
function getSystemAlerts(limit = 30): {
  level: string;
  source: string;
  groupFolder: string;
  message: string;
  timestamp: string;
  hourKey: string;
}[] {
  const p = join(process.cwd(), 'data', 'system-alerts.jsonl');
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean);
    const seen = new Set<string>();
    const results: any[] = [];
    // Read from end (newest first), deduplicate
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const dedupeKey = `${entry.hourKey}|${entry.source}|${entry.groupFolder}|${(entry.message || '').slice(0, 60)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        results.push(entry);
      } catch {
        /* skip */
      }
    }
    return results;
  } catch {
    return [];
  }
}

export class AlertsPage extends Page<any> {
  render(_: any, lang: Lang): string {
    const agents = getAgentStatusFiles();
    const logs = getTaskRunLogs(undefined, 50);
    const systemAlerts = getSystemAlerts(20);
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
    // System-level alerts (RAG indexing, embedding errors, etc.)
    for (const sa of systemAlerts)
      alerts.push({
        level: sa.level === 'error' ? 'error' : 'warning',
        badge: sa.level === 'error' ? 'badge-red' : 'badge-yellow',
        message: `[${sa.source}${sa.groupFolder ? '/' + sa.groupFolder : ''}] ${sa.message}`,
        time: sa.timestamp,
      });
    // Sort all alerts by time descending
    alerts.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

    // Header with clear button
    const clearBtn = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;justify-content:space-between">
        <div>
          <span style="font-size:var(--fs-xl);font-weight:700">${t(lang, 'Alerts', '告警')}</span>
          ${alerts.length > 0 ? `<span class="badge badge-red" style="margin-left:10px;vertical-align:middle">${alerts.length}</span>` : ''}
        </div>
        <button id="btn-clear-alerts" onclick="clearAlerts()" style="
          background:rgba(239,68,68,0.12);
          border:1px solid rgba(239,68,68,0.35);
          color:#ef4444;
          padding:6px 16px;
          border-radius:8px;
          cursor:pointer;
          font-size:var(--fs-sm);
          font-weight:600;
          transition:background 0.2s;
        " onmouseover="this.style.background='rgba(239,68,68,0.25)'" onmouseout="this.style.background='rgba(239,68,68,0.12)'">
          🗑 ${t(lang, 'Clear Logs', '清除日志')}
        </button>
      </div>
      <script>
      async function clearAlerts() {
        const btn = document.getElementById('btn-clear-alerts');
        btn.textContent = '${t(lang, 'Clearing...', '清除中...')}';
        btn.disabled = true;
        try {
          const r = await fetch('/cc/api/alerts/clear', { method: 'POST' });
          const d = await r.json();
          if (d.success) location.reload();
          else { btn.textContent = '${t(lang, 'Failed', '失败')}'; btn.disabled = false; }
        } catch { btn.textContent = '${t(lang, 'Failed', '失败')}'; btn.disabled = false; }
      }
      </script>`;

    html += clearBtn;

    if (alerts.length === 0) {
      html += `<div class="card" style="text-align:center;padding:60px"><div style="font-size:48px;margin-bottom:16px">✅</div><div style="font-size:var(--fs-md);font-weight:600">${t(lang, 'All Clear', '一切正常')}</div><div style="color:var(--muted);margin-top:8px;font-size:var(--fs-base)">${t(lang, 'No active alerts', '没有活跃告警')}</div></div>`;
    } else {
      html += `<div class="card"><table><thead><tr><th>${t(lang, 'Level', '级别')}</th><th>${t(lang, 'Message', '消息')}</th><th>${t(lang, 'Time', '时间')}</th></tr></thead><tbody>`;
      for (const a of alerts)
        html += `<tr><td><span class="badge ${a.badge}">${a.level}</span></td><td>${esc(a.message)}</td><td style="font-size:var(--fs-sm)">${esc((a.time || '').replace('T', ' ').slice(0, 19))}</td></tr>`;
      html += `</tbody></table></div>`;
    }
    return html;
  }
}
