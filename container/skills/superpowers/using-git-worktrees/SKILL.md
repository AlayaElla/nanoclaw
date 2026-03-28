---
name: using-git-worktrees
description: 在开始需要与当前工作区隔离的功能开发时使用，或在执行实施计划之前使用。创建具有智能目录选择和安全验证的隔离 Git 工作树。
---

# 使用 Git 工作树 (Using Git Worktrees)

## 概述

Git 工作树 (Worktrees) 可以在共享同一个仓库的同时创建隔离的工作空间，允许你同时在多个分支上工作而无需频繁切换。

**核心原则：** 系统化的目录选择 + 安全验证 = 可靠的隔离环境。

**开始时请宣告：** “我正在使用 `using-git-worktrees` Skill 来设置隔离的工作空间。”

## 目录选择流程

请遵循以下优先级顺序：

### 1. 检查现有目录

```bash
# 按优先级顺序检查
ls -d .worktrees 2>/dev/null     # 首选（隐藏目录）
ls -d worktrees 2>/dev/null      # 备选
```

**如果找到：** 使用该目录。如果两者都存在，`.worktrees` 胜出。

### 2. 检查 CLAUDE.md

```bash
grep -i "worktree.*director" CLAUDE.md 2>/dev/null
```

**如果指定了偏好：** 直接使用，无需询问。

### 3. 询问用户

如果既没有现有目录，也没在 `CLAUDE.md` 中指定偏好：

```
未找到工作树目录。我应该在哪里创建工作树？

1. .worktrees/ (项目本地，隐藏)
2. ~/.config/superpowers/worktrees/<项目名称>/ (全局位置)

你更倾向于哪一个？
```

## 安全验证

### 对于项目本地目录 (.worktrees 或 worktrees)

**在创建工作树之前，必须验证该目录已被忽略 (ignored)：**

```bash
# 检查目录是否被忽略（遵循本地、全局和系统级 gitignore）
git check-ignore -q .worktrees 2>/dev/null || git check-ignore -q worktrees 2>/dev/null
```

**如果没有被忽略：**

根据“立即修复损坏的事物”原则：
1. 在 `.gitignore` 中添加相应行。
2. 提交 (Commit) 该更改。
3. 继续创建工作树。

**为什么这至关重要：** 防止意外地将工作树内容提交到仓库中。

### 对于全局目录 (~/.config/superpowers/worktrees)

无需验证 `.gitignore` —— 因为它完全位于项目之外。

## 创建步骤

### 1. 检测项目名称

```bash
project=$(basename "$(git rev-parse --show-toplevel)")
```

### 2. 创建工作树

```bash
# 确定完整路径
case $LOCATION in
  .worktrees|worktrees)
    path="$LOCATION/$BRANCH_NAME"
    ;;
  ~/.config/superpowers/worktrees/*)
    path="~/.config/superpowers/worktrees/$project/$BRANCH_NAME"
    ;;
esac

# 创建带有新分支的工作树
git worktree add "$path" -b "$BRANCH_NAME"
cd "$path"
```

### 3. 运行项目设置

自动检测并运行相应的设置命令：

```bash
# Node.js
if [ -f package.json ]; then npm install; fi

# Rust
if [ -f Cargo.toml ]; then cargo build; fi

# Python
if [ -f requirements.txt ]; then pip install -r requirements.txt; fi
if [ -f pyproject.toml ]; then poetry install; fi

# Go
if [ -f go.mod ]; then go mod download; fi
```

### 4. 验证基准环境

运行测试以确保工作树初始状态是“干净”的：

```bash
# 示例 - 使用适合项目的命令
npm test
cargo test
pytest
go test ./...
```

**如果测试失败：** 汇报失败情况，并询问是继续还是先进行调查。

**如果测试通过：** 汇报已就绪。

### 5. 汇报位置

```
工作树就绪，位于 <完整路径>
测试已通过 (<N> 个测试，0 个失败)
准备开始实施 <功能名称>
```

## 快速参考

| 情况 | 动作 |
|-----------|--------|
| `.worktrees/` 存在 | 使用它（验证是否已忽略） |
| `worktrees/` 存在 | 使用它（验证是否已忽略） |
| 两者都存在 | 使用 `.worktrees/` |
| 都不存在 | 检查 CLAUDE.md -> 询问用户 |
| 目录未被忽略 | 添加到 .gitignore + 提交 |
| 基准测试失败 | 汇报失败情况 + 询问 |
| 无 package.json/Cargo.toml | 跳过依赖安装 |

## 常见错误

### 跳过忽略验证 (Ignore Verification)

- **问题：** 工作树内容被追踪，污染 Git 状态。
- **修复：** 在创建项目本地工作树之前，始终使用 `git check-ignore`。

### 臆断目录位置

- **问题：** 导致不一致，违反项目约定。
- **修复：** 遵循优先级：现有目录 > CLAUDE.md > 询问。

### 在测试失败的情况下继续

- **问题：** 无法区分是新产生的 Bug 还是预先存在的问题。
- **修复：** 汇报失败，获得明确许可后再继续。

### 写死设置命令

- **问题：** 在使用不同工具的项目中会失效。
- **修复：** 从项目文件（package.json 等）中自动检测。

## 工作流示例

```
你：我正在使用 `using-git-worktrees` Skill 来设置隔离的工作空间。

[检查 .worktrees/ - 存在]
[验证是否忽略 - git check-ignore 确认 .worktrees/ 已被忽略]
[创建工作树：git worktree add .worktrees/auth -b feature/auth]
[运行 npm install]
[运行 npm test - 47 个测试通过]

工作树就绪，位于 /Users/jesse/myproject/.worktrees/auth
测试已通过 (47 个测试，0 个失败)
准备开始实施 auth 功能
```

## 红灯信号

**绝不要：**
- 在未验证项目本地工作区是否被忽略的情况下创建工作树。
- 跳过基准测试验证。
- 在测试失败且未询问的情况下继续。
- 在存在歧义时臆断目录位置。
- 跳过 `CLAUDE.md` 检查。

**始终做到：**
- 遵循目录优先级：现有 > CLAUDE.md > 询问。
- 验证项目本地目录是否已被忽略。
- 自动检测并运行项目设置。
- 验证干净的测试基准。

## 集成

**被以下项调用：**
- **brainstorming** (第四阶段) —— 当设计通过并开始实施时**必需**执行。
- **subagent-driven-development** —— 执行任何任务前**必需**执行。
- **executing-plans** —— 执行任何任务前**必需**执行。
- 任何需要隔离工作空间的 Skill。

**配对使用：**
- **finishing-a-development-branch** —— 工作完成后清理工作空间时**必需**执行。
