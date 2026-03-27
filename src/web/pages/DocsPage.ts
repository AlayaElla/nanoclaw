import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import {
  getAgentStatusFiles,
  listWorkspaceFiles,
  readWorkspaceFile,
} from '../data.js';

export class DocsPage extends Page<{ query: URLSearchParams }> {
  render(props: { query: URLSearchParams }, lang: Lang): string {
    const selectedAgent = props.query.get('agent') || '';
    const selectedFile = props.query.get('file') || '';
    const agents = getAgentStatusFiles();
    let html = pageHeader(
      t(lang, 'Documents', '文档'),
      t(lang, 'Browse agent workspace files', '浏览 Agent 工作目录文件'),
    );
    html += `<div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap">`;
    for (const a of agents)
      html += `<a class="${selectedAgent === a.name ? 'btn btn-primary' : 'btn'}" href="/?section=docs&agent=${encodeURIComponent(a.name)}&lang=${lang}">${esc(a.name)}</a>`;
    html += `</div>`;
    if (selectedAgent) {
      const files = listWorkspaceFiles(selectedAgent);
      html += `<div class="card">`;
      if (selectedFile) {
        const content = readWorkspaceFile(selectedAgent, selectedFile);
        html += `<div style="margin-bottom:12px"><a href="/?section=docs&agent=${encodeURIComponent(selectedAgent)}&lang=${lang}">← ${t(lang, 'Back', '返回')}</a> <span style="color:var(--muted)">/ ${esc(selectedFile)}</span></div>`;
        if (content)
          html += `<pre style="font-size:12px;white-space:pre-wrap;max-height:600px;overflow-y:auto;padding:12px;background:rgba(0,0,0,.3);border-radius:8px">${esc(content)}</pre>`;
        else
          html += `<div class="empty-state">${t(lang, 'Cannot read', '无法读取')}</div>`;
      } else {
        html += `<div class="file-tree">`;
        for (const f of files) {
          const icon = f.isDirectory ? '📁' : '📄';
          if (!f.isDirectory)
            html += `<a class="file-tree-item" href="/?section=docs&agent=${encodeURIComponent(selectedAgent)}&file=${encodeURIComponent(f.relativePath)}&lang=${lang}"><span class="file-icon">${icon}</span><span>${esc(f.relativePath)}</span><span style="margin-left:auto;color:var(--muted);font-size:11px">${(f.size / 1024).toFixed(1)}KB</span></a>`;
          else
            html += `<div class="file-tree-item"><span class="file-icon">${icon}</span><span style="color:var(--accent)">${esc(f.relativePath)}/</span></div>`;
        }
        if (files.length === 0)
          html += `<div class="empty-state">${t(lang, 'No files', '未找到文件')}</div>`;
        html += `</div>`;
      }
      html += `</div>`;
    } else
      html += `<div class="card empty-state">${t(lang, 'Select an agent', '选择一个 Agent 浏览文件')}</div>`;
    return html;
  }
}
