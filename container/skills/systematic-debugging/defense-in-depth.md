# 深度防御校验 (Defense-in-Depth Validation)

## 概述

当你修复了一个由无效数据引起的 Bug 时，仅在一个地方添加校验似乎就足够了。但那单一的检查可能会被不同的代码路径、重构或 Mock 所绕过。

**核心原则：** 在数据流经的**每一层**都进行校验。让 Bug 在结构上变得不可能发生。

## 为什么要多层校验

单层校验：“我们修复了这个 Bug”
多层校验：“我们让这个 Bug 变得不可能发生”

不同的层级捕获不同的情况：
- 入口解析 (Entry validation) 捕获大多数 Bug。
- 业务逻辑 (Business logic) 捕获边缘情况。
- 环境守卫 (Environment guards) 防止特定上下文下的危险。
- 调试日志 (Debug logging) 在其他层失效时提供帮助。

## 四层防御结构

### 第 1 层：入口点校验 (Entry Point Validation)
**目的：** 在 API 边界拒绝明显无效的输入。

```typescript
function createProject(name: string, workingDirectory: string) {
  if (!workingDirectory || workingDirectory.trim() === '') {
    throw new Error('工作目录 (workingDirectory) 不能为空');
  }
  if (!existsSync(workingDirectory)) {
    throw new Error(`工作目录不存在：${workingDirectory}`);
  }
  if (!statSync(workingDirectory).isDirectory()) {
    throw new Error(`工作目录不是一个目录：${workingDirectory}`);
  }
  // ... 继续执行
}
```

### 第 2 层：业务逻辑校验 (Business Logic Validation)
**目的：** 确保数据对于该操作是有意义的。

```typescript
function initializeWorkspace(projectDir: string, sessionId: string) {
  if (!projectDir) {
    throw new Error('工作空间初始化需要 projectDir');
  }
  // ... 继续执行
}
```

### 第 3 层：环境守卫 (Environment Guards)
**目的：** 在特定上下文中防止危险操作。

```typescript
async function gitInit(directory: string) {
  // 在测试中，拒绝在临时目录之外执行 git init
  if (process.env.NODE_ENV === 'test') {
    const normalized = normalize(resolve(directory));
    const tmpDir = normalize(resolve(tmpdir()));

    if (!normalized.startsWith(tmpDir)) {
      throw new Error(
        `测试期间拒绝在临时目录外执行 git init：${directory}`
      );
    }
  }
  // ... 继续执行
}
```

### 第 4 层：调试插桩 (Debug Instrumentation)
**目的：** 捕获上下文以供事后分析。

```typescript
async function gitInit(directory: string) {
  const stack = new Error().stack;
  logger.debug('即将执行 git init', {
    directory,
    cwd: process.cwd(),
    stack,
  });
  // ... 继续执行
}
```

## 应用该模式

当你发现一个 Bug 时：

1. **追踪数据流** —— 异常值起源于何处？在哪里被使用？
2. **绘制所有检查点** —— 列出数据流经的每一个点。
3. **在每一层添加校验** —— 入口层、业务层、环境层、调试层。
4. **测试每一层** —— 尝试绕过第 1 层，验证第 2 层是否能捕获它。

## 会话案例

Bug：空的 `projectDir` 导致在源代码目录执行了 `git init`。

**数据流：**
1. 测试设置 (Test setup) → 获取到空字符串。
2. `Project.create(name, '')`。
3. `WorkspaceManager.createWorkspace('')`。
4. `git init` 在 `process.cwd()` 中运行。

**添加的四层防御：**
- 第 1 层：`Project.create()` 校验是否为空/是否存在/是否可写。
- 第 2 层：`WorkspaceManager` 校验 `projectDir` 不为空。
- 第 3 层：`WorktreeManager` 拒绝在测试期间在临时目录之外执行 `git init`。
- 第 4 层：在 `git init` 之前进行堆栈跟踪日志记录。

**结果：** 1847 个测试全部通过，Bug 变得无法复现。

## 关键洞察

这四层都是必要的。在测试过程中，每一层都捕获到了其他层漏掉的 Bug：
- 不同的代码路径绕过了入口校验。
- Mock 绕过了业务逻辑检查。
- 不同平台上的边缘情况需要环境守卫。
- 调试日志识别出了结构上的误用。

**不要止步于单一的校验点。在每一层都增加检查。**
