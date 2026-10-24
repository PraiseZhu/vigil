# Cindy PR 盯梢修复工具

[Mivo watcher](../mivo/README.md) 的 fork 场景变体：PR 的 head 在你自己的 fork 上,base 在
一个你没有写权限的上游仓库(默认目标是公开仓库 `makecindy/cindy`)。轮询你自己的 open PR,
发现新的审查反馈 / CI 失败 / 与上游的冲突时整理成结构化任务;**绝不 push 到 base 仓**,只
fast-forward 到你 fork 上的 PR 分支。本轮通过只代表"修复 session 认为可以请维护者审批了",
不会代替维护者做任何审批动作。

## 与 Mivo watcher 的核心差异

| 项 | Mivo(同仓分支) | Cindy(cross-repo fork) |
|----|------|-------|
| origin | 插件仓本身 | PR head 所在的 fork;`upstream` 远程只用来 `fetch`,不 push |
| push 目标 | origin 上的 PR 分支 | 只允许 fast-forward 到 fork 的 `headRefName`;硬编码拒绝向 base 仓 push |
| 冲突处理 | `git merge origin/main` | `git fetch upstream main` 后在 PR 分支上 merge,再 push 回 fork |
| 本轮通过 | 打标签 | 等待一个外部状态位(默认约定名 `awaiting-maintainer-approval`),仍需维护者人工 approve |
| 停止盯梢 | 打标签(有仓库写权限) | 走 `config/optout.json` 配置,或作者本人在 issue comment 里发 `/cindy-watch off`(fork 场景下你可能没有打标签权限) |

可信审查来源的判断方式:GraphQL 返回的 Bot 账号 `login` 不带 `[bot]` 后缀,代码按
`__typename === "Bot"` 归一化后再与白名单比较(见 `cindy-pr-policy.mjs`)。

与 [mivo watcher 相同](../mivo/README.md#这是什么不是什么),discover 模式不是可以配进任意
cron 的无状态脚本,而是专门为 Cindy 桌面端的调度器("script 模式")设计的,机制与安装步骤见
根目录 [`README.md`](../../README.md#安装与部署)。

Review thread 的"已处理"判定:thread 一旦被标记 `resolved` 就视为已处理,不再据此派发修复
(混合优先级评论不会被这套工具自动 resolve);`resolved → unresolved` 的高优先级 thread
会重新进入待处理队列。工具自己只在两种情况下 resolve:整条 thread 都是可信 Bot 的 P3;或修复会话
核实某条必修意见不成立(已验证完成的结果里该 key 为 `no-change` 且附证据),此时带证据回复后关闭,
没有证据的不关,权限不足时只降级报告、不重复回复。

接手与出口(2026-10-15 起):

- 作者自己的 PR 转 Ready 后下一轮就接手,不要求必需检查先绿:CI 失败和冲突直接成为修复反馈。
- 维护者(OWNER/MEMBER/COLLABORATOR)、作者本人和已知代码审查应用(`REVIEW_APPS`)留的 review thread
  交修复会话按 REVIEW.md 分级(`review-thread-triage`):确认成立的 P0/P1/P2 才改代码,P3 由 watcher 回复分级说明后 resolve。
  其它应用的状态评论、没有自己必修项的 Greptile 汇总不再单独开会话。严重度未知时按不成立记 no-change,不 blocked；Jev 不可用是例外：`finalize` 门禁要求被引用的决策行带 Jev 结论,会话遇到 Jev 不可用要立即以 `keel-jev-unavailable:` 开头的原因 blocked。
- 修复会话 `prepare` 先对齐 watch 树:落后 fork 就快进,与 fork 分叉就把旧分支打 bundle 存进
  `_backup/` 后按 fork 重建。
- 因环境原因 blocked(预检跑不起来、watch 树分叉、子代理路由被拒等,见 `INFRA_BLOCK_REASON`)的轮次退还轮次、
  把反馈放回队列重投,每个 Ready 代次最多 3 次;新的 Ready 代次重新计修复轮次。
- 再次转 Ready 时游标只保留「覆盖账本」（`feedbackLedger`）还担保的部分：完成轮次（`complete` / `waiting-ci`）消费时把每个反馈 key 的 `stamp`（游标戳）、`disposition`、`resultHead`、`dispatchId` 记入账本；转 Ready 时账本里 `stamp` 未变且旧处置为 `no-change` 的反馈不再重投。被撤销、blocked 无覆盖、无结果任务的反馈，内容 / revision / CI sha 变化的反馈，以及旧处置为 `fixed` 的反馈照常重投。`missing-result-limit` 遇到新 head、新反馈或必需 CI 状态变化时自动转回 active（`missing-result-reopened`），同一 Ready 代次最多 3 次，超过后保持终态并写 `missing-result-reset-limit` 通知；无变化不复位。复位时死任务领到却从未得到判定的反馈（读它的 task 文件）也从游标取回、与新反馈一起派发；limit 与复位在同一次扫描发生时，limit 的人工通知照常写出。cindy 没有 PR 评论形式的「盯梢停下了」通知，故不涉及评论去重。
- 终点仍是 `awaiting-maintainer-approval`:仓库要求有写权限的维护者批准并经合并队列合入,watcher 不代替审批。

等 CI 的复查需要约 15–20 秒;剩余扫描预算不足 40 秒时不硬跑(硬跑会被超时杀掉、排在后面的 PR
每轮同样失败),而是结束本轮并从该 PR 续扫,复查超时上限 60 秒。`waiting-ci` 不算在途:当前 head 出现新的必需 CI 失败、冲突或审查意见时,同一轮就会派新任务。被预算推迟的复查(`recheckDeferredAt`)下一轮即使指纹没变也会再查。

补投只在该 dispatch 没有结果文件、且距最近 helper 活动或派发已超过 30 分钟时发生,上限仍为 3 次。helper 的 prepare / validate / finalize / blocked / recheck 都会刷新活动时间;validate 心跳跑在独立子进程,长跑期间至少每 60 秒一次(可用 `VIGIL_ACTIVITY_HEARTBEAT_MS` 覆盖)。session 写结果不抢 PR 状态锁,下一轮由 watcher 消费。无代码改动且当前 head 必需 CI 仍红时,会做一次带 DCO 的空提交重触发;第二次仍红按同因升级,不再无限重跑。`waiting-ci` 任务被新反馈取代时,旧任务已有证据的 thread 会等到后续 complete 或当前 head CI 全绿再回复并 resolve。通知队列用 `pending.lock` 串行读写。

同因 blocked 不再原样重投,改为写一条升级通知(每个 PR、每个原因、每个 head 一次)。规则版本变化、新 head 或新反馈时仍会重投。可合并、同因升级、needs-human 这类事件写进 `state/notices/`,用 `bin/notify.mjs` 配独立调度发出,见 [`docs/operations.md`](../../docs/operations.md)。

## 配置:profile.mjs 的 fail-closed 机制

机制与 [mivo watcher 完全一致](../mivo/README.md#配置profilemjs-的-fail-closed-机制),
`watcher home` 解析为 `CINDY_WATCHER_HOME` 环境变量 > `bin/` 目录的上一级目录。

### 必填项

| profile 字段 | 环境变量 | 用途 |
|---|---|---|
| `pluginRepoPath` | `CINDY_WATCHER_REPO`(函数内手动预检,不经过 `profile.mjs` 的 fail-closed 报错路径) | 本地项目工作仓的绝对路径 |
| `preflightFile` | `CINDY_PREFLIGHT_BIN`(同上,函数内手动预检) | 推送前预检脚本的绝对路径 |

### 可选项(有安全/合理默认值)

| profile 字段 | 环境变量 | 默认值 |
|---|---|---|
| `targetRepo` | `CINDY_WATCHER_TARGET_REPO` | `makecindy/cindy`(公开仓库,可直接用,也可覆盖成别的仓) |
| `watchHomes` | `CINDY_WATCHER_WATCH_HOMES`(逗号分隔) | `[]`(不内置任何路径) |
| `scheduleTimeoutMs` | `CINDY_WATCHER_SCHEDULE_TIMEOUT_MS` | `180000`。宿主对 discover 定时任务的超时(毫秒),整轮预算以它减 15 秒为上限 |
| `roundBudgetMs` | `CINDY_WATCHER_ROUND_BUDGET_MS` | `165000`(超时 180 秒减 15 秒安全余量)。一轮 discover 的总预算 |
| `dispatchReserveMs` | `CINDY_WATCHER_DISPATCH_RESERVE_MS` | `25000`。给派发回执留的时间:采集结束时整轮只剩不足这个时间的 PR 才会 `dispatch-budget-deferred` |
| `minCollectMs` | `CINDY_WATCHER_MIN_COLLECT_MS` | `15000`。整轮截止减派发预留后不足这个时间时,不再启动新的采集,留给下一轮 |
| `fullCollectMs` | `CINDY_WATCHER_FULL_COLLECT_MS` | `600000`。无修复会话的 Ready PR 即使指纹没变,距上次完整采集超过它也强制全量采集一次 |
| `followIntervalMs` | `CINDY_WATCHER_FOLLOW_MS` | `15000`。轮内批量复查 open PR 变化的间隔;环境变量设为 `0` 只跑全量一轮 |
| `validateConcurrency` | `CINDY_VALIDATE_CONCURRENCY` | `2`。同一 watcher home 同时运行的 validate 上限，正整数；非法值直接报错，不静默回退。超限的 validate 排队等槽位，排队不是失败。槽位按 pid 存活判定回收，并终止遗留进程组：命令经 `sh` 启动，先把进程组号落盘到槽位旁的 `.pgid` 文件、确认持有者仍存活才 `exec`，持有者在 spawn 后任意时刻崩溃都能回收 |
| `validateStallMinutes` | `CINDY_VALIDATE_STALL_MINUTES` | `10`。连续无新输出超过它就终止整个进程组，收据记 `failureKind: validate-stalled`，不当作测试失败 |
| `preflightTimeoutMinutes` | `CINDY_PREFLIGHT_TIMEOUT_MINUTES` | `60`。validate 的总超时（此前硬编码 60 分钟，现可配置）；只接受大于 0 的有限数字，换算毫秒后须为不超过 2147483647 的安全整数。非法值直接报错 |


拷一份 [`config/examples/cindy.profile.example.json`](../../config/examples/cindy.profile.example.json)
到 watcher home 下的 `config/profile.json`,把占位值换成真实路径即可。

其余环境变量(`CINDY_WATCHER_MODE`/`CINDY_WATCHER_PR`/`CINDY_WATCHER_NODE_ID`/
`CINDY_WATCHER_ENABLED`/`CINDY_WATCHER_DISPATCH`/`CINDY_WATCHER_BRIDGE`)是运行时/调度相关
的开关,不经过 profile 机制,直接读 `process.env`,具体含义见对应源码文件头部注释。

### validate 运行方式与证据（本地预检）

- **异步、限并发**：`validate` 是异步命令。helper 运行锁（每 PR 一把）撑到 validate 真正结束，部署锁互斥不被异步化破坏；同一 PR 的并发 validate 仍由 helper 锁拒绝为 `busy`，限并发针对不同 PR 之间的争用。
- **流式日志**：stdout/stderr 流式写入 `state/validations/logs/` 下 0600 的不可变日志；收据记 `logPath`、`logSha256`。无输出看门狗与总超时是两个独立原因（`validate-stalled`、`validate-timeout`），都终止整个进程组。
- **固定 TMPDIR**：子进程注入 `TMPDIR=realpath(os.tmpdir())`；policy 文件（外部预检脚本）及其 sha256 不变。
- **同条件复用通过收据**：同一 PR、同一 `validatedHead`、同一外部预检脚本 sha256、同一运行指纹（platform、arch、node、uid、`realpath(TMPDIR)`、`package-lock.json` sha256）已有完整 pass 收据时不再重跑，写一份绑定当前派发的新收据，`reusedFrom` 指向原收据；任一要素变化或收据/日志被改都重跑。
- **失败集合**：收据记 `failureSetState`、`failureSet`（`{step, file, test, errorSha}`）、`failureSetSha256`；无法完整解析记 `unparsed`，不与任何集合相等。外部预检脚本的输出格式不由本仓约定，解析器只认 vitest 的 `FAIL` 行；其他格式（含 node:test）一律 `unparsed`，不会被当作「失败没有变化」的证据。

### 为什么 Cindy 没有「仅基线失败受控通过」

Mivo 侧的 `baseline-only-failure` 依赖仓库内的 `.githooks/pre-push`：它可以在 merge-base 的干净树里原样复跑同一份 policy，并通过受控 pre-push 让 `git push` 不再重跑。Cindy 的 policy 是外部脚本（`CINDY_PREFLIGHT_BIN`），PR 在 fork 上，也没有受控 pre-push hook，基线树里没有「同一份 policy」可比，且新增 hook 会改变 fork push 的边界。因此本 watcher **不实现**基线受控通过，也不接受 `baseline-only-failure` 状态；本地 validate 失败就是失败。失败集合的记录是为了让 infra 重开判据能识别「失败没有变化」。

### validate 类阻塞不再原样重投

与 Mivo 相同：validate 类阻塞（判定只有一个：原因不属于 submodule、pathspec、worktree HEAD 等环境/配置故障，且（带 `validationBlock`，或原因含 preflight/validat）；原因不必命中 infra 关键词（例如「helper validate … exit 1」「validate DCO fails」这类文字也算）。infra 重开与 external 的 `rulesVersion` 重开用的是同一个判定）重开前比较上次阻塞时的远端 head、merge-base（被验证 head 与 base 的 merge-base，base 分支 tip 前进但 merge-base 不变不重开；取不到时按未知处理）、外部预检脚本 sha256、运行指纹、失败集合；全部未变（或关键观测缺失）不重新派发、不消耗每代次上限，任一已知变化才重开。原因属于 pathspec、submodule、worktree HEAD 等环境/配置故障的阻塞，即使带着 `validationBlock`，也按原有 infra 规则重开，不套五要素。当前 base（`baseRefOid`/`baseRefName`）取自本轮 poll/采集结果并随采集写进 PR 状态条目；升级前的旧条目没有这两个字段，首轮 merge-base 记为未知，下一轮写入后即可比较。部署新版（`rulesVersion` 变化）不是 validate 类阻塞的重开理由，同一 dispatch 已被五要素判据重开的，external 路径不再重复重开；非 validate 类 external 阻塞随 `rulesVersion` 变化重开的行为不变。

### 新版任务必需的 Keel 配置

| profile 字段 | 环境变量 | 要求 |
|---|---|---|
| `keelLedgerRoot` | `CINDY_KEEL_LEDGER_ROOT` | Keel 插件数据目录（包含 `runs/` 的那一层）；新派发的 `keelFlowVersion>=2` 任务缺少此配置，或目录不存在、不可读时：`prepare` 在建 worktree 前以 `keel-unavailable:` 报 blocked，派发前门禁也不向修复会话派发（见下文「Keel 环境变化时的行为」）；真要走到 `finalize` 时同样报 `KEEL_RUN_REQUIRED`，拒绝收口和推送 |
| `keelNamespace` | `CINDY_KEEL_NAMESPACE` | 可选。Keel 插件装在企业命名空间下时填该命名空间（如重装到 `xd` 之后）。配置后，派工消息里所有 Keel 调用都写明 `ghost_id=keel` 加 `namespace="<值>"`；不配置时消息要求修复会话省略 `namespace` 参数、不得传 `null`（`null` 会让命名空间安装的 Keel 报 `GHOST_NOT_FOUND`）。已设置但不合法（只允许字母、数字、下划线、连字符，以字母或数字开头，最长 128 位）时直接报配置错误，不会被当作未配置 |

### Keel 环境变化时的行为

- **台账路径提前核对**：对 `keelFlow=true` 且 `keelFlowVersion>=2` 的任务，`prepare` 在建 worktree 之前先确认 `keelLedgerRoot` 已配置、目录存在且可读；不满足就立即以 `keel-unavailable: keelLedgerRoot not configured` 或 `keel-unavailable: ledger root unreadable (<errno>)` 报 blocked，不再拖到 `validate` 之后的 `finalize` 才发现（原因里只带错误码，不带路径）。v1 及更早、没有 Keel 流程的任务不受影响。
- **派发前核对**：每次向修复会话派发之前，watcher 同样检查 `keelLedgerRoot` 已配置且可读（与 `finalize` 对未配置根目录的拒绝一致）。不满足时本轮不派发修复会话、不扣轮次、不发 `blocked` 阻塞播报，反馈保持未交付；同时写一条 `keel-unavailable` 通知（每个 PR 每天一条，原因里写明是未配置还是读不到）。该 PR 下一轮扫描会重新处理，台账恢复后自动派发。这道门禁只拦「派发修复会话」，不拦与 Keel 无关的确定性处理：P3 线程的自动回复与 resolve 照常执行。
- **Jev 不可用**：`finalize` 仍要求被引用的决策行带 Jev 结论（`answer`、`policy` 非空），门禁不放宽。所以修复会话遇到 Jev 不可用（如 `JEV_NOT_CONFIGURED`）时，立即用 `blocked --reason "keel-jev-unavailable: <原文>"` 停下，不先做修复、不跑 `validate`。
- **keel- 阻塞自动重开**：以 `keel-` 开头原因阻塞的任务，在当前 `KEEL_FLOW_VERSION` 下也会重开：距离阻塞至少 30 分钟，且已配置的 `keelLedgerRoot` 此时可读（台账仍读不到时不登记重开、不退轮次，等台账恢复后再重开）；同一 PR 同一次准入（admission epoch）最多重开 3 次。重开只在修复会话真正派发出去（拿到回执）时才计入次数并退还轮次；本轮因预算推迟、台账门禁、所有权复核或采集失败而没派发时，什么都不消耗，下一轮继续重开。超过上限后保持阻塞，由通知提示人处理。旧合约（`keelFlowVersion<3`）任务的一次性重开同样要求台账可读。

## 修复 session 的 Keel 流程

派给修复 session 的消息要求全程用 Cindy 的 Keel 插件（`ghost_id=keel`），不再用 goal skill。当前契约是 v3（`keelFlowVersion=3`）：

- 每个任务的 Keel `run_id` 固定为 `run-<dispatchId 里的时间戳>-<dispatchId 哈希前 6 位>`（`keelRunIdFor`），同时写进 task 文件的 `keelRunId`。watcher 把它写进派工消息，helper 收口时重算，不接受别的值。
- 台账顺序不可颠倒：`prepare` 之后第一次判断必须是带这个 `run_id` 的 `pstack_decide(op:"decide", template:"J4")`。当前 Keel 只有这一步会建立 `runs/<run_id>/decisions.jsonl`（Jev 不可用时也会先写一行再报错）；然后用 `pstack_decide(op:"log")` 写入 `kind:"step"`、`summary:"vigil task=<dispatchId>"` 绑定任务。`op:"log"` 要求台账已存在，先 log 会得到 `RUN_NOT_FOUND`。可改代码的任务使用 `bug-fix` 手册，调查任务使用 `investigation`。
- 不要调用 `pstack_start`、`keel_run`、`keel_report`、`keel_wait`、`keel_gate`、`keel_status`：它们会另建 worktree 和图 run，与本流程无关。只允许 `jev`、`pstack_decide`（decide / log / read）、`pr_threads` 和手册；`pr_reply` 每次弹确认框、`pr_wait` 长轮询、`pr_status` 会读到作者转 Ready 时写的交接记录而停手，所以都禁止。GitHub 写操作仍只走 helper 与 `gh`。
- Jev 只在固定判断点给参考（严重度未知、CI 抖动还是真失败、P0/P1/P2 不成立的证据、修法选择），不能单独授权改代码。
- `finalize --keel-run <run_id>` 在推送前读取 `runs/<run_id>/decisions.jsonl`。v3 任务必须具有：固定的 `run_id`、任务创建后写入的精确绑定行、实际处置判断（Keel 写入的 `pstack_decide` 决策行，带 `state_sha256`、`answer`、`policy`；手写的 `decision` 行不算），以及绑定当前 `validated-head` 的 `vigil-flow` 证据。第一条决策必然先于绑定行（它建立台账文件），所以 v3 不要求决策晚于绑定，也不再要求启动记录。缺配置、缺记录、任务或提交不匹配均报 `KEEL_RUN_REQUIRED`；结果的 `keel.contractVersion=3` 表示通过 v3 契约。
- 收口证据通过 `pstack_decide(op:"log")` 的 `kind:"evidence"` 写入：`evidence` 包含 `kind:"vigil-flow"`、`version:3`、`taskId`、`head`、`playbook`、`manualPath`、`decisionRowIds` 和 `steps`。`decisionRowIds` 引用 `pstack_decide(op:"decide")` 返回的 `ledger_row`（形如 `<run_id>#<n>`）；`steps.reproduce`、`steps.repair` 写明实际复现/调查与处置证据；`steps.verify` 的 `head`、`receiptSha256` 必须匹配 helper `validate` 返回的验证收据。完整调用格式见派工消息。
- 全部 SC 为 `no-change` 且提交未变时，`steps.verify` 改为 `{status:"not-run",reason:"具体原因"}`，仍需调查证据和实际判断。后续同提交的 `recheck` 保留已验证的 `keel` 结果。
- Keel 台账本身不可用（工具缺失、`RUN_NOT_FOUND` 等）时，会话用 `blocked --reason "keel-unavailable: <原文>"`。reason 以 `keel-` 开头的 blocked 说明契约和已安装的 Keel 对不上，不是对反馈的判断。watcher 升级到更新的契约版本后，对仍在旧契约（v1/v2）上的这类任务，下一次扫描把它们的反馈退回游标并退还轮次（每个 `dispatchId` 只退一次，同一 PR 更早的同类任务一并退，状态里记 `keelReopened`；指纹未变的 poll 也会走到这一步），反馈会被重新投递。已在当前契约上的任务不会自动重投，避免 Keel 再次损坏时循环，只发 `repair-blocked` 事件等人处理。
- v3 依赖已安装的 Keel 提供 `pstack_decide` 的 `op`（`decide` / `log` / `read`）参数，即 `pstack_ledger` 已并入之后的版本。部署 v3 前先确认各机 Keel 版本；旧版 Keel 会把 `op:"log"` 当成 decide，会话会以 `keel-` 开头的原因 blocked，而 v3 任务不会自动重投。
- 在途旧任务不改写，各按自己的契约核对。v1（`keelFlow=true` 且没有 `keelFlowVersion`）沿用绑定检查，缺台账配置时仍为 `disabled`；配置存在且任务没有 `keelFlow=true` 时为 `not-required-legacy-task`。v2（`keelFlowVersion=2`）仍要求 `pstack_start` 写入的 `start <playbook>（` 行；当前 Keel 不再自动写这一行，v2 任务只能靠会话手写才能通过，这是升级 v3 的原因。这些旧契约结果不代表通过 v3。
- `prepare` 返回 `ciErrors`：失败必需检查所在 workflow run 的 `##[error]` 行（每个 run 最多 20 行），取不到时给出错误原因。

## 并行与跟进

与 Mivo watcher 相同（详见 `../mivo/README.md`「并行与跟进」）：发现器由定时任务触发（建议 `* * * * *`，超时 180 秒；宿主在本轮结束后才排下一次触发，同一 schedule 不重叠不积压，选每分钟时两轮之间约 20–30 秒空档，整轮预算须小于调度 `timeoutMs`），一轮最多 165 秒（超时减 15 秒安全余量；每次采集在「整轮截止 − 派发预留」处中止并标 `collectRetry`、下一轮最先处理，整轮最后约 40 秒内才出现的变化留到下一轮开头），一轮里所有 open PR 同时采集、同时派发，不设并发上限；采集可用掉整轮预算里除派发预留（默认 25 秒）以外的时间，被推迟的 PR 下一轮优先；没有修复会话的 Ready PR 也先走指纹闸（指纹覆盖更新时间、近若干条评论 / review / 线程评论的 id 与更新时间、CI 汇总与 legacy status；指纹没变且无 `collectRetry` 就跳过全量采集，采集不完整不收口，并有 `fullCollectMs`（默认 10 分钟）的强制全量兜底）；分支规则、仓库变量等仓库级查询每轮只查一次；已完成的 CI job / run 按 head 缓存，多个必需检查并发查询；与全量处理并行、每隔 15 秒用一次批量 GraphQL 查询（含最新提交的 CI 汇总 state）检查所有 open PR，慢采集不挡节拍，转 Ready、有新推送、新反馈或 CI 变化的 PR 当轮立刻处理，一直查到整轮预算用尽（一轮实际约 150–160 秒结束，两轮之间约 20–30 秒空档）；查询失败或限流时退避、本轮照常结束；Python 包装同时转发多个 `sessions.dispatch`（最多 12 个同时在途，宿主上限 16）。时间配置（profile 字段或环境变量）：`roundBudgetMs` / `CINDY_WATCHER_ROUND_BUDGET_MS`（默认 165000）、`dispatchReserveMs` / `CINDY_WATCHER_DISPATCH_RESERVE_MS`（默认 25000）、`followIntervalMs` / `CINDY_WATCHER_FOLLOW_MS`（默认 15000，环境变量 `0` 只跑全量一轮）、`fullCollectMs` / `CINDY_WATCHER_FULL_COLLECT_MS`（默认 600000）、`scheduleTimeoutMs` / `CINDY_WATCHER_SCHEDULE_TIMEOUT_MS`（默认 180000，整轮预算上限为它减 15 秒）。

## 修复轮次

与 Mivo watcher 一致，修复不设轮次上限：同一 PR 只要还有新反馈、还没到可合并，就继续派修复轮次（`repairRounds` 只作记录）。旧版本按 6 轮上限停下的 PR（`blockedKind: round-limit`）下一次扫描转回 active（`round-limit-reset`），压住没投的反馈照常投递。

## 规则版本与已开会话

修复会话是长期复用的，历史里留着旧版 watcher 投递的规则。每次投递的第一行都是 `盯梢规则版本 <12 位>`，并写明本条覆盖此前收到的规则；版本号是把当前全部规则文字渲染后取的摘要，规则一改版本就变。回执确认后，PR 状态记下这次实际投递的版本（`rulesVersion`，重投旧消息时记旧版本）。

已绑定会话的 PR 每轮检查一次：版本落后、手上没有任务在跑（不是 queued / accepted / prepared / running）、没有待投递的反馈、PR 不是可合并时，补发一条「规则更新，不是新任务」的消息，只带当前规则、不改代码不回评论；同一版本最多补发 3 次（`rulesRefresh` 记次数和错误）。有反馈要投递的会话不补发，因为那条投递本身就带当前规则。

## CLI

```sh
node bin/cindy-watcher.mjs                                     # 默认 discover 模式
CINDY_WATCHER_MODE=poll CINDY_WATCHER_PR=<N> node bin/cindy-watcher.mjs --node-id <id>   # 手动单跑一个 PR,排障用

node bin/cindy-repair.mjs <子命令> --home "$CINDY_WATCHER_HOME"

node bin/cindy-ownership.mjs --repo makecindy/cindy --pr 123 --home "$CINDY_WATCHER_HOME"

node bin/notify.mjs check --home "$CINDY_WATCHER_HOME"   # 有未发事件 exit 0,否则 2
node bin/notify.mjs emit --home "$CINDY_WATCHER_HOME"    # 按 cindy-script/1 发出并标记已发
```

## 运行锁与 lock-doctor

`state/locks/<name>.lock` 用于防止同一个 PR 被并发处理两次;锁文件内容是 JSON
`{pid, token, createdAt}`。接管一个疑似失效的锁时,先用 `mkdir <name>.lock.reclaim` 占一个
"接管守卫"(`EEXIST` 即说明别人正在接管,直接判 busy)——**锁层从不自动删除别人的守卫**,
避免两个进程同时拿到锁的竞态。

人工清理卡死的接管守卫:

```sh
node bin/cindy-repair.mjs lock-doctor --home "$CINDY_WATCHER_HOME"
node bin/cindy-repair.mjs lock-doctor --home "$CINDY_WATCHER_HOME" --clear-guard discover
```

`--clear-guard` 只有在守卫的进程确实已经不存在、且文件修改时间超过 10 分钟时才会清除,
清除前会先独占 `state/locks/maintenance.lock` 防止并发清理。

## 部署脚本(可选)

与 [mivo 的 `deploy.mjs`](../mivo/README.md#部署脚本可选) 用法一致,四个子命令
`verify`/`bootstrap`/`preview`/`apply` 都是纯文件系统操作加哈希校验,不绑定具体调度器。
`--database` 指向的 sqlite3 文件只用于一个可选的"目标会话是否空闲"检查,不需要可以自行移除。

## 测试

```sh
node --env-file=watchers/cindy/test.env --test watchers/cindy/*.test.mjs
python3 -B watchers/cindy/cindy-watch-script.test.py
```

测试里的仓库名、fork 用户名、session id 均为占位数据(`ExampleUser/cindy-fork` 等),
不对应任何真实账号或仓库。`repair-lifecycle.test.mjs` 里的 Git/文件操作是真实执行在临时
本地仓上的,GitHub API 与下游任务派发是受控 fixture,不代表真实网络调用。
