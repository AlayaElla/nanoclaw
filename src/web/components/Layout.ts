import { Section, Lang, SECTIONS } from '../types.js';

const SECTION_ICONS: Record<Section, string> = {
  overview: '📊',
  usage: '📈',
  staff: '🤖',
  memory: '💬',
  docs: '📁',
  tasks: '⏰',
  alerts: '🔔',
  replay: '🔄',
  settings: '⚙️',
};
const LABELS_ZH: Record<Section, string> = {
  overview: '概览',
  usage: '用量',
  staff: '员工',
  memory: '记忆',
  docs: '文档',
  tasks: '任务',
  alerts: '告警',
  replay: '回放与审计',
  settings: '设置',
};
const LABELS_EN: Record<Section, string> = {
  overview: 'Overview',
  usage: 'Usage',
  staff: 'Staff',
  memory: 'Memory',
  docs: 'Documents',
  tasks: 'Tasks',
  alerts: 'Alerts',
  replay: 'Replay & Audit',
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
    
    /* Staff Grid (Ultra Deep Light Glassmorphism) */
    .staff-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; perspective: 1200px; }
    
    .staff-card { 
      background: var(--glass-bg); 
      backdrop-filter: blur(40px) saturate(200%); 
      -webkit-backdrop-filter: blur(40px) saturate(200%); 
      border: 1px solid var(--glass-border); 
      border-radius: var(--radius); 
      padding: 24px 28px; 
      display: flex; 
      flex-direction: column; 
      gap: 20px; 
      box-shadow: 0 10px 20px rgba(0,0,0,0.03), inset 0 1px 1px #fff; 
      position: relative; 
      transition: all 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      overflow: hidden;
      animation: float 8s ease-in-out infinite;
    }
    
    .staff-grid .staff-card:nth-child(2n) { animation-delay: -1.5s; }
    .staff-grid .staff-card:nth-child(3n) { animation-delay: -4s; }

    .staff-card:hover { 
      animation-play-state: paused;
      transform: translateY(-12px) rotateX(5deg) rotateY(-3deg); 
      border-color: #fff; 
      box-shadow: 0 30px 60px rgba(0,0,0,0.08), inset 0 1px 2px #fff; 
      background: rgba(255,255,255,0.7); 
    }
    
    .staff-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 4px; z-index: 2; position: relative; }
    .staff-card-title { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; color: var(--text-main); }
    .staff-card-desc { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
    
    .staff-info-row { display: flex; flex-direction: column; gap: 8px; z-index: 2; position: relative; }
    .staff-info-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }
    .staff-info-value { font-size: 14px; font-weight: 500; color: var(--text-main); line-height: 1.5; }
    
    .staff-info-output { 
      font-family: "SF Mono", Menlo, monospace; 
      font-size: 12px; 
      background: rgba(0,0,0,0.03); 
      border-radius: 12px; 
      border: 1px solid rgba(0,0,0,0.01); 
      color: var(--text-muted); 
      padding: 14px; 
      box-shadow: inset 0 2px 4px rgba(0,0,0,0.02); 
      line-height: 1.6; 
      z-index: 2; 
      position: relative;
    }
    .staff-card-status { align-self: flex-start; z-index: 2; position: relative; }
    
    /* Ethereal pastel glow orbs */
    .color-strip { 
      position: absolute; 
      top: -70px; 
      right: -70px; 
      width: 200px; 
      height: 200px; 
      border-radius: 50%; 
      opacity: 0.35; 
      filter: blur(60px); 
      z-index: 0; 
      pointer-events: none; 
    }
    
    a{color:var(--accent);text-decoration:none}a:hover{opacity:0.8}
    .file-tree{font-family:"SF Mono",Menlo,monospace;font-size:13px}.file-tree-item{padding:6px 10px;display:flex;gap:10px;align-items:center;border-radius:8px;transition:background 0.2s}.file-tree-item:hover{background:rgba(0,0,0,0.02)}.file-icon{color:var(--text-muted);width:16px;text-align:center}
    .msg-bubble{padding:12px 16px;border-radius:18px;margin-bottom:8px;max-width:75%;font-size:14px;line-height:1.5;box-shadow:0 4px 12px rgba(0,0,0,0.02)}.msg-user{background:var(--accent);color:#fff;margin-left:auto;border-bottom-right-radius:4px}.msg-bot{background:rgba(255,255,255,0.8);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid var(--glass-border);border-bottom-left-radius:4px}.msg-meta{font-size:11px;color:var(--text-muted);margin-bottom:6px;padding:0 6px}

    @media(max-width:900px){
      .app{grid-template-columns:1fr;height:auto}
      .sidebar{position:static;height:auto;display:flex;flex-direction:row;overflow-x:auto;padding:16px;border-right:none;border-bottom:1px solid rgba(0,0,0,0.05);gap:8px}
      .sidebar-title{display:none}
      .nav-item{padding:8px 16px;margin:0;border-radius:20px;white-space:nowrap}
      .grid-3,.grid-4,.staff-grid{grid-template-columns:repeat(2,1fr)}
    }
    @media(max-width:600px){
      .grid-2,.grid-3,.grid-4,.staff-grid{grid-template-columns:1fr}
      .main{padding:20px}
    }`;
  }

  static render(section: Section, lang: Lang, body: string): string {
    const labels = lang === 'zh' ? LABELS_ZH : LABELS_EN;
    const nav = SECTIONS.map((s) => {
      const cls = s === section ? 'nav-item active' : 'nav-item';
      return `<a class="${cls}" href="/?section=${s}&lang=${lang}"><span class="nav-icon">${SECTION_ICONS[s]}</span>${labels[s]}</a>`;
    }).join('');

    const langSwitch =
      lang === 'zh'
        ? `<a class="nav-item" href="/?section=${section}&lang=en"><span class="nav-icon">🌐</span>English</a>`
        : `<a class="nav-item" href="/?section=${section}&lang=zh"><span class="nav-icon">🌐</span>中文</a>`;

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
      ${langSwitch}
    </nav>
    <div class="main">
      ${body}
    </div>
  </div>
</body>
</html>`;
  }
}
