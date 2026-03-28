import { Page, t, esc, timeAgo, pageHeader, fmtDateTime } from '../utils.js';
import { Lang } from '../types.js';
import { getTaskRunLogs } from '../data.js';
import { getAllTasks, getAllRegisteredGroups } from '../../db.js';

export class TasksPage extends Page<{ query: URLSearchParams }> {
  render(props: { query: URLSearchParams }, lang: Lang): string {
    const tasks = getAllTasks();

    // Build group_folder -> group_name mapping
    const groups = getAllRegisteredGroups();
    const folderToGroup = new Map<string, string>();
    for (const [, g] of Object.entries(groups)) {
      if (g.folder && g.name) folderToGroup.set(g.folder, g.name);
    }

    const selectedTask = props.query.get('task') || '';
    const active = tasks.filter((x: any) => x.status === 'active').length;
    const paused = tasks.filter((x: any) => x.status === 'paused').length;

    let html = pageHeader(
      t(lang, 'Tasks', '任务'),
      t(lang, 'Scheduled tasks and execution logs', '定时任务与执行日志'),
    );

    // ── Summary cards ──
    html += `
    <div class="grid grid-3 mobile-3col" style="margin-bottom:20px">
      <div class="card">
        <div class="card-title">${t(lang, 'Active', '活跃')}</div>
        <div class="card-value" style="color:var(--green)">${active}</div>
      </div>
      <div class="card">
        <div class="card-title">${t(lang, 'Paused', '暂停')}</div>
        <div class="card-value" style="color:var(--yellow)">${paused}</div>
      </div>
      <div class="card">
        <div class="card-title">${t(lang, 'Total', '总计')}</div>
        <div class="card-value">${tasks.length}</div>
      </div>
    </div>`;

    // ── Task list table ──
    html += `
    <div class="section-group">
      <div class="section-label">${t(lang, 'Task List', '任务列表')}</div>
      <div class="card">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Agent</th>
              <th>${t(lang, 'Prompt', '提示')}</th>
              <th>${t(lang, 'Schedule', '排程')}</th>
              <th>${t(lang, 'Next Run', '下次执行')}</th>
              <th>${t(lang, 'Status', '状态')}</th>
              <th>${t(lang, 'Logs', '日志')}</th>
            </tr>
          </thead>
          <tbody>`;

    for (const task of tasks) {
      const badge =
        task.status === 'active'
          ? 'badge-green'
          : task.status === 'paused'
            ? 'badge-yellow'
            : 'badge-gray';
      const nextRun = task.next_run ? timeAgo(task.next_run, lang) : '—';
      const groupName =
        folderToGroup.get(task.group_folder) || task.group_folder;

      html += `
            <tr>
              <td data-label="ID" style="font-family:monospace;font-size:var(--fs-xs)">${esc(task.id)}</td>
              <td data-label="Agent"><span class="badge badge-blue" style="font-size:var(--fs-xs)">${esc(groupName)}</span></td>
              <td data-label="${t(lang, 'Prompt', '提示')}">${esc(task.prompt)}</td>
              <td data-label="${t(lang, 'Schedule', '排程')}"><span class="badge badge-blue">${esc(task.schedule_type)}</span> ${esc(task.schedule_value)}</td>
              <td data-label="${t(lang, 'Next Run', '下次执行')}">${nextRun}</td>
              <td data-label="${t(lang, 'Status', '状态')}"><span class="badge ${badge}">${task.status}</span></td>
              <td data-label="${t(lang, 'Logs', '日志')}"><a href="/cc/?section=tasks&task=${encodeURIComponent(task.id)}&lang=${lang}">${t(lang, 'View', '查看')}</a></td>
            </tr>`;
    }

    if (tasks.length === 0) {
      html += `
            <tr>
              <td colspan="7" class="empty-state">${t(lang, 'No tasks', '暂无任务')}</td>
            </tr>`;
    }

    html += `
          </tbody>
        </table>
      </div>
    </div>`;

    // ── Run logs (when a task is selected) ──
    if (selectedTask) {
      const logs = getTaskRunLogs(selectedTask, 20);

      html += `
      <div class="section-group">
        <div class="section-label">${t(lang, 'Run Logs', '运行日志')} ${esc(selectedTask)}</div>
        <div class="card">
          <table>
            <thead>
              <tr>
                <th>${t(lang, 'Run At', '执行时间')}</th>
                <th>${t(lang, 'Duration', '耗时')}</th>
                <th>${t(lang, 'Status', '状态')}</th>
                <th>${t(lang, 'Result', '结果')}</th>
              </tr>
            </thead>
            <tbody>`;

      for (const log of logs) {
        const badge = log.status === 'success' ? 'badge-green' : 'badge-red';
        const resultText = ((log.result || log.error || '—') + '').slice(
          0,
          100,
        );

        html += `
              <tr>
                <td data-label="${t(lang, 'Run At', '执行时间')}">${esc(fmtDateTime(log.run_at || ''))}</td>
                <td data-label="${t(lang, 'Duration', '耗时')}">${((log.duration_ms || 0) / 1000).toFixed(1)}s</td>
                <td data-label="${t(lang, 'Status', '状态')}"><span class="badge ${badge}">${log.status}</span></td>
                <td data-label="${t(lang, 'Result', '结果')}" style="font-size:12px">${esc(resultText)}</td>
              </tr>`;
      }

      if (logs.length === 0) {
        html += `
              <tr>
                <td colspan="4" class="empty-state">${t(lang, 'No run logs', '暂无运行日志')}</td>
              </tr>`;
      }

      html += `
            </tbody>
          </table>
        </div>
      </div>`;
    }

    return html;
  }
}
