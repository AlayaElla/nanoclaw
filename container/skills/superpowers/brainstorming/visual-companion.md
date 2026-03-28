# 视觉伴侣指南 (Visual Companion Guide)

基于浏览器的视觉头脑风暴伴侣，用于展示原型、图表和选项。

## 何时使用

针对**每个问题**独立决定，而非针对每个会话。衡量标准：**通过“看”是否比通过“读”能让用户理解得更好？**

**在以下内容本身具有视觉属性时使用浏览器：**

- **UI 原型** —— 线框图、布局、导航结构、组件设计。
- **架构图** —— 系统组件、数据流、关系图。
- **并排视觉对比** —— 对比两种布局、两种配色方案、两个设计方向。
- **外观润色** —— 当问题涉及观感、间距、视觉层次时。
- **空间关系** —— 状态机、流程图、渲染为图表的实体关系。

**在内容为纯文本或表格时使用终端：**

- **需求和范围问题** —— “X 是什么意思？”、“哪些功能在范围内？”
- **概念性的 A/B/C 选择** —— 在用文字描述的方案之间进行选择。
- **利弊清单** —— 优缺点对比表。
- **技术决策** —— API 设计、数据建模、架构方案选择。
- **澄清式提问** —— 任何答案为文字而非视觉偏好的问题。

关于 UI 主题的问题不自动等同于视觉问题。“你想要什么样的向导 (Wizard)？”是概念性的 —— 使用终端。“这些向导布局中哪一个感觉更好？”是视觉性的 —— 使用浏览器。

## 工作原理

服务器监控一个目录中的 HTML 文件，并将最新的文件推送到浏览器。你将 HTML 内容写入 `screen_dir`，用户在浏览器中看到它并可以点击选择选项。选择结果会记录到 `state_dir/events` 中，供你在下一轮对话中读取。

**内容片段 (Content fragments) vs 完整文档：** 如果你的 HTML 文件以 `<!DOCTYPE` 或 `<html` 开头，服务器将按原样提供（仅注入辅助脚本）。否则，服务器会自动将你的内容包装在框架模板中 —— 添加页眉、CSS 主题、选择指示器和所有的交互基础设施。**默认情况下请编写内容片段。** 只有当你需要完全控制页面时才编写完整文档。

## 启动会话

```bash
# 启动带有持久化支持的服务器（原型将保存至项目目录）
scripts/start-server.sh --project-dir /path/to/project

# 返回：{"type":"server-started","port":52341,"url":"http://localhost:52341",
#           "screen_dir":"/path/to/project/.superpowers/brainstorm/12345-1706000000/content",
#           "state_dir":"/path/to/project/.superpowers/brainstorm/12345-1706000000/state"}
```

保存响应中的 `screen_dir` 和 `state_dir`。告诉用户打开该 URL。

**寻找连接信息：** 服务器会将其启动 JSON 写入 `$STATE_DIR/server-info`。如果你在后台启动了服务器且未捕获标准输出，请阅读该文件以获取 URL 和端口。使用 `--project-dir` 时，请在 `<项目目录>/.superpowers/brainstorm/` 中检查会话目录。

**注意：** 将项目根目录作为 `--project-dir` 传入，以便原型保存在 `.superpowers/brainstorm/` 中，并在服务器重启后依然存在。如果不传，文件将进入 `/tmp` 并在停止后被清理。提醒用户将 `.superpowers/` 添加到 `.gitignore` 中（如果尚未添加）。

**按平台启动服务器：**

**Claude Code (macOS / Linux):**
```bash
# 默认模式即可 —— 脚本本身会让服务器在后台运行
scripts/start-server.sh --project-dir /path/to/project
```

**Claude Code (Windows):**
```bash
# Windows 会自动检测并使用前台模式，这会阻塞工具调用。
# 在使用 Bash 工具调用时设置 run_in_background: true，以便服务器在对话轮次切换间继续运行。
scripts/start-server.sh --project-dir /path/to/project
```
通过 Bash 工具调用时，设置 `run_in_background: true`。然后在下一轮对话中读取 `$STATE_DIR/server-info` 获取 URL 和端口。

**Codex:**
```bash
# Codex 会清理后台进程。脚本会自动检测到 CODEX_CI 并切换到前台模式。
# 正常运行即可 —— 无需额外标志。
scripts/start-server.sh --project-dir /path/to/project
```

**Gemini CLI:**
```bash
# 使用 --foreground 并在 shell 工具调用中设置 is_background: true
# 以便进程在轮次切换间继续生存
scripts/start-server.sh --project-dir /path/to/project --foreground
```

**其他环境：** 服务器必须在对话轮次切换间持续在后台运行。如果你的环境会清理分离的进程，请使用 `--foreground` 并通过你平台的后台执行机制启动命令。

如果无法从浏览器访问 URL（常见于远程/容器化环境），请绑定到非环回 (non-loopback) 主机：

```bash
scripts/start-server.sh \
  --project-dir /path/to/project \
  --host 0.0.0.0 \
  --url-host localhost
```

使用 `--url-host` 来控制返回的 URL JSON 中打印的主机名。

## 交互循环

1. **检查服务器是否存活**，然后将 **HTML 写入** `screen_dir` 中的新文件：
   - 在每次写入前，检查 `$STATE_DIR/server-info` 是否存在。如果不存在（或 `$STATE_DIR/server-stopped` 存在），说明服务器已关闭 —— 在继续前需通过 `start-server.sh` 重启。服务器在闲置 30 分钟后会自动退出。
   - 使用语义化文件名：`platform.html`, `visual-style.html`, `layout.html`。
   - **绝不要重复使用文件名** —— 每个屏幕都应该是一个新文件。
   - 使用 Write 工具 —— **绝不要使用 cat/heredoc**（会导致终端产生大量噪音）。
   - 服务器会自动提供最新的文件。

2. **告诉用户预期的内容并结束本轮对话：**
   - 提醒他们查看 URL（每一步都要提醒，而不仅仅是第一次）。
   - 提供屏幕内容的简要文本摘要（例如：“正在展示首页的 3 种布局选项”）。
   - 要求他们在终端回复：“请看一下，告诉我你的想法。如果愿意，可以点击选择一个选项。”

3. **在你的下一轮对话中** —— 在用户于终端响应后：
   - 如果 `$STATE_DIR/events` 存在，请阅读它 —— 其中包含用户以 JSON 行形式记录的浏览器交互（点击、选择）。
   - 将其与用户的终端文本结合，获取完整的信息。
   - 终端消息是主要的反馈来源；`state_dir/events` 提供结构化的交互数据。

4. **迭代或推进** —— 如果反馈要求修改当前屏幕，请编写一个新文件（例如 `layout-v2.html`）。只有在当前步骤得到验证后才进入下一个问题。

5. **返回终端时卸载页面** —— 当下一步不需要浏览器时（例如：澄清问题、利弊讨论），推送一个等待页面以清除过时内容：

   ```html
   <!-- 文件名: waiting.html (或 waiting-2.html 等) -->
   <div style="display:flex;align-items:center;justify-content:center;min-height:60vh">
     <p class="subtitle">在终端继续...</p>
   </div>
   ```

   这可以防止用户在对话已经推进时依然盯着一个已经解决的选项。当下一次视觉问题出现时，正常推送新的内容文件即可。

6. 重复上述步骤直到完成。

## 编写内容片段 (Content Fragments)

只需编写页面内部的内容。服务器会自动将其封装在框架模板中（包含页眉、主题 CSS、选择指示器和所有交互基础设施）。

**极简示例：**

```html
<h2>哪种布局效果更好？</h2>
<p class="subtitle">请考虑可读性和视觉层次</p>

<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>单列布局</h3>
      <p>整洁、专注的阅读体验</p>
    </div>
  </div>
  <div class="option" data-choice="b" onclick="toggleSelect(this)">
    <div class="letter">B</div>
    <div class="content">
      <h3>双列布局</h3>
      <p>带侧边栏导航的主内容区</p>
    </div>
  </div>
</div>
```

就是这样。不需要 `<html>`、CSS 或 `<script>` 标签。服务器会提供这些。

## 可用的 CSS 类

框架模板为你的内容提供了以下 CSS 类：

### 选项（A/B/C 选择）

```html
<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>标题</h3>
      <p>描述</p>
    </div>
  </div>
</div>
```

**多选：** 在容器上添加 `data-multiselect` 允许用户选择多个选项。每次点击都会切换选中状态。指示栏会显示计数。

```html
<div class="options" data-multiselect>
  <!-- 相同的选项标记 —— 用户可以多选/取消多选 -->
</div>
```

### 卡片（视觉设计）

```html
<div class="cards">
  <div class="card" data-choice="design1" onclick="toggleSelect(this)">
    <div class="card-image"><!-- 原型内容 --></div>
    <div class="card-body">
      <h3>名称</h3>
      <p>描述</p>
    </div>
  </div>
</div>
```

### 原型容器 (Mockup Container)

```html
<div class="mockup">
  <div class="mockup-header">预览：仪表盘布局</div>
  <div class="mockup-body"><!-- 你的原型 HTML --></div>
</div>
```

### 拆分视图（并排对比）

```html
<div class="split">
  <div class="mockup"><!-- 左侧 --></div>
  <div class="mockup"><!-- 右侧 --></div>
</div>
```

### 优缺点 (Pros/Cons)

```html
<div class="pros-cons">
  <div class="pros"><h4>优点</h4><ul><li>好处</li></ul></div>
  <div class="cons"><h4>缺点</h4><ul><li>不足</li></ul></div>
</div>
```

### 模拟元素 (Mock Elements — 线框图组件)

```html
<div class="mock-nav">Logo | 首页 | 关于 | 联系我们</div>
<div style="display: flex;">
  <div class="mock-sidebar">导航栏</div>
  <div class="mock-content">内容主区域</div>
</div>
<button class="mock-button">动作按钮</button>
<input class="mock-input" placeholder="输入框">
<div class="placeholder">占位区域</div>
```

### 排版与章节

- `h2` —— 页面标题
- `h3` —— 章节标题
- `.subtitle` —— 标题下方的辅助文本
- `.section` —— 带有下边距的内容块
- `.label` —— 小型大写字母标签文本

## 浏览器事件格式

当用户在浏览器中点击选项时，他们的交互会被记录至 `$STATE_DIR/events`（每行一个 JSON 对象）。当你推送新屏幕时，该文件会被自动清空。

```jsonl
{"type":"click","choice":"a","text":"选项 A - 简单布局","timestamp":1706000101}
{"type":"click","choice":"c","text":"选项 C - 复杂网格","timestamp":1706000108}
{"type":"click","choice":"b","text":"选项 B - 混合模式","timestamp":1706000115}
```

完整的事件流展示了用户的探索路径 —— 他们可能会在最终确定前点击多个选项。最后一个 `choice` 事件通常是最终选择，但点击模式可以揭示用户的犹豫或值得进一步询问的偏好。

如果 `$STATE_DIR/events` 不存在，说明用户并未与浏览器交互 —— 请仅参考他们的终端文本。

## 设计建议

- **根据问题调整逼真度** —— 布局问题使用线框图，视觉问题使用高保真原型。
- **在每个页面上解释问题** —— 使用“哪种布局感觉更专业？”而非简单的“选一个”。
- **在推进前先迭代** —— 如果反馈要求修改当前屏幕，请编写一个新版本。
- 每个屏幕最多 **2-4 个选项**。
- **在关键处使用真实内容** —— 例如对于摄影作品集，使用真实的图片 (Unsplash)。占位内容会掩盖设计问题。
- **保持原型简洁** —— 专注于布局和结构，而非像素级完美。

## 文件命名

- 使用语义化名称：`platform.html`, `visual-style.html`, `layout.html`。
- 绝不要重复使用文件名 —— 每个屏幕必须是一个新文件。
- 迭代版本：添加版本后缀，如 `layout-v2.html`, `layout-v3.html`。
- 服务器按修改时间提供最新的文件。

## 清理工作

```bash
scripts/stop-server.sh $SESSION_DIR
```

如果会话使用了 `--project-dir`，原型文件将保留在 `.superpowers/brainstorm/` 中供后续查阅。只有 `/tmp` 会话会在停止后被物理删除。

## 参考

- 框架模板 (CSS 参考)：`scripts/frame-template.html`
- 辅助脚本 (客户端)：`scripts/helper.js`
