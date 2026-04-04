import { Lang } from '../types.js';

export class LoggerPage {
  render(params: { query?: URLSearchParams }, lang: Lang = 'zh'): string {
    return `
      <div class="space-y-6">
        <div>
          <h2 class="page-title bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-indigo-300">
            ${lang === 'zh' ? '交互日志' : 'Interaction Logs'}
          </h2>
          <p class="page-subtitle mt-1">
            ${lang === 'zh' ? '实时追踪底层大模型调用日志 (litellm.jsonl)' : 'Live monitoring for LLM calls'}
          </p>
        </div>

        <!-- Filters -->
        <!-- Filters -->
        <div class="card mb-6" style="padding: 16px 20px; background: rgba(255,255,255,0.02); border: 1px solid rgba(0,0,0,0.05); box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); overflow-x: auto;">
          <form id="logger-filters" 
                hx-get="/cc/api/logs/litellm" 
                hx-target="#log-table-body"
                hx-trigger="submit"
                onsubmit="event.preventDefault();"
                style="display: flex; flex-direction: row; flex-wrap: nowrap; align-items: flex-end; gap: 16px; margin: 0; min-width: max-content;">
            <div style="flex: 0 0 160px;">
              <label class="block text-xs font-medium tracking-wide mb-2 pointer-events-none" style="color: var(--text-muted); text-transform: uppercase;">Event Type</label>
              <select name="event" style="width: 100%; background: var(--bg-card); border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; color: var(--text-main); transition: all 0.2s;">
                <option value="">All Events</option>
                <option value="pre_api_call">Pre API Call</option>
                <option value="post_api_call">Post API Call</option>
              </select>
            </div>
            <div style="flex: 0 0 200px;">
               <label class="block text-xs font-medium tracking-wide mb-2 pointer-events-none" style="color: var(--text-muted); text-transform: uppercase;">Model Name</label>
               <input type="text" name="model" placeholder="huoshan-kimi..." style="width: 100%; background: var(--bg-card); border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; color: var(--text-main); transition: all 0.2s;">
            </div>
            <div style="flex: 0 0 200px;">
               <label class="block text-xs font-medium tracking-wide mb-2 pointer-events-none" style="color: var(--text-muted); text-transform: uppercase;">Keyword</label>
               <input type="text" name="search" placeholder="Text deep search..." style="width: 100%; background: var(--bg-card); border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; color: var(--text-main); transition: all 0.2s;">
            </div>
            <div style="flex: 0 0 100px;">
               <label class="block text-xs font-medium tracking-wide mb-2 pointer-events-none" style="color: var(--text-muted); text-transform: uppercase;">Row Limit</label>
               <input type="number" name="lines" value="20" style="width: 100%; background: var(--bg-card); border: 1px solid rgba(0,0,0,0.1); border-radius: 8px; padding: 8px 12px; font-size: 13px; outline: none; color: var(--text-main); transition: all 0.2s;">
            </div>
            <div style="flex: 0 0 auto; margin-bottom: 2px; display: flex; gap: 8px;">
               <button type="button"
                       hx-post="/cc/api/logs/litellm/clear"
                       hx-target="#log-table-body"
                       hx-confirm="确定清空所有 LiteLLM 日志数据吗？(Clear all logs?)"
                       style="background: rgba(239,68,68,0.05); border: 1px solid rgba(239,68,68,0.2); border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer; color: #ef4444; display: flex; align-items: center; gap: 6px; transition: all 0.2s;"
                       onmouseover="this.style.background='rgba(239,68,68,0.1)'" 
                       onmouseout="this.style.background='rgba(239,68,68,0.05)'">
                   <svg style="width: 16px; height: 16px; color: #ef4444;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                   清空
               </button>
               <button type="submit" 
                       style="background: rgba(40,40,40,0.1); border: 1px solid rgba(40,40,40,0.2); border-radius: 8px; padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer; color: var(--text-main); display: flex; align-items: center; gap: 6px; transition: all 0.2s;"
                       onmouseover="this.style.background='rgba(40,40,40,0.15)'" 
                       onmouseout="this.style.background='rgba(40,40,40,0.1)'">
                 <svg style="width: 16px; height: 16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                 刷新
               </button>
            </div>
          </form>
        </div>

        <!-- Table -->
        <div class="card" style="padding: 0; border: 1px solid rgba(0,0,0,0.05); box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05);">
          <div>
            <table style="width: 100%; table-layout: fixed; border-collapse: collapse;">
              <thead style="background: rgba(0,0,0,0.03); border-bottom: 1px solid rgba(0,0,0,0.05);">
                <tr>
                  <th style="padding: 14px 16px; text-align: left; font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; width: 140px;">Time</th>
                  <th style="padding: 14px 16px; text-align: left; font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; width: 120px;">Event</th>
                  <th style="padding: 14px 16px; text-align: left; font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; width: 180px;">Model</th>
                  <th style="padding: 14px 16px; text-align: left; font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; width: auto;">Call ID</th>
                </tr>
              </thead>
              <tbody id="log-table-body" 
                     hx-get="/cc/api/logs/litellm" 
                     hx-include="#logger-filters" 
                     hx-trigger="load, change from:#logger-filters">
                <tr><td colspan="4" class="empty-state" style="padding: 40px; text-align: center; color: var(--text-muted);">Loading logs...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <!-- Ensure HTMX is loaded -->
      <script src="https://unpkg.com/htmx.org@1.9.12" data-nomorph="true"></script>
    `;
  }
}
