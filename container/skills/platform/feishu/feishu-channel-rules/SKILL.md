---
name: feishu-channel-rules
description: |
  Lark/Feishu channel output rules. Always active in Lark conversations.
alwaysActive: true
---

# Lark Output Rules

## Writing Style

- Short, conversational, low ceremony — talk like a coworker, not a manual
- Prefer plain sentences over bullet lists when a brief answer suffices
- Get to the point and stop — no need for a summary paragraph every time

## Note

- Lark Markdown differs from standard Markdown in some ways; when unsure, refer to `references/markdown-syntax.md`

## 消息卡片（Interactive Card）

当需要展示结构化信息时（如任务操作结果、列表、状态汇报），**使用 `mcp__nanoclaw__send_card` 工具**发送飞书互动卡片。不要自己输出 JSON。

工具参数：`title`（标题）、`content`（Markdown 正文）、`color`（标题栏颜色）、`buttons`（可选按钮）。

### 何时用卡片

- ✅ 任务创建/更新/完成的结果通知
- ✅ 任务列表展示
- ✅ 带结构化数据的操作反馈
- ❌ 简单的对话回复不需要卡片

### 卡片 JSON 模板

**任务创建成功**：
```json
{
  "type": "template",
  "data": {
    "template_variable": {
      "title": "✅ 任务已创建",
      "summary": "任务标题",
      "assignee": "负责人名",
      "due": "截止时间",
      "link": "https://applink.feishu.cn/client/task/detail/任务guid"
    }
  }
}
```

**通用卡片格式**（适用于所有场景）：
```json
{
  "elements": [
    {
      "tag": "markdown",
      "content": "**✅ 任务已创建**\n\n任务标题：准备周会材料\n负责人：<at id=ou_xxx></at>\n截止时间：2026-03-15 18:00\n\n[查看任务](https://applink.feishu.cn/client/task/detail/guid)"
    }
  ],
  "header": {
    "template": "green",
    "title": {
      "tag": "plain_text",
      "content": "📋 任务管理"
    }
  }
}
```

### 卡片 Header 颜色

可用颜色：`blue`, `wathet`, `turquoise`, `green`, `yellow`, `orange`, `red`, `carmine`, `violet`, `purple`, `indigo`, `grey`

推荐：
- 创建成功 → `green`
- 查询/列表 → `blue`
- 更新/修改 → `wathet`
- 删除/警告 → `orange`
- 错误 → `red`

### Markdown 语法限制

卡片中的 markdown 字段：
- ✅ 支持：加粗、斜体、删除线、链接、@人、彩色文本、列表
- ❌ 不支持：一二三级标题（只能用四五级）、图片用 http 链接
- 用 `\n` 换行
