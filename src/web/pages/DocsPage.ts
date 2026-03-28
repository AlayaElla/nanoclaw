import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import {
  getAgentStatusFiles,
  listWorkspaceFiles,
  readWorkspaceFile,
  FileEntry,
} from '../data.js';

/**
 * Build a tree structure from flat FileEntry list.
 * Returns top-level children for the given `parentPath`.
 */
function getChildEntries(files: FileEntry[], parentPath: string): FileEntry[] {
  // Direct children: their relativePath is `parentPath/name` (one level deeper)
  return files.filter((f) => {
    if (parentPath === '') {
      // Top-level: no "/" in relativePath
      return !f.relativePath.includes('/');
    }
    const prefix = parentPath + '/';
    if (!f.relativePath.startsWith(prefix)) return false;
    const rest = f.relativePath.slice(prefix.length);
    return !rest.includes('/');
  });
}

function getFileIcon(entry: FileEntry): string {
  if (entry.isDirectory) return '📁';
  const ext = entry.extension.toLowerCase();
  if (['.md', '.txt', '.rst'].includes(ext)) return '📝';
  if (['.ts', '.js', '.tsx', '.jsx'].includes(ext)) return '📜';
  if (['.py'].includes(ext)) return '🐍';
  if (['.json', '.yaml', '.yml', '.toml'].includes(ext)) return '⚙️';
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext))
    return '🖼️';
  if (['.css', '.scss', '.less'].includes(ext)) return '🎨';
  if (['.html', '.htm'].includes(ext)) return '🌐';
  if (['.sh', '.bash'].includes(ext)) return '🔧';
  if (['.db', '.sqlite'].includes(ext)) return '🗄️';
  return '📄';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class DocsPage extends Page<{ query: URLSearchParams }> {
  render(props: { query: URLSearchParams }, lang: Lang): string {
    const selectedAgent = props.query.get('agent') || '';
    const selectedFile = props.query.get('file') || '';
    const selectedDir = props.query.get('dir') || '';
    const agents = getAgentStatusFiles();

    let html = pageHeader(
      t(lang, 'Documents', '文档'),
      t(lang, 'Agent Workspace File Manager', 'Agent 工作区文件管理器'),
    );

    html += `<div class="fm-container">`;

    // === Left sidebar: Agent list (Flat, no groups) ===
    html += `<div class="fm-sidebar">`;
    html += `<div class="fm-sidebar-header">${t(lang, 'Agents', 'Agent 列表')}</div>`;

    for (const agent of agents) {
      const isSelected = selectedAgent === agent.name;
      html += `
        <div class="fm-agent-section ${isSelected ? 'active' : ''}">
          <a class="fm-agent-item ${isSelected ? 'active' : ''}" 
             href="/cc/?section=docs&agent=${encodeURIComponent(agent.name)}&lang=${lang}">
            <span class="fm-agent-icon">🤖</span>
            <span class="fm-agent-name">${esc(agent.name)}</span>
          </a>
        </div>`;
    }

    if (agents.length === 0) {
      html += `<div class="empty-state" style="padding:24px;font-size:13px">${t(lang, 'No agents found', '未找到 Agent')}</div>`;
    }

    html += `</div>`; // fm-sidebar

    // === Right panel: File browser ===
    html += `<div class="fm-main">`;

    if (selectedAgent) {
      const allFiles = listWorkspaceFiles(selectedAgent);

      if (selectedFile) {
        // === File view & edit mode ===
        const fileName = selectedFile.split('/').pop() || selectedFile;
        const ext = (fileName.split('.').pop() || '').toLowerCase();
        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(
          ext,
        );
        const isVideo = ['mp4', 'webm', 'ogg'].includes(ext);
        const isAudio = ['mp3', 'wav', 'm4a', 'aac'].includes(ext);
        const isMedia = isImage || isVideo || isAudio;

        const isCode = [
          'ts',
          'js',
          'py',
          'json',
          'yaml',
          'yml',
          'sh',
          'bash',
          'css',
          'html',
          'tsx',
          'jsx',
          'toml',
          'sql',
          'md',
          'txt',
        ].includes(ext);

        const content = isMedia
          ? null
          : readWorkspaceFile(selectedAgent, selectedFile);

        // Breadcrumb
        html += `<div class="fm-breadcrumb">`;
        html += `<a href="/cc/?section=docs&agent=${encodeURIComponent(selectedAgent)}&lang=${lang}" class="fm-crumb">🏠 ${esc(selectedAgent)}</a>`;

        const parts = selectedFile.split('/');
        let pathAcc = '';
        for (let i = 0; i < parts.length - 1; i++) {
          pathAcc += (i > 0 ? '/' : '') + parts[i];
          html += `<span class="fm-crumb-sep">›</span>`;
          html += `<a href="/cc/?section=docs&agent=${encodeURIComponent(selectedAgent)}&dir=${encodeURIComponent(pathAcc)}&lang=${lang}" class="fm-crumb">${esc(parts[i])}</a>`;
        }
        html += `<span class="fm-crumb-sep">›</span>`;
        html += `<span class="fm-crumb-current">${esc(fileName)}</span>`;
        html += `</div>`;

        // Action Bar for File
        html += `<div class="fm-action-bar" style="justify-content: flex-end;">`;
        if (content !== null) {
          html += `
            <button class="btn btn-sm" onclick="fmDownload('${esc(selectedAgent)}', '${esc(selectedFile)}')">💾 ${t(lang, 'Download', '下载')}</button>
          `;
          if (isCode) {
            html += `
              <button class="btn btn-sm btn-primary" onclick="fmSaveFile('${esc(selectedAgent)}', '${esc(selectedFile)}')">📝 ${t(lang, 'Save', '保存')}</button>
            `;
          }
        }
        html += `<button class="btn btn-sm btn-danger" onclick="fmDelete('${esc(selectedAgent)}', '${esc(selectedFile)}')">🗑️ ${t(lang, 'Delete', '删除')}</button>`;
        html += `</div>`;

        // File content editor/viewer
        html += `<div class="fm-file-view">`;
        if (isMedia) {
          const downloadUrl = `/cc/api/fs/download?agent=${encodeURIComponent(selectedAgent)}&file=${encodeURIComponent(selectedFile)}`;
          html += `
            <div class="fm-file-header">
              <div class="fm-file-title">${getFileIcon({ extension: '.' + ext, isDirectory: false } as FileEntry)} ${esc(fileName)}</div>
            </div>
            <div class="fm-media-preview">`;
          if (isImage) {
            html += `<img src="${downloadUrl}" alt="${esc(fileName)}" class="fm-img-preview" />`;
          } else if (isVideo) {
            html += `<video controls src="${downloadUrl}" class="fm-video-preview">${t(lang, 'Your browser does not support the video tag.', '您的浏览器不支持视频标签。')}</video>`;
          } else if (isAudio) {
            html += `<audio controls src="${downloadUrl}" class="fm-audio-preview">${t(lang, 'Your browser does not support the audio tag.', '您的浏览器不支持音频标签。')}</audio>`;
          }
          html += `</div>`;
        } else if (content !== null) {
          html += `
            <div class="fm-file-header">
              <div class="fm-file-title">${getFileIcon({ extension: '.' + ext, isDirectory: false } as FileEntry)} ${esc(fileName)}</div>
              <span class="fm-file-size">${formatSize(content.length)}</span>
            </div>`;

          if (isCode) {
            html += `<textarea id="fm-editor" class="fm-code fm-code-edit" spellcheck="false">${esc(content)}</textarea>`;
          } else {
            html += `<pre class="fm-code">${esc(content)}</pre>`;
          }
        } else {
          html += `<div class="empty-state">${t(lang, 'Cannot read file or file is too large', '无法读取文件或文件过大')}</div>`;
        }
        html += `</div>`;
      } else {
        // === Directory listing mode ===
        const currentDir = selectedDir;

        // Breadcrumb
        html += `<div class="fm-breadcrumb">`;
        html += `<a href="/cc/?section=docs&agent=${encodeURIComponent(selectedAgent)}&lang=${lang}" class="fm-crumb ${!currentDir ? 'active' : ''}">🏠 ${esc(selectedAgent)}</a>`;

        if (currentDir) {
          const parts = currentDir.split('/');
          let pathAcc = '';
          for (let i = 0; i < parts.length; i++) {
            pathAcc += (i > 0 ? '/' : '') + parts[i];
            const isLast = i === parts.length - 1;
            html += `<span class="fm-crumb-sep">›</span>`;
            if (isLast) {
              html += `<span class="fm-crumb-current">${esc(parts[i])}</span>`;
            } else {
              html += `<a href="/cc/?section=docs&agent=${encodeURIComponent(selectedAgent)}&dir=${encodeURIComponent(pathAcc)}&lang=${lang}" class="fm-crumb">${esc(parts[i])}</a>`;
            }
          }
        }
        html += `</div>`;

        // Back button + Action Bar
        html += `<div class="fm-action-bar">`;
        html += `<div>`; // Left side
        if (currentDir) {
          const parentDir = currentDir.includes('/')
            ? currentDir.substring(0, currentDir.lastIndexOf('/'))
            : '';
          const parentHref = parentDir
            ? `/cc/?section=docs&agent=${encodeURIComponent(selectedAgent)}&dir=${encodeURIComponent(parentDir)}&lang=${lang}`
            : `/cc/?section=docs&agent=${encodeURIComponent(selectedAgent)}&lang=${lang}`;
          html += `
            <a class="fm-back-link" href="${parentHref}">
              <span>←</span> ${t(lang, 'Back', '返回上级')}
            </a>`;
        }
        html += `</div>`;

        // Right side actions
        html += `<div class="fm-actions-right">`;
        html += `<button class="btn btn-sm" id="fm-paste-btn" style="display:none" onclick="fmPaste('${esc(selectedAgent)}', '${esc(currentDir)}')">📋 ${t(lang, 'Paste', '粘贴')}</button>`;
        html += `<button class="btn btn-sm" onclick="fmNewFolder('${esc(selectedAgent)}', '${esc(currentDir)}')">📁 ${t(lang, 'New Folder', '新建文件夹')}</button>`;
        html += `<label class="btn btn-sm btn-primary" style="cursor: pointer; margin-bottom: 0; display: inline-flex; align-items: center;">`;
        html += `<input type="file" style="display:none" onchange="fmUploadFile(event, '${esc(selectedAgent)}', '${esc(currentDir)}')"/>`;
        html += `☁️ ${t(lang, 'Upload', '上传文件')}</label>`;
        html += `</div>`;
        html += `</div>`; // .fm-action-bar

        // Get entries for current path
        const children = getChildEntries(allFiles, currentDir);
        const dirs = children
          .filter((f) => f.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name));
        const files = children
          .filter((f) => !f.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name));

        if (dirs.length === 0 && files.length === 0) {
          html += `<div class="fm-empty">${t(lang, 'This folder is empty', '此文件夹为空')}</div>`;
        } else {
          // Stats bar
          html += `<div class="fm-stats">${dirs.length} ${t(lang, 'folders', '文件夹')}, ${files.length} ${t(lang, 'files', '文件')}</div>`;

          html += `<div class="fm-grid">`;

          // Directories first
          for (const dir of dirs) {
            const dirSubItems = allFiles.filter((f) =>
              f.relativePath.startsWith(dir.relativePath + '/'),
            );
            const subCount = dirSubItems.length;
            html += `
              <div class="fm-item-wrapper">
                <a class="fm-item fm-item-dir" href="/cc/?section=docs&agent=${encodeURIComponent(selectedAgent)}&dir=${encodeURIComponent(dir.relativePath)}&lang=${lang}">
                  <div class="fm-item-icon">📁</div>
                  <div class="fm-item-info">
                    <div class="fm-item-name">${esc(dir.name)}</div>
                    <div class="fm-item-meta">${subCount} ${t(lang, 'items', '项')}</div>
                  </div>
                </a>
                <div class="fm-item-menu" tabindex="0">
                  <div class="fm-item-menu-icon">⋮</div>
                  <div class="fm-dropdown">
                    <div class="fm-dd-item" onclick="fmRename('${esc(selectedAgent)}', '${esc(dir.relativePath)}', '${esc(dir.name)}')">✏️ ${t(lang, 'Rename', '重命名')}</div>
                    <div class="fm-dd-item" onclick="fmSetClipboard('copy', '${esc(selectedAgent)}', '${esc(dir.relativePath)}')">📄 ${t(lang, 'Copy', '复制')}</div>
                    <div class="fm-dd-item" onclick="fmSetClipboard('cut', '${esc(selectedAgent)}', '${esc(dir.relativePath)}')">✂️ ${t(lang, 'Cut', '剪切')}</div>
                    <div class="fm-dd-divider"></div>
                    <div class="fm-dd-item text-danger" onclick="fmDelete('${esc(selectedAgent)}', '${esc(dir.relativePath)}')">🗑️ ${t(lang, 'Delete', '删除')}</div>
                  </div>
                </div>
              </div>`;
          }

          // Files
          for (const file of files) {
            html += `
              <div class="fm-item-wrapper">
                <a class="fm-item fm-item-file" href="/cc/?section=docs&agent=${encodeURIComponent(selectedAgent)}&file=${encodeURIComponent(file.relativePath)}&lang=${lang}">
                  <div class="fm-item-icon">${getFileIcon(file)}</div>
                  <div class="fm-item-info">
                    <div class="fm-item-name">${esc(file.name)}</div>
                    <div class="fm-item-meta">${formatSize(file.size)}</div>
                  </div>
                </a>
                <div class="fm-item-menu" tabindex="0">
                  <div class="fm-item-menu-icon">⋮</div>
                  <div class="fm-dropdown">
                    <div class="fm-dd-item" onclick="fmDownload('${esc(selectedAgent)}', '${esc(file.relativePath)}')">💾 ${t(lang, 'Download', '下载')}</div>
                    <div class="fm-dd-item" onclick="fmRename('${esc(selectedAgent)}', '${esc(file.relativePath)}', '${esc(file.name)}')">✏️ ${t(lang, 'Rename', '重命名')}</div>
                    <div class="fm-dd-item" onclick="fmSetClipboard('copy', '${esc(selectedAgent)}', '${esc(file.relativePath)}')">📄 ${t(lang, 'Copy', '复制')}</div>
                    <div class="fm-dd-item" onclick="fmSetClipboard('cut', '${esc(selectedAgent)}', '${esc(file.relativePath)}')">✂️ ${t(lang, 'Cut', '剪切')}</div>
                    <div class="fm-dd-divider"></div>
                    <div class="fm-dd-item text-danger" onclick="fmDelete('${esc(selectedAgent)}', '${esc(file.relativePath)}')">🗑️ ${t(lang, 'Delete', '删除')}</div>
                  </div>
                </div>
              </div>`;
          }

          html += `</div>`; // fm-grid
        }
      }
    } else {
      // No agent selected - welcome screen
      html += `
        <div class="fm-welcome">
          <div class="fm-welcome-icon">📂</div>
          <div class="fm-welcome-title">${t(lang, 'Select an Agent', '选择一个 Agent')}</div>
          <div class="fm-welcome-sub">${t(lang, 'Choose an agent from the sidebar to manage files', '从侧边栏选择一个 Agent 进行文件管理')}</div>
        </div>`;
    }

    html += `</div>`; // fm-main
    html += `</div>`; // fm-container

    // Client-side JS and CSS
    html += `<style>${DocsPage.renderCss()}</style>`;
    html += DocsPage.renderScript(lang);

    return html;
  }

  static renderScript(lang: Lang): string {
    return `
    <script>
      // Clipboard state
      function fmCheckClipboard() {
        const pasteBtn = document.getElementById('fm-paste-btn');
        if (!pasteBtn) return;
        try {
          const clip = JSON.parse(sessionStorage.getItem('nano_fm_clipboard') || 'null');
          if (clip && clip.path) {
            pasteBtn.style.display = 'inline-block';
            const actionStr = clip.op === 'cut' ? '${t(lang, 'Cut', '剪切')}' : '${t(lang, 'Copy', '复制')}';
            pasteBtn.innerHTML = '📋 ${t(lang, 'Paste', '粘贴')} (' + actionStr + ')';
          } else {
            pasteBtn.style.display = 'none';
          }
        } catch { pasteBtn.style.display = 'none'; }
      }

      function fmSetClipboard(op, agent, path) {
        sessionStorage.setItem('nano_fm_clipboard', JSON.stringify({op, agent, path}));
        fmCheckClipboard();
        alert(op === 'copy' ? '${t(lang, 'Copied to clipboard', '已复制到剪贴板')}' : '${t(lang, 'Cut to clipboard', '已剪切到剪贴板')}');
        document.activeElement.blur(); // close menu
      }

      async function postFs(action, payload) {
        try {
          const res = await fetch('/cc/api/fs/' + action, {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (!data.success) {
            alert('${t(lang, 'Error', '错误')}: ' + (data.error || '${t(lang, 'Unknown', '未知')}'));
            return false;
          }
          return true;
        } catch (e) {
          alert('${t(lang, 'Network error', '网络错误')}');
          return false;
        }
      }

      async function fmPaste(agent, currentDir) {
        try {
          const clip = JSON.parse(sessionStorage.getItem('nano_fm_clipboard') || 'null');
          if (!clip || !clip.path) return;
          
          let targetPath = clip.path.split('/').pop();
          if (currentDir) targetPath = currentDir + '/' + targetPath;

          const action = clip.op === 'cut' ? 'move' : 'copy';
          if (await postFs(action, { sourceAgent: clip.agent, targetAgent: agent, sourcePath: clip.path, targetPath })) {
            if (clip.op === 'cut') sessionStorage.removeItem('nano_fm_clipboard');
            window.location.reload();
          }
        } catch {}
      }

      async function fmDelete(agent, path) {
        if (!confirm('${t(lang, 'Are you sure you want to delete:', '确定要删除：')} ' + path + '?')) return;
        if (await postFs('delete', { agent, path })) {
          // Redirect to current folder if deleting a viewed file
          const params = new URLSearchParams(window.location.search);
          if (params.get('file') === path) {
            const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
            params.delete('file');
            if (dir) params.set('dir', dir);
            window.location.search = params.toString();
          } else {
            window.location.reload();
          }
        }
      }

      async function fmRename(agent, oldPath, oldName) {
        const newName = prompt('${t(lang, 'Enter new name:', '请输入新名称：')}', oldName);
        if (!newName || newName === oldName) return;
        
        let newPath = newName;
        if (oldPath.includes('/')) {
          newPath = oldPath.substring(0, oldPath.lastIndexOf('/')) + '/' + newName;
        }

        if (await postFs('rename', { agent, oldPath, newPath })) {
          window.location.reload();
        }
      }

      async function fmNewFolder(agent, currentDir) {
        const name = prompt('${t(lang, 'Folder name:', '文件夹名称：')}');
        if (!name) return;
        const path = currentDir ? currentDir + '/' + name : name;
        if (await postFs('mkdir', { agent, path })) {
          window.location.reload();
        }
      }

      async function fmUploadFile(event, agent, currentDir) {
        const file = event.target.files[0];
        if (!file) return;
        const btnLabel = event.target.parentElement;
        const originalHtml = btnLabel.innerHTML;
        btnLabel.innerHTML = '⏳ ${t(lang, 'Uploading...', '上传中...')}';
        
        const reader = new FileReader();
        reader.onload = async function() {
          const base64 = reader.result;
          const path = currentDir ? currentDir + '/' + file.name : file.name;
          if (await postFs('upload', { agent, path, contentBase64: base64 })) {
            window.location.reload();
          } else {
            btnLabel.innerHTML = originalHtml;
          }
        };
        reader.onerror = function() {
          alert('${t(lang, 'Error reading file', '读取文件出错')}');
          btnLabel.innerHTML = originalHtml;
        };
        reader.readAsDataURL(file);
      }

      async function fmSaveFile(agent, path) {
        const btn = event.currentTarget;
        const originalText = btn.innerHTML;
        btn.innerHTML = '⏳ ${t(lang, 'Saving...', '保存中...')}';
        btn.disabled = true;

        const content = document.getElementById('fm-editor').value;
        if (await postFs('write', { agent, path, content })) {
          btn.innerHTML = '✅ ${t(lang, 'Saved', '已保存')}';
          setTimeout(() => { btn.innerHTML = originalText; btn.disabled = false; }, 2000);
        } else {
          btn.innerHTML = '❌ ${t(lang, 'Error', '错误')}';
          setTimeout(() => { btn.innerHTML = originalText; btn.disabled = false; }, 2000);
        }
      }

      function fmDownload(agent, path) {
        window.open('/cc/api/fs/download?agent=' + encodeURIComponent(agent) + '&file=' + encodeURIComponent(path), '_blank');
      }

      // Init UI state
      document.addEventListener('DOMContentLoaded', fmCheckClipboard);
    </script>
    `;
  }

  static renderCss(): string {
    return `
    .fm-container {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 0;
      height: calc(100vh - 180px);
      background: var(--glass-bg);
      backdrop-filter: blur(32px) saturate(200%);
      -webkit-backdrop-filter: blur(32px) saturate(200%);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: 0 10px 40px rgba(0,0,0,0.04), inset 0 1px 1px #fff;
    }

    /* Sidebar */
    .fm-sidebar {
      background: rgba(0,0,0,0.015);
      border-right: 1px solid rgba(0,0,0,0.05);
      overflow-y: auto;
      padding: 0;
    }
    .fm-sidebar-header {
      font-size: var(--fs-xs);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      padding: 20px 20px 12px;
    }

    .fm-agent-section {
      border-bottom: 1px solid rgba(0,0,0,0.02);
    }
    .fm-agent-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 20px;
      text-decoration: none;
      color: var(--text-main);
      transition: all 0.2s ease;
      cursor: pointer;
      border-left: 3px solid transparent;
    }
    .fm-agent-item:hover {
      background: rgba(0,0,0,0.02);
      opacity: 1;
    }
    .fm-agent-item.active {
      background: rgba(0,102,255,0.04);
      border-left-color: var(--accent);
      font-weight: 600;
    }
    .fm-agent-icon {
      font-size: 18px;
    }
    .fm-agent-name {
      font-size: var(--fs-base);
      font-weight: 500;
    }

    /* Main file area */
    .fm-main {
      overflow-y: auto;
      padding: 24px 28px;
      position: relative;
    }

    /* Breadcrumb & Action Bar */
    .fm-action-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      gap: 12px;
      flex-wrap: wrap;
    }
    .fm-actions-right {
      display: flex;
      gap: 8px;
    }

    .fm-breadcrumb {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 16px;
      font-size: var(--fs-sm);
    }
    .fm-crumb {
      color: var(--accent);
      text-decoration: none;
      padding: 4px 8px;
      border-radius: 8px;
      transition: background 0.2s;
    }
    .fm-crumb:hover {
      background: rgba(0,102,255,0.06);
    }
    .fm-crumb.active { font-weight: 600; }
    .fm-crumb-sep { color: var(--text-muted); font-size: var(--fs-xs); opacity: 0.5; }
    .fm-crumb-current { color: var(--text-main); font-weight: 600; padding: 4px 8px; }

    /* Back link */
    .fm-back-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--text-main);
      text-decoration: none;
      font-size: var(--fs-sm);
      font-weight: 500;
      padding: 6px 12px;
      border-radius: 10px;
      background: rgba(0,0,0,0.03);
      transition: all 0.2s;
    }
    .fm-back-link:hover {
      background: rgba(0,0,0,0.06);
      transform: translateX(-2px);
    }

    /* Stats bar */
    .fm-stats {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 16px;
      padding: 8px 0;
      border-bottom: 1px solid rgba(0,0,0,0.04);
    }

    /* File grid */
    .fm-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 12px;
    }

    .fm-item-wrapper {
      position: relative;
    }
    .fm-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 36px 14px 16px; /* Space for menu dot */
      border-radius: var(--radius-sm);
      border: 1px solid rgba(0,0,0,0.04);
      background: rgba(255,255,255,0.5);
      text-decoration: none;
      color: var(--text-main);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      cursor: pointer;
      height: 100%;
    }
    .app.animate-in .fm-item {
      animation: fadeUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) backwards;
    }
    .fm-item-wrapper:nth-child(1) .fm-item { animation-delay: 0.05s; }
    .fm-item-wrapper:nth-child(2) .fm-item { animation-delay: 0.1s; }
    .fm-item-wrapper:nth-child(3) .fm-item { animation-delay: 0.15s; }
    .fm-item-wrapper:nth-child(4) .fm-item { animation-delay: 0.2s; }
    
    .fm-item:hover {
      border-color: rgba(0,0,0,0.08);
      background: rgba(255,255,255,0.9);
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(0,0,0,0.04);
    }
    .fm-item-icon {
      font-size: 28px;
      flex-shrink: 0;
      width: 36px;
      text-align: center;
    }
    .fm-item-info {
      flex: 1;
      min-width: 0;
    }
    .fm-item-name {
      font-size: 13px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fm-item-meta {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    /* Context Menu */
    .fm-item-menu {
      position: absolute;
      top: 14px;
      right: 10px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      transition: background 0.2s;
    }
    .fm-item-menu:hover { background: rgba(0,0,0,0.05); color: var(--text-main); }
    .fm-item-menu:focus-within { outline: none; background: rgba(0,0,0,0.05); }
    
    .fm-dropdown {
      display: none;
      position: absolute;
      top: 100%;
      right: 0;
      background: rgba(255,255,255,0.95);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(0,0,0,0.08);
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
      border-radius: 12px;
      padding: 6px;
      min-width: 140px;
      z-index: 10;
    }
    .fm-item-menu:focus-within .fm-dropdown,
    .fm-dropdown:active {
      display: block;
      animation: fadeIn 0.15s ease-out;
    }
    @keyframes fadeIn { from{opacity:0;transform:translateY(-5px)} to{opacity:1;transform:translateY(0)} }
    
    .fm-dd-item {
      padding: 8px 12px;
      font-size: 13px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .fm-dd-item:hover { background: rgba(0,0,0,0.04); }
    .fm-dd-divider { height: 1px; background: rgba(0,0,0,0.05); margin: 4px 0; }
    .text-danger { color: var(--red); }

    /* Empty states */
    .fm-empty { text-align: center; padding: 60px 20px; color: var(--text-muted); font-size: 14px; }
    .fm-welcome {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      height: 100%; text-align: center; gap: 12px;
    }
    .fm-welcome-icon { font-size: 56px; opacity: 0.6; animation: float 6s ease-in-out infinite; }
    .fm-welcome-title { font-size: 20px; font-weight: 600; color: var(--text-main); }
    .fm-welcome-sub { font-size: 14px; color: var(--text-muted); max-width: 300px; }

    /* File viewer / Editor */
    .fm-file-view { margin-top: 8px; display: flex; flex-direction: column; height: calc(100% - 100px); min-height: 400px; }
    .fm-file-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; background: rgba(0,0,0,0.02);
      border-radius: 12px 12px 0 0; border: 1px solid rgba(0,0,0,0.05); border-bottom: none;
    }
    .fm-file-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    .fm-file-size { font-size: 12px; color: var(--text-muted); background: rgba(0,0,0,0.04); padding: 3px 10px; border-radius: 8px; }
    
    .fm-code {
      font-family: "SF Mono", Menlo, "Cascadia Code", monospace;
      font-size: 12px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
      padding: 16px 20px; background: #FAFBFD;
      border: 1px solid rgba(0,0,0,0.05); border-radius: 0 0 12px 12px;
      color: #334; tab-size: 2; flex: 1; resize: none; margin: 0; outline: none;
    }
    textarea.fm-code:focus { border-color: rgba(0,102,255,0.4); box-shadow: inset 0 0 0 1px rgba(0,102,255,0.4); }
    .fm-code::-webkit-scrollbar { width: 8px; }
    .fm-code::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 4px; }
    .fm-code::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.2); }

    .fm-media-preview {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f0f2f5;
      padding: 20px;
      border: 1px solid rgba(0,0,0,0.05);
      border-radius: 0 0 12px 12px;
      overflow: auto;
    }
    .fm-img-preview {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      box-shadow: 0 10px 30px rgba(0,0,0,0.1);
      border-radius: 4px;
    }
    .fm-video-preview {
      max-width: 100%;
      max-height: 100%;
      border-radius: 8px;
    }
    .fm-audio-preview {
      width: 100%;
      max-width: 500px;
    }

    .btn-sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }

    /* Responsive */
    @media (max-width: 900px) {
      .fm-container { grid-template-columns: 1fr; height: auto; min-height: 500px; }
      .fm-sidebar { border-right: none; border-bottom: 1px solid rgba(0,0,0,0.05); max-height: 160px; }
      .fm-agent-item { padding: 10px 16px; }
      .fm-main { padding: 16px 20px; }
      .fm-item { padding: 8px 12px; font-size: 13px; }
      .fm-item-icon { font-size: 18px; }
      .fm-grid { gap: 8px; }
      .fm-breadcrumb { font-size: 12px; margin-bottom: 12px; }
      .fm-crumb, .fm-crumb-current { padding: 2px 4px; }
    }
    @media (max-width: 600px) {
      .fm-sidebar { max-height: 140px; }
      .fm-main { padding: 12px 14px; }
      .fm-grid { grid-template-columns: 1fr !important; }
      .fm-action-bar { gap: 8px; margin-bottom: 12px; }
      .fm-actions-right { width: 100%; justify-content: space-between; gap: 4px; }
      .btn-sm { padding: 5px 10px; font-size: 11px; flex: 1; text-align: center; }
    }
    `;
  }
}
