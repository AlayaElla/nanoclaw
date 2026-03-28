export class LoginPage {
  render(lang: 'en' | 'zh'): string {
    const isZh = lang === 'zh';
    return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NanoClaw Control Center - ${isZh ? '登陆' : 'Login'}</title>
  <style>
    :root {
      --bg-color: #F8FAFC;
      --glass-bg: rgba(255, 255, 255, 0.45);
      --glass-border: rgba(255, 255, 255, 0.8);
      --text-main: rgba(15, 23, 42, 0.9);
      --text-muted: rgba(71, 85, 105, 0.7);
      --accent: #0066FF;
      --radius: 24px;
      --radius-sm: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: "Inter", -apple-system, sans-serif; }
    body {
      background-color: var(--bg-color);
      background-image: 
        radial-gradient(at 0% 0%, rgba(59,130,246,0.15) 0px, transparent 50%),
        radial-gradient(at 100% 0%, rgba(139,92,246,0.15) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(16,185,129,0.1) 0px, transparent 50%),
        radial-gradient(at 0% 100%, rgba(239,68,68,0.1) 0px, transparent 50%);
      color: var(--text-main);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .login-card {
      background: var(--glass-bg);
      backdrop-filter: blur(40px) saturate(200%);
      -webkit-backdrop-filter: blur(40px) saturate(200%);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius);
      padding: 40px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 30px 60px rgba(0,0,0,0.1), inset 0 1px 1px #fff;
      text-align: center;
      animation: fadeUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .title { font-size: 28px; font-weight: 700; margin-bottom: 8px; letter-spacing: -1px; }
    .subtitle { font-size: 14px; color: var(--text-muted); margin-bottom: 32px; }
    
    .input-group { margin-bottom: 24px; text-align: left; }
    .input-group label { display: block; font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .input-group input {
      width: 100%;
      background: rgba(255,255,255,0.6);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-sm);
      padding: 14px 16px;
      color: var(--text-main);
      font-size: 16px;
      outline: none;
      transition: all 0.2s;
      box-shadow: 0 2px 6px rgba(0,0,0,0.02), inset 0 1px 1px #fff;
    }
    .input-group input:focus { border-color: var(--accent); background: #fff; box-shadow: 0 0 0 3px rgba(0, 102, 255, 0.2); }
    
    .btn {
      width: 100%;
      padding: 14px;
      border-radius: var(--radius-sm);
      border: none;
      background: var(--accent);
      color: #fff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s;
      box-shadow: 0 6px 16px rgba(0, 102, 255, 0.3);
    }
    .btn:hover { background: #1a75ff; transform: translateY(-2px); box-shadow: 0 10px 20px rgba(0, 102, 255, 0.4); }
    .btn:active { transform: scale(0.98); }
    
    .error { color: #ef4444; font-size: 13px; margin-top: 16px; min-height: 20px; font-weight: 500;}
  </style>
</head>
<body>
  <div class="login-card">
    <div style="font-size: 48px; margin-bottom: 16px;">🦀</div>
    <div class="title">${isZh ? '登陆' : 'Login'}</div>
    <div class="subtitle">${isZh ? '控制中心安全网关' : 'Control Center Secure Gateway'}</div>
    
    <div class="input-group">
      <label>${isZh ? '访问令牌 (Auth Token)' : 'Access Token'}</label>
      <input type="password" id="token" placeholder="••••••••••••••••" autofocus>
    </div>
    
    <button class="btn" id="login-btn" onclick="login()">${isZh ? '进入控制中心' : 'Enter Control Center'}</button>
    <div class="error" id="error-msg"></div>
  </div>

  <script>
    document.getElementById('token').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') login();
    });

    async function login() {
      const tokenField = document.getElementById('token');
      const errorMsg = document.getElementById('error-msg');
      const btn = document.getElementById('login-btn');
      
      const token = tokenField.value.trim();
      if (!token) {
        errorMsg.textContent = '${isZh ? '请输入访问令牌' : 'Please enter an access token'}';
        return;
      }
      
      btn.textContent = '${isZh ? '验证中...' : 'Verifying...'}';
      btn.disabled = true;
      
      try {
        const res = await fetch('/cc/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        
        if (res.ok) {
          window.location.href = '/cc/?lang=${lang}';
        } else {
          errorMsg.textContent = '${isZh ? '令牌无效或已过期' : 'Invalid or expired token'}';
          btn.disabled = false;
          btn.textContent = '${isZh ? '进入控制中心' : 'Enter Control Center'}';
          tokenField.value = '';
          tokenField.focus();
        }
      } catch (err) {
        errorMsg.textContent = '${isZh ? '网络错误，请稍后再试' : 'Network error, please try again'}';
        btn.disabled = false;
        btn.textContent = '${isZh ? '进入控制中心' : 'Enter Control Center'}';
      }
    }
  </script>
</body>
</html>`;
  }
}
