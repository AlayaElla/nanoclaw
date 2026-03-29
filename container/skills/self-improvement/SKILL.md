---
name: self-improvement
description: "捕捉学习经验、错误和纠正信息，实现系统的持续自我进化。使用场景：(1) 命令或操作发生预期外的失败，(2) 用户纠正了 Agent，(3) 用户请求了一个当前不存在的功能，(4) 外部 API 或工具调用失败，(5) 发现自己的知识已过时或错误，(6) 为某项重复任务找到了更优解。执行重大任务前可审阅过往积累的经验（learnings）。"
metadata:
---

# 自我提升 (Self-Improvement) 技能

将学习经验和报错日志记录至 Markdown 文件，实现持续优化。并在时机成熟时，将具有重大价值的学习经验提升（Promote）整合至全局指令配置（如 `USER.md`）中长久生效。

## 快速参考

| 情况场景 | 应对动作 |
|-----------|--------|
| 命令/操作失败 | 记录至 `.learnings/ERRORS.md` |
| 用户对你的输出进行纠正 | 记录至 `.learnings/LEARNINGS.md`，分类标注为 `correction` |
| 用户提出了缺失的特性需求 | 记录至 `.learnings/FEATURE_REQUESTS.md` |
| API/外部工具调用失败 | 记录至 `.learnings/ERRORS.md`，附带接口集成细节 |
| 现有知识已过时 | 记录至 `.learnings/LEARNINGS.md`，分类标注为 `knowledge_gap` |
| 发现了更优的解决思路 | 记录至 `.learnings/LEARNINGS.md`，分类标注为 `best_practice` |
| 简化/巩固复发性模式 | 记录/更新至 `.learnings/LEARNINGS.md`，标注 `Source: simplify-and-harden` |
| 具有普适性的经验指引 | 提升整合至工作区的 `USER.md` 中 |

## NanoClaw 工作区挂载说明

在 NanoClaw 架构中，本技能会在工作区（Workspace）级别生效。依托 NanoClaw 独属的 Universal Dispatcher (`hooks/session-start` 及 `hooks/error-detect`) 进行自动加载。

NanoClaw 将所有会话进行了网格化的物理隔离：

```text
data/workspace/<group_folder>/
├── USER.md            # 群组或用户级别的核心指令/预设 (用于永久记忆)
└── .claude/
    └── skills/
        └── self-improvement/  # 本技能挂载路径
            └── .learnings/    # 所有的进化日志统一汇聚于此
                ├── LEARNINGS.md
                ├── ERRORS.md
                └── FEATURE_REQUESTS.md
```

### 自动运行与拦截

系统会在下列钩子时机自动生效本技能机制：
- `SessionStart`: 对话创建时即刻注入提示，唤醒并保持“随时从教训中总结”的心智。
- `PostToolUse`: 从终端 StdOut 输出自动嗅探 `Error/Exception`，一旦发现，立刻主动触发思考并建议计入日志。

---

## 日志录入格式与规范

#### 1. 学习经验条目 (Learning Entry)

追加写入到 `.learnings/LEARNINGS.md`：

```markdown
## [LRN-YYYYMMDD-XXX] 类别 (category)

**Logged (记录时间)**: ISO-8601 时间戳
**Priority (优先级)**: low | medium | high | critical
**Status (状态)**: pending (待处理)
**Area (领域)**: frontend | backend | infra | tests | docs | config

### Summary (摘要)
一行话描述学到了什么

### Details (详细说明)
完整上下文：发生了什么，错在哪里，正确的做法是什么

### Suggested Action (建议操作)
具体的修复建议或改进点

### Metadata (元数据)
- Source (来源): conversation | error | user_feedback
- Pattern-Key: (可选，复发模式的去重标识)
- Recurrence-Count: 1 (重犯次数统计)

---
```

#### 2. 报错深究条目 (Error Entry)

追加写入到 `.learnings/ERRORS.md`：

```markdown
## [ERR-YYYYMMDD-XXX] 技能或命令的名称

**Logged (记录时间)**: ISO-8601 时间戳
**Priority (优先级)**: high
**Status (状态)**: pending (待处理)

### Summary (摘要)
简要描述什么东西运行失败了

### Error (报错信息)
\`\`\`
实际的报错信息或输出内容
\`\`\`

### Context (上下文)
试图执行的操作，使用的输入参数。

### Suggested Fix (建议修复方案)
如果能看出来，写出可能的解决方案或替代方案。

---
```

## 提升为项目记忆 (Promoting to Project Memory)

当一项学习经验具备了**广泛适用性**（而不是某种一次性的修修补补），或者你发现你在连续踩同一个坑，你就应该将它提权（Promote）到项目的底层指令。

**注意：在 NanoClaw 中，不要尝试覆盖或修改系统全局的 `CLAUDE.md` 与原生 `TOOLS.md`，它们为不可执行或受保护模块。你的一切业务与工作区级别的经验沉淀，全部建议提升并写入到所属项目的专属 `USER.md` 文件中维系！**

### 提升流程 (How to Promote)

1. **萃取 (Distill)**：将冗长的学习经验浓缩成一句极简明确的规则或命令。
2. **添加 (Add)**：将其写入工作区 `USER.md` 中的经验累积板块（若无则自助在文件末尾开辟）。
3. **闭环更新 (Update)**：
   回到原本的那条 `LEARNINGS.md` 或 `ERRORS.md` 日志中：
   - 将 `**Status**: pending` 更改为 `**Status**: promoted`
   - 增加一行 `**Promoted File**: USER.md`

### 侦测共性教训

如果遇到与现有条目高度相似的报错：
1. **主动关联**: 在原有记录下添加 `**See Also**: ERR-XXX` 并累加次数。
2. **重度警惕**: 若 `Recurrence-Count` >= 3 次，立刻将其凝练并 Promote 到 `USER.md`，使其化作永远守护你的系统提示词。

## 致命级别判定指南 (Priority Guidelines)

| 严重度 | 何时使用 |
|------|-------------|
| `critical` | 阻断了核心功能、危及数据安全、暴露了系统秘钥等。 |
| `high` | 影响到了工作流流转的闭环，使得自动化被反复打断的常见报错坑洞。 |
| `medium` | 需要多执行几步绕过（Workaround）但不影响整体的中度问题。 |
| `low` | 轻微的不便、边缘场景缺陷。 |

## 全自动化重构专属子拓展 (Skill Extraction)

当你认为你摸索出了一套足以被后人长期复用的“方法论外挂”时：

1. **创建专属领地目录** (在 bash 工具中执行)：
   ```bash
   mkdir -p ./skills/<起个一目了然的技能名>
   ```
2. **编纂配置骨架**: 使用原生工具新建一份 `./skills/<技能名>/SKILL.md`。文件起手必须带有包含 `name: XXX` 和 `description: XXX` 的 YAML 元数据区（Frontmatter）。
3. **自主充填精髓**: 接着由你将打磨好的系统防护经验与工作流样例充填进去。
4. **完成封装**: 将此经验封存为一条独立的、随时可插拔的 NanoClaw 子技能包。
