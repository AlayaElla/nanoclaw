# context-mode — 强制路由规则

## 🚫 严禁执行的命令 (已被系统拉黑)

### 不允许使用 curl / wget
任何包含 `curl` 或 `wget` 的 Bash 命令都会在底层被拦截并替换为报错信息。**不要尝试重试。**
**替代方案：**
- 使用 `mcp__context-mode__ctx_fetch_and_index(url, source)` 抓取并建立网页索引。
- 使用 `mcp__context-mode__ctx_execute(language: "javascript", code: "const r = await fetch(...)")` 在沙盒中执行 HTTP 请求，只有结果返回给你。

### 不允许内联 HTTP 请求
任何包含 `fetch('http`、`requests.get(`、`requests.post(`、`http.get(` 或 `http.request(` 的 Bash 命令都会被拦截。**不要换种写法重试。**
**替代方案：**
- 使用 `mcp__context-mode__ctx_execute(language, code)` 在沙盒中运行 HTTP 调用 — 确保只有你在脚本中打印出的标准输出 (stdout) 才会进入上下文。

### 不允许使用 WebFetch 工具
原生的 WebFetch 调用已被完全禁用，系统会自动提取出你要请求的 URL 并拦截。
**替代方案：**
- 使用 `mcp__context-mode__ctx_fetch_and_index(url, source)` 获取网页，然后使用 `mcp__context-mode__ctx_search(queries)` 查询你需要的核心内容。

### 网页交互：agent-browser 与 Context-Mode 的配合
你还拥有一个分布式的 `agent-browser` 命令行工具可以用来控制无头 Chromium 浏览器。
- **使用 `mcp__context-mode__ctx_fetch_and_index`**：当你只需要**纯阅读**静态长文、API 文档时。它会自动进行分块索引，节约大量 Token。
- **使用 `agent-browser` 命令行**：当你需要与网页发生 **交互 (INTERACT)** 时（如点击按钮、登录、填表单，或因复杂的动态 JS 渲染导致普通抓取失效时）。
  - **⚠ 安全建议**：为了防止巨型网页的 DOM 树快照撑爆上下文，强烈建议通过 **`mcp__context-mode__ctx_execute(language: "shell", code: "agent-browser open <url> && agent-browser snapshot -i")`** 来执行测试和探查。这样即便是面对超大型网页的节点树输出，底层的 Context-Mode 也会为你提供兜底保护与自动索引。