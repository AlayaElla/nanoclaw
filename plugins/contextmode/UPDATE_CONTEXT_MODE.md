# NanoClaw Context-Mode 更新指引

由于 NanoClaw 使用了深度定制的 `context-mode` 插件（增加了中文分词、本地角色缓存快照等特性），我们的源码存放在项目根目录下的 `.context-mode-ref/` 中，并在构建容器时打包进入 Docker 镜像。

当上游（MKSGLU/context-mode）发布了新的功能或 Bug 修复时，可以按照以下标准流程来更新我们的定制版，同时保留我们本地的改动：

## 1. 拉取上游最新代码并 Rebase

首先进入 `.context-mode-ref` 目录下，获取上游的最新更新，并基于最新主分支重写我们的定制提交。

```bash
cd .context-mode-ref

# 如果还没有添加过 upstream 远程仓库，先执行：
git remote add upstream https://github.com/mksglu/context-mode.git

# 获取上游最新代码
git fetch upstream

# 将我们当前的本地提交（主要包含中文定制和 Session 挂载逻辑）变基到最新的上游 main 分支顶端
git rebase upstream/main
```

## 2. 解决潜在的合并冲突

如果上游修改了我们定制过的文件（主要集中在 `hooks/session-helpers.mjs` 和 `src/session/` 下的提取和分块逻辑），在 Rebase 过程中可能会遇到冲突。

**解决冲突时的重要原则：**
- **Session 隔离与挂载**：必须保留我们自定义的 `process.env.CONTEXT_MODE_HOME` 基础路径逻辑。这不仅为了让数据可以持久化保存到宿主机的 `workspace/group` 中，更能确保多个不同群组间的独立会话不交叉。
- **中文与提取正则**：上游对于英文的匹配规则如果发生变动可以接纳，但请务必保留或合并我们针对含有 `Roles`、中文人名提取以及正则表达式适配的部分。
- **MCP 工具参数限定**：由于底层存储引擎 (SQLite FTS5) 对中文分词的支持极差，我们在 `src/server.ts` 文件中对 `ctx_search`、`ctx_batch_execute`、`ctx_index` 等相关工具的 `source` 和 `queries` 字段明确追加了 `MUST USE ENGLISH ONLY, NO CHINESE.`。在应对 `src/server.ts` 的合并冲突时，请务必保证该强制英文说明不被抹除。
- **MCP 服务环境注入陷阱**：在维护 `agent-runner/src/index.ts` 中 `context-mode` 的 `env` 环境变量注入块时，请牢记两点血泪教训：
  1. **必须显式展开 `...process.env`**：在向子进程传递 `env` 覆盖对象时，如果没有显式展开宿主底层环境，容器内的 `PATH` 会被瞬间抹除，进而导致 MCP 服务因找不到 `node` 进程而上报致命的 `error_during_execution` 且直接崩溃退出。
  2. **警惕 `process.env.HOME` 伪装兜底**：在尝试将 `HOME` 重定向到持久化的 `/workspace/group` 时，切忌使用类似 `HOME: process.env.CONTEXT_MODE_HOME || process.env.HOME || '/workspace/group'` 这样的伪退路逻辑。因为 Docker 容器自身会为主体注入不可改变的 `HOME=/home/node`，这个值永远为真，使得最后真正安全的 `/workspace/group` 兜底彻底失效，最终导致高频查询索引数据库偷偷写入沙盒临时内存中然后在容器重启时集体暴毙。应当强制使用只认专属值或绑定路径的逻辑：`HOME: process.env.CONTEXT_MODE_HOME || '/workspace/group'`。

解决所有冲突后，继续：
```bash
git add .
git rebase --continue
```

## 3. (可选但推荐) 本地打包查错

在重新构建 NanoClaw 镜像之前，可以先在本地进行 NPM 和 Bun 的模块构建，以确保没有语法错误和依赖报错。

```bash
npm install
npm run build
npm run bundle
```

执行完毕后确保 `build/` 目录下生成了 `cli.bundle.mjs` 与 `server.bundle.mjs` 等最终产物且没有报错。

## 4. 重新构建 NanoClaw 容器镜像

**这是最关键的一步**。由于 NanoClaw 的运行环境是由 Docker 隔离的，宿主机的 `.context-mode-ref` 代码在运行时并不会被直接挂载，而是依赖于初始构建时的拷贝（`COPY`）。

返回 NanoClaw 根目录，执行构建脚本，这一步会将带有最新特性和我们自定义逻辑的 `context-mode-ref` 重新封入基础镜像：

```bash
cd ..
./container/build.sh
```

## 5. 重启 Agent 生效

当构建脚本提示 `Successfully tagged nanoclaw-agent:latest` 后，镜像就已经更新完毕。
你只需要重启当前的 NanoClaw 主服务或使用 `podman/docker restart <容器名>` 重启现有的 Agent 容器即可。Agent 容器在下一次随服务生成时，即会自动用上崭新的 `context-mode` 核心。
