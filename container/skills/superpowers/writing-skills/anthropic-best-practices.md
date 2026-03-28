# Skill 编写最佳实践 (Skill Authoring Best Practices)

> 了解如何编写有效的 Skill，使 Claude 能够发现并成功使用它们。

优秀的 Skill 应简洁、结构良好，并在实际使用中经过测试。本指南提供了实用的编写决策，帮助你编写出 Claude 能够有效发现和使用的 Skill。

有关 Skill 工作原理的概念背景，请参阅 [Skill 概述](/en/docs/agents-and-tools/agent-skills/overview)。

## 核心原则

### 简洁是关键

[上下文窗口](https://platform.claude.com/docs/en/build-with-claude/context-windows) 是一种公共资源。你的 Skill 与 Claude 需要知道的其他所有内容共享上下文窗口，包括：

* 系统提示词 (System Prompt)
* 对话历史
* 其他 Skill 的元数据
* 你的实际请求

并非你的 Skill 中的每个 Token 都有即时成本。在启动时，仅预加载所有 Skill 的元数据（名称和描述）。只有当 Skill 变得相关时，Claude 才会读取 `SKILL.md`，并在需要时读取其他文件。然而，在 `SKILL.md` 中保持简洁仍然很重要：一旦 Claude 加载了它，每个 Token 都会与对话历史和其他上下文产生竞争。

**默认假设**：Claude 已经非常聪明。

只添加 Claude 尚未拥有的上下文。对每一条信息提出挑战：

* “Claude 真的需要这个解释吗？”
* “我可以假设 Claude 知道这个吗？”
* “这一段内容的 Token 成本是否合理？”

**优秀示例：简洁**（约 50 个 Token）：

```markdown
## 提取 PDF 文本

使用 pdfplumber 进行文本提取：

```python
import pdfplumber

with pdfplumber.open("file.pdf") as pdf:
    text = pdf.pages[0].extract_text()
```
```

**糟糕示例：太啰嗦**（约 150 个 Token）：

```markdown
## 提取 PDF 文本

PDF（便携式文档格式）文件是一种常见的文件格式，包含文本、图像和其他内容。
要从 PDF 中提取文本，你需要使用一个库。有很多可用于 PDF 处理的库，但我们
推荐 pdfplumber，因为它易于使用且能很好地处理大多数情况。
首先，你需要使用 pip 安装它。然后你可以使用下面的代码……
```

简洁版本假设 Claude 知道 PDF 是什么以及库是如何工作的。

### 设置适当的自由度

根据任务的脆弱性和可变性来匹配特异性水平。

**高自由度**（基于文本的指令）：

适用场景：
* 多种方法均有效
* 决策取决于上下文
* 启发式方法引导流程

示例：
```markdown
## 代码审查流程

1. 分析代码结构和组织
2. 检查潜在的 Bug 或边缘情况
3. 提出关于可读性和可维护性的改进建议
4. 验证是否符合项目约定
```

**中等自由度**（带有参数的伪代码或脚本）：

适用场景：
* 存在首选模式
* 接受一定程度的变化
* 配置会影响行为

示例：
```python
def generate_report(data, format="markdown", include_charts=True):
    # 处理数据
    # 按指定格式生成输出
    # （可选）包含可视化内容
```

**低自由度**（特定的脚本，很少或没有参数）：

适用场景：
* 操作脆弱且容易出错
* 一致性至关重要
* 必须遵循特定的顺序

示例：
```bash
## 数据库迁移

务必运行此脚本：

```bash
python scripts/migrate.py --verify --backup
```

请勿修改命令或添加额外的标志。
```

**类比**：把 Claude 想象成一个在路径上探索的机器人：
* **两边都是悬崖的窄桥**：只有一条安全的前行道路。提供具体的护栏和精确的指令（低自由度）。示例：必须按精确顺序运行的数据库迁移。
* **没有危险的开阔地**：条条大路通罗马。给出总体方向，信任 Claude 能找到最佳路线（高自由度）。示例：由上下文决定最佳方法的代码审查。

### 在你计划使用的所有模型上进行测试

Skill 作为模型的补充，其有效性取决于底层模型。在你计划使用的所有模型上测试你的 Skill。

**各模型的测试考量**：
* **Claude Haiku**（快速、经济）：Skill 是否提供了足够的引导？
* **Claude Sonnet**（平衡）：Skill 是否清晰且高效？
* **Claude Opus**（强大的推理）：Skill 是否避免了过度解释？

对 Opus 完美运行的内容可能需要为 Haiku 提供更多细节。如果你计划在多个模型上使用你的 Skill，目标是编写在所有模型上都能良好运行的指令。

## Skill 结构

> [!NOTE]
> **YAML Frontmatter**: `SKILL.md` 的前言需要两个字段：
> * `name` - Skill 的易读名称（最多 64 个字符）
> * `description` - 一行描述，说明 Skill 做什么以及何时使用（最多 1024 个字符）
> 
> 有关完整的 Skill 结构详情，请参阅 [Skill 概述](/en/docs/agents-and-tools/agent-skills/overview#skill-structure)。

### 命名规范

使用一致的命名模式使 Skill 易于引用和讨论。我们建议对 Skill 名称使用**动名词形式**（动词 + -ing），因为这能清晰地描述 Skill 提供的活动或能力。

**优秀的命名示例（动名词形式）**：
* "Processing PDFs" (处理 PDF)
* "Analyzing spreadsheets" (分析电子表格)
* "Managing databases" (管理数据库)
* "Testing code" (测试代码)
* "Writing documentation" (编写文档)

**可接受的替代方案**：
* 名词短语："PDF Processing", "Spreadsheet Analysis"
* 行动导向："Process PDFs", "Analyze Spreadsheets"

**避免使用**：
* 模糊的名称："Helper", "Utils", "Tools"
* 过于通用："Documents", "Data", "Files"
* Skill 集合中命名模式不一致

一致的命名使得以下操作更加容易：
* 在文档和对话中引用 Skill
* 一眼就能理解 Skill 的作用
* 组织和搜索多个 Skill
* 维护专业、统一的 Skill 库

### 编写有效的描述

`description` 字段支持 Skill 的发现，应包含 Skill 的作用以及何时使用。

> [!WARNING]
> **始终使用第三人称编写**。描述将被注入系统提示词中，不一致的视角（人称）可能会导致发现问题。
> * **正例**："Processes Excel files and generates reports" (处理 Excel 文件并生成报告)
> * **避雷**："I can help you process Excel files" (我可以帮你处理 Excel 文件)
> * **避雷**："You can use this to process Excel files" (你可以用这个来处理 Excel 文件)

**要具体并包含核心术语**。同时包含 Skill 的功能以及使用它的特定触发器/上下文。

每个 Skill 恰好有一个描述字段。描述对于 Skill 选择至关重要：Claude 使用它从可能上百个可用的 Skill 中选择正确的那个。你的描述必须提供足够的细节让 Claude 知道何时选择该 Skill，而 `SKILL.md` 的其余部分则提供实施细节。

有效示例：

**PDF 处理 Skill**:
```yaml
description: 从 PDF 文件中提取文本和表格、填写表单、合并文档。在处理 PDF 文件或用户提到 PDF、表单或文档提取时使用。
```

**Excel 分析 Skill**:
```yaml
description: 分析 Excel 电子表格、创建数据透视表、生成图表。在分析 Excel 文件、电子表格、表格数据或 .xlsx 文件时使用。
```

**Git 提交助手 Skill**:
```yaml
description: 通过分析 git diff 生成描述性的提交消息。在用户寻求编写提交消息或审查暂存更改的帮助时使用。
```

避免使用如下模糊的描述：
```yaml
description: 帮助处理文档
description: 处理数据
description: 对文件进行操作
```

### 渐进式披露模式

`SKILL.md` 作为总览，在需要时引导 Claude 查阅详细材料，就像入职指南中的目录一样。

**实用建议**：
* 将 `SKILL.md` 正文保持在 500 行以内以获得最佳性能。
* 在接近此限制时将内容拆分为独立文件。
* 使用以下模式有效地组织指令、代码及资源。

#### 视觉总览：从简单到复杂

一个基础 Skill 仅由一个包含元数据和指令的 `SKILL.md` 文件开始。

随着 Skill 的增长，你可以打包 Claude 仅在需要时才会加载的额外内容。

完整的 Skill 目录结构可能如下所示：
```
pdf/
├── SKILL.md              # 主指令 (触发时加载)
├── FORMS.md              # 表单填写指南 (按需加载)
├── reference.md          # API 参考 (按需加载)
├── examples.md           # 使用示例 (按需加载)
└── scripts/
    ├── analyze_form.py   # 实用脚本 (执行而非加载)
    ├── fill_form.py      # 表单填写脚本
    └── validate.py       # 验证脚本
```

#### 模式 1：带有参考的高层级指南

Claude 仅在需要时才会加载 `FORMS.md`、`REFERENCE.md` 或 `EXAMPLES.md`。

#### 模式 2：特定领域的组织

对于涉及多个领域的 Skill，按领域组织内容以避免加载无关的上下文。当用户询问销售指标时，Claude 只需要阅读与销售相关的架构，而不需要阅读财务或营销数据。这能保持低 Token 使用量并使上下文聚焦。

```
bigquery-skill/
├── SKILL.md (总览与导航)
└── reference/
    ├── finance.md (收入、账单指标)
    ├── sales.md (机会、流水)
    ├── product.md (API 使用、功能)
    └── marketing.md (活动、归因)
```

#### 模式 3：条件性细节

显示基础内容，链接到高级内容。Claude 只有在用户需要这些功能时才会阅读 `REDLINING.md` 或 `OOXML.md`。

### 避免深度嵌套的引用

当文件从其他被引用的文件中被引用时，Claude 可能会部分读取这些文件。遇到嵌套引用时，Claude 可能会使用 `head -100` 之类的命令来预览内容，而不是读取整个文件，从而导致信息不完整。

**保持引用距离 `SKILL.md` 仅一级深度**。所有参考文件都应直接从 `SKILL.md` 链接，以确保 Claude 在需要时读取完整的文件。

### 为较长的参考文件构建目录

对于超过 100 行的参考文件，请在顶部包含目录。这能确保 Claude 在通过部分读取进行预览时，也能看到可用信息的全貌。

## 工作流与反馈循环

### 为复杂任务使用工作流

将复杂操作分解为清晰、顺序的步骤。对于特别复杂的工作流，提供一个清单，供 Claude 复制到其回复中并在执行过程中逐项勾选。

**模式：运行验证器 -> 修复错误 -> 重复**
这种模式能极大地提高输出质量。

## 内容指南

### 避免具有时效性的信息
由于文档会过时，不要包含会失效的信息，而是使用“旧模式 (Old patterns)”章节来提供历史背景而不干扰主线内容。

### 使用一致的术语
在整个 Skill 中选择一个术语并贯穿始终。一致性有助于 Claude 理解并遵循指令。

## 常用模式

### 模板模式
为输出格式提供模板。根据需求匹配严格程度。

### 示例模式
对于输出质量依赖于示例的 Skill，提供输入/输出对，就像在常规提示词工程中做的那样。

### 条件工作流模式
引导 Claude 经过决策点：根据任务类型选择不同的子工作流，必要时将大型工作流推送到独立文件。

## 评估与迭代

### 先构建评估 (Evaluations)
**在编写大量文档之前，请先创建评估。** 这能确保你的 Skill 解决的是真实问题，而不是凭空臆想出来的问题。

### 与 Claude 协同迭代开发 Skill
最有效的 Skill 开发过程涉及 Claude 自身。与一个 Claude 实例（“Claude A”）合作创建一个 Skill，供其他实例（“Claude B”）使用。Claude A 帮助你设计和微调指令，而 Claude B 在实际任务中测试它们。

1. **在没有 Skill 的情况下完成任务**：观察你自己反复提供了哪些信息。
2. **识别可重用模式**。
3. **让 Claude A 创建 Skill**：Claude 模型原生理解 Skill 格式，直接要求即可。
4. **审查简洁性**：移除多余解释。
5. **改进信息架构**。
6. **在类似任务上测试**：观察 Claude B 是否能找到正确信息。
7. **根据观察进行迭代**。
