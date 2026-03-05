# NanoClaw 技能架构

## 核心原则

技能是自包含的、可审计的包，通过标准 git 合并机制以编程方式应用。Claude Code 编排这个过程——运行 git 命令、读取技能清单、仅在 git 无法自行解决冲突时介入。系统使用现有的 git 功能（`merge-file`、`rerere`、`apply`）而不是自定义合并基础设施。

### 三级解决模型

系统中的每个操作都遵循以下升级：

1. **Git** — 确定性的，编程化的。`git merge-file` 合并，`git rerere` 重放缓存的解决方案，结构化操作无需合并即可应用。无 AI 参与。处理绝大多数情况。
2. **Claude Code** — 读取 `SKILL.md`、`.intent.md`、迁移指南和 `state.yaml` 来理解上下文。解决 git 无法编程化处理的冲突。通过 `git rerere` 缓存解决方案，因此永远不需要解决相同的冲突两次。
3. **用户** — 当 Claude Code 缺乏上下文或意图时询问用户。这发生在两个功能在应用层面真正冲突（不仅仅是文本层面的合并冲突）且需要人类决定期望行为时。

目标是第 1 级在成熟、经过充分测试的安装上处理一切。第 2 级处理首次冲突和边缘情况。第 3 级是罕见的，仅用于真正的歧义。

**重要**：干净的合并（退出码 0）不保证代码能工作。语义冲突——重命名的变量、移动的引用、更改的函数签名——可以产生在运行时破坏的干净文本合并。**每次操作后都必须运行测试**，无论合并是否干净。带有失败测试的干净合并升级到第 2 级。

### 通过备份/恢复的安全操作

许多用户克隆仓库但不 fork，不提交更改，也不认为自己是 git 用户。系统必须在不要求任何 git 知识的情况下为他们安全工作。

在任何操作之前，系统将所有将被修改的文件复制到 `.nanoclaw/backup/`。成功时删除备份。失败时恢复备份。这提供了回滚安全性，无论用户是否提交、推送或理解 git。

---

## 1. 共享基线

`.nanoclaw/base/` 保存干净的核心——在任何技能或定制应用之前的原始代码库。这是所有三路合并的稳定共同祖先，仅在核心更新时更改。

- `git merge-file` 使用基线计算两个差异：用户更改了什么（当前 vs 基线）和技能想要更改什么（基线 vs 技能的修改文件），然后合并两者
- 基线实现漂移检测：如果文件的哈希与基线哈希不同，说明有东西被修改了（技能、用户定制或两者兼有）
- 每个技能的 `modify/` 文件包含文件应用了该技能后的完整内容（包括任何前置技能的更改），全部针对相同的干净核心基线编写

在**全新代码库**上，用户的文件与基线完全相同。这意味着 `git merge-file` 对第一个技能总是干净退出——合并简单地产生技能的修改版本。无需特殊处理。

当多个技能修改同一文件时，三路合并自然处理重叠。如果 Telegram 和 Discord 都修改 `src/index.ts`，且两个技能文件都包含 Telegram 的更改，这些共同更改会对照基线干净合并。结果是基线 + 所有技能更改 + 用户定制。

---

## 2. 两种变更类型：代码合并 vs. 结构化操作

不是所有文件都应该作为文本合并。系统区分**代码文件**（通过 `git merge-file` 合并）和**结构化数据**（通过确定性操作修改）。

### 代码文件（三路合并）

技能编织逻辑的源代码文件——路由处理器、中间件、业务逻辑。使用 `git merge-file` 对照共享基线合并。技能携带文件的完整修改版本。

### 结构化数据（确定性操作）

像 `package.json`、`docker-compose.yml`、`.env.example` 和生成的配置这样的文件不是你合并的代码——它们是你聚合的结构化数据。多个技能向 `package.json` 添加 npm 依赖不应该需要三路文本合并。相反，技能在清单中声明其结构化需求，系统以编程方式应用。

**结构化操作是隐式的。** 如果技能声明了 `npm_dependencies`，系统自动处理依赖安装。无需技能作者在 `post_apply` 中添加 `npm install`。当多个技能按顺序应用时，系统批量处理结构化操作：先合并所有依赖声明，写一次 `package.json`，最后运行一次 `npm install`。

```yaml
# 在 manifest.yaml 中
structured:
  npm_dependencies:
    whatsapp-web.js: "^2.1.0"
    qrcode-terminal: "^0.12.0"
  env_additions:
    - WHATSAPP_TOKEN
    - WHATSAPP_VERIFY_TOKEN
    - WHATSAPP_PHONE_ID
  docker_compose_services:
    whatsapp-redis:
      image: redis:alpine
      ports: ["6380:6379"]
```

### 结构化操作冲突

结构化操作消除了文本合并冲突，但仍然可能在语义层面冲突：

- **NPM 版本冲突**：两个技能请求同一包的不兼容 semver 范围
- **端口冲突**：两个 docker-compose 服务声明同一主机端口
- **服务名称冲突**：两个技能定义同名的服务
- **环境变量重复**：两个技能声明同一变量但有不同期望

解决策略：

1. **尽可能自动**：扩大 semver 范围寻找兼容版本，检测并标记端口/名称冲突
2. **第 2 级（Claude Code）**：如果自动解决失败，Claude 基于技能意图提出选项
3. **第 3 级（用户）**：如果是真正的产品选择（哪个 Redis 实例应该获得端口 6379？），询问用户

结构化操作冲突与代码文件重叠一起包含在 CI 重叠图中，因此维护者的测试矩阵会在用户遇到之前捕获这些。

### 状态记录结构化结果

`state.yaml` 不仅记录声明的依赖，还记录解决的结果——实际安装的版本、解决的端口分配、最终的环境变量列表。这使结构化操作可重放和可审计。

### 确定性序列化

所有结构化输出（YAML、JSON）使用稳定序列化：排序的键、一致的引号、规范化的空白。这防止了 git 历史中因非功能性格式更改而产生的噪音差异。

---

## 3. 技能包结构

技能只包含它添加或修改的文件。对于修改的代码文件，技能携带**完整的修改文件**（干净核心加上技能的更改）。

```
skills/
  add-whatsapp/
    SKILL.md                          # 上下文、意图、这个技能做什么以及为什么
    manifest.yaml                     # 元数据、依赖、环境变量、应用后步骤
    tests/                            # 该技能的集成测试
      whatsapp.test.ts
    add/                              # 新文件 — 直接复制
      src/channels/whatsapp.ts
      src/channels/whatsapp.config.ts
    modify/                           # 修改的代码文件 — 通过 git merge-file 合并
      src/
        server.ts                     # 完整文件：干净核心 + whatsapp 更改
        server.ts.intent.md           # "添加 WhatsApp webhook 路由和消息处理器"
        config.ts                     # 完整文件：干净核心 + whatsapp 配置选项
        config.ts.intent.md           # "添加 WhatsApp 渠道配置块"
```

### 为什么使用完整修改文件

- `git merge-file` 需要三个完整文件——无需中间重构步骤
- Git 的三路合并使用上下文匹配，因此即使用户移动了代码它仍然有效——不像基于行号的差异会立即破坏
- 可审计：`diff .nanoclaw/base/src/server.ts skills/add-whatsapp/modify/src/server.ts` 精确显示技能更改了什么
- 确定性：相同的三个输入总是产生相同的合并结果
- 大小可以忽略，因为 NanoClaw 的核心文件很小

### 意图文件

每个修改的代码文件有一个对应的 `.intent.md`，带有结构化标题：

```markdown
# 意图：server.ts 修改

## 这个技能添加了什么
向 Express 服务器添加 WhatsApp webhook 路由和消息处理器。

## 关键部分
- 在 `/webhook/whatsapp` 注册路由（POST 和 GET 用于验证）
- 在认证和响应管道之间的消息处理中间件

## 不变量
- 不能干扰其他渠道的 webhook 路由
- 认证中间件必须在 WhatsApp 处理器之前运行
- 错误处理必须传播到全局错误处理器

## 必须保留的部分
- webhook 验证流程（GET 路由）是 WhatsApp Cloud API 所要求的
```

结构化标题（什么、关键部分、不变量、必须保留）为 Claude Code 在冲突解决期间提供具体指导，而不是要求它从非结构化文本中推断。

### 清单格式

```yaml
# --- 必填字段 ---
skill: whatsapp
version: 1.2.0
description: "通过 Cloud API 的 WhatsApp Business API 集成"
core_version: 0.1.0               # 此技能编写时的核心版本

# 此技能添加的文件
adds:
  - src/channels/whatsapp.ts
  - src/channels/whatsapp.config.ts

# 此技能修改的代码文件（三路合并）
modifies:
  - src/server.ts
  - src/config.ts

# 文件操作（重命名、删除、移动 — 见第 5 节）
file_ops: []

# 结构化操作（确定性，无合并 — 隐式处理）
structured:
  npm_dependencies:
    whatsapp-web.js: "^2.1.0"
    qrcode-terminal: "^0.12.0"
  env_additions:
    - WHATSAPP_TOKEN
    - WHATSAPP_VERIFY_TOKEN
    - WHATSAPP_PHONE_ID

# 技能关系
conflicts: []              # 不能共存而不需 agent 解决的技能
depends: []                # 必须先应用的技能

# 测试命令 — 应用后运行以验证技能工作
test: "npx vitest run src/channels/whatsapp.test.ts"

# --- 未来字段（v0.1 中尚未实现） ---
# author: nanoclaw-team
# license: MIT
# min_skills_system_version: "0.1.0"
# tested_with: [telegram@1.0.0]
# post_apply: []
```

注意：`post_apply` 仅用于无法表达为结构化声明的操作。依赖安装**永远不**在 `post_apply` 中——它由结构化操作系统隐式处理。

---

## 4. 技能、定制与分层

### 一个技能，一条快乐路径

技能实现**一种做事方式——涵盖 80% 用户的合理默认方案。** `add-telegram` 给你一个干净、可靠的 Telegram 集成。它不会试图用预定义的配置选项和模式来预测每一个用例。

### 定制就是更多的补丁

整个系统围绕对代码库应用变换构建。应用技能后自定义它与其他任何修改没有区别：

- **应用技能** — 获取标准 Telegram 集成
- **从那里修改** — 使用定制流程（跟踪的补丁）、直接编辑（通过哈希跟踪检测），或应用在其上构建的额外技能

### 分层技能

技能可以构建在其他技能之上：

```
add-telegram                    # 核心 Telegram 集成（快乐路径）
  ├── telegram-reactions        # 添加反应处理（depends: [telegram]）
  ├── telegram-multi-bot        # 多个 bot 实例（depends: [telegram]）
  └── telegram-filters          # 自定义消息过滤（depends: [telegram]）
```

每一层是一个独立的技能，有自己的 `SKILL.md`、清单（带 `depends: [telegram]`）、测试和修改文件。用户通过叠加技能来精确组合他们想要的。

### 自定义技能应用

用户可以在单步中带着自己的修改应用技能：

1. 正常应用技能（编程式合并）
2. Claude Code 询问用户是否要做任何修改
3. 用户描述他们想要的不同之处
4. Claude Code 在刚应用的技能之上进行修改
5. 修改被记录为绑定到此技能的自定义补丁

记录在 `state.yaml` 中：

```yaml
applied_skills:
  - skill: telegram
    version: 1.0.0
    custom_patch: .nanoclaw/custom/telegram-group-only.patch
    custom_patch_description: "限制 bot 只在群聊中响应"
```

重放时，技能以编程方式应用，然后自定义补丁应用在其上。

---

## 5. 文件操作：重命名、删除、移动

核心更新和某些技能需要重命名、删除或移动文件。这些不是文本合并——它们是作为显式脚本化操作处理的结构性更改。

### 清单中的声明

```yaml
file_ops:
  - type: rename
    from: src/server.ts
    to: src/app.ts
  - type: delete
    path: src/deprecated/old-handler.ts
  - type: move
    from: src/utils/helpers.ts
    to: src/lib/helpers.ts
```

### 执行顺序

文件操作在代码合并**之前**运行，因为合并需要针对正确的文件路径：

1. 预检查（状态验证、核心版本、依赖、冲突、漂移检测）
2. 获取操作锁
3. **备份**所有将被修改的文件
4. **文件操作**（重命名、删除、移动）
5. 从 `add/` 复制新文件
6. 三路合并修改的代码文件
7. 冲突解决（rerere 自动解决，或以 `backupPending: true` 返回）
8. 应用结构化操作（npm 依赖、环境变量、docker-compose — 批量处理）
9. 运行 `npm install`（一次，如果有任何结构化 npm_dependencies）
10. 更新状态（记录技能应用、文件哈希、结构化结果）
11. 运行测试（如果 `manifest.test` 已定义；失败时回滚状态 + 备份）
12. 清理（成功时删除备份，释放锁）

### 技能的路径重映射

当核心重命名文件（例如 `server.ts` → `app.ts`）时，针对旧路径编写的技能仍在其 `modifies` 和 `modify/` 目录中引用 `server.ts`。**技能包永远不会在用户机器上被修改。**

相反，核心更新附带一个**兼容性映射**：

```yaml
# 在更新包中
path_remap:
  src/server.ts: src/app.ts
  src/old-config.ts: src/config/main.ts
```

系统在应用时解析路径：如果技能目标是 `src/server.ts` 且重映射表明它现在是 `src/app.ts`，合并就针对 `src/app.ts` 运行。重映射记录在 `state.yaml` 中以保持未来操作的一致性。

### 安全检查

执行文件操作前：

- 验证源文件存在
- 对于删除：如果文件有超出基线的修改（用户或技能更改会丢失）则发出警告

---

## 6. 应用流程

当用户在 Claude Code 中运行技能的斜杠命令时：

### 第 1 步：预检查

- 核心版本兼容性
- 依赖已满足
- 与已应用技能无不可解决的冲突
- 检查未跟踪的更改（见第 9 节）

### 第 2 步：备份

将所有将被修改的文件复制到 `.nanoclaw/backup/`。如果操作在任何时候失败，从备份恢复。

### 第 3 步：文件操作

执行重命名、删除或移动，带安全检查。必要时应用路径重映射。

### 第 4 步：应用新文件

```bash
cp skills/add-whatsapp/add/src/channels/whatsapp.ts src/channels/whatsapp.ts
```

### 第 5 步：合并修改的代码文件

对 `modifies` 中的每个文件（应用路径重映射后）：

```bash
git merge-file src/server.ts .nanoclaw/base/src/server.ts skills/add-whatsapp/modify/src/server.ts
```

- **退出码 0**：干净合并，继续
- **退出码 > 0**：文件中有冲突标记，继续到解决阶段

### 第 6 步：冲突解决（三级）

1. **检查共享解决方案缓存**（`.nanoclaw/resolutions/`）— 如果存在此技能组合的已验证解决方案，加载到本地 `git rerere`。**仅在输入哈希完全匹配时应用**（基线哈希 + 当前哈希 + 技能修改哈希）。
2. **`git rerere`** — 检查本地缓存。如果找到，自动应用。完成。
3. **Claude Code** — 读取冲突标记 + `SKILL.md` + 当前和之前应用技能的 `.intent.md`（不变量、必须保留部分）。解决。`git rerere` 缓存解决方案。
4. **用户** — 如果 Claude Code 无法确定意图，询问用户期望的行为。

### 第 7 步：应用结构化操作

收集所有结构化声明（来自此技能和任何之前应用的技能，如果批量处理）。确定性地应用：

- 将 npm 依赖合并到 `package.json`（检查版本冲突）
- 将环境变量追加到 `.env.example`
- 合并 docker-compose 服务（检查端口/名称冲突）
- 最后运行一次 `npm install`
- 在状态中记录解决的结果

### 第 8 步：应用后和验证

1. 运行任何 `post_apply` 命令（仅非结构化操作）
2. 更新 `.nanoclaw/state.yaml` — 技能记录、每文件哈希（基线、技能、合并后）、结构化结果
3. **运行技能测试** — 必须，即使所有合并都是干净的
4. 如果测试在干净合并上失败 → 升级到第 2 级（Claude Code 诊断语义冲突）

### 第 9 步：清理

如果测试通过，删除 `.nanoclaw/backup/`。操作完成。

如果测试失败且第 2 级无法解决，从 `.nanoclaw/backup/` 恢复并报告失败。

---

## 7. 共享解决方案缓存

### 问题

`git rerere` 默认是本地的。但 NanoClaw 有成千上万的用户应用相同的技能组合。每个用户遇到相同的冲突并等待 Claude Code 解决是浪费的。

### 解决方案

NanoClaw 在 `.nanoclaw/resolutions/` 中维护一个经过验证的解决方案缓存，随项目一起发布。这是共享的产物——**不是** `.git/rr-cache/`，那个保持本地。

```
.nanoclaw/
  resolutions/
    whatsapp@1.2.0+telegram@1.0.0/
      src/
        server.ts.resolution
        server.ts.preimage
        config.ts.resolution
        config.ts.preimage
      meta.yaml
```

### 哈希强制

缓存的解决方案**仅在输入哈希完全匹配时应用**：

```yaml
# meta.yaml
skills:
  - whatsapp@1.2.0
  - telegram@1.0.0
apply_order: [whatsapp, telegram]
core_version: 0.6.0
resolved_at: 2026-02-15T10:00:00Z
tested: true
test_passed: true
resolution_source: maintainer
input_hashes:
  base: "aaa..."
  current_after_whatsapp: "bbb..."
  telegram_modified: "ccc..."
output_hash: "ddd..."
```

如果任何输入哈希不匹配，缓存的解决方案被跳过，系统继续到第 2 级。

### 已验证：rerere + merge-file 需要索引适配器

`git rerere` **不**原生识别 `git merge-file` 的输出。这在 Phase 0 测试中得到验证（`tests/phase0-merge-rerere.sh`，33 个测试）。

问题不在于冲突标记格式——`merge-file` 使用文件名作为标签（`<<<<<<< current.ts`）而 `git merge` 使用分支名（`<<<<<<< HEAD`），但 rerere 去除所有标签并仅对冲突体进行哈希。格式是兼容的。

实际问题：**rerere 需要未合并的索引条目**（阶段 1/2/3）来检测合并冲突的存在。正常的 `git merge` 自动创建这些。`git merge-file` 仅在文件系统上操作，不触及索引。

#### 适配器

在 `git merge-file` 产生冲突后，系统必须创建 rerere 期望的索引状态：

```bash
# 1. 运行合并（在工作树中产生冲突标记）
git merge-file current.ts .nanoclaw/base/src/file.ts skills/add-whatsapp/modify/src/file.ts

# 2. 如果退出码 > 0（冲突），设置 rerere 适配器：

# 为三个版本创建 blob 对象
base_hash=$(git hash-object -w .nanoclaw/base/src/file.ts)
ours_hash=$(git hash-object -w skills/previous-skill/modify/src/file.ts)  # 或合并前的当前文件
theirs_hash=$(git hash-object -w skills/add-whatsapp/modify/src/file.ts)

# 在阶段 1（基线）、2（我们的）、3（他们的）创建未合并索引条目
printf '100644 %s 1\tsrc/file.ts\0' "$base_hash" | git update-index --index-info
printf '100644 %s 2\tsrc/file.ts\0' "$ours_hash" | git update-index --index-info
printf '100644 %s 3\tsrc/file.ts\0' "$theirs_hash" | git update-index --index-info

# 设置合并状态（rerere 检查 MERGE_HEAD）
echo "$(git rev-parse HEAD)" > .git/MERGE_HEAD
echo "skill merge" > .git/MERGE_MSG

# 3. 现在 rerere 可以看到冲突
git rerere  # 记录 preimage，或从缓存自动解决

# 4. 解决后（手动或自动）：
git add src/file.ts
git rerere  # 记录 postimage（缓存解决方案）

# 5. 清理合并状态
rm .git/MERGE_HEAD .git/MERGE_MSG
git reset HEAD
```

#### 已验证的关键属性

- **冲突体一致性**：`merge-file` 和 `git merge` 对相同输入产生相同的冲突体。Rerere 仅对体进行哈希，因此从任一来源学习的解决方案可互换。
- **哈希确定性**：相同的冲突总是产生相同的 rerere 哈希。这对共享解决方案缓存至关重要。
- **解决方案可移植性**：将 `preimage` 和 `postimage` 文件（加上哈希目录名）从一个仓库的 `.git/rr-cache/` 复制到另一个有效。Rerere 在目标仓库中自动解决。
- **相邻行敏感性**：`merge-file` 将约 3 行以内的更改视为单个冲突块。修改文件同一区域的技能即使修改不同行也会冲突。这是预期的，由解决方案缓存处理。

#### 含义：需要 Git 仓库

适配器需要 `git hash-object`、`git update-index` 和 `.git/rr-cache/`。这意味着项目目录必须是 git 仓库才能使 rerere 缓存工作。下载 zip（无 `.git/`）的用户失去解决方案缓存但不失去功能——冲突直接升级到第 2 级（Claude Code 解决）。系统应检测此情况并优雅地跳过 rerere 操作。

### 维护者工作流

发布核心更新或新技能版本时：

1. 在目标核心版本上的全新代码库
2. 逐个应用每个官方技能——验证干净合并，运行测试
3. 对**至少修改一个共同文件或有重叠结构化操作的技能**应用成对组合
4. 基于流行度和高重叠度应用精选的三技能组合
5. 解决所有冲突（代码和结构化）
6. 记录所有带输入哈希的解决方案
7. 为每个组合运行完整测试套件
8. 随版本发布经过验证的解决方案

标准：**拥有任何常见官方技能组合的用户永远不应遇到未解决的冲突。**

---

## 8. 状态跟踪

`.nanoclaw/state.yaml` 记录安装的所有信息：

```yaml
skills_system_version: "0.1.0"     # Schema 版本 — 工具在任何操作前检查此项
core_version: 0.1.0

applied_skills:
  - name: telegram
    version: 1.0.0
    applied_at: 2026-02-16T22:47:02.139Z
    file_hashes:
      src/channels/telegram.ts: "f627b9cf..."
      src/channels/telegram.test.ts: "400116769..."
      src/config.ts: "9ae28d1f..."
      src/index.ts: "46dbe495..."
      src/routing.test.ts: "5e1aede9..."
    structured_outcomes:
      npm_dependencies:
        grammy: "^1.39.3"
      env_additions:
        - TELEGRAM_BOT_TOKEN
        - TELEGRAM_ONLY
      test: "npx vitest run src/channels/telegram.test.ts"

  - name: discord
    version: 1.0.0
    applied_at: 2026-02-17T17:29:37.821Z
    file_hashes:
      src/channels/discord.ts: "5d669123..."
      src/channels/discord.test.ts: "19e1c6b9..."
      src/config.ts: "a0a32df4..."
      src/index.ts: "d61e3a9d..."
      src/routing.test.ts: "edbacb00..."
    structured_outcomes:
      npm_dependencies:
        discord.js: "^14.18.0"
      env_additions:
        - DISCORD_BOT_TOKEN
        - DISCORD_ONLY
      test: "npx vitest run src/channels/discord.test.ts"

custom_modifications:
  - description: "添加了自定义日志中间件"
    applied_at: 2026-02-15T12:00:00Z
    files_modified:
      - src/server.ts
    patch_file: .nanoclaw/custom/001-logging-middleware.patch
```

**v0.1 实现说明：**
- `file_hashes` 为每个文件存储单个 SHA-256 哈希（最终合并结果）。三部分哈希（基线/技能修改/合并）计划在未来版本中改进漂移诊断。
- 已应用技能使用 `name` 作为键字段（非 `skill`），与 TypeScript `AppliedSkill` 接口匹配。
- `structured_outcomes` 存储原始清单值加上 `test` 命令。已解决的 npm 版本（实际安装版本 vs semver 范围）尚未跟踪。
- `installed_at`、`last_updated`、`path_remap`、`rebased_at`、`core_version_at_apply`、`files_added` 和 `files_modified` 等字段计划在未来版本中添加。

---

## 9. 未跟踪的更改

如果用户直接编辑文件，系统通过哈希比较检测。

### 检测时机

在**任何修改代码库的操作**之前：应用技能、移除技能、更新核心、重放或变基。

### 发生什么

```
检测到 src/server.ts 的未跟踪更改。
[1] 记录为自定义修改（推荐）
[2] 继续（更改保留，但不跟踪以供未来重放）
[3] 中止
```

系统永远不阻塞或丢失工作。选项 1 生成补丁并记录它，使更改可重现。选项 2 保留更改但它们不会在重放中保留。

### 恢复保证

无论用户在系统外多大程度地修改了代码库，三级模型始终可以恢复：

1. **Git**：对比当前文件与基线，识别更改了什么
2. **Claude Code**：读取 `state.yaml` 了解应用了哪些技能，与实际文件状态比较，识别差异
3. **用户**：Claude Code 询问他们的意图，保留什么，丢弃什么

不存在不可恢复的状态。

---

## 10. 核心更新

核心更新必须尽可能编程化。NanoClaw 团队负责确保更新能干净地应用到常见的技能组合上。

### 补丁和迁移

大多数核心更改——错误修复、性能改进、新功能——通过三路合并自动传播。无需特殊处理。

**破坏性更改**——更改的默认值、移除的功能、移到技能中的功能——需要**迁移**。迁移是一个保留旧行为的技能，针对新核心编写。在更新期间自动应用，这样用户的设置不会改变。

维护者在进行破坏性更改时的责任：在核心中做更改，编写一个恢复它的迁移技能，在 `migrations.yaml` 中添加条目，测试它。这就是破坏性更改的代价。

### `migrations.yaml`

仓库根目录中的仅追加文件。每个条目记录一个破坏性更改和保留旧行为的技能：

```yaml
- since: 0.6.0
  skill: apple-containers@1.0.0
  description: "保留 Apple Containers（0.6 中默认改为 Docker）"

- since: 0.7.0
  skill: add-whatsapp@2.0.0
  description: "保留 WhatsApp（0.7 中从核心移至技能）"

- since: 0.8.0
  skill: legacy-auth@1.0.0
  description: "保留旧认证模块（0.8 中从核心移除）"
```

迁移技能是 `skills/` 目录中的常规技能。它们有清单、意图文件、测试——一应俱全。它们针对**新**核心版本编写：修改的文件是新核心加上特定破坏性更改被恢复，其他所有内容（错误修复、新功能）与新核心相同。

### 迁移在更新期间如何工作

1. 三路合并引入新核心的所有内容——补丁、破坏性更改、全部
2. 冲突解决（正常）
3. 重新应用自定义补丁（正常）
4. **更新基线为新核心**
5. 过滤 `migrations.yaml` 中 `since` > 用户旧 `core_version` 的条目
6. **使用正常应用流程对照新基线应用每个迁移技能**
7. 在 `state.yaml` 中记录迁移技能，与其他技能一样
8. 运行测试

第 6 步就是用于任何技能的相同应用函数。迁移技能对照新基线合并：

- **基线**：新核心（例如 v0.8 带 Docker）
- **当前**：更新合并后的用户文件（新核心 + 早期合并保留的用户定制）
- **其他**：迁移技能的文件（新核心加 Docker 恢复为 Apple，其他所有内容相同）

三路合并正确保留用户的定制，恢复破坏性更改，并保留所有错误修复。如有冲突，正常解决：缓存 → Claude → 用户。

对于大版本跳跃（v0.5 → v0.8），所有适用的迁移按顺序应用。迁移技能针对最新核心版本维护，因此它们总是与当前代码库正确组合。

### 用户看到什么

```
核心已更新：0.5.0 → 0.8.0
  ✓ 所有补丁已应用

  保留你当前的设置：
    + apple-containers@1.0.0
    + add-whatsapp@2.0.0
    + legacy-auth@1.0.0

  技能更新：
    ✓ add-telegram 1.0.0 → 1.2.0

  要接受新默认值：/remove-skill <name>
  ✓ 所有测试通过
```

更新期间没有提示，没有选择。用户的设置不会改变。如果他们以后想接受新默认值，移除迁移技能即可。

### 核心团队随更新发布什么

```
updates/
  0.5.0-to-0.6.0/
    migration.md                  # 更改了什么、为什么、如何影响技能
    files/                        # 新的核心文件
    file_ops:                     # 任何重命名、删除、移动
    path_remap:                   # 旧技能路径的兼容性映射
    resolutions/                  # 官方技能的预计算解决方案
```

加上添加到 `skills/` 的新迁移技能和追加到 `migrations.yaml` 的条目。

### 维护者流程

1. **做核心更改**
2. **如果是破坏性更改**：针对新核心编写迁移技能，在 `migrations.yaml` 中添加条目
3. **编写 `migration.md`** — 更改了什么、为什么、哪些技能可能受影响
4. **对照新核心逐个测试每个官方技能**（包括迁移技能）
5. **对共享修改文件或结构化操作的技能进行成对测试**
6. **基于流行度和重叠度测试精选的三技能组合**
7. **解决所有冲突**
8. **记录所有带强制输入哈希的解决方案**
9. **运行完整测试套件**
10. **发布所有内容** — 迁移指南、迁移技能、文件操作、路径重映射、解决方案

标准：**补丁静默应用。破坏性更改通过迁移技能自动保留。用户永远不应对其工作设置的更改感到惊讶。**

### 更新流程（完整）

#### 第 1 步：预检查

- 检查未跟踪的更改
- 读取 `state.yaml`
- 加载附带的解决方案
- 解析 `migrations.yaml`，过滤适用的迁移

#### 第 2 步：预览

在修改任何内容之前，向用户展示即将发生的事情。仅使用 git 命令——不打开或更改文件：

```bash
# 计算共同基线
BASE=$(git merge-base HEAD upstream/$BRANCH)

# 自上次同步以来的上游提交
git log --oneline $BASE..upstream/$BRANCH

# 上游更改的文件
git diff --name-only $BASE..upstream/$BRANCH
```

按影响分组展示摘要：

```
可用更新：0.5.0 → 0.8.0（12 个提交）

  源代码：4 个文件修改（server.ts, config.ts, ...）
  技能：2 个新技能添加，1 个技能更新
  配置：package.json, docker-compose.yml 更新

  迁移（自动应用以保留你的设置）：
    + apple-containers@1.0.0（容器默认改为 Docker）
    + add-whatsapp@2.0.0（WhatsApp 从核心移至技能）

  技能更新：
    add-telegram 1.0.0 → 1.2.0

  [1] 继续更新
  [2] 中止
```

如果用户中止，到此停止。没有任何内容被修改。

#### 第 3 步：备份

将所有将被修改的文件复制到 `.nanoclaw/backup/`。

#### 第 4 步：文件操作和路径重映射

应用重命名、删除、移动。在状态中记录路径重映射。

#### 第 5 步：三路合并

对每个更改的核心文件：

```bash
git merge-file src/server.ts .nanoclaw/base/src/server.ts updates/0.5.0-to-0.6.0/files/src/server.ts
```

#### 第 6 步：冲突解决

1. 附带的解决方案（哈希验证） → 自动
2. `git rerere` 本地缓存 → 自动
3. Claude Code 配合 `migration.md` + 技能意图 → 解决
4. 用户 → 仅用于真正的歧义

#### 第 7 步：重新应用自定义补丁

```bash
git apply --3way .nanoclaw/custom/001-logging-middleware.patch
```

使用 `--3way` 允许 git 在行号漂移时回退到三路合并。如果 `--3way` 失败，升级到第 2 级。

#### 第 8 步：更新基线

`.nanoclaw/base/` 替换为新的干净核心。这是基线更改的**唯一时刻**。

#### 第 9 步：应用迁移技能

对每个适用的迁移（`since` > 旧 `core_version`），使用正常应用流程对照新基线应用迁移技能。记录在 `state.yaml` 中。

#### 第 10 步：重新应用更新的技能

技能存在于仓库中，随核心文件一起更新。更新后，将磁盘上每个技能 `manifest.yaml` 中的版本与 `state.yaml` 中记录的版本进行比较。

对于磁盘上版本比记录版本新的每个技能：

1. 使用正常应用流程对照新基线重新应用该技能
2. 三路合并引入技能的新更改，同时保留用户定制
3. 重新应用绑定到该技能的任何自定义补丁（`git apply --3way`）
4. 更新 `state.yaml` 中的版本

版本未变的技能被跳过——无需操作。

如果用户有一个自定义补丁在一个显著变化的技能上，补丁可能冲突。正常解决：缓存 → Claude → 用户。

#### 第 11 步：重新运行结构化操作

对照更新的代码库重新计算结构化操作以确保一致性。

#### 第 12 步：验证

- 运行所有技能测试 — 必须
- 兼容性报告：

```
核心已更新：0.5.0 → 0.8.0
  ✓ 所有补丁已应用

  迁移：
    + apple-containers@1.0.0（保留容器运行时）
    + add-whatsapp@2.0.0（WhatsApp 移至技能）

  技能更新：
    ✓ add-telegram 1.0.0 → 1.2.0（新功能已应用）
    ✓ custom/telegram-group-only — 干净地重新应用

  ✓ 所有测试通过
```

#### 第 13 步：清理

删除 `.nanoclaw/backup/`。

### 渐进式核心精简

迁移为随时间精简核心提供了一条清晰的路径。每个版本可以将更多功能移至技能：

- 破坏性更改从核心中移除功能
- 迁移技能为现有用户保留它
- 新用户从最小核心开始，添加他们需要的
- 随时间推移，`state.yaml` 精确反映每个用户正在运行的内容

---

## 11. 技能移除（卸载）

移除技能不是反向补丁操作。**卸载是不包含该技能的重放。**

### 工作原理

1. 读取 `state.yaml` 获取已应用技能和自定义修改的完整列表
2. 从列表中移除目标技能
3. 将当前代码库备份到 `.nanoclaw/backup/`
4. **从干净基线重放** — 按顺序应用每个剩余技能，应用自定义补丁，使用解决方案缓存
5. 运行所有测试
6. 如果测试通过，删除备份并更新 `state.yaml`
7. 如果测试失败，从备份恢复并报告

### 绑定到被移除技能的自定义补丁

如果被移除的技能在 `state.yaml` 中有 `custom_patch`，用户会被警告：

```
移除 telegram 也将丢弃自定义补丁："限制 bot 只在群聊中响应"
[1] 继续（丢弃自定义补丁）
[2] 中止
```

---

## 12. 变基

将累积的层展平为干净的起点。

### 变基做什么

1. 将用户当前的实际文件作为新的现实
2. 将 `.nanoclaw/base/` 更新为当前核心版本的干净文件
3. 对每个已应用的技能，对照新基线重新生成修改文件的差异
4. 使用 `rebased_at` 时间戳更新 `state.yaml`
5. 清除旧的自定义补丁（现在已融入）
6. 清除过期的解决方案缓存条目

### 何时变基

- 重大核心更新后
- 当累积的补丁变得难以管理时
- 在重大新技能应用之前
- 作为定期维护

### 权衡

**失去**：单个技能补丁历史、干净移除单个旧技能的能力、作为独立产物的旧自定义补丁

**获得**：干净的基线、更简单的未来合并、减少的缓存大小、全新起点

---

## 13. 重放

给定 `state.yaml`，在全新机器上无需 AI 干预即可重现完全相同的安装（假设所有解决方案已缓存）。

### 重放流程

```bash
# 完全编程化 — 无需 Claude Code

# 1. 安装指定版本的核心
nanoclaw-init --version 0.5.0

# 2. 将共享解决方案加载到本地 rerere 缓存
load-resolutions .nanoclaw/resolutions/

# 3. 对 applied_skills 中的每个技能（按顺序）：
for skill in state.applied_skills:
  # 文件操作
  apply_file_ops(skill)

  # 复制新文件
  cp skills/${skill.name}/add/* .

  # 合并修改的代码文件（带路径重映射）
  for file in skill.files_modified:
    resolved_path = apply_remap(file, state.path_remap)
    git merge-file ${resolved_path} .nanoclaw/base/${resolved_path} skills/${skill.name}/modify/${file}
    # git rerere 在需要时从共享缓存自动解决

  # 如果记录了，应用技能特定的自定义补丁
  if skill.custom_patch:
    git apply --3way ${skill.custom_patch}

# 4. 应用所有结构化操作（批量）
collect_all_structured_ops(state.applied_skills)
merge_npm_dependencies → 写一次 package.json
npm install 一次
merge_env_additions → 写一次 .env.example
merge_compose_services → 写一次 docker-compose.yml

# 5. 应用独立的自定义修改
for custom in state.custom_modifications:
  git apply --3way ${custom.patch_file}

# 6. 运行测试并验证哈希
run_tests && verify_hashes
```

---

## 14. 技能测试

每个技能包含集成测试，验证技能在应用后能正确工作。

### 结构

```
skills/
  add-whatsapp/
    tests/
      whatsapp.test.ts
```

### 测试验证什么

- **单个技能在全新核心上**：应用到干净代码库 → 测试通过 → 集成正常
- **技能功能**：功能确实工作
- **应用后状态**：文件在预期状态，`state.yaml` 正确更新

### 测试何时运行（始终）

- **应用技能后** — 即使所有合并都是干净的
- **核心更新后** — 即使所有合并都是干净的
- **卸载重放后** — 确认移除没有破坏剩余技能
- **在 CI 中** — 测试所有官方技能的单独和常见组合
- **重放期间** — 验证重放的状态

干净合并 ≠ 能工作的代码。测试是唯一可靠的信号。

### CI 测试矩阵

测试覆盖是**智能的，不是穷举的**：

- 每个官方技能逐个对照每个支持的核心版本
- **至少修改一个共同文件或有重叠结构化操作的技能的成对组合**
- 基于流行度和高重叠度的精选三技能组合
- 测试矩阵从清单的 `modifies` 和 `structured` 字段自动生成

每个通过的组合为共享缓存生成一个经过验证的解决方案条目。

---

## 15. 项目配置

### `.gitattributes`

随 NanoClaw 发布，减少噪音合并冲突：

```
* text=auto
*.ts text eol=lf
*.json text eol=lf
*.yaml text eol=lf
*.md text eol=lf
```

---

## 16. 目录结构

```
project/
  src/                              # 实际代码库
    server.ts
    config.ts
    channels/
      whatsapp.ts
      telegram.ts
  skills/                           # 技能包（Claude Code 斜杠命令）
    add-whatsapp/
      SKILL.md
      manifest.yaml
      tests/
        whatsapp.test.ts
      add/
        src/channels/whatsapp.ts
      modify/
        src/
          server.ts
          server.ts.intent.md
          config.ts
          config.ts.intent.md
    add-telegram/
      ...
    telegram-reactions/             # 分层技能
      ...
  .nanoclaw/
    base/                           # 干净核心（共享基线）
      src/
        server.ts
        config.ts
        ...
    state.yaml                      # 完整安装状态
    backup/                         # 操作期间的临时备份
    custom/                         # 自定义补丁
      telegram-group-only.patch
      001-logging-middleware.patch
      001-logging-middleware.md
    resolutions/                    # 共享的经过验证的解决方案缓存
      whatsapp@1.2.0+telegram@1.0.0/
        src/
          server.ts.resolution
          server.ts.preimage
        meta.yaml
  .gitattributes
```

---

## 17. 设计原则

1. **使用 git，不要重新发明它。** `git merge-file` 用于代码合并，`git rerere` 用于缓存解决方案，`git apply --3way` 用于自定义补丁。
2. **三级解决：git → Claude → 用户。** 编程化优先，AI 其次，人类最后。
3. **干净的合并不够。** 每次操作后运行测试。语义冲突可以通过文本合并存活。
4. **所有操作都是安全的。** 之前备份，失败时恢复。无半应用状态。
5. **一个共享基线。** `.nanoclaw/base/` 是任何技能或定制之前的干净核心。它是所有三路合并的稳定共同祖先。仅在核心更新时更新。
6. **代码合并 vs. 结构化操作。** 源代码三路合并。依赖、环境变量和配置以编程方式聚合。结构化操作是隐式的且批量处理的。
7. **解决方案被学习和共享。** 维护者解决冲突并发布带哈希强制的经过验证的解决方案。`.nanoclaw/resolutions/` 是共享产物。
8. **一个技能，一条快乐路径。** 无预定义配置选项。定制就是更多的补丁。
9. **技能分层和组合。** 核心技能提供基础。扩展技能添加功能。
10. **意图是一等公民且结构化的。** `SKILL.md`、`.intent.md`（什么、不变量、必须保留）和 `migration.md`。
11. **状态是显式且完整的。** 技能、自定义补丁、每文件哈希、结构化结果、路径重映射。重放是确定性的。漂移即时检测。
12. **始终可恢复。** 三级模型从任何起点重构一致状态。
13. **卸载就是重放。** 从干净基线重放，不包含该技能。备份以确保安全。
14. **核心更新是维护者的责任。** 测试、解决、发布。破坏性更改需要一个保留旧行为的迁移技能。破坏性更改的代价是编写和测试迁移。用户永远不应对其设置的更改感到惊讶。
15. **文件操作和路径重映射是一等公民。** 清单中的重命名、删除、移动。技能永远不被修改——路径在应用时解析。
16. **技能要测试。** 每个技能的集成测试。CI 按重叠度成对测试。测试始终运行。
17. **确定性序列化。** 排序的键、一致的格式。无噪音差异。
18. **需要时变基。** 展平层以获得干净起点。
19. **渐进式核心精简。** 破坏性更改将功能从核心移至迁移技能。现有用户自动保留已有功能。新用户从最小核心开始，添加他们需要的。