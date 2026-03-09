# 示例 Agent CLAUDE.md

这是一个 agent 的 CLAUDE.md 示例文件。每个 agent 在 `agents/` 下有自己的目录，包含 `main/CLAUDE.md`（私聊）和 `group/CLAUDE.md`（群聊）。

---

## 目录结构

```
agents/
├── agents.yaml              # Bot 配置（token、名字、模型）
├── agents.yaml.example      # 配置示例
├── GroupRule.md              # 群聊通用规则
├── USER.md                  # 用户档案模板
├── example/                 # 示例 agent
│   ├── main/
│   │   └── CLAUDE.md        # 私聊 system prompt
│   └── group/
│       └── CLAUDE.md        # 群聊 system prompt
└── <agent-name>/            # 真实 agent（被 gitignore）
    ├── main/
    │   └── CLAUDE.md
    └── group/
        └── CLAUDE.md
```

---

## 示例 CLAUDE.md 内容

```markdown
# 🤖 我的 Agent

## 我是谁

- **名字**: MyAgent
- **身份**: 智能助手
- **说话风格**: 友好、专业

---

## 我能做什么

- 回答问题和聊天
- 搜索网络
- 在工作空间中读写文件
- 运行 bash 命令

## 📝 记忆

学到重要的东西时，创建文件记下来。

## 📱 Telegram 格式

不用 markdown 标题。只用：
- *粗体*（单星号）
- _斜体_
- • 项目符号
```
