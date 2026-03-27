import { Page, t, esc, pageHeader } from '../utils.js';
import { Lang } from '../types.js';
import { getLiteLLMModels, getNanoClawEnv } from '../data.js';
import { getFullStatus } from '../../status.js';

export class SettingsPage extends Page<any> {
  render(_: any, lang: Lang): string {
    const status = getFullStatus();
    const models = getLiteLLMModels();
    const envVars = getNanoClawEnv();
    let html = pageHeader(
      t(lang, 'Settings', '设置'),
      t(
        lang,
        'System configuration and service management',
        '系统配置与服务管理',
      ),
    );
    if (status) {
      html += `<div class="section-group"><div class="section-label">${t(lang, 'System Information', '系统信息')}</div><div class="grid grid-3">`;
      html += `<div class="card"><div class="card-title">Node.js</div><div class="card-value" style="font-size:18px">${esc(status.system.nodeVersion)}</div><div class="card-detail">${esc(status.system.platform)} / ${esc(status.system.arch)}</div></div>`;
      html += `<div class="card"><div class="card-title">${t(lang, 'Container Image', '容器镜像')}</div><div class="card-value" style="font-size:14px;word-break:break-all">${esc(status.system.containerImage)}</div></div>`;
      html += `<div class="card"><div class="card-title">${t(lang, 'Max Containers', '最大容器')}</div><div class="card-value">${status.system.maxConcurrentContainers}</div><div class="card-detail">${t(lang, 'Timezone', '时区')}: ${esc(status.system.timezone)}</div></div>`;
      html += `</div></div>`;
    }
    html += `<div class="section-group"><div class="section-label">${t(lang, 'LiteLLM Models', 'LiteLLM 模型')}</div><div class="card"><table><thead><tr><th>${t(lang, 'Model Name', '模型名')}</th><th>${t(lang, 'Backend', '后端')}</th><th>${t(lang, 'API Base', 'API 地址')}</th></tr></thead><tbody>`;
    for (const m of models)
      html += `<tr><td><span class="badge badge-purple">${esc(m.model_name)}</span></td><td style="font-size:12px">${esc(m.model || '—')}</td><td style="font-size:12px;color:var(--muted)">${esc(m.api_base || '—')}</td></tr>`;
    if (models.length === 0)
      html += `<tr><td colspan="3" class="empty-state">${t(lang, 'No models configured', '未配置模型')}</td></tr>`;
    html += `</tbody></table></div>`;
    html += `<div style="margin-top:12px;display:flex;gap:8px"><form method="POST" action="/?action=litellm-restart&lang=${lang}" style="display:inline"><button class="btn btn-primary" type="submit" onclick="return confirm('${t(lang, 'Restart LiteLLM?', '确定重启 LiteLLM？')}')">${t(lang, 'Restart LiteLLM', '重启 LiteLLM')}</button></form><form method="POST" action="/?action=litellm-stop&lang=${lang}" style="display:inline"><button class="btn btn-danger" type="submit" onclick="return confirm('${t(lang, 'Stop LiteLLM?', '确定停止 LiteLLM？')}')">${t(lang, 'Stop LiteLLM', '停止 LiteLLM')}</button></form></div></div>`;
    html += `<div class="section-group"><div class="section-label">${t(lang, 'Environment (.env)', '环境变量 (.env)')}</div><div class="card"><table><thead><tr><th>${t(lang, 'Key', '键')}</th><th>${t(lang, 'Value', '值')}</th></tr></thead><tbody>`;
    for (const v of envVars)
      html += `<tr><td style="font-family:monospace;font-size:12px">${esc(v.key)}</td><td style="font-size:12px">${esc(v.value)}</td></tr>`;
    html += `</tbody></table></div></div>`;
    return html;
  }
}
