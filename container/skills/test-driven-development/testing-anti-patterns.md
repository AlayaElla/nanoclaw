# 测试反模式 (Testing Anti-Patterns)

**在以下情况下加载此参考文档：** 编写或修改测试、添加 Mock，或产生在生产代码中添加“仅用于测试”的方法的念头时。

## 概述

测试必须验证真实的行为，而不是 Mock 的行为。Mock 是隔离手段，而不是被测试的对象。

**核心原则：** 测试代码做了什么，而不是 Mock 做了什么。

**遵循严格的 TDD 流程可以防止这些反模式的产生。**

## 铁律

```
1. 绝不测试 Mock 行为
2. 绝不在生产类中添加“仅用于测试”的方法
3. 在不理解依赖关系的情况下，绝不进行 Mock
```

## 反模式 1：测试 Mock 行为

**违规示例：**
```typescript
// ❌ 错误：测试 Mock 是否存在
test('渲染侧边栏', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});
```

**为什么这是错的：**
- 你在验证 Mock 是否工作，而不是组件是否工作。
- 当有 Mock 时测试通过，没有时失败。
- 无法告诉你关于真实行为的任何信息。

**人类伙伴的纠正建议：** “我们是在测试 Mock 的行为吗？”

**修复方案：**
```typescript
// ✅ 正确：测试真实的组件，或者不要 Mock 它
test('渲染侧边栏', () => {
  render(<Page />);  // 不要 Mock 侧边栏
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

// 或者，如果侧边栏必须被 Mock 以进行隔离：
// 不要对 Mock 元素进行断言——测试 Page 组件在侧边栏存在时的行为。
```

### 门槛自检 (Gate Function)

```
在对任何 Mock 元素进行断言之前：
  自问：“我是在测试真实的组件行为，还是仅仅在测试 Mock 的存在？”

  如果是测试 Mock 的存在：
    停止——删除该断言，或对该组件取消 Mock。

  改为测试真实的行为。
```

## 反模式 2：生产品代码中的“仅用于测试”方法

**违规示例：**
```typescript
// ❌ 错误：destroy() 仅在测试中使用
class Session {
  async destroy() {  // 看起来像生产 API！
    await this._workspaceManager?.destroyWorkspace(this.id);
    // ... 清理逻辑
  }
}

// 在测试中
afterEach(() => session.destroy());
```

**为什么这是错的：**
- 生产类被仅用于测试的代码污染了。
- 如果在生产环境中被意外调用会很危险。
- 违反了 YAGNI（你不需要它）原则和关注点分离。
- 混淆了“对象生命周期”与“实体生命周期”。

**修复方案：**
```typescript
// ✅ 正确：使用测试工具处理测试清理
// Session 类没有 destroy() 方法——它在生产环境中是无状态的

// 在 test-utils/ 中
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// 在测试中
afterEach(() => cleanupSession(session));
```

### 门槛自检 (Gate Function)

```
在向生产类添加任何方法之前：
  自问：“这个方法是否仅由测试使用？”

  如果是：
    停止——不要添加。
    将其放入测试工具 (Test Utilities) 中。

  自问：“这个类是否拥有该资源的生命周期？”

  如果不是：
    停止——这个方法放错了类。
```

## 反模式 3：在不理解的情况下进行 Mock

**违规示例：**
```typescript
// ❌ 错误：Mock 破坏了测试逻辑
test('检测重复的服务器', () => {
  // Mock 阻止了测试所依赖的配置写入！
  vi.mock('ToolCatalog', () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
  }));

  await addServer(config);
  await addServer(config);  // 应该报错——但现在不会了！
});
```

**为什么这是错的：**
- 被 Mock 的方法具有测试所依赖的副作用（写入配置）。
- 为了“求稳”而过度 Mock 破坏了真实的行为。
- 测试由于错误的原因通过，或莫名其妙地失败。

**修复方案：**
```typescript
// ✅ 正确：在正确的层级进行 Mock
test('检测重复的服务器', () => {
  // Mock 缓慢的部分，保留测试所需的行为
  vi.mock('MCPServerManager'); // 仅 Mock 缓慢的服务器启动过程

  await addServer(config);  // 配置得以写入
  await addServer(config);  // 检测到重复 ✓
});
```

### 门槛自检 (Gate Function)

```
在 Mock 任何方法之前：
  停止——先不要 Mock。

  1. 自问：“真实方法具有哪些副作用？”
  2. 自问：“这个测试是否依赖于这些副作用中的任何一个？”
  3. 自问：“我是否完全理解这个测试需要什么？”

  如果依赖于副作用：
    在更低的层级进行 Mock（即真实的缓存/外部操作）。
    或者使用能保留必要行为的测试替身 (Test Doubles)。
    而不是测试所依赖的高级方法。

  如果不确定测试依赖什么：
    首先使用真实实现运行测试。
    观察实际发生了什么。
    然后才在正确的层级添加最小化的 Mock。

  红灯信号：
    - “我做个 Mock 以防万一。”
    - “这可能会很慢，最好 Mock 掉。”
    - 在不理解依赖链的情况下进行 Mock。
```

## 反模式 4：不完整的 Mock

**违规示例：**
```typescript
// ❌ 错误：部分 Mock——只包含你认为需要的字段
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // 缺失：下游代码会用到的 metadata 字段
};

// 稍后：当代码访问 response.metadata.requestId 时会报错
```

**为什么这是错的：**
- **部分 Mock 隐藏了结构性假设**——你只 Mock 了你知道的字段。
- **下游代码可能依赖你未包含的字段**——导致静默失败。
- **测试通过但集成失败**——Mock 是不完整的，真实的 API 是完整的。
- **虚假的信心**——测试证明不了任何真实行为。

**铁律：** Mock 现实中存在的完整数据结构，而不仅仅是当前测试用到的字段。

**修复方案：**
```typescript
// ✅ 正确：镜像真实 API 的完整性
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
  // 包含真实 API 返回的所有字段
};
```

### 门槛自检 (Gate Function)

```
在创建 Mock 响应之前：
  检查：“真实的 API 响应包含哪些字段？”

  行动：
    1. 查阅文档/示例中的实际 API 响应。
    2. 包含系统在下游可能消费的所有字段。
    3. 验证 Mock 与真实响应的 Schema 完全匹配。

  至关重要：
    如果你在创建 Mock，你必须理解整个结构。
    当代码依赖被忽略的字段时，部分 Mock 会导致静默失败。

  如果不确定：包含所有文档中提到的字段。
```

## 反模式 5：将集成测试视为事后补充

**违规示例：**
```
✅ 实现完成
❌ 未编写测试
“准备好测试了”
```

**为什么这是错的：**
- 测试是实现的一部分，而不是可选的后续工作。
- TDD 本可以捕获到这一点。
- 没有测试就不能声称开发完成。

**修复方案：**
```
TDD 循环：
1. 编写失败的测试
2. 实现以通过测试
3. 重构
4. 然后再声称完成
```

## 当 Mock 变得过于复杂时

**警示信号：**
- Mock 的设置 (Setup) 比测试逻辑还长。
- 为了让测试通过而 Mock 掉一切。
- Mock 缺失了真实组件具备的方法。
- 当 Mock 改变时，测试就会崩溃。

**人类伙伴的问题：** “我们这里真的需要使用 Mock 吗？”

**考虑：** 使用真实组件的集成测试通常比复杂的 Mock 更简单。

## TDD 可以防止这些反模式

**为什么 TDD 有帮助：**
1. **先写测试** -> 强迫你思考你究竟在测试什么。
2. **观察失败** -> 确认测试考察的是真实行为，而不是 Mock。
3. **最小化实现** -> 防止不必要的“仅用于测试”方法潜入。
4. **真实依赖** -> 在 Mock 之前，你会看到测试实际需要什么。

**如果你在测试 Mock 行为，说明你违反了 TDD**——你没能先观察测试在真实代码上失败，就直接添加了 Mock。

## 快速参考

| 反模式 | 修复方案 |
|--------------|-----|
| 对 Mock 元素进行断言 | 测试真实组件或取消 Mock |
| 生产代码中的仅用于测试方法 | 移至测试工具类 |
| 在不理解的情况下 Mock | 先理解依赖，进行最小化 Mock |
| 不完整的 Mock | 镜像真实的完整 API |
| 将测试视为事后工作 | TDD - 测试先行 |
| 过度复杂的 Mock | 考虑进行集成测试 |

## 红灯信号

- 断言检查 `*-mock` 的测试 ID。
- 仅在测试文件中被调用的方法。
- Mock 的设置占测试代码的 50% 以上。
- 当你移除 Mock 时测试就挂了。
- 无法解释为什么需要这个 Mock。
- 为了“求稳”而进行 Mock。

## 总结

**Mock 是用于隔离的工具，而不是被测试的对象。**

如果 TDD 显示你在测试 Mock 行为，说明你走错了路。

修复方案：测试真实行为，或者质问自己为什么要用 Mock。
