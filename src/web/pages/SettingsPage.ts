import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import {
  getLiteLLMModels,
  getNanoClawEnv,
  getAgentsConfig,
  getHostStatus,
} from '../data.js';
import { getAllRegisteredGroups } from '../../db.js';

export class SettingsPage extends Page<any> {
  render(_: any, lang: Lang): string {
    const status = getHostStatus();
    const models = getLiteLLMModels();
    const envVars = getNanoClawEnv();
    const agents = getAgentsConfig();
    const groups = getAllRegisteredGroups();

    const modelOptions = models
      .map(
        (m) =>
          `<option value="${esc(m.model_name)}">${esc(m.model_name)}</option>`,
      )
      .join('');

    let html = pageHeader(
      t(lang, 'Settings', '设置'),
      t(
        lang,
        'System configuration and service management',
        '系统配置与服务管理',
      ),
    );

    html += `<div style="margin-bottom:24px;display:flex;gap:8px">`;
    html += `<button class="btn btn-primary" onclick="restartService('litellm')">${t(lang, 'Restart LiteLLM', '重启 LiteLLM')}</button>`;
    html += `<button class="btn btn-danger" onclick="restartService('nanoclaw')">${t(lang, 'Restart NanoClaw', '重启 NanoClaw')}</button>`;
    html += `<button class="btn" style="color:var(--red);border-color:rgba(239,68,68,0.2)" onclick="stopNanoClaw()">${t(lang, 'Stop NanoClaw', '关闭 NanoClaw')}</button>`;
    html += `</div>`;

    if (status) {
      html += `<div class="section-group"><div class="section-label">${t(lang, 'System Information', '系统信息')}</div><div class="grid grid-3">`;
      html += `<div class="card"><div class="card-title">Node.js</div><div class="card-value" style="font-size:var(--fs-lg)">${esc(status.system.nodeVersion)}</div><div class="card-detail">${esc(status.system.platform)} / ${esc(status.system.arch)}</div></div>`;
      html += `<div class="card"><div class="card-title">${t(lang, 'Container Image', '容器镜像')}</div><div class="card-value" style="font-size:var(--fs-base);word-break:break-all">${esc(status.system.containerImage)}</div></div>`;
      html += `<div class="card"><div class="card-title">${t(lang, 'Max Containers', '最大容器')}</div><div class="card-value">${status.system.maxConcurrentContainers}</div><div class="card-detail">${t(lang, 'Timezone', '时区')}: ${esc(status.system.timezone)}</div></div>`;
      html += `</div></div>`;
    }
    html += `<div class="section-group"><div class="section-label">${t(lang, 'Agents Configuration', 'Agent 配置')} <button class="btn btn-primary" style="float:right;padding:4px 10px;font-size:var(--fs-sm);" onclick="openAgentModal()">${t(lang, '➕ Add Agent', '➕ 新建 Agent')}</button></div><div class="card"><table><thead><tr><th>${t(lang, 'Name', '名称')}</th><th>${t(lang, 'Channel', '渠道')}</th><th>${t(lang, 'Model', '模型')}</th><th>${t(lang, 'Actions', '操作')}</th></tr></thead><tbody>`;
    for (const a of agents) {
      html += `<tr><td><strong>${esc(a.name)}</strong></td><td><span class="badge badge-blue">${esc(a.channel || 'telegram')}</span></td><td style="font-size:var(--fs-sm)">${esc(a.model || '—')}</td><td><button class="btn" style="padding:4px 8px;font-size:var(--fs-sm)" onclick="openAgentModal('${esc(a.name)}', '${esc(a.channel || 'telegram')}', '${esc(a.token || '')}', '${esc(a.model || '')}')">⚙️ ${t(lang, 'Edit', '修改')}</button></td></tr>`;
    }
    if (agents.length === 0)
      html += `<tr><td colspan="4" class="empty-state">${t(lang, 'No agents configured', '未配置 Agent')}</td></tr>`;
    html += `</tbody></table></div></div>`;

    html += `<div class="section-group"><div class="section-label">${t(lang, 'Registered Groups', '已注册群组')} <button class="btn btn-primary" style="float:right;padding:4px 10px;font-size:var(--fs-sm);" onclick="openGroupModal()">${t(lang, '➕ Register Group', '➕ 注册群组')}</button></div><div class="card"><table><thead><tr><th>${t(lang, 'JID', '群组/联系人 JID')}</th><th>${t(lang, 'Name / Folder', '名称 / 文件夹')}</th><th>${t(lang, 'Routing Config', '路由配置')}</th><th>${t(lang, 'Actions', '操作')}</th></tr></thead><tbody>`;
    for (const jid of Object.keys(groups)) {
      const g = groups[jid];
      html += `<tr>
        <td style="font-family:monospace;font-size:var(--fs-sm)">${esc(jid)}</td>
        <td><strong>${esc(g.name)}</strong><div style="font-size:var(--fs-xs);color:var(--text-muted)">${esc(g.folder)}</div></td>
        <td style="font-size:var(--fs-xs)">
          ${g.isMain ? `<span class="badge badge-green" style="margin-right:4px">Main</span>` : ''}
          ${g.model ? `<span class="badge badge-purple" style="margin-right:4px">${esc(g.model)}</span>` : ''}
          ${esc(g.trigger || '')}
        </td>
        <td><button class="btn" style="padding:4px 8px;font-size:var(--fs-sm)" onclick="openGroupModal('${esc(jid)}', '${esc(g.name).replace(/'/g, "\\'")}', '${esc(g.folder).replace(/'/g, "\\'")}', '${esc(g.trigger || '').replace(/'/g, "\\'")}', ${g.isMain ? 'true' : 'false'}, '${esc(g.assistantName || '').replace(/'/g, "\\'")}', '${esc(g.botToken || '').replace(/'/g, "\\'")}', '${esc(g.model || '').replace(/'/g, "\\'")}')">⚙️ ${t(lang, 'Edit', '修改')}</button></td>
      </tr>`;
    }
    if (Object.keys(groups).length === 0)
      html += `<tr><td colspan="4" class="empty-state">${t(lang, 'No groups registered', '未注册群组')}</td></tr>`;
    html += `</tbody></table></div></div>`;

    html += `<div class="section-group"><div class="section-label">${t(lang, 'LiteLLM Models', 'LiteLLM 模型')}</div><div class="card"><table><thead><tr><th>${t(lang, 'Model Name', '模型名')}</th><th>${t(lang, 'Backend', '后端')}</th><th>${t(lang, 'API Base', 'API 地址')}</th></tr></thead><tbody>`;
    for (const m of models)
      html += `<tr><td><span class="badge badge-purple">${esc(m.model_name)}</span></td><td style="font-size:var(--fs-sm)">${esc(m.model || '—')}</td><td style="font-size:var(--fs-sm);color:var(--muted)">${esc(m.api_base || '—')}</td></tr>`;
    if (models.length === 0)
      html += `<tr><td colspan="3" class="empty-state">${t(lang, 'No models configured', '未配置模型')}</td></tr>`;
    html += `</tbody></table></div></div>`;

    html += `
    <script>
    function restartService(service) {
      const msg = service === 'litellm' ? '${t(lang, 'Restart LiteLLM?', '确定重启 LiteLLM？')}' : '${t(lang, 'Restart NanoClaw?', '确定重启 NanoClaw？')}';
      if (!confirm(msg)) return;
      
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;color:white;font-size:24px;backdrop-filter:blur(5px);';
      modal.innerText = service === 'litellm' ? '${t(lang, 'Restarting LiteLLM...', '正在重启 LiteLLM...')}' : '${t(lang, 'Restarting NanoClaw...', '正在重启 NanoClaw...')}';
      document.body.appendChild(modal);

      fetch('/cc/api/system/restart-' + service, { method: 'POST' }).then(() => {
        let attempts = 0;
        const interval = setInterval(() => {
          attempts++;
          const checkUrl = service === 'litellm' ? '/cc/api/system/litellm-status' : '/cc/health';
          fetch(checkUrl).then(res => {
            if (res.ok) {
              clearInterval(interval);
              modal.innerText = '${t(lang, 'Restart Successful! Reloading...', '重启成功！正在刷新...')}';
              setTimeout(() => location.reload(), 1000);
            }
          }).catch(() => {
            if (attempts > 30) {
              clearInterval(interval);
              modal.innerText = '${t(lang, 'Restart timeout. Please check logs.', '重启超时，请检查日志。')}';
              setTimeout(() => modal.remove(), 3000);
            }
          });
        }, 2000);
      }).catch(() => {
        modal.innerText = 'Failed to send restart command.';
        setTimeout(() => modal.remove(), 2000);
      });
    }
    function stopNanoClaw() {
      if (!confirm('${t(lang, 'Are you sure you want to stop NanoClaw? The service will terminate.', '确定要关闭 NanoClaw 吗？服务将会终止运行。')}')) return;
      
      const modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;color:white;font-size:24px;backdrop-filter:blur(5px);';
      modal.innerText = '${t(lang, 'Stopping NanoClaw...', '正在关闭 NanoClaw...')}';
      document.body.appendChild(modal);

      fetch('/cc/api/system/stop-nanoclaw', { method: 'POST' }).then(() => {
        setTimeout(() => {
          modal.innerText = '${t(lang, 'NanoClaw stopped. You can now close this page.', 'NanoClaw 已关闭，您可以关闭此页面了。')}';
        }, 1000);
      }).catch(() => {
        modal.innerText = 'Failed to send stop command.';
        setTimeout(() => modal.remove(), 2000);
      });
    }
    </script>
    `;
    html += `<div class="section-group"><div class="section-label">${t(lang, 'Language Options', '语言选项')}</div><div class="card" style="display:flex; gap:12px;">`;
    if (lang === 'zh') {
      html += `<a class="btn" href="/cc/?section=settings&lang=en">🌐 Switch to English</a>`;
    } else {
      html += `<a class="btn" href="/cc/?section=settings&lang=zh">🌐 切换为中文</a>`;
    }
    html += `</div></div>`;
    html += `<div class="section-group"><div class="section-label">${t(lang, 'Environment (.env)', '环境变量 (.env)')}</div><div class="card"><table><thead><tr><th>${t(lang, 'Key', '键')}</th><th>${t(lang, 'Value', '值')}</th></tr></thead><tbody>`;
    for (const v of envVars)
      html += `<tr><td style="font-family:monospace;font-size:var(--fs-sm)">${esc(v.key)}</td><td style="font-size:var(--fs-sm)">${esc(v.value)}</td></tr>`;
    html += `</tbody></table></div></div>`;

    // Config modals and scripts
    html += `
    <dialog id="agent-modal" class="agent-modal">
      <div class="agent-modal-header">
        <span id="agent-modal-title"></span>
        <button class="btn" onclick="this.closest('dialog').close()">✕</button>
      </div>
      <div class="agent-modal-body" style="display:flex;flex-direction:column;gap:12px;">
        <label>${t(lang, 'Name', '名称')}: <input type="text" id="agent-name" class="input" style="width:100%"></label>
        <label>${t(lang, 'Channel', '渠道')}: <select id="agent-channel" class="input" style="width:100%">
          <option value="telegram">telegram</option>
          <option value="feishu">feishu</option>
          <option value="discord">discord</option>
          <option value="whatsapp">whatsapp</option>
          <option value="claude">claude</option>
        </select></label>
        <label>${t(lang, 'Model', '模型')}: <select id="agent-model" class="input" style="width:100%">${modelOptions}</select></label>
        <label>${t(lang, 'Token', 'Token')}: <input type="password" id="agent-token" class="input" style="width:100%" placeholder="${t(lang, 'Leave blank if not needed', '如不需要请留空')}"></label>
        <input type="hidden" id="agent-is-update" value="">
        <button class="btn btn-primary" style="margin-top:12px;" onclick="saveAgent()">${t(lang, 'Save Agent', '保存 Agent')}</button>
      </div>
    </dialog>
    
    <dialog id="group-modal" class="agent-modal">
      <div class="agent-modal-header">
        <span id="group-modal-title"></span>
        <button class="btn" onclick="this.closest('dialog').close()">✕</button>
      </div>
      <div class="agent-modal-body" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <label style="grid-column:1/-1">${t(lang, 'JID (ID)', '群组/联系人 JID')}: <input type="text" id="group-jid" class="input" style="width:100%" placeholder="-100123..."></label>
        <label>${t(lang, 'Name', '名称')}: <input type="text" id="group-name" class="input" style="width:100%"></label>
        <label>${t(lang, 'Folder Name', '文件夹名')}: <input type="text" id="group-folder" class="input" style="width:100%"></label>
        <label>${t(lang, 'Trigger Pattern', '触发词')}: <input type="text" id="group-trigger" class="input" style="width:100%" placeholder="@Bot Name"></label>
        <label>${t(lang, 'Assistant Name', '助理名称')}: <input type="text" id="group-assistant" class="input" style="width:100%"></label>
        <label>${t(lang, 'Bot Token Ref', 'Bot Token 变量')}: <input type="text" id="group-token" class="input" style="width:100%" placeholder="TELEGRAM_BOT_TOKEN_1"></label>
        <label>${t(lang, 'Model Override', '模型覆盖')}: <select id="group-model" class="input" style="width:100%"><option value="">-- ${t(lang, 'None (Use Agent Default)', '无 (使用 Agent 默认)')} --</option>${modelOptions}</select></label>
        <label style="display:flex;align-items:center;gap:8px;grid-column:1/-1"><input type="checkbox" id="group-ismain"> ${t(lang, 'Is Main Control Group', '是否为主控面板群组')}</label>
        <button class="btn btn-primary" style="grid-column:1/-1;margin-top:8px;" onclick="saveGroup()">${t(lang, 'Save Group', '保存群组')}</button>
      </div>
    </dialog>
    
    <style>
      .input { padding:8px 12px; border:1px solid rgba(0,0,0,0.1); border-radius:8px; display:block; margin-top:4px; font-size:var(--fs-base); background:rgba(255,255,255,0.8); }
    </style>
    
    <script>
    function setSelectValue(id, val) {
      const sel = document.getElementById(id);
      if (val && !Array.from(sel.options).some(o => o.value === val)) {
        const opt = document.createElement('option');
        opt.value = opt.text = val;
        sel.add(opt);
      }
      sel.value = val;
    }

    function openAgentModal(name='', channel='', token='', model='') {
      document.getElementById('agent-name').value = name;
      setSelectValue('agent-channel', channel || 'telegram');
      setSelectValue('agent-model', model);
      document.getElementById('agent-token').value = !!name ? '********' : '';
      document.getElementById('agent-is-update').value = !!name ? 'true' : '';
      document.getElementById('agent-modal-title').innerText = !!name ? '${t(lang, 'Edit Agent', '修改 Agent')}' : '${t(lang, 'Add Agent', '新建 Agent')}';
      if (name) document.getElementById('agent-name').setAttribute('disabled', 'disabled');
      else document.getElementById('agent-name').removeAttribute('disabled');
      document.getElementById('agent-modal').showModal();
    }
    
    function saveAgent() {
      const payload = {
        name: document.getElementById('agent-name').value,
        channel: document.getElementById('agent-channel').value,
        model: document.getElementById('agent-model').value,
        token: document.getElementById('agent-token').value,
        isUpdate: !!document.getElementById('agent-is-update').value
      };
      if (payload.token === '********') delete payload.token; // Do not override if unchanged pseudo-token
      fetch('/cc/api/config/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(res => res.json()).then(data => {
        if (data.success) location.reload();
        else alert('Failed: ' + data.error);
      });
    }

    function openGroupModal(jid='', name='', folder='', trigger='', isMain=false, assistant='', token='', model='') {
      document.getElementById('group-jid').value = jid;
      document.getElementById('group-name').value = name;
      document.getElementById('group-folder').value = folder;
      document.getElementById('group-trigger').value = trigger;
      document.getElementById('group-ismain').checked = isMain;
      document.getElementById('group-assistant').value = assistant;
      document.getElementById('group-token').value = token;
      setSelectValue('group-model', model);
      document.getElementById('group-modal-title').innerText = !!jid ? '${t(lang, 'Edit Group', '修改群组')}' : '${t(lang, 'Register Group', '注册群组')}';
      if (jid) document.getElementById('group-jid').setAttribute('readonly', 'readonly');
      else document.getElementById('group-jid').removeAttribute('readonly');
      document.getElementById('group-modal').showModal();
    }
    
    function saveGroup() {
      const payload = {
        jid: document.getElementById('group-jid').value,
        name: document.getElementById('group-name').value,
        folder: document.getElementById('group-folder').value,
        trigger_pattern: document.getElementById('group-trigger').value,
        is_main: document.getElementById('group-ismain').checked,
        assistant_name: document.getElementById('group-assistant').value,
        bot_token: document.getElementById('group-token').value,
        model: document.getElementById('group-model').value
      };
      fetch('/cc/api/config/group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(res => res.json()).then(data => {
        if (data.success) location.reload();
        else alert('Failed: ' + data.error);
      });
    }
    </script>
    `;

    return html;
  }
}
