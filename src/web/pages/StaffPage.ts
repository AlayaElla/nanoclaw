import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import { getAgentStatusFiles, getAgentsConfig } from '../data.js';
import { getAllTasks } from '../../db.js';

export class StaffPage extends Page<any> {
  render(_: any, lang: Lang): string {
    const agents = getAgentStatusFiles();
    const botsConfig = getAgentsConfig();
    const tasks = getAllTasks();

    let html = pageHeader(
      t(lang, 'Staff', '员工总览'),
      t(
        lang,
        'A grid view of agent status, roles, and scheduled tasks.',
        '默认视图显示员工名字、角色定位、当前状态、正在处理什么、最近产出，以及是否在排班里。',
      ),
    );

    html += `<div class="staff-grid">`;

    for (const agent of agents) {
      const bot = botsConfig.find((b) => b.name === agent.name);
      const isWorking = (agent.groups || []).some(
        (g: any) => g.container?.active,
      );
      const activeTool = (agent.groups || [])
        .map((g: any) => g.activeTool)
        .filter(Boolean)
        .join(', ');

      const groupScheduledTaskIds = (agent.groups || []).flatMap(
        (g: any) => g.scheduledTasks || [],
      );
      const isScheduled = groupScheduledTaskIds.length > 0;

      let nextTask = t(lang, 'No pending tasks', '当前无实时任务');
      if (isScheduled) {
        const firstTaskId = groupScheduledTaskIds[0];
        const match = tasks.find(
          (t) =>
            t.id === firstTaskId || (firstTaskId && t.id === firstTaskId.id),
        );
        if (match && match.prompt) {
          nextTask =
            match.prompt.length > 40
              ? match.prompt.slice(0, 40) + '...'
              : match.prompt;
        } else if (typeof firstTaskId === 'string') {
          nextTask = `Task: ${firstTaskId}`;
        } else {
          nextTask = `${groupScheduledTaskIds.length} ${t(lang, 'tasks', '个排班任务')}`;
        }
      }

      let recentOutput = '';
      for (const g of agent.groups || []) {
        if (g.lastEvent && g.lastEvent.detail) {
          recentOutput = g.lastEvent.detail;
        }
      }
      if (!recentOutput)
        recentOutput = t(lang, 'No recent output', '无近期输出');

      const statusBadge = isWorking
        ? `<span class="badge badge-green">● ${t(lang, 'Working', '工作中')}</span>`
        : `<span class="badge badge-gray">○ ${t(lang, 'Standby', '待命')}</span>`;

      const scheduledText = isScheduled
        ? `<span style="color:var(--text);font-weight:600">${t(lang, 'Scheduled', '已排班')}</span>`
        : `<span style="color:var(--muted)">${t(lang, 'Not Scheduled', '未排班')}</span>`;

      const colors = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#db6d28'];
      const colorHash =
        agent.name
          .split('')
          .reduce((s: number, c: string) => s + c.charCodeAt(0), 0) %
        colors.length;
      const borderColor = colors[colorHash];

      html += `
      <div class="staff-card">
        <div class="color-strip" style="background: ${borderColor}"></div>
        <div class="staff-card-header">
          <div>
            <div class="staff-card-title">${esc(agent.name)}</div>
            <div class="staff-card-desc">${esc(bot?.description || bot?.model || 'General Assistant')}</div>
          </div>
        </div>
        
        <div class="staff-info-row">
          <div class="staff-info-label">${t(lang, 'Current Status', '当前状态')}</div>
          <div class="staff-card-status">${statusBadge} ${isWorking && activeTool ? `<span style="font-size:12px;color:var(--muted);margin-left:6px">${esc(activeTool)}</span>` : ''}</div>
        </div>

        <div class="staff-info-row">
          <div class="staff-info-label">${t(lang, 'What are they doing', '正在处理什么')}</div>
          <div class="staff-info-value">${esc(nextTask)}</div>
        </div>

        <div class="staff-info-row">
          <div class="staff-info-label">${t(lang, 'Recent Output', '最近产出')}</div>
          <div class="staff-info-output">${esc(recentOutput)}</div>
        </div>

        <div class="staff-info-row" style="margin-top:auto">
          <div class="staff-info-label">${t(lang, 'In Schedule', '是否在排班里')}</div>
          <div class="staff-info-value">${scheduledText}</div>
        </div>
      </div>
      `;
    }

    if (agents.length === 0) {
      html += `<div class="empty-state" style="grid-column: 1/-1">${t(lang, 'No agents found', '未找到员工')}</div>`;
    }

    html += `</div>`;
    return html;
  }
}
