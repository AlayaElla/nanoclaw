import { Section, Lang, SECTIONS } from '../types.js';

const SECTION_ICONS: Record<Section, string> = {
  overview: '📊',
  agent: '🤖',
  tasks: '⏰',
  docs: '📁',
  usage: '📈',
  alerts: '🔔',
  settings: '⚙️',
  logger: '📝',
};
const LABELS_ZH: Record<Section, string> = {
  overview: '概览',
  agent: '智能体',
  tasks: '任务',
  docs: '文档',
  usage: '用量',
  alerts: '告警',
  settings: '设置',
  logger: '日志',
};
const LABELS_EN: Record<Section, string> = {
  overview: 'Overview',
  agent: 'Agent',
  tasks: 'Tasks',
  docs: 'Documents',
  usage: 'Usage',
  alerts: 'Alerts',
  settings: 'Settings',
  logger: 'Logger',
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
      --radius: 24px;
      --radius-sm: 12px;
      
      /* Typography Scale */
      --fs-xs: 11px;
      --fs-sm: 12px;
      --fs-base: 14px;
      --fs-md: 16px;
      --fs-lg: 18px;
      --fs-xl: 24px;
      --fs-2xl: 32px;
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
    
    /* Custom Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.25); }
    * { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.15) transparent; }
    
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
    .sidebar-title{font-size:var(--fs-lg);font-weight:700;padding:0 12px 24px;color:var(--text-main);letter-spacing:1px;text-transform:uppercase}
    
    .nav-item{display:flex;align-items:center;gap:12px;padding:12px 16px;color:var(--text-muted);font-size:var(--fs-base);font-weight:500;cursor:pointer;transition:all .3s ease;border-radius:14px;border:1px solid transparent;}
    .nav-item:hover{background:rgba(0,0,0,0.03);color:var(--text-main)}
    .nav-item.active{
      background: rgba(255,255,255,0.8);
      border: 1px solid rgba(0,0,0,0.05);
      color: var(--text-main);
      box-shadow: 0 4px 12px rgba(0,0,0,0.03);
    }
    .nav-item.active .nav-icon{opacity:1;color:var(--accent)}
    .nav-icon{font-size:var(--fs-lg);width:24px;text-align:center;opacity:0.7}
    
    .grid{display:grid;gap:20px;perspective:1200px}.grid-2{grid-template-columns:repeat(2,1fr)}.grid-3{grid-template-columns:repeat(3,1fr)}.grid-4{grid-template-columns:repeat(4,1fr)}
    
    @keyframes mainFadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    .main { padding: 40px; height: 100vh; overflow-y: auto; scroll-behavior: smooth; }
    .main.animate-in { animation: mainFadeIn 0.3s ease-out; }
    .page-header{margin-bottom:32px}.page-title{font-size:var(--fs-2xl);font-weight:700;letter-spacing:-1px}.page-subtitle{color:var(--text-muted);font-size:var(--fs-base);margin-top:6px}

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(15px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Standard Card (Light Glass + Interactive) */
    .card{
      background: var(--glass-bg);
      backdrop-filter: blur(32px) saturate(200%);
      -webkit-backdrop-filter: blur(32px) saturate(200%);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius);
      padding: 20px;
      box-shadow: 0 10px 20px rgba(0,0,0,0.03), inset 0 1px 1px #fff;
      position:relative;
      overflow:hidden;
      transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .app.animate-in .card, .app.animate-in .agent-card, .app.animate-in .nav-item {
      animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) backwards;
    }
    .card:hover { 
      transform: translateY(-6px); 
      border-color: #fff; 
      box-shadow: 0 20px 40px rgba(0,0,0,0.08), inset 0 1px 2px #fff; 
      background: rgba(255,255,255,0.7); 
    }
    
    .card-title{font-size:var(--fs-sm);color:var(--text-muted);font-weight:600;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px}
    .card-value{font-size:var(--fs-2xl);font-weight:800;letter-spacing:-1px;line-height:1;color:var(--text-main)}
    .card-detail{font-size:var(--fs-sm);color:var(--text-muted);margin-top:8px;font-weight:500}
    
    /* Pill badges */
    .badge{display:inline-flex;align-items:center;padding:6px 14px;border-radius:20px;font-size:var(--fs-sm);font-weight:600;gap:6px;border:1px solid rgba(0,0,0,0.03)}
    .badge-green{background:rgba(16,185,129,0.08);color:var(--green)}.badge-yellow{background:rgba(245,158,11,0.08);color:var(--yellow)}.badge-red{background:rgba(239,68,68,0.08);color:var(--red)}.badge-blue{background:rgba(59,130,246,0.08);color:var(--accent)}.badge-purple{background:rgba(139,92,246,0.08);color:var(--purple)}.badge-gray{background:rgba(0,0,0,0.04);color:var(--text-muted)}
    
    /* Tables */
    table{width:100%;border-collapse:separate;border-spacing:0;font-size:var(--fs-base)}
    th{text-align:left;padding:10px 16px;border-bottom:1px solid rgba(0,0,0,0.05);color:var(--text-muted);font-weight:600;font-size:var(--fs-sm);letter-spacing:0.3px}
    td{padding:12px 16px;border-bottom:1px solid rgba(0,0,0,0.02);line-height:1.4}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:rgba(0,0,0,0.01)}
    
    .empty-state{text-align:center;padding:48px;color:var(--text-muted);font-size:var(--fs-base)}
    .status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
    .status-dot.green{background:var(--green);box-shadow:0 0 10px rgba(16,185,129,0.3)}.status-dot.red{background:var(--red);box-shadow:0 0 10px rgba(239,68,68,0.3)}.status-dot.gray{background:rgba(0,0,0,0.1)}
    
    .section-group{margin-bottom:40px}.section-label{font-size:var(--fs-lg);font-weight:600;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid rgba(0,0,0,0.05);color:var(--text-main)}
    
    /* Buttons */
    .btn{padding:10px 20px;border-radius:var(--radius-sm);border:1px solid var(--glass-border);background:rgba(255,255,255,0.6);color:var(--text-main);cursor:pointer;font-size:var(--fs-base);font-weight:500;transition:all .3s cubic-bezier(0.16,1,0.3,1);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow: 0 2px 6px rgba(0,0,0,0.02), inset 0 1px 1px #fff}.btn:hover{background:#fff;transform:translateY(-2px);box-shadow:0 6px 12px rgba(0,0,0,0.06)}.btn:active{transform:scale(0.95);box-shadow:none}.btn-danger{color:var(--red);background:rgba(239,68,68,0.05)}.btn-primary{color:#fff;background:var(--accent);border-color:transparent;box-shadow:0 6px 16px var(--accent-glow), inset 0 1px 1px rgba(255,255,255,0.2)}
    
    /* Agent Grid */
    .agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 20px; align-items: start; }
    
    .agent-card { 
      background: var(--glass-bg); 
      backdrop-filter: blur(40px) saturate(200%); 
      -webkit-backdrop-filter: blur(40px) saturate(200%); 
      border: 1px solid var(--glass-border); 
      border-radius: var(--radius); 
      padding: 20px 24px; 
      display: flex; 
      flex-direction: column; 
      gap: 16px; 
      box-shadow: 0 10px 20px rgba(0,0,0,0.03), inset 0 1px 1px #fff; 
      position: relative; 
      transition: all 0.5s cubic-bezier(0.16, 1, 0.3, 1);
      overflow: hidden;
    }
    
    .app.animate-in .card:nth-child(1), .app.animate-in .agent-card:nth-child(1) { animation-delay: 0.05s; }
    .app.animate-in .card:nth-child(2), .app.animate-in .agent-card:nth-child(2) { animation-delay: 0.1s; }
    .app.animate-in .card:nth-child(3), .app.animate-in .agent-card:nth-child(3) { animation-delay: 0.15s; }
    .app.animate-in .card:nth-child(4), .app.animate-in .agent-card:nth-child(4) { animation-delay: 0.2s; }
    .app.animate-in .card:nth-child(5), .app.animate-in .agent-card:nth-child(5) { animation-delay: 0.25s; }
    .app.animate-in .card:nth-child(6), .app.animate-in .agent-card:nth-child(6) { animation-delay: 0.3s; }
    
    .agent-card:hover { 
      transform: translateY(-6px); 
      border-color: #fff; 
      box-shadow: 0 20px 40px rgba(0,0,0,0.08), inset 0 1px 2px #fff; 
      background: rgba(255,255,255,0.7); 
    }
    
    .agent-card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; z-index: 2; position: relative; }
    .agent-card-title { font-size: var(--fs-xl); font-weight: 700; letter-spacing: -0.5px; color: var(--text-main); }
    .agent-card-model { font-size: var(--fs-sm); color: var(--text-muted); margin-top: 2px; font-family: "SF Mono", Menlo, monospace; }
    .card-color-btn { background: none; border: none; cursor: pointer; font-size: var(--fs-md); padding: 4px; border-radius: 8px; transition: all 0.2s; opacity: 0.4; }
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
    @keyframes modal-in {
      from { opacity: 0; transform: translate(-50%, -46%) scale(0.96); }
      to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    @keyframes modal-out {
      from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      to { opacity: 0; transform: translate(-50%, -46%) scale(0.96); }
    }
    @keyframes backdrop-in { 
      from { opacity: 0; } 
      to { opacity: 1; } 
    }
    @keyframes backdrop-out { 
      from { opacity: 1; } 
      to { opacity: 0; } 
    }
    
    .agent-modal { border: 1px solid var(--glass-border); border-radius: var(--radius); background: var(--glass-bg); backdrop-filter: blur(40px) saturate(200%); -webkit-backdrop-filter: blur(40px) saturate(200%); padding: 0; max-width: 900px; width: 90vw; max-height: 80vh; box-shadow: 0 30px 80px rgba(0,0,0,0.15); overflow: hidden; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); margin: 0; will-change: transform, opacity; -webkit-backface-visibility: hidden; backface-visibility: hidden; }
    .agent-modal[open] { animation: modal-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
    .agent-modal.closing { animation: modal-out 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
    .agent-modal[open]::backdrop { animation: backdrop-in 0.35s ease forwards; }
    .agent-modal[open].closing::backdrop { animation: backdrop-out 0.25s ease forwards; }
    
    .agent-modal::backdrop { background: rgba(0,0,0,0.5); opacity: 1; }
    .agent-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid rgba(0,0,0,0.05); font-weight: 600; font-size: 15px; }
    .agent-modal-header .btn { padding: 4px 10px; font-size: 14px; min-width: auto; }
    .agent-modal-body { padding: 20px 24px; max-height: 60vh; overflow-y: auto; }

    /* Ethereal pastel glow orbs */
    .color-strip { position: absolute; top: -70px; right: -70px; width: 200px; height: 200px; border-radius: 50%; opacity: 0.35; filter: blur(60px); z-index: 0; pointer-events: none; }

    a{color:var(--accent);text-decoration:none}a:hover{opacity:0.8}
    .file-tree{font-family:"SF Mono",Menlo,monospace;font-size:13px}.file-tree-item{padding:6px 10px;display:flex;gap:10px;align-items:center;border-radius:8px;transition:background 0.2s}.file-tree-item:hover{background:rgba(0,0,0,0.02)}.file-icon{color:var(--text-muted);width:16px;text-align:center}

    @media(max-width:900px){
      .app{grid-template-columns:1fr;height:auto;}
      .main{padding:24px;padding-bottom:100px;}
      .sidebar{
        position:fixed;
        top:auto;
        bottom:0;
        left:0;
        width:100%;
        height:70px;
        display:flex;
        flex-direction:row;
        justify-content:space-around;
        align-items:center;
        padding:0 8px;
        border-right:none;
        border-top:1px solid rgba(255,255,255,0.4);
        background:var(--glass-bg);
        z-index:100;
        backdrop-filter: blur(30px) saturate(200%);
        -webkit-backdrop-filter: blur(30px) saturate(200%);
        box-shadow: 0 -10px 30px rgba(0,0,0,0.05);
      }
      .sidebar-title, .global-status{display:none}
      .nav-item{
        flex-direction:column;
        gap:4px;
        padding:8px 4px;
        font-size:var(--fs-xs);
        border-radius:12px;
        flex:1;
        text-align:center;
      }
      .nav-item.active{box-shadow:none;background:rgba(0,102,255,0.08);transform:translateY(-2px)}
      .nav-icon{font-size:var(--fs-xl);width:auto;margin:0 auto}
      .grid{gap:12px}
      .grid-2,.grid-3,.grid-4{grid-template-columns:repeat(2,1fr)}
      .grid-3.mobile-3col { grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .grid-4.mobile-4col { grid-template-columns: repeat(4,1fr); gap: 6px; }
      
      .grid-3.mobile-3col .card, .grid-4.mobile-4col .card { padding: 10px 4px; text-align: center; }
      .grid-3.mobile-3col .card-value { font-size: var(--fs-md); font-weight: 700; margin-bottom: 2px; }
      .grid-4.mobile-4col .card-value { font-size: var(--fs-base); font-weight: 700; margin-bottom: 2px; }
      .grid-3.mobile-3col .card-title, .grid-4.mobile-4col .card-title { font-size: var(--fs-xs); margin-bottom: 4px; }
      .grid-3.mobile-3col .card-detail, .grid-4.mobile-4col .card-detail { font-size: var(--fs-xs); margin-top: 2px; line-height: 1.1; opacity: 0.8; }
      
      .agent-grid{grid-template-columns: 1fr; gap: 16px}
      
      /* Responsive Tables for Mobile */
      table { display: block; width: 100%; border-collapse: collapse; overflow: hidden; }
      thead { display: none; }
      tbody { display: block; width: 100%; }
      tr { display: flex; flex-direction: column; background: rgba(0,0,0,0.02); border: 1px solid rgba(0,0,0,0.04); border-radius: var(--radius-sm); margin-bottom: 8px; padding: 8px 10px; align-items: stretch; }
      td { display: flex; align-items: flex-start; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid rgba(0,0,0,0.02); text-align: right; gap: 8px; }
      td:last-child { border-bottom: none; }
      td::before { content: attr(data-label); font-weight: 600; color: var(--text-muted); font-size: var(--fs-xs); text-align: left; flex-shrink: 0; padding-top: 1px;}
      td > * { text-align: right; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-sm); }
      
      .card { padding: 14px; border-radius: 16px; }
      .card-value { font-size: var(--fs-xl); }
      .card-title { font-size: var(--fs-xs); margin-bottom: 6px; }
      .card-detail { font-size: var(--fs-xs); margin-top: 6px; }
      .agent-card { padding: 16px; border-radius: 16px; gap: 12px; }
      .agent-card-title { font-size: var(--fs-lg); }
    }
    @media(max-width:600px){
      :root {
        --fs-2xl: 24px;
        --fs-xl: 20px;
        --fs-lg: 16px;
        --fs-md: 14px;
        --fs-base: 13px;
        --fs-sm: 11px;
        --fs-xs: 10px;
      }
      .main{padding:16px;padding-bottom:90px;}
      .grid-2,.grid-3,.grid-4{grid-template-columns:repeat(2,1fr)}
      .agent-grid{grid-template-columns: 1fr; gap:12px}
      .page-title { font-size: var(--fs-2xl); }
      .page-subtitle { font-size: var(--fs-base); margin-top: 4px; }
      .section-group { margin-bottom: 24px; }
      .section-label { font-size: var(--fs-md); margin-bottom: 12px; padding-bottom: 8px;}
    }`;
  }

  static render(section: Section, lang: Lang, body: string): string {
    const labels = lang === 'zh' ? LABELS_ZH : LABELS_EN;
    const nav = SECTIONS.map((s) => {
      const cls = s === section ? 'nav-item active' : 'nav-item';
      return `<a class="${cls}" href="/cc/?section=${s}&lang=${lang}"><span class="nav-icon">${SECTION_ICONS[s]}</span>${labels[s]}</a>`;
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
        <div style="font-size: var(--fs-xs); font-weight: 700; color: var(--text-muted); margin-bottom: 12px; text-transform: uppercase;">${lang === 'zh' ? '系统状态' : 'System Status'}</div>
        <div style="display:flex; align-items:center; gap: 8px; margin-bottom: 10px;">
          <span class="status-dot gray" id="status-nanoclaw"></span>
          <span style="font-size: var(--fs-base);">NanoClaw Core</span>
        </div>
        <div style="display:flex; align-items:center; gap: 8px;">
          <span class="status-dot gray" id="status-litellm"></span>
          <span style="font-size: var(--fs-base);">LiteLLM Proxy</span>
        </div>
      </div>
      <script>
        function closeModal(element) {
          const dialog = element.tagName === 'DIALOG' ? element : element.closest('dialog');
          if (!dialog) return;
          dialog.classList.add('closing');
          setTimeout(() => {
            dialog.classList.remove('closing');
            dialog.close();
          }, 240); // slightly before max animation ends
        }

        function checkSystemStatus() {
          fetch('/cc/health').then(res => {
            document.getElementById('status-nanoclaw').className = res.ok ? 'status-dot green' : 'status-dot red';
          }).catch(() => {
            document.getElementById('status-nanoclaw').className = 'status-dot red';
          });
          
          fetch('/cc/api/system/litellm-status').then(res => {
            document.getElementById('status-litellm').className = res.ok ? 'status-dot green' : 'status-dot red';
          }).catch(() => {
            document.getElementById('status-litellm').className = 'status-dot red';
          });
        }
        checkSystemStatus();
        setInterval(checkSystemStatus, 1000);

        // Global SPA Soft Navigation and Auto Refresh
        const autoRefreshSections = ['overview', 'agent', 'tasks', 'usage'];
        
        function updateDOM(oldNode, newNode) {
          if (!oldNode || !newNode) return;
          
          if (oldNode.tagName === 'DIALOG' && oldNode.open) {
            return;
          }

          if (oldNode.nodeType !== newNode.nodeType) {
            oldNode.replaceWith(newNode.cloneNode(true));
            return;
          }
          if (oldNode.nodeType === Node.TEXT_NODE) {
            if (oldNode.textContent !== newNode.textContent) {
              oldNode.textContent = newNode.textContent;
            }
            return;
          }
          if (oldNode.nodeType === Node.ELEMENT_NODE) {
            if (oldNode.tagName === 'SCRIPT') {
              if (oldNode.textContent !== newNode.textContent || oldNode.src !== newNode.src) {
                const newScript = document.createElement('script');
                Array.from(newNode.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
                newScript.textContent = newNode.textContent;
                oldNode.replaceWith(newScript);
              }
              return;
            }
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(oldNode.tagName) && document.activeElement === oldNode) {
              return;
            }
            if (oldNode.getAttribute('data-nomorph') === 'true' && newNode.getAttribute('data-nomorph') === 'true') {
              return;
            }
            const oldAttrs = oldNode.attributes;
            const newAttrs = newNode.attributes;
            for (let i = oldAttrs.length - 1; i >= 0; i--) {
              const name = oldAttrs[i].name;
              if (!newNode.hasAttribute(name)) {
                if ((oldNode.tagName === 'DIALOG' || oldNode.tagName === 'DETAILS') && name === 'open') continue;
                oldNode.removeAttribute(name);
              }
            }
            for (let i = 0; i < newAttrs.length; i++) {
              const name = newAttrs[i].name;
              const val = newAttrs[i].value;
              if (oldNode.getAttribute(name) !== val) {
                oldNode.setAttribute(name, val);
              }
            }
            const oldChildren = Array.from(oldNode.childNodes);
            const newChildren = Array.from(newNode.childNodes);
            const max = Math.max(oldChildren.length, newChildren.length);
            for (let i = 0; i < max; i++) {
              if (i >= oldChildren.length) {
                oldNode.appendChild(newChildren[i].cloneNode(true));
              } else if (i >= newChildren.length) {
                oldNode.removeChild(oldChildren[i]);
              } else {
                updateDOM(oldChildren[i], newChildren[i]);
              }
            }
          }
        }

        function fetchAndMerge(url) {
          fetch(url).then(r => r.text()).then(html => {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const newMain = doc.querySelector('.main');
            const oldMain = document.querySelector('.main');
            if (newMain && oldMain) {
              updateDOM(oldMain, newMain);
              const activeSection = new URLSearchParams(location.search).get('section') || 'overview';
              if (activeSection === 'agent') {
                const cardColors = ['#58a6ff','#3fb950','#d29922','#bc8cff','#db6d28','#f778ba','#79c0ff','#7ee787'];
                document.querySelectorAll('.agent-card').forEach(card => {
                  const name = card.dataset.agent;
                  const idx = localStorage.getItem('card-color-' + name);
                  if (idx !== null) {
                    const strip = card.querySelector('.color-strip');
                    if (strip) strip.style.background = cardColors[parseInt(idx, 10)] || cardColors[0];
                  }
                });
              }
            }
          }).catch(() => {});
        }

        window.nanoSoftNavigate = function(url, push = true) {
          if (push) history.pushState(null, '', url);
          fetchAndMerge(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now());
          const hash = url.split('#')[1];
          if (hash) {
            setTimeout(function() {
              var target = document.getElementById(hash);
              var main = document.querySelector('.main');
              if (target && main) {
                main.scrollTo({ top: target.offsetTop - 24, behavior: 'auto' });
              }
            }, 100);
          }
        };

        setInterval(() => {
          const currentSection = new URLSearchParams(location.search).get('section') || 'overview';
          if (autoRefreshSections.includes(currentSection)) {
            fetchAndMerge(location.href + (location.href.includes('?') ? '&' : '?') + 't=' + Date.now());
          }
        }, 1000);

        window._currentSectOnLoad = new URLSearchParams(window.location.search).get('section') || 'overview';

        document.addEventListener('click', function(e) {
          const a = e.target.closest('a');
          if (a && a.href && a.href.startsWith(window.location.origin) && !a.hasAttribute('download') && a.getAttribute('target') !== '_blank') {
            const nextSect = new URL(a.href).searchParams.get('section') || 'overview';
            if (window._currentSectOnLoad === nextSect) {
              e.preventDefault();
              window.nanoSoftNavigate(a.href);
            }
            // Otherwise, let the browser naturally navigate to the new section
          }
        });

        window.addEventListener('popstate', function() {
          const nextSect = new URLSearchParams(window.location.search).get('section') || 'overview';
          if (window._currentSectOnLoad === nextSect) {
            window.nanoSoftNavigate(window.location.href, false);
          } else {
            window.location.reload();
          }
        });
      </script>
    </nav>
    <div class="main">
      ${body}
    </div>
    <script>
      (function() {
        var currentSection = new URLSearchParams(window.location.search).get('section') || 'overview';
        var lastSection = sessionStorage.getItem('nano_last_section');
        if (lastSection !== currentSection) {
          document.querySelector('.app').classList.add('animate-in');
          sessionStorage.setItem('nano_last_section', currentSection);
        }
        
        // Handle custom scroll area hash jumps
        if (window.location.hash) {
          setTimeout(function() {
            var target = document.querySelector(window.location.hash);
            var main = document.querySelector('.main');
            if (target && main) {
              main.scrollTo({ top: target.offsetTop - 24, behavior: 'instant' });
            }
          }, 10);
        }
      })();
    </script>
  </div>
</body>
</html>`;
  }
}
