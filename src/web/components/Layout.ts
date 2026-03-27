import { Section, Lang, SECTIONS } from '../types.js';

const SECTION_ICONS: Record<Section, string> = {
  overview: '📊',
  agent: '🤖',
  tasks: '⏰',
  docs: '📁',
  usage: '📈',
  alerts: '🔔',
  settings: '⚙️',
};
const LABELS_ZH: Record<Section, string> = {
  overview: '概览',
  agent: 'Agent',
  tasks: '任务',
  docs: '文档',
  usage: '用量',
  alerts: '告警',
  settings: '设置',
};
const LABELS_EN: Record<Section, string> = {
  overview: 'Overview',
  agent: 'Agent',
  tasks: 'Tasks',
  docs: 'Documents',
  usage: 'Usage',
  alerts: 'Alerts',
  settings: 'Settings',
};

export class Layout {
  static renderCss(): string {
    return `
    :root{
      --bg-color: #F8FAFC;
      --glass-bg: rgba(255, 255, 255, 0.45);
      --glass-border: rgba(255, 255, 255, 0.8);
      --glass-highlight: rgba(255, 255, 255, 0.6);
      --text-main: rgba(15, 23, 42, 0.9);
      --text-muted: rgba(71, 85, 105, 0.7);
      --accent: #0066FF;
      --accent-glow: rgba(0, 102, 255, 0.2);
      --green: #10b981;
      --yellow: #f59e0b;
      --red: #ef4444;
      --purple: #8b5cf6;
      --radius: 20px;
      --radius-sm: 12px;
    }
    *{box-sizing:border-box;margin:0;padding:0;font-family:"Inter",-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
    body{
      background-color: var(--bg-color);
      /* Light, ethereal mesh gradient background */
      background-image: 
        radial-gradient(at 0% 0%, rgba(59,130,246,0.15) 0px, transparent 50%),
        radial-gradient(at 100% 0%, rgba(139,92,246,0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(16,185,129,0.1) 0px, transparent 50%),
        radial-gradient(at 0% 100%, rgba(239,68,68,0.1) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text-main);
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 0;
    }
    
    .app{
      width: 100%;
      height: 100vh;
      display: grid;
      grid-template-columns: 260px minmax(0,1fr);
      position: relative;
    }
    
    .sidebar{
      background: rgba(255, 255, 255, 0.4);
      backdrop-filter: blur(40px) saturate(180%);
      -webkit-backdrop-filter: blur(40px) saturate(180%);
      border-right: 1px solid rgba(0,0,0,0.05);
      padding: 32px 20px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .sidebar-title{font-size:18px;font-weight:700;padding:0 12px 24px;color:var(--text-main);letter-spacing:1px;text-transform:uppercase}
    
    .nav-item{display:flex;align-items:center;gap:12px;padding:12px 16px;color:var(--text-muted);font-size:14px;font-weight:500;cursor:pointer;transition:all .3s ease;border-radius:14px;border:1px solid transparent}
    .nav-item:hover{background:rgba(0,0,0,0.03);color:var(--text-main)}
    .nav-item.active{
      background: rgba(255,255,255,0.8);
      border: 1px solid rgba(0,0,0,0.05);
      color: var(--text-main);
      box-shadow: 0 4px 12px rgba(0,0,0,0.03);
    }
    .nav-item.active .nav-icon{opacity:1;color:var(--accent)}
    .nav-icon{font-size:18px;width:24px;text-align:center;opacity:0.7}
    
    .main{padding:48px;height:100vh;overflow-y:auto;}
    .page-header{margin-bottom:40px}.page-title{font-size:32px;font-weight:700;letter-spacing:-1px}.page-subtitle{color:var(--text-muted);font-size:15px;margin-top:8px}
    
    .grid{display:grid;gap:24px;perspective:1200px}.grid-2{grid-template-columns:repeat(2,1fr)}.grid-3{grid-template-columns:repeat(3,1fr)}.grid-4{grid-template-columns:repeat(4,1fr)}
    
    @keyframes float {
      0% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
      100% { transform: translateY(0px); }
    }

    /* Standard Card (Light Glass + Interactive) */
    .card{
      background: var(--glass-bg);
      backdrop-filter: blur(32px) saturate(200%);
      -webkit-backdrop-filter: blur(32px) saturate(200%);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius);
      padding: 24px;
      box-shadow: 0 10px 20px rgba(0,0,0,0.03), inset 0 1px 1px #fff;
      position:relative;
      overflow:hidden;
      transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      animation: float 8s ease-in-out infinite;
    }
    .grid > .card:nth-child(2n) { animation-delay: -1.5s; }
    .grid > .card:nth-child(3n) { animation-delay: -4s; }

    .card:hover { 
      animation-play-state: paused;
      transform: translateY(-12px) rotateX(5deg) rotateY(-3deg); 
      border-color: #fff; 
      box-shadow: 0 30px 60px rgba(0,0,0,0.08), inset 0 1px 2px #fff; 
      background: rgba(255,255,255,0.7); 
    }
    .card-title{font-size:14px;color:var(--text-muted);font-weight:500;margin-bottom:12px}
    .card-value{font-size:36px;font-weight:700;letter-spacing:-1px;line-height:1;color:var(--text-main)}
    .card-detail{font-size:13px;color:var(--text-muted);margin-top:10px}
    
    /* Pill badges */
    .badge{display:inline-flex;align-items:center;padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;gap:6px;border:1px solid rgba(0,0,0,0.03)}
    .badge-green{background:rgba(16,185,129,0.08);color:var(--green)}.badge-yellow{background:rgba(245,158,11,0.08);color:var(--yellow)}.badge-red{background:rgba(239,68,68,0.08);color:var(--red)}.badge-blue{background:rgba(59,130,246,0.08);color:var(--accent)}.badge-purple{background:rgba(139,92,246,0.08);color:var(--purple)}.badge-gray{background:rgba(0,0,0,0.04);color:var(--text-muted)}
    
    /* Tables */
    table{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}
    th{text-align:left;padding:12px 16px;border-bottom:1px solid rgba(0,0,0,0.05);color:var(--text-muted);font-weight:500;font-size:13px}
    td{padding:16px;border-bottom:1px solid rgba(0,0,0,0.02)}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:rgba(0,0,0,0.01)}
    
    .empty-state{text-align:center;padding:48px;color:var(--text-muted);font-size:15px}
    .status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
    .status-dot.green{background:var(--green);box-shadow:0 0 10px rgba(16,185,129,0.3)}.status-dot.red{background:var(--red);box-shadow:0 0 10px rgba(239,68,68,0.3)}.status-dot.gray{background:rgba(0,0,0,0.1)}
    
    .section-group{margin-bottom:40px}.section-label{font-size:18px;font-weight:600;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid rgba(0,0,0,0.05);color:var(--text-main)}
    
    /* Buttons */
    .btn{padding:10px 20px;border-radius:var(--radius-sm);border:1px solid var(--glass-border);background:rgba(255,255,255,0.6);color:var(--text-main);cursor:pointer;font-size:14px;font-weight:500;transition:all .3s;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow: 0 2px 6px rgba(0,0,0,0.02), inset 0 1px 1px #fff}.btn:hover{background:#fff;transform:translateY(-1px)}.btn-danger{color:var(--red);background:rgba(239,68,68,0.05)}.btn-primary{color:#fff;background:var(--accent);border-color:transparent;box-shadow:0 6px 16px var(--accent-glow), inset 0 1px 1px rgba(255,255,255,0.2)}
    
    /* Agent Grid */
    .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 24px; align-items: start; }
    
    .agent-card { 
      background: var(--glass-bg); 
      backdrop-filter: blur(40px) saturate(200%); 
      -webkit-backdrop-filter: blur(40px) saturate(200%); 
      border: 1px solid var(--glass-border); 
      border-radius: var(--radius); 
      padding: 24px 28px; 
      display: flex; 
      flex-direction: column; 
      gap: 16px; 
      box-shadow: 0 10px 20px rgba(0,0,0,0.03), inset 0 1px 1px #fff; 
      position: relative; 
      transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      overflow: hidden;
      animation: float 8s ease-in-out infinite;
    }
    
    .agent-grid .agent-card:nth-child(2n) { animation-delay: -1.5s; }
    .agent-grid .agent-card:nth-child(3n) { animation-delay: -4s; }

    .agent-card:hover { 
      animation-play-state: paused;
      transform: translateY(-8px) rotateX(3deg) rotateY(-2deg); 
      border-color: #fff; 
      box-shadow: 0 30px 60px rgba(0,0,0,0.08), inset 0 1px 2px #fff; 
      background: rgba(255,255,255,0.7); 
    }
    
    .agent-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; z-index: 2; position: relative; }
    .agent-card-title { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; color: var(--text-main); }
    .agent-card-model { font-size: 12px; color: var(--text-muted); margin-top: 2px; font-family: "SF Mono", Menlo, monospace; }
    .card-color-btn { background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px; border-radius: 8px; transition: all 0.2s; opacity: 0.4; }
    .card-color-btn:hover { opacity: 1; transform: scale(1.2); }
    
    /* Agent Groups */
    .agent-groups { display: flex; flex-direction: column; gap: 12px; z-index: 2; position: relative; }
    .agent-group-section { 
      background: rgba(0,0,0,0.02); 
      border: 1px solid rgba(0,0,0,0.04); 
      border-radius: var(--radius-sm); 
      padding: 14px 16px; 
      display: flex; 
      flex-direction: column; 
      gap: 10px; 
    }
    .agent-group-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .agent-group-name { font-size: 14px; font-weight: 600; color: var(--text-main); }
    .agent-group-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .agent-modal-btn { padding: 6px 14px; font-size: 12px; border-radius: 10px; }

    /* SDK Tasks */
    .agent-sdk-tasks { display: flex; flex-wrap: wrap; gap: 6px; }

    /* Todo list */
    .agent-todo-list { padding: 8px 0; }
    .agent-todo-item { font-size: 13px; padding: 3px 0; line-height: 1.5; color: var(--text-main); }

    /* Audit steps */
    .audit-steps { display: flex; flex-direction: column; gap: 0; }
    .audit-step { 
      border-bottom: 1px solid rgba(0,0,0,0.04); 
      transition: background 0.15s;
    }
    .audit-step:hover, .audit-step-inline:hover { background: rgba(0,0,0,0.015); }
    .audit-step summary { 
      display: grid; 
      grid-template-columns: 130px 80px 1fr; 
      align-items: center; 
      gap: 10px; 
      padding: 8px 12px; 
      cursor: pointer; 
      list-style: none;
      font-size: 12px;
    }
    .audit-step summary::-webkit-details-marker { display: none; }
    .audit-step summary::after { 
      content: '▾'; 
      font-size: 10px; 
      color: var(--text-muted); 
      transition: transform 0.2s; 
      grid-column: -1;
      justify-self: end;
    }
    .audit-step:not([open]) summary::after { transform: rotate(-90deg); }
    .audit-step-inline { 
      display: grid; 
      grid-template-columns: 130px 80px 1fr; 
      align-items: center; 
      gap: 10px; 
      padding: 8px 12px; 
      font-size: 12px; 
      border-bottom: 1px solid rgba(0,0,0,0.04);
      transition: background 0.15s;
    }
    .audit-ts { 
      font-family: "SF Mono", Menlo, monospace;
      font-size: 10px; 
      color: var(--text-muted); 
      white-space: nowrap; 
    }
    .audit-preview { 
      font-family: "SF Mono", Menlo, monospace; 
      font-size: 11px; 
      color: var(--text-main); 
      overflow: hidden; 
      text-overflow: ellipsis; 
      white-space: nowrap; 
      min-width: 0;
    }
    .audit-full { 
      font-family: "SF Mono", Menlo, monospace; 
      font-size: 11px; 
      background: rgba(0,0,0,0.025); 
      border-radius: 10px; 
      padding: 12px 14px; 
      margin: 4px 12px 10px 12px; 
      white-space: pre-wrap; 
      word-break: break-word; 
      max-height: 260px; 
      overflow-y: auto; 
      color: var(--text-muted); 
      line-height: 1.6; 
      border: 1px solid rgba(0,0,0,0.03);
    }

    /* Messages */
    .msg-list { display: flex; flex-direction: column; gap: 12px; }
    .msg-item { display: flex; flex-direction: column; gap: 4px; }
    .msg-meta { 
      font-size: 11px; 
      color: var(--text-muted); 
      padding: 0 4px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .msg-bubble { 
      padding: 10px 16px; 
      border-radius: 16px; 
      max-width: 85%; 
      font-size: 13px; 
      line-height: 1.6; 
      word-break: break-word;
    }
    .msg-user { 
      background: var(--accent); 
      color: #fff; 
      align-self: flex-end;
      border-bottom-right-radius: 4px; 
      box-shadow: 0 2px 8px rgba(0,122,255,0.15);
    }
    .msg-bot { 
      background: rgba(255,255,255,0.85); 
      backdrop-filter: blur(20px); 
      -webkit-backdrop-filter: blur(20px); 
      border: 1px solid var(--glass-border); 
      align-self: flex-start;
      border-bottom-left-radius: 4px; 
      box-shadow: 0 2px 6px rgba(0,0,0,0.03);
    }

    /* CLAUDE.md collapsible */
    .agent-claude-md { z-index: 2; position: relative; }
    .agent-claude-md summary { font-size: 12px; color: var(--text-muted); cursor: pointer; padding: 8px 0; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; user-select: none; }
    .agent-claude-md summary:hover { color: var(--text-main); }
    .agent-claude-content { font-family: "SF Mono", Menlo, monospace; font-size: 11px; background: rgba(0,0,0,0.03); border-radius: 12px; border: 1px solid rgba(0,0,0,0.01); color: var(--text-muted); padding: 14px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; line-height: 1.6; }

    /* Modal Dialog */
    .agent-modal { border: none; border-radius: var(--radius); background: var(--glass-bg); backdrop-filter: blur(40px) saturate(200%); -webkit-backdrop-filter: blur(40px) saturate(200%); padding: 0; max-width: 900px; width: 90vw; max-height: 80vh; box-shadow: 0 30px 80px rgba(0,0,0,0.15); overflow: hidden; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); margin: 0; }
    .agent-modal::backdrop { background: rgba(0,0,0,0.3); backdrop-filter: blur(4px); }
    .agent-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid rgba(0,0,0,0.05); font-weight: 600; font-size: 15px; }
    .agent-modal-header .btn { padding: 4px 10px; font-size: 14px; min-width: auto; }
    .agent-modal-body { padding: 20px 24px; max-height: 60vh; overflow-y: auto; }

    /* Ethereal pastel glow orbs */
    .color-strip { position: absolute; top: -70px; right: -70px; width: 200px; height: 200px; border-radius: 50%; opacity: 0.35; filter: blur(60px); z-index: 0; pointer-events: none; }

    a{color:var(--accent);text-decoration:none}a:hover{opacity:0.8}
    .file-tree{font-family:"SF Mono",Menlo,monospace;font-size:13px}.file-tree-item{padding:6px 10px;display:flex;gap:10px;align-items:center;border-radius:8px;transition:background 0.2s}.file-tree-item:hover{background:rgba(0,0,0,0.02)}.file-icon{color:var(--text-muted);width:16px;text-align:center}

    @media(max-width:900px){
      .app{grid-template-columns:1fr;height:auto}
      .sidebar{position:static;height:auto;display:flex;flex-direction:row;overflow-x:auto;padding:16px;border-right:none;border-bottom:1px solid rgba(0,0,0,0.05);gap:8px}
      .sidebar-title{display:none}
      .nav-item{padding:8px 16px;margin:0;border-radius:20px;white-space:nowrap}
      .grid-3,.grid-4,.agent-grid{grid-template-columns:repeat(2,1fr)}
    }
    @media(max-width:600px){
      .grid-2,.grid-3,.grid-4,.agent-grid{grid-template-columns:1fr}
      .main{padding:20px}
    }`;
  }

  static render(section: Section, lang: Lang, body: string): string {
    const labels = lang === 'zh' ? LABELS_ZH : LABELS_EN;
    const nav = SECTIONS.map((s) => {
      const cls = s === section ? 'nav-item active' : 'nav-item';
      return `<a class="${cls}" href="/?section=${s}&lang=${lang}"><span class="nav-icon">${SECTION_ICONS[s]}</span>${labels[s]}</a>`;
    }).join('');

    return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NanoClaw Control Center</title>
  <style>${Layout.renderCss()}</style>
</head>
<body>
  <div class="app">
    <nav class="sidebar">
      <div class="sidebar-title">🦀 NanoClaw CC</div>
      ${nav}
      <div style="flex:1"></div>
      <div class="global-status" style="padding: 16px; border-top: 1px solid rgba(0,0,0,0.05); margin-top: auto;">
        <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); margin-bottom: 12px; text-transform: uppercase;">${lang === 'zh' ? '系统状态' : 'System Status'}</div>
        <div style="display:flex; align-items:center; gap: 8px; margin-bottom: 10px;">
          <span class="status-dot gray" id="status-nanoclaw"></span>
          <span style="font-size: 13px;">NanoClaw Core</span>
        </div>
        <div style="display:flex; align-items:center; gap: 8px;">
          <span class="status-dot gray" id="status-litellm"></span>
          <span style="font-size: 13px;">LiteLLM Proxy</span>
        </div>
      </div>
      <script>
        function checkSystemStatus() {
          fetch('/health').then(res => {
            document.getElementById('status-nanoclaw').className = res.ok ? 'status-dot green' : 'status-dot red';
          }).catch(() => {
            document.getElementById('status-nanoclaw').className = 'status-dot red';
          });
          
          fetch('/api/system/litellm-status').then(res => {
            document.getElementById('status-litellm').className = res.ok ? 'status-dot green' : 'status-dot red';
          }).catch(() => {
            document.getElementById('status-litellm').className = 'status-dot red';
          });
        }
        checkSystemStatus();
        setInterval(checkSystemStatus, 5000);
      </script>
    </nav>
    <div class="main">
      ${body}
    </div>
  </div>
</body>
</html>`;
  }
}
