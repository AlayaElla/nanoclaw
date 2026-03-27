import { Page, t, esc, fmtNum, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import {
  getUsageSummary,
  getUsageTimelineByDimension,
  getUsageByDimension,
} from '../data.js';

export class UsagePage extends Page<any> {
  render(props: { query: URLSearchParams }, lang: Lang): string {
    const days = parseInt(props.query?.get('days') || '1', 10);
    const dimension = (props.query?.get('dim') || 'total') as
      | 'total'
      | 'model'
      | 'group_id'
      | 'tool_name'
      | 'task_id';

    // Fetch data
    const summary = getUsageSummary(days);
    const timeline = getUsageTimelineByDimension(
      dimension,
      days,
      days <= 1 ? 'hour' : 'day',
    );

    let html = pageHeader(
      t(lang, 'Usage', '用量'),
      t(lang, 'Multi-dimensional Token Analytics', '多维度 Token 消耗分析'),
    );
    html += `<style>.card { animation: none !important; } .card:hover { transform: none !important; box-shadow: 0 10px 20px rgba(0,0,0,0.03), inset 0 1px 1px #fff !important; background: var(--glass-bg) !important; border-color: var(--glass-border) !important; }</style>`;

    // ── UI Controls ──
    const tabs = [
      { value: 1, label: t(lang, 'Today', '今日') },
      { value: 7, label: t(lang, '7 Days', '7 天') },
      { value: 30, label: t(lang, '30 Days', '30 天') },
    ];

    // Build Time Tabs
    const tabsHtml = tabs
      .map((tab) => {
        const active = days === tab.value;
        const style = active
          ? 'background: var(--accent); color: #fff; box-shadow: 0 4px 12px var(--accent-glow);'
          : 'background: rgba(0,0,0,0.04); color: var(--text-muted);';
        return `<a href="?section=usage&days=${tab.value}&dim=${dimension}" style="padding: 6px 18px; border-radius: 20px; font-size: 13px; font-weight: 600; text-decoration: none; transition: all 0.3s ease; ${style}">${tab.label}</a>`;
      })
      .join('');

    const dims = [
      { value: 'total', label: t(lang, 'Total', '总量') },
      { value: 'task_id', label: t(lang, 'Source', '来源') },
      { value: 'model', label: t(lang, 'Model', '模型') },
      { value: 'group_id', label: t(lang, 'Group', '群组') },
      { value: 'tool_name', label: t(lang, 'Tool', '工具') },
    ];

    // Build Dimension Tabs
    const dimsHtml = dims
      .map((dim) => {
        const active = dimension === dim.value;
        const style = active
          ? 'background: var(--purple); color: #fff; box-shadow: 0 4px 12px rgba(139, 92, 246, 0.2);'
          : 'background: rgba(0,0,0,0.04); color: var(--text-muted);';
        return `<a href="?section=usage&days=${days}&dim=${dim.value}" style="padding: 6px 16px; border-radius: 8px; font-size: 12px; font-weight: 600; text-decoration: none; transition: all 0.3s ease; ${style}">${dim.label}</a>`;
      })
      .join('');

    html += `<div class="section-group"><div class="card" style="padding: 28px; animation: none;">`;

    // Card header
    html += `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px;">
      <div>
        <div style="font-size: 17px; font-weight: 700; color: var(--text-main); letter-spacing: -0.3px; margin-bottom: 12px;">
          ${t(lang, 'Token Consumption Trend', 'Token 消耗趋势')}
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <span style="font-size: 12px; color: var(--text-muted); margin-right: 4px;">${t(lang, 'Breakdown:', '拆分维度:')}</span>
          ${dimsHtml}
        </div>
      </div>
      <div style="display: flex; gap: 6px; align-items: center;">
        ${tabsHtml}
      </div>
    </div>`;

    // ── Interactive Chart Container ──
    if (timeline.length > 0) {
      html += `
        <div id="interactive-chart" style="position: relative; height: 280px; margin-bottom: 16px;">
          <div id="chart-area" style="display: flex; height: 220px; align-items: flex-end; gap: ${timeline.length > 20 ? '2' : '4'}px;"></div>
          <div id="x-axis" style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); margin-top: 8px;"></div>
          <div id="chart-legend" style="display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 16px; font-size: 12px; margin-top: 16px; user-select: none;"></div>
        </div>
      `;

      // Inject Client-Side JavaScript for rendering the interactive chart
      html += `<script>
        (function() {
          const rawData = ${JSON.stringify(timeline)};
          const chartArea = document.getElementById('chart-area');
          const xAxis = document.getElementById('x-axis');
          const legendArea = document.getElementById('chart-legend');
          
          let tooltip = document.getElementById('chart-tooltip');
          if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'chart-tooltip';
            tooltip.style.cssText = 'position: fixed; display: none; background: rgba(0,0,0,0.85); color: #fff; padding: 8px 12px; border-radius: 6px; font-size: 12px; pointer-events: none; z-index: 99999; box-shadow: 0 4px 12px rgba(0,0,0,0.2); white-space: pre-wrap; transform: translate(-50%, -100%); margin-top: -12px; transition: left 0.05s ease-out, top 0.05s ease-out;';
            document.body.appendChild(tooltip);
          }
          
          let disabledSeries = new Set();
          
          // 1. Extract all series keys
          const skipKeys = new Set(['date', 'total_tokens']);
          const seriesSet = new Set();
          rawData.forEach(row => {
            Object.keys(row).forEach(k => {
              if (!skipKeys.has(k)) seriesSet.add(k);
            });
          });
          const allSeries = Array.from(seriesSet).sort();
          
          // 2. Assign Colors
          const colorPalette = ['#0066FF', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4', '#eab308', '#84cc16'];
          const seriesColors = {};
          allSeries.forEach((s, i) => {
            if (s === 'input_tokens') seriesColors[s] = '#8b5cf6';
            else if (s === 'output_tokens') seriesColors[s] = '#0066FF';
            else seriesColors[s] = colorPalette[i % colorPalette.length];
          });
          
          function formatNum(n) {
            return n.toLocaleString();
          }

          // 3. Render Function
          function renderChart() {
            chartArea.innerHTML = '';
            
            // Calculate sums per day and absolute max
            let maxTotal = 1; // prevent div by zero
            const activeData = rawData.map(row => {
              let sum = 0;
              const segments = [];
              allSeries.forEach(s => {
                if (!disabledSeries.has(s) && row[s]) {
                  sum += row[s];
                  segments.push({ name: s, value: row[s], color: seriesColors[s] });
                }
              });
              if (sum > maxTotal) maxTotal = sum;
              return { date: row.date, sum, segments };
            });
            
            // Draw Columns
            activeData.forEach(day => {
              const col = document.createElement('div');
              col.style.flex = '1';
              col.style.height = '100%';
              col.style.display = 'flex';
              col.style.flexDirection = 'column';
              col.style.justifyContent = 'flex-end';
              col.style.minWidth = '3px';
              
              const barWrap = document.createElement('div');
              barWrap.style.width = '100%';
              const hPct = (day.sum / maxTotal) * 100;
              barWrap.style.height = hPct + '%';
              barWrap.style.display = 'flex';
              barWrap.style.flexDirection = 'column';
              barWrap.style.borderRadius = '3px 3px 0 0';
              barWrap.style.overflow = 'hidden';
              barWrap.style.minHeight = day.sum > 0 ? '2px' : '0';
              
              // sort segments: largest at bottom
              day.segments.sort((a,b) => b.value - a.value);
              
              day.segments.forEach(seg => {
                const segDiv = document.createElement('div');
                segDiv.style.flex = (seg.value / day.sum).toString();
                segDiv.style.background = seg.color;
                segDiv.style.opacity = '0.85';
                segDiv.style.transition = 'opacity 0.2s';
                
                // Hover Events
                segDiv.onmouseover = (e) => {
                  segDiv.style.opacity = '1';
                  tooltip.style.display = 'block';
                  tooltip.innerHTML = \`<div style="color:#aaa;margin-bottom:4px">\${day.date}</div>\u003Cdiv style="display:flex;align-items:center;gap:6px">\u003Cspan style="display:inline-block;width:10px;height:10px;background:\${seg.color};border-radius:2px;">\u003C/span>\u003Cspan>\${seg.name}: \u003Cstrong>\${formatNum(seg.value)}\u003C/strong>\u003C/span>\u003C/div>\`;
                };
                segDiv.onmousemove = (e) => {
                  tooltip.style.left = e.clientX + 'px';
                  tooltip.style.top = e.clientY + 'px';
                };
                segDiv.onmouseout = () => {
                  segDiv.style.opacity = '0.85';
                  tooltip.style.display = 'none';
                };
                
                barWrap.appendChild(segDiv);
              });
              
              col.appendChild(barWrap);
              chartArea.appendChild(col);
            });
            
            // X-Axis
            xAxis.innerHTML = '';
            if (activeData.length > 0) {
              const spanFirst = document.createElement('span'); spanFirst.innerText = activeData[0].date;
              xAxis.appendChild(spanFirst);
              if (activeData.length > 2) {
                const spanMid = document.createElement('span'); spanMid.innerText = activeData[Math.floor(activeData.length/2)].date;
                xAxis.appendChild(spanMid);
              }
              const spanLast = document.createElement('span'); spanLast.innerText = activeData[activeData.length-1].date;
              xAxis.appendChild(spanLast);
            }
            
            // Legend
            legendArea.innerHTML = '';
            allSeries.forEach(s => {
              const item = document.createElement('div');
              const isHidden = disabledSeries.has(s);
              item.style.display = 'flex';
              item.style.alignItems = 'center';
              item.style.gap = '5px';
              item.style.cursor = 'pointer';
              item.style.opacity = isHidden ? '0.4' : '1';
              item.style.transition = 'opacity 0.2s';
              
              item.innerHTML = \`<span style="display:inline-block;width:10px;height:10px;background:\${seriesColors[s]};border-radius:2px;">\u003C/span>\u003Cspan style="color:var(--text-muted)">\${s}\u003C/span>\`;
              
              item.onclick = () => {
                if (isHidden) disabledSeries.delete(s);
                else disabledSeries.add(s);
                renderChart();
              };
              legendArea.appendChild(item);
            });
          }
          
          renderChart();
        })();
      </script>`;
    } else {
      html += `<div class="empty-state" style="padding: 60px 20px;">${t(lang, 'No usage data yet', '暂无用量数据')}</div>`;
    }

    // ── Summary Stats Footer ──
    html += `
    <div style="
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid rgba(0,0,0,0.06);
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
    ">
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-muted); font-weight: 500; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${t(lang, 'Total Tokens', 'Token 总量')}</div>
        <div style="font-size: 24px; font-weight: 700; color: var(--text-main); letter-spacing: -0.5px;">${fmtNum(summary.total_tokens)}</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-muted); font-weight: 500; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${t(lang, 'Input', '输入')}</div>
        <div style="font-size: 24px; font-weight: 700; color: var(--purple); letter-spacing: -0.5px;">${fmtNum(summary.input_tokens)}</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-muted); font-weight: 500; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${t(lang, 'Output', '输出')}</div>
        <div style="font-size: 24px; font-weight: 700; color: var(--accent); letter-spacing: -0.5px;">${fmtNum(summary.output_tokens)}</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 12px; color: var(--text-muted); font-weight: 500; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">${t(lang, 'Requests', '请求次数')}</div>
        <div style="font-size: 24px; font-weight: 700; color: var(--text-main); letter-spacing: -0.5px;">${fmtNum(summary.request_count)}</div>
      </div>
    </div>`;

    html += `</div></div>`;

    // ── Generate Dimension Ranking Card if not 'total' ──
    if (dimension !== 'total') {
      const breakdown = getUsageByDimension(dimension, days, 50);
      const titleMap: Record<string, string> = {
        model: t(lang, 'Model Leaderboard', '模型排行'),
        group_id: t(lang, 'Group Leaderboard', '群组排行'),
        task_id: t(lang, 'Source Leaderboard', '来源排行'),
        tool_name: t(lang, 'Tool Leaderboard', '工具排行'),
      };
      const lTitle = titleMap[dimension] || 'Leaderboard';

      html += `<div class="card" style="margin-top: 24px;">`;
      html += `<div class="card-title">${lTitle}</div>`;
      html += `<table><thead><tr><th>${t(lang, 'Name', '名称')}</th><th>${t(lang, 'Tokens', '消耗 Token')}</th><th>${t(lang, 'Requests', '请求次数')}</th></tr></thead><tbody>`;

      for (const row of breakdown) {
        html += `<tr>
          <td><span class="badge badge-purple">${esc(row.name)}</span></td>
          <td>${fmtNum(row.total_tokens)}</td>
          <td>${fmtNum(row.request_count)}</td>
        </tr>`;
      }
      if (breakdown.length === 0) {
        html += `<tr><td colspan="3" class="empty-state">${t(lang, 'No data', '暂无数据')}</td></tr>`;
      }
      html += `</tbody></table></div>`;
    }

    return html;
  }
}
