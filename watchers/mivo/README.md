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
| `reviewerLogin` | `MIVO_WATCHER_REVIEWER_LOGIN` | 审查流程提交 review 的 GitHub 账号（它的报告、发现问题的 review 与行内线程才被当作审查信号） |
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
投递去重沿用确认失败的身份，不把 schema 迁移或 epoch/workId 变化当新证据；完整 proof 仍绑定当前归属，旧 proof 不能因去重键相同而继续获权。
同一证据幂等去重并续交该 PR 的既有会话；修复 helper 在使用任务时再次读取来源和字节，
过期世代、已降级的记录、变更证据与调用者自填的权限标记均不能授权写代码。
普通作者评论仍按原来的调查权限处理；本地接入不改变 GitHub CI、审查或单写者要求，
不把队列接收或分支修复当作正式业务部署完成。

### 新版任务必需的 Keel 配置

| profile 字段 | 环境变量 | 要求 |
|---|---|---|
| `keelLedgerRoot` | `MIVO_KEEL_LEDGER_ROOT` | Keel 插件数据目录（包含 `runs/` 的那一层）；新派发的 `keelFlowVersion>=2` 任务缺少此配置时，`finalize` 报 `KEEL_RUN_REQUIRED`，拒绝收口和推送 |

## 修复 session 的 Keel 流程

### 作者交接与取回

**转 Ready 就是交接**（2026-10-15 起）。作者自己的 PR 不管是网页按钮、`gh pr ready` 还是 Keel `pr_ready` 转的 Ready，watcher 下一轮（≤5 分钟）就接手：没有评论回执时，按本次 Ready 代次和当前 HEAD 合成一份隐式回执（`implicit: true`），下游归属检查照常核对仓库、PR、作者和 Ready 代次。准入不再要求 CI 先全绿，必需检查失败和冲突直接成为修复反馈；审查流程不在线（`review-ingress-missing`）时才不接手。

下面的命令仍可用，作用变成「显式留一条交接记录」：

```sh
node "$MIVO_WATCHER_HOME/bin/mivo-handoff.mjs" handoff --repo your-org/your-plugin-repo --pr 123
```

命令核对当前 GitHub 账号为 PR 作者，并发布绑定仓库、PR、HEAD、本次 Ready 代次的结构化评论回执；重复调用复用同代次已有回执。Keel 交接车道配置 `handoffHelperPath` 后，`pr_ready` 会在转 Ready 后自动调用它。watcher 已按隐式回执接手的同代次 PR，后来发的回执不会换任务。

`inspect --repo <repo> --pr <number>` 只读返回当前 PR、Ready/Draft 代次、作者身份匹配情况及有效回执。`handoff --expected-head <SHA>` 在写回执前拒绝 HEAD 漂移。同代次手工重复回执不会替换 watcher 已采用的回执或撤销其任务。

作者需要继续修改时，先取回处理权，读回 `author-owned` 后再写：

```sh
node "$MIVO_WATCHER_HOME/bin/mivo-handoff.mjs" reclaim --repo your-org/your-plugin-repo --pr 123
```

`reclaim` 将 PR 转回 Draft 并确认结果。watcher 在 discover、poll 和 scan 入口观察到 Draft 时作废活动任务；修复 helper 每次读取 GitHub 的 Ready/Draft 代次，即使巡检错过中间的 Draft、HEAD 也未变化，旧任务仍会被拒绝。再次转 Ready 是新的交接：新代次、新任务，旧任务永远不能续用；修复轮次上限（6 轮）也按新代次重新计数。

修复会话每次改文件、提交或外发回复前执行 `mivo-repair.mjs assert-owner --home <home> --task <task>`。`prepare`、`validate` 前后、`finalize` 推送前和 CI 复查也执行同一归属检查。网络失败不放行，旧任务没有交接回执也不放行。已确认受控 push 的回执只允许同一任务继续验证/收口，不允许旧任务继续修改已推进的 HEAD。

受控 push 使用一次性 hooks 目录：先按 Git 原语执行原有 `pre-push`，再核验实际推送的 SHA/ref 和实时归属。作者在耗时预检期间转 Draft 时，Git 拒绝发布。原 hook 的参数、标准输入、失败退出码及其他 hooks 保留；结束后清除临时目录，不改持久 Git 配置。此入口需要支持 `git hook run --to-stdin` 的 Git；不支持时拒绝推送。GitHub 核验与远端 Git 接收不是原子事务，核验后瞬间取回的极短窗口仍无法靠客户端完全消除。

受控 push 可能先于结果回执可见。判断「HEAD 变了」的基准是本次交接认可过的最新 HEAD（`trustedHead`：Ready 时的 HEAD，之后每轮修复任务到达的 HEAD，以及任务派发时的 HEAD），所以第二轮及以后的修复不会被当成作者推送。同一 Ready 代次内，修复会话还在跑时出现的新 HEAD 先按 `head-change-unconfirmed` 等它自己的结果（最多 60 分钟），晚到的有效结果会重新触发消费，即使 PR 指纹没有再次变化。没有会话在跑、或等满 60 分钟，新 HEAD 就算作者自己的推送：没做完的任务作废、它负责的反馈重新投递；已经处理过的反馈不重投，也不额外消耗修复轮次；watcher 以新 HEAD 的隐式回执继续处理，不再永久暂停（事件 `author-push-superseded`）。真正的 Draft 或代次变化仍会永久撤销旧任务。

运行中的命令不能保证被立即打断；这些检查是协作式边界检查，不是宿主对任意文件写入的强制拦截。

### 反馈出口

- 审查账号的 P0/P1：修复会话修，修完 watcher 带证据回复并 resolve；不成立也带证据回复并 resolve。
- Greptile 的 P0/P1（`greptile-p1-triage`）：Greptile 按自己的标准打 P1，所以修复会话先按统一分级重新判定，确认是 P0/P1 才改代码；其余带核实依据回复并 resolve。
- Greptile、审查账号的 P2/P3：watcher 直接回复说明并 resolve，不开会话。
- 仓库成员（OWNER/MEMBER/COLLABORATOR，含作者本人）留的 review thread（`member-thread-triage`），以及严重度读不出、来源未核验的其他未解决 thread（`thread-triage`，含仓外人员和其他机器人）：交修复会话按统一分级判定，确认 P0/P1 才改代码；其余由 watcher 贴出会话写的结论并 resolve。目标是 PR 不因为一条没人处理的讨论卡在合并前。
- 产品意图：watcher 抓 PR 正文，优先取标题含「产品意图 / 设计意图 / Product intent」的一节（没有就取正文开头，最多 2000 字），写进任务的 `prSnapshot.prIntent` 和派工消息。反馈要求的改法会推翻 PR 正文、规格或维护者裁定里写明的界面、交互或流程时，它不算缺陷：会话不改代码，记 SC=no-change 并引用正文，watcher 回复后 resolve，继续推进。
- 全自动推进到可合并（不合并）：严重度拿不准时会话自己复现核实，确认不了 P0/P1 就按不成立回复并 resolve；Jev 不可用也不因此 blocked。只有缺权限、缺环境、外部服务故障、Keel 台账不可用、作者收回才 blocked。
- 卡住要让人看见：修复任务 blocked（外部阻塞、6 轮上限、补投三次无结果、结果无效、派发失败）时，watcher 在 PR 上发一条评论，按「发生了什么 / 对本 PR 意味着什么 / 需要谁做什么」写明原因并 @作者。同一 blocked 状态只发一次，发送失败下一轮重试（最多 3 次）。必需 CI 红、HEAD 漂移这类 watcher 自己会接着处理的状态不发。
- Greptile 汇总评论没有自己的 P0/P1 时不单独开会话（它的发现另以行内 thread 出现）。
- 策略读不出（`required-policy-unknown`）和可合并（`merge-ready`）各在状态转换时出一条事件。

`handoff.e2e.test.mjs` 在隔离子进程中运行真实 CLI、Git 和状态机，GitHub/Host 传输使用替身。它验证交接、投递、取回、遗漏 Draft 的代次检查与查询失败路径，不代表真实 Host 会话已被中断。

派给修复 session 的消息要求全程用 Cindy 的 Keel 插件（`ghost_id=keel`），不再用 goal skill。当前契约是 v3（`keelFlowVersion=3`）：

- 每个任务的 Keel `run_id` 固定为 `run-<dispatchId 里的时间戳>-<dispatchId 哈希前 6 位>`（`keelRunIdFor`）。watcher 把它写进派工消息，helper 收口时重算，不接受别的值。
- 台账顺序不可颠倒：`prepare` 之后第一次判断必须是带这个 `run_id` 的 `pstack_decide(op:"decide", template:"J4")`。当前 Keel 只有这一步会建立 `runs/<run_id>/decisions.jsonl`（Jev 不可用时也会先写一行再报错）；然后用 `pstack_decide(op:"log")` 写入 `kind:"step"`、`summary:"vigil task=<dispatchId>"` 绑定任务。`op:"log"` 要求台账已存在，先 log 会得到 `RUN_NOT_FOUND`。可改代码的任务使用 `bug-fix` 手册，调查任务使用 `investigation`。
- 不要调用 `pstack_start`、`keel_run`、`keel_report`、`keel_wait`、`keel_gate`、`keel_status`：它们会另建 worktree 和图 run，与本流程无关。只允许 `jev`、`pstack_decide`（decide / log / read）、`pr_threads` 和手册；`pr_reply` 每次弹确认框、`pr_wait` 长轮询、`pr_status` 会读到作者转 Ready 时写的交接记录而停手，所以都禁止。GitHub 写操作仍只走 helper 与 `gh`。
- Jev 只在固定判断点给参考（严重度未知、CI 抖动还是真失败、P0/P1 不成立的证据、修法选择），不能单独授权改代码。
- `finalize --keel-run <run_id>` 在推送前读取 `runs/<run_id>/decisions.jsonl`。v3 任务必须具有：固定的 `run_id`、任务创建后写入的精确绑定行、实际处置判断（Keel 写入的 `pstack_decide` 决策行，带 `state_sha256`、`answer`、`policy`；手写的 `decision` 行不算），以及绑定当前 `validated-head` 的 `vigil-flow` 证据。第一条决策必然先于绑定行（它建立台账文件），所以 v3 不要求决策晚于绑定，也不再要求启动记录。缺配置、缺记录、任务或提交不匹配均报 `KEEL_RUN_REQUIRED`；结果的 `keel.contractVersion=3` 表示通过 v3 契约。
- 收口证据通过 `pstack_decide(op:"log")` 的 `kind:"evidence"` 写入：`evidence` 包含 `kind:"vigil-flow"`、`version:3`、`taskId`、`head`、`playbook`、`manualPath`、`decisionRowIds` 和 `steps`。`decisionRowIds` 引用 `pstack_decide(op:"decide")` 返回的 `ledger_row`（形如 `<run_id>#<n>`）；`steps.reproduce`、`steps.repair` 写明实际复现/调查与处置证据；`steps.verify` 的 `head`、`receiptSha256` 必须匹配 helper `validate` 返回的验证收据。完整调用格式见派工消息。
- 全部 SC 为 `no-change` 且提交未变时，`steps.verify` 改为 `{status:"not-run",reason:"具体原因"}`，仍需调查证据和实际判断。后续同提交的 `recheck` 保留已验证的 `keel` 结果。
- Keel 台账本身不可用（工具缺失、`RUN_NOT_FOUND` 等）时，会话用 `blocked --reason "keel-unavailable: <原文>"`。reason 以 `keel-` 开头的 blocked 说明契约和已安装的 Keel 对不上，不是对反馈的判断。watcher 升级到更新的契约版本后，对仍在旧契约（v1/v2）上的这类任务，下一次扫描把它们的反馈退回游标并退还轮次（每个 `dispatchId` 只退一次，同一 PR 更早的同类任务一并退，状态里记 `keelReopened`），反馈会被重新投递。已在当前契约上的任务不会自动重投，避免 Keel 再次损坏时循环，只发 `repair-blocked` 事件等人处理。
- v3 依赖已安装的 Keel 提供 `pstack_decide` 的 `op`（`decide` / `log` / `read`）参数，即 `pstack_ledger` 已并入之后的版本。部署 v3 前先确认各机 Keel 版本；旧版 Keel 会把 `op:"log"` 当成 decide，会话会以 `keel-` 开头的原因 blocked，而 v3 任务不会自动重投。
- 在途旧任务不改写，各按自己的契约核对。v1（`keelFlow=true` 且没有 `keelFlowVersion`）沿用绑定检查，缺台账配置时仍为 `disabled`；配置存在且任务没有 `keelFlow=true` 时为 `not-required-legacy-task`。v2（`keelFlowVersion=2`）仍要求 `pstack_start` 写入的 `start <playbook>（` 行；当前 Keel 不再自动写这一行，v2 任务只能靠会话手写才能通过，这是升级 v3 的原因。这些旧契约结果不代表通过 v3。
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
- 修复会话核实某条 P0/P1 讨论不成立(已验证完成的结果里该 key 为 `no-change` 且附证据)或确认已修复(`fixed` 且 SC=`pass` 附证据)时,watcher 带证据回复并关闭该讨论;没有证据的不关。新审查机(`mivo-review:` 前缀)的行内线程同样走这条路径。收口在等 CI 的复查之后执行，CI 在本轮变绿就在本轮收口；线程里只要还有一条不属于已完成任务的外部意见(例如修复期间新加的回复)就不关，交给正常派工。本轮刚关闭的线程，其评论即使因修复推送变成 outdated 而重新出现，也不再当作新反馈派工。会话不要自己回复或 resolve thread。会话结果晚于上一次轮询写入时,即使 PR 指纹未变也会重新读取,避免任务停在 accepted、讨论永远挡住合并。等 CI 的复查需要约 15–20 秒;剩余扫描预算不足 40 秒时不硬跑(硬跑会被超时杀掉、排在后面的 PR 每轮同样失败),而是结束本轮并从该 PR 续扫,复查超时上限 60 秒。
- 本轮通过的标签名 `review:merge-ready`。
- 审查信号（`public-review.mjs`）：审查流程由前置协调器派发 `review-pr.yml`。判「可合并」要同时满足：当前 head 上最新一条 `review-pr` check（GitHub Actions 写入、关联到本仓 `review-pr.yml` 的 workflow_dispatch run）成功；`reviewerLogin` 在同一 head/base 上提交了干净报告（Approve，或带 `<!-- mivo-review:report head=… -->` 的 COMMENT）且晚于本次 Ready；其余条件同前（必需 CI、可合并、讨论已解决、无否决、无新反馈）。
- 审查入场：`review-pr.yml` 为 active 且仓库变量 `MIVO_REVIEW_MODE=live` 时，每个 Ready PR 都由协调器接管；读不到按未入场处理。`review-pr` check 是审查结论，不计入产品必需 CI（`mivo-pr-policy.mjs`），否则发现问题的 PR 会因「CI 不绿」永远不进修复。
- 可信审查来源(自动触发修复的评论来源)在 `mivo-pr-policy.mjs` / `mivo-feedback-policy.mjs`
  里按来源名单判断,按需改成你自己团队的 Bot/Reviewer 名单。`reviewerLogin` 带 `<!-- review-pr:findings … -->` 的 review 及其行内线程记为 `mivo-review` 来源（不按 head 过滤：上一版留下的未解决线程同样挡住下一次审查）；它的干净报告是结论，不进反馈流。

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
