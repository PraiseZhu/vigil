# Mivo PR 盯梢修复工具

同仓分支场景下的 PR 自动盯梢器：轮询你自己在某个仓库里打开的 PR，发现新的审查反馈 / CI 失败 /
与主干的冲突时，把这些信息整理成结构化任务，交给负责修复的下游（人工或 agent）处理；不做
合并、不开 auto-merge、不删远端分支、不代替维护者审批。

## 这是什么、不是什么

- **是**：一个只读轮询 + 状态机 + 修复动作封装的工具集。`mivo-watcher.mjs` 负责发现与轮询，
  `mivo-repair.mjs` 负责 clone/worktree/push 等具体修复动作，`mivo-ownership.mjs` 回答"这个 PR
  现在归哪个 session/任务管"。
- **不是**：不是可以配进任意 cron 的无状态脚本。discover 模式专门为 Cindy 桌面端的调度器
  ("script 模式")设计——`mivo-watch-script.py` 的 `main()` 会检查协议环境变量，没有就直接
  拒绝空跑。完整机制与安装步骤见根目录 [`README.md`](../../README.md#安装与部署) 和
  [`docs/architecture.md`](../../docs/architecture.md#调度依赖-cindy-桌面端的-script-模式调度器)。

## 快速开始

```sh
npm install   # 本项目无第三方依赖，这一步只是确认 Node 版本
npm test      # 跑全部测试（mivo + cindy 两套）
```

单独跑 mivo 这一套：

```sh
node --env-file=watchers/mivo/test.env --test watchers/mivo/*.test.mjs
```

## 配置：profile.mjs 的 fail-closed 机制

所有需要「你的仓库 / 你的本地路径」的地方，都通过 `bin/profile.mjs` 解析，优先级：

1. 对应的环境变量（见下表）
2. `<watcher home>/config/profile.json` 里的同名字段
3. 都没有 → **直接抛错**，错误信息里会写清楚该填哪个环境变量或 profile 字段。没有任何
   指向本机个人路径的默认值。

`watcher home` 的解析：`MIVO_WATCHER_HOME` 环境变量 > `bin/` 目录的上一级目录。

### 必填项

| profile 字段 | 环境变量 | 用途 |
|---|---|---|
| `targetRepo` | `MIVO_WATCHER_TARGET_REPO` | 要盯梢的 `owner/repo` |
| `pluginRepoPath` | `MIVO_PLUGIN_REPO`（函数内手动预检，不经过 `profile.mjs` 的 fail-closed 报错路径） | 本地插件/项目工作仓的绝对路径，`mivo-repair.mjs` 建 worktree 要用 |

### 可选项（有安全默认值）

| profile 字段 | 环境变量 | 默认值 |
|---|---|---|
| `watchHomes` | `MIVO_WATCHER_WATCH_HOMES`（逗号分隔） | `[]`（不内置任何路径） |
| `lifelineConfigPath` | `MIVO_WATCHER_LIFELINE_CONFIG` | 未配置时不接收本地 Doctor 任务 |

拷一份 [`config/examples/mivo.profile.example.json`](../../config/examples/mivo.profile.example.json)
到你的 watcher home 下的 `config/profile.json`，把占位值换成真实路径即可。`config/profile.json`
已在 `.gitignore` 里排除，不会被提交。

`lifelineConfigPath` 可连接同一目标仓的本地生命线 Doctor。配置必须由操作者提供绝对路径；
配置中的 `repo` 要与 `targetRepo` 相同，授权须为确认 P0/P1 的修复并允许 push。
接收器读取该配置的 `stateRoot/lifeline-state.json` 和 `evidenceRoot`，只接收实际 Ready PR
对应的已确认修复或调查中保留的未交付修复，核对 owner 世代、具体失败观察与失败证据文件 hash。
配置 `schemaVersion` 仍为 1。台账可读 schema 1 或 2；schema 2 必须有非空 `controlEpoch`，
缺陷须显式 `ownershipMode=legacy|work-item`，并把 epoch、归属与 `workId` 写入 proof。
缺字段不当成 legacy。使用前再次读真源，拒旧 epoch、错 workItem、换 owner 与调用者自填权限。
同一证据幂等去重并续交该 PR 的既有会话；修复 helper 在使用任务时再次读取来源和字节，
过期世代、已降级的记录、变更证据与调用者自填的权限标记均不能授权写代码。
普通作者评论仍按原来的调查权限处理；本地接入不改变 GitHub CI、审查或单写者要求，
不把队列接收或分支修复当作正式业务部署完成。

### 新版任务必需的 Keel 配置

| profile 字段 | 环境变量 | 要求 |
|---|---|---|
| `keelLedgerRoot` | `MIVO_KEEL_LEDGER_ROOT` | Keel 插件数据目录（包含 `runs/` 的那一层）；新派发的 `keelFlowVersion=2` 任务缺少此配置时，`finalize` 报 `KEEL_RUN_REQUIRED`，拒绝收口和推送 |

## 修复 session 的 Keel 流程

派给修复 session 的消息要求全程用 Cindy 的 Keel 插件（`ghost_id=keel`），不再用 goal skill：

- `prepare` 之后先 `pstack_start`，读取它返回的流程手册，再用 `pstack_ledger` 写入 `kind:"step"`、`summary:"vigil task=<dispatchId>"`，精确绑定当前任务。可改代码的任务使用 `bug-fix`，调查任务使用 `investigation`。
- 只允许 `jev`、`pstack_start`、`pstack_decide`、`pstack_ledger`、`pr_threads` 和手册；`pr_reply` 每次弹确认框、`pr_wait` 长轮询、`pr_status` 会读到作者转 Ready 时写的交接记录而停手，所以都禁止。GitHub 写操作仍只走 helper 与 `gh`。
- Jev 只在固定判断点给参考（严重度未知、CI 抖动还是真失败、P0/P1 不成立的证据、修法选择），不能单独授权改代码。
- 新版任务的适用判断点使用 `pstack_decide`，绑定同一个 `run_id`；仅有启动判断 J1/J2 或手写 `decision` 行不足以收口。
- `finalize --keel-run <run_id>` 在推送前读取 `runs/<run_id>/decisions.jsonl`。新版任务必须具有任务创建后的启动记录、精确绑定、实际处置判断，以及绑定当前 `validated-head` 的 `vigil-flow` 证据。缺配置、缺记录、任务或提交不匹配均报 `KEEL_RUN_REQUIRED`；结果的 `keel.contractVersion=2` 表示通过新版契约。
- 收口证据通过 `pstack_ledger` 的 `kind:"evidence"` 写入：`evidence` 包含 `kind:"vigil-flow"`、`version:2`、`taskId`、`head`、`playbook`、`manualPath`、`decisionRowIds` 和 `steps`。`decisionRowIds` 引用同一 run 中真实 `pstack_decide` 的台账行；`steps.reproduce`、`steps.repair` 写明实际复现/调查与处置证据；`steps.verify` 的 `head`、`receiptSha256` 必须匹配 helper `validate` 返回的验证收据。完整调用格式见派工消息。
- 全部 SC 为 `no-change` 且提交未变时，`steps.verify` 改为 `{status:"not-run",reason:"具体原因"}`，仍需调查证据和实际判断。后续同提交的 `recheck` 保留已验证的 `keel` 结果。
- 在途旧任务不改写：`keelFlow=true` 且没有 `keelFlowVersion` 的任务沿用 v1 绑定检查，缺台账配置时仍为 `disabled`；配置存在且任务没有 `keelFlow=true` 时为 `not-required-legacy-task`。这些旧契约结果不代表通过 v2。
- `prepare` 返回 `ciErrors`：失败必需检查所在 workflow run 的 `##[error]` 行（每个 run 最多 20 行），取不到时给出错误原因。

## CLI

```sh
# 发现：扫描 targetRepo 下你自己的 open PR,找出需要处理的
node bin/mivo-watcher.mjs                       # 默认 discover 模式
MIVO_WATCHER_MODE=poll MIVO_WATCHER_PR=<N> node bin/mivo-watcher.mjs   # 单独轮询一个 PR

# 修复动作:clone/worktree、push、清理
node bin/mivo-repair.mjs <子命令> --home "$MIVO_WATCHER_HOME"

# 查询某个 PR 当前归哪个任务/session 管
node bin/mivo-ownership.mjs --repo your-org/your-plugin-repo --pr 123 --home "$MIVO_WATCHER_HOME"
```

## 停止盯梢某个 PR

给该 PR 打标签 `mivo-watch:off`，发现器下一轮会跳过它。

## Mivo profile 约定（可按需适配）

以下严重度分级与标签名是这套工具原本运作所在团队（Mivo）的约定，代码里保留了这些具体名字，
但它们只是**可替换的配置**，不是协议的一部分：

- 审查反馈严重度 `P0`/`P1`/`P2`/`P3`:P0/P1 视为必须改代码才能回复;P2/P3 只需回复不改代码。
- 修复会话核实某条 P0/P1 讨论不成立(已验证完成的结果里该 key 为 `no-change` 且附证据)时,watcher 带证据回复并关闭该讨论;没有证据的不关。会话结果晚于上一次轮询写入时,即使 PR 指纹未变也会重新读取,避免任务停在 accepted、讨论永远挡住合并。等 CI 的复查需要约 15–20 秒;剩余扫描预算不足 40 秒时不硬跑(硬跑会被超时杀掉、排在后面的 PR 每轮同样失败),而是结束本轮并从该 PR 续扫,复查超时上限 60 秒。
- 本轮通过的标签名 `review:merge-ready`。
- 可信审查来源(自动触发修复的评论来源)在 `mivo-pr-policy.mjs` / `mivo-feedback-policy.mjs`
  里按来源名单判断,按需改成你自己团队的 Bot/Reviewer 名单。

如果你的团队用不同的分级或标签名,直接改这几个文件里的常量即可,不影响其余逻辑。

## 部署脚本（可选）

`deploy.mjs` 是一个无数据库依赖的「校验 + 原子安装」脚本,用于把 `bin/` 下的文件同步到某个
运行目录,并在安装前后做哈希校验、回滚。它不绑定任何具体调度器或数据库,`verify`/`bootstrap`/
`preview`/`apply` 四个子命令都是纯文件系统操作:

```sh
node deploy.mjs verify                                  # 只校验源码 manifest 闭包
node deploy.mjs bootstrap --home /path/to/runtime
node deploy.mjs preview  --home /path/to/runtime --database /path/to/some.db --id <release-id> --plan /tmp/plan.json
node deploy.mjs apply    --plan /tmp/plan.json
```

`--database` 参数指向一个 sqlite3 文件,`preview`/`apply` 会用它检查"目标 session 当前是否
空闲",这是可选的额外安全检查;如果你的场景不需要,可以直接改 `deploy.mjs` 里的 `idle()`
函数跳过这一步。

## 测试

```sh
node --env-file=watchers/mivo/test.env --test watchers/mivo/*.test.mjs
```

测试里用到的仓库名、路径、session id 均为占位数据(`example-org/example-plugin`、
`/tmp/...` 等),不对应任何真实仓库。
