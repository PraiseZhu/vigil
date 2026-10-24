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
| `severityStandardPath` | `MIVO_SEVERITY_STANDARD_PATH` | 审查机发布的统一分级文件（审查仓的 `mivo/config/severity.md`，与前置审查同机检出的那份）。修复会话和裁决 Worker 只按它判 P0/P1/P2/P3；版本号是文件原始内容 sha256 的前 12 位，与审查机算法相同。未配置或读不到时不报错，但本轮审查账号的 P0/P1/P2 一律按成立处理、必须修，finalize 拒绝把它们记成 no-change |
| `scheduleTimeoutMs` | `MIVO_WATCHER_SCHEDULE_TIMEOUT_MS` | `180000`。宿主对 discover 定时任务的超时（毫秒），整轮预算以它减 15 秒为上限 |
| `roundBudgetMs` | `MIVO_WATCHER_ROUND_BUDGET_MS` | `165000`（超时 180 秒减 15 秒安全余量）。一轮 discover 的总预算；超过 `scheduleTimeoutMs − 15000` 的值会被截到该上限 |
| `dispatchReserveMs` | `MIVO_WATCHER_DISPATCH_RESERVE_MS` | `25000`。给派发回执留的时间：采集结束时整轮只剩不足这个时间的 PR 才会 `dispatch-budget-deferred` |
| `minCollectMs` | `MIVO_WATCHER_MIN_COLLECT_MS` | `15000`。整轮截止减派发预留后不足这个时间时，不再启动新的采集，留给下一轮 |
| `fullCollectMs` | `MIVO_WATCHER_FULL_COLLECT_MS` | `600000`。无修复会话的 Ready PR 即使指纹没变，距上次完整采集超过它也强制全量采集一次 |
| `followIntervalMs` | `MIVO_WATCHER_FOLLOW_MS` | `15000`。轮内批量复查 open PR 变化的间隔；环境变量设为 `0` 只跑全量一轮 |
| `validateConcurrency` | `MIVO_VALIDATE_CONCURRENCY` | `2`。同一 watcher home 同时运行的 validate 上限，正整数；非法值（0、负数、小数、空串、非数字）直接报错，不静默回退。超限的 validate 排队等槽位，**排队不是失败**：不记失败、不消耗重试或 missing-result 计数。持有槽位的进程崩溃后，槽位按 pid 存活判定回收，并先终止它遗留的进程组：命令经 `sh` 启动，`sh` 先把进程组号落盘到槽位旁的 `.pgid` 文件、确认持有者仍存活才 `exec` 真正的命令，所以持有者在 spawn 之后任意时刻崩溃，要么组号已落盘可被回收，要么命令根本没有开始 |
| `validateStallMinutes` | `MIVO_VALIDATE_STALL_MINUTES` | `10`。连续无新输出（stdout/stderr 都没有新字节）超过它就终止整个进程组，收据记 `failureKind: validate-stalled`，不当作测试失败；规则同 `preflightTimeoutMinutes`。心跳不算输出 |
| `preflightTimeoutMinutes` | `MIVO_PREFLIGHT_TIMEOUT_MINUTES` | `60`。只接受大于 0 的有限数字或非空十进制字符串；换算毫秒后须为不超过 2147483647 的安全整数。非法值直接报错，不静默回退。env 优先于 profile。validate 的 `npm ci`（如需）与仓库预检、以及未复用收据时的 `git push` 都用此时限；两阶段各自独立计时，不共享一笔总预算。显式 `options.timeout` 仍然优先。 |

拷一份 [`config/examples/mivo.profile.example.json`](../../config/examples/mivo.profile.example.json)
到你的 watcher home 下的 `config/profile.json`，把占位值换成真实路径即可。`config/profile.json`
已在 `.gitignore` 里排除，不会被提交。

普通 `validate` 在跑仓库预检前，若工作树没有 `node_modules` 且 `package-lock.json` 是普通文件，会先执行 `npm ci`。安装失败或超时不写 PASS 收据、也不启动预检。已有 `node_modules` 或没有 lockfile 时不调用 npm。`approved-exception` 路径不自动安装、不跑预检。

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

### validate 运行方式与证据（本地预检）

- **异步、限并发**：`validate` 是异步命令（CLI 仍只输出一个 JSON）。槽位在 `state/validations/slots/`，申请不到就排队；排队期间心跳照常，拿到槽位后若等待超过 1 秒会重新核对所有权与 worktree HEAD 再运行。
- **流式日志**：命令的 stdout/stderr 按到达顺序写入 `state/validations/logs/` 下 0600 的不可变日志（`wx` 创建，不覆盖）。收据记录 `logPath`、`logSha256`。总超时（`preflightTimeoutMinutes`）与无输出看门狗（`validateStallMinutes`）是两个独立原因：`validate-timeout`、`validate-stalled`，都终止整个进程组，都不是「测试失败」，失败集合记 `unparsed`。
- **固定 TMPDIR**：子进程环境注入 `TMPDIR=realpath(os.tmpdir())`（避开 `/var` → `/private/var` 软链）。policy 文件与它的 sha256 不变。
- **同条件复用通过收据**：同一 PR、同一 `validatedHead`、同一 policy sha256、同一运行指纹（platform、arch、node 版本、uid、`realpath(TMPDIR)`、`package-lock.json` sha256）已有 pass 收据，且收据、日志、哈希全部复验通过时，不再运行 validate，直接写一份绑定当前派发/会话的新收据，`reusedFrom` 指向原始收据（owner 复核照旧）。任一要素不同、日志或收据被改、索引损坏，都重新运行。旧版收据（没有 `validationEvidenceVersion`）不进入复用。
- **失败集合**：收据新增 `logSha256`、`failureSetState`（`parsed`/`unparsed`）、`failureSet`（元素 `{step, file, test, errorSha}`，`step` 取 hook 的 `[preflight] ❌ <step> 失败` 标记，`file/test` 取失败行，`errorSha` 为归一化首条断言信息的哈希）。认得三种失败块：vitest 的 `FAIL <file> > <test>`、vitest 文件级失败 `FAIL <file> [ <file> ]`（`test` 记 `<file>`，按 `Test Files N failed` 核对文件数）、node:test 的 spec（`✖ failing tests:` 段）与 TAP（`not ok N - name` 的 yaml 块，`subtestsFailed` 的套件行不计），各自按 `Tests N failed` / `ℹ fail N` / `# fail N` 核对计数；其中 node:test 是按 Node 自带报告格式写的，目标仓 pre-push 本身只跑 vitest，没有取到线上真实日志回放过、`failureSetSha256`。解析不完整（lint 报错、截断、计数对不上、未处理错误）一律 `unparsed`，`unparsed` 不与任何集合相等。旧收据照常可读。

### 仅基线失败的受控通过（`baseline-only-failure`）

仅当 PR 的 validate 以 exit 1 失败、失败集合解析完整且非空时才会跑基线（通过的运行零额外开销）。基线在干净的 detached worktree 里检出 `git merge-base(validatedHead, origin/<base>)`，同宿主、同命令（`bash .githooks/pre-push`）、同 policy、同运行指纹各跑一次；基线日志与收据不可变，基线结果按 `sha256(repo, mergeBase, policy, package-lock blob, 运行指纹)` 缓存，同键并发加锁只跑一次，用完的 worktree 定点清理（清理失败则不受控通过）。

接受条件缺一不可：PR 失败集合非空且每个元素（含 `errorSha`）都在基线失败集合里；基线本身 exit 1；两次 policy 哈希与运行指纹相同（含 `package-lock.json` 一致）；收据 head = validatedHead 且 owner 复核通过。基线通过、PR 多一个失败、`errorSha` 不同、任一方 `unparsed`/stalled/超时都判 fail。

状态是机器判定的 `baseline-only-failure`，**不扩展 `validationException`**（后者仍是人批准）。收据保留真实 `exitCode: 1` 与 PR 日志，不会写成 pass。该状态接入 `pushIfNeeded`（传 `validatedPolicy`，受控 pre-push 不再重跑）、`finalize`/`recheck`（重新核验两份原始收据，不只看状态字符串）、Keel 校验与 watcher 消费；**远端必需 CI 仍要求全绿**，`requiredGreen` 不变。

### validate 类阻塞不再原样重投

validate 类阻塞（原因含 preflight/validat，且不属于 pathspec、submodule 等环境故障）重开前，watcher 比较上次阻塞时记录的五要素：远端 head、merge-base（被验证 head 与 base 的 merge-base，不是 base 分支 tip——base 前进但 merge-base 不变不重开）、policy sha256、运行指纹、失败集合。merge-base 取不到（对象不在本地）时该项按未知处理：不单独触发重开，其他要素变化仍照常重开。全部未变（或关键观测缺失）则不重新派发，也不消耗每代次 3 次的上限；任一已知变化才照常重开。新的失败收据若失败集合与阻塞时完全相同，视为未变；新的 `unparsed` 证据视为变化。没有 `validationBlock` 的旧阻塞只在远端 head 变化时重开。

### 新版任务必需的 Keel 配置

| profile 字段 | 环境变量 | 要求 |
|---|---|---|
| `keelLedgerRoot` | `MIVO_KEEL_LEDGER_ROOT` | Keel 插件数据目录（包含 `runs/` 的那一层）；新派发的 `keelFlowVersion>=2` 任务缺少此配置，或目录不存在、不可读时：`prepare` 在建 worktree 前以 `keel-unavailable:` 报 blocked，派发前门禁也不向修复会话派发（见下文「Keel 环境变化时的行为」）；真要走到 `finalize` 时同样报 `KEEL_RUN_REQUIRED`，拒绝收口和推送 |
| `keelNamespace` | `MIVO_KEEL_NAMESPACE` | 可选。Keel 插件装在企业命名空间下时填该命名空间（如重装到 `xd` 之后）。配置后，派工消息里所有 Keel 调用都写明 `ghost_id=keel` 加 `namespace="<值>"`；不配置时消息要求修复会话省略 `namespace` 参数、不得传 `null`（`null` 会让命名空间安装的 Keel 报 `GHOST_NOT_FOUND`）。已设置但不合法（只允许字母、数字、下划线、连字符，以字母或数字开头，最长 128 位）时直接报配置错误，不会被当作未配置 |

### Keel 环境变化时的行为

- **台账路径提前核对**：对 `keelFlow=true` 且 `keelFlowVersion>=2` 的任务，`prepare` 在建 worktree 之前先确认 `keelLedgerRoot` 已配置、目录存在且可读；不满足就立即以 `keel-unavailable: keelLedgerRoot not configured` 或 `keel-unavailable: ledger root unreadable (<errno>)` 报 blocked，不再拖到 `validate` 之后的 `finalize` 才发现（原因里只带错误码，不带路径）。v1 及更早、没有 Keel 流程的任务不受影响。
- **派发前核对**：每次向修复会话派发之前，watcher 同样检查 `keelLedgerRoot` 已配置且可读（与 `finalize` 对未配置根目录的拒绝一致）。不满足时本轮不派发修复会话、不扣轮次、不发 `blocked` 阻塞播报，反馈保持未交付；同时写一条 `keel-unavailable` 通知（每个 PR 每天一条，原因里写明是未配置还是读不到）。该 PR 下一轮扫描会重新处理，台账恢复后自动派发。这道门禁只拦「派发修复会话」，不拦与 Keel 无关的确定性处理：P3 线程的自动回复与 resolve 照常执行。
- **Jev 不可用**：`finalize` 仍要求被引用的决策行带 Jev 结论（`answer`、`policy` 非空），门禁不放宽。所以修复会话遇到 Jev 不可用（如 `JEV_NOT_CONFIGURED`）时，立即用 `blocked --reason "keel-jev-unavailable: <原文>"` 停下，不先做修复、不跑 `validate`。
- **keel- 阻塞自动重开**：以 `keel-` 开头原因阻塞的任务，在当前 `KEEL_FLOW_VERSION` 下也会重开：距离阻塞至少 30 分钟，且已配置的 `keelLedgerRoot` 此时可读（台账仍读不到时不登记重开、不退轮次，等台账恢复后再重开）；同一 PR 同一次准入（admission epoch）最多重开 3 次。重开只在修复会话真正派发出去（拿到回执）时才计入次数并退还轮次；本轮因预算推迟、台账门禁、所有权复核或采集失败而没派发时，什么都不消耗，下一轮继续重开。超过上限后保持阻塞，由通知提示人处理。旧合约（`keelFlowVersion<3`）任务的一次性重开同样要求台账可读。

## 修复 session 的 Keel 流程

### 作者交接与取回

**转 Ready 就是交接**（2026-10-15 起）。作者自己的 PR 不管是网页按钮、`gh pr ready` 还是 Keel `pr_ready` 转的 Ready，watcher 通常在 30 秒内接手（轮末约 40 秒内出现的留到下一轮开头，见下文「并行与跟进」）：没有评论回执时，按本次 Ready 代次和当前 HEAD 合成一份隐式回执（`implicit: true`），下游归属检查照常核对仓库、PR、作者和 Ready 代次。准入不再要求 CI 先全绿，必需检查失败和冲突直接成为修复反馈；审查流程不在线（`review-ingress-missing`）时才不接手。

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

`reclaim` 将 PR 转回 Draft 并确认结果。watcher 在 discover、poll 和 scan 入口观察到 Draft 时作废活动任务；修复 helper 每次读取 GitHub 的 Ready/Draft 代次，即使巡检错过中间的 Draft、HEAD 也未变化，旧任务仍会被拒绝。再次转 Ready 是新的交接：新代次、新任务，旧任务永远不能续用；修复轮次计数（`repairRounds`，只作记录）也按新代次重新计数。

再次转 Ready 时游标不再整体清空，而是只保留「覆盖账本」（`feedbackLedger`）还担保的那部分：一个完成轮次（`complete` 或 `waiting-ci`）被消费时，把它对每个反馈 key 的处置记入账本（`stamp` 即当时的游标戳 `revision:contentHash[:sha]`、`disposition`、`resultHead`、`dispatchId`）。转 Ready 时，账本里 `stamp` 与当前游标相同、且旧处置为 `no-change` 的反馈不再重投；其余全部照常重投——被作废（`author-reclaimed`）、blocked 没有覆盖、没有结果的任务所带的反馈，内容或 revision 变了的反馈，CI / 冲突 / code-scanning 在新 sha 上的反馈，以及旧处置为 `fixed` 的反馈（第一版保守，Draft 期间作者可能改回代码）。

`missing-result-limit`（补投三次无结果）不再是死路：同一 PR 出现新 head、新反馈或必需 CI 状态变化时，watcher 自动把它转回 active（`blockedKind: missing-result-reopened`，不发评论）并按新反馈派发；同一 Ready 代次内最多自动复位 3 次（`missingResultResets`），超过后保持终态并写一条 `missing-result-reset-limit` 通知。没有任何变化时不复位，不会对不交结果的会话反复投递。复位时死任务当初领到、却从未得到判定的反馈（读它的 task 文件）也从游标里取回，与新反馈一起派发，不会被静默当成已处理；若 limit 与复位发生在同一次扫描，limit 的人工通知照常写出。

PR 上的「盯梢停下了」评论按 (PR, head, blockedKind, 归一化原因) 去重，同一组合只发一次，不再因为每个新派发的 `dispatchId` 不同而重复；原因或 head 变了才再发。通知队列与升级逻辑不变。

修复不设轮次上限：同一 PR 只要还有新反馈、还没到可合并，watcher 就继续派修复轮次。旧版本按 6 轮上限停下的 PR（`blockedKind: round-limit`），下一次扫描会转回 active（`round-limit-reset`，不发评论），压住没投的反馈照常投递。

修复会话每次改文件、提交或外发回复前执行 `mivo-repair.mjs assert-owner --home <home> --task <task>`。`prepare`、`validate` 前后、`finalize` 推送前和 CI 复查也执行同一归属检查。网络失败不放行，旧任务没有交接回执也不放行。已确认受控 push 的回执只允许同一任务继续验证/收口，不允许旧任务继续修改已推进的 HEAD。

受控 push 使用一次性 hooks 目录：先按 Git 原语执行原有 `pre-push`，再核验实际推送的 SHA/ref 和实时归属。作者在耗时预检期间转 Draft 时，Git 拒绝发布。原 hook 的参数、标准输入、失败退出码及其他 hooks 保留；结束后清除临时目录，不改持久 Git 配置。此入口需要支持 `git hook run --to-stdin` 的 Git；不支持时拒绝推送。GitHub 核验与远端 Git 接收不是原子事务，核验后瞬间取回的极短窗口仍无法靠客户端完全消除。

受控 push 可能先于结果回执可见。判断「HEAD 变了」的基准是本次交接认可过的最新 HEAD（`trustedHead`：Ready 时的 HEAD，之后每轮修复任务到达的 HEAD，以及任务派发时的 HEAD），所以第二轮及以后的修复不会被当成作者推送。同一 Ready 代次内，修复会话还在跑时出现的新 HEAD 先按 `head-change-unconfirmed` 等它自己的结果（最多 60 分钟），晚到的有效结果会重新触发消费，即使 PR 指纹没有再次变化。没有会话在跑、或等满 60 分钟，新 HEAD 就算作者自己的推送：没做完的任务作废、它负责的反馈重新投递；已经处理过的反馈不重投，也不额外消耗修复轮次；watcher 以新 HEAD 的隐式回执继续处理，不再永久暂停（事件 `author-push-superseded`）。真正的 Draft 或代次变化仍会永久撤销旧任务。

运行中的命令不能保证被立即打断；这些检查是协作式边界检查，不是宿主对任意文件写入的强制拦截。

### 反馈出口

- 统一分级：修复会话、裁决 Worker 与审查机读同一份标准文件（`severityStandardPath`），派单消息带它的全文和版本号；KEEL J4 或其他分级说法与它冲突时以它为准。标准变化会改变规则版本，已绑定的会话随规则刷新拿到新标准。
- 审查账号的 P0/P1/P2：修复会话修，修完 watcher 带证据回复并 resolve。读不到统一分级时不允许判不成立。
- 各执一词交裁决：会话认为一条可修的 P0/P1/P2 不成立时不能自己定。它用 helper `adjudication-brief --keys <反馈 key> --claim <会话的说法>` 生成裁决材料（意见原文、审查机问题 key、相关文件在本 PR 的改动、会话说法、任务带的统一分级全文和交回格式），原样交给只读裁决 Worker；裁决结论逐条记进 SC JSON 的 `workers[].rulings`（`valid` / `invalid` / `p3` 加理由）。`valid` 必须修，finalize 拒绝把它记成 no-change；`invalid` / `p3` 才能 no-change，watcher 带证据回复并 resolve。审查账号的 P1/P2 还会在回复末尾附一行机读裁决记录（P0 不附：审查机不按裁决放行 P0） `<!-- mivo-ruling v=1 key=<问题 key> head=<结果 head> verdict=<invalid|p3> std=<分级版本> by=<agent/model> task=<dispatchId> -->`，审查机核对后采信，不再重复提出；之后的提交改了相关文件，裁决失效。会话写的证据和理由里的 HTML 注释会被转义，伪造不了这行记录。
- 裁决 Worker 开不成（缺路由、没有 Orca 工具、创建失败）时，会话在 SC evidence 写一条 `adjudicate-skipped:` 说明后记 no-change。审查账号的 P1/P2 这样收口时，watcher 转成 issue 跟进：issue 标题和正文提到本 PR，带意见原文、会话说法（未经裁决）、没能裁决的原因和 `<!-- mivo-defer key=… class=… path=… -->`；再在 PR 说明的「转 issue 跟进的审查问题」一节登记（没有就新增，已登记不重复），回复说明后 resolve。审查机按 key 认这个 issue，它打开期间不再阻断；由人在 issue 里确认。同一 PR 同一问题已经有 issue（不论开关）就复用，重跑或中途失败不会重复开。P0 不转。
- Greptile 的 P0/P1/P2（`greptile-p1-triage`）：Greptile 按自己的标准打级，所以修复会话先按统一分级重新判定，确认是 P0/P1/P2 才改代码；其余带核实依据回复并 resolve。
- Greptile、审查账号的 P3：watcher 直接回复说明并 resolve，不开会话。P2 只走行内 finding，不从 Greptile 汇总评论派修复。
- 仓库成员（OWNER/MEMBER/COLLABORATOR，含作者本人）留的 review thread（`member-thread-triage`），以及成员的 review 总评 / PR 主讨论区评论（`member-feedback-triage`）：交修复会话按统一分级判定，确认 P0/P1/P2 才改代码，否则 no-change 并回复说明；不解析正文命令作为授权。严重度读不出、来源未核验的其他未解决 thread（`thread-triage`，含仓外人员和其他机器人）同样先核实。P3 由 watcher 贴出会话写的结论并 resolve。目标是 PR 不因为一条没人处理的讨论卡在合并前。
- 当前 head 上阻断合并的 CodeQL / code scanning 告警带 verified evidence 后作为可修复反馈（`required-ci-fix`），不再记外部阻塞；没权限或分析缺失保持采集 unknown，禁止 dismiss 或降阈值。
- Ready PR 只差落后 main（`mergeStateStatus=BEHIND`）且其余门都通过时，watcher 用 GitHub `update-branch`（merge，不 rebase / 不 force push）把 main 合进 PR 分支；BEHIND 本身不算可合并。watcher 不自己触发审查机重审：审查机的讨论全部 resolve 后，由前置审查（唯一派发入口）在同一 head 上重新送审，审查机按回复里的裁决记录放行。旧版本记下的重审尝试只做收尾，10 分钟后记为失败、不再算待办。
- 产品意图：watcher 抓 PR 正文，优先取标题含「产品意图 / 设计意图 / Product intent」的一节（没有就取正文开头，最多 2000 字），写进任务的 `prSnapshot.prIntent` 和派工消息。反馈要求的改法会推翻 PR 正文、规格或维护者裁定里写明的界面、交互或流程时，它不算缺陷：会话不改代码，记 SC=no-change 并引用正文，watcher 回复后 resolve，继续推进。
- 全自动推进到可合并（不合并）：严重度拿不准时会话自己复现核实，确认不了 P0/P1/P2 就按不成立回复并 resolve；严重度未知本身不 blocked。Jev 不可用是例外：`finalize` 门禁要求被引用的决策行带 Jev 结论，没有结论就收不了口，所以会话遇到 Jev 不可用（如 `JEV_NOT_CONFIGURED`）要立即以 `keel-jev-unavailable:` 开头的原因 blocked。只有缺权限、缺环境、外部服务故障、Keel 台账或 Jev 不可用、作者收回才 blocked。本地审查/e2e Worker 是局部例外：本机缺 `routing.json` 或开不了 Orca Worker 时不 blocked，先尝试一次 `start_team({worker_permission_mode:"bypassPermissions"})`，仍不行就跳过尚未运行的本地审查/e2e，并在 SC evidence 写明原因；禁止改用原生子代理。仓库预检、validate 收据、required CI 和服务器审查不豁免。
- 卡住要让人看见：修复任务 blocked（外部阻塞、补投三次无结果、结果无效、派发失败）时，watcher 把事件写进 `state/notices/`，用独立的 `bin/notify.mjs` 调度发飞书（watcher 与作者是同一 GitHub 账号，@自己不会通知）。同一 blocked 原因每个 head 只升级一次，不再原样重投。规则版本变化、新 head 或新反馈时仍会重投。必需 CI 红、HEAD 漂移这类 watcher 自己会接着处理的状态不发。无代码改动且当前 head 必需 CI 仍红时，对失败 job 做一次 `gh run rerun --failed`；第二次仍红按同因升级。`waiting-ci` 被新反馈取代时，旧任务已有证据的 thread 会等到后续 complete 或当前 head CI 全绿再回复并 resolve。validate 心跳跑在独立子进程；通知队列用 `pending.lock` 串行读写。
- Greptile 汇总评论没有自己的 P0/P1 时不单独开会话（它的发现另以行内 thread 出现）。汇总里只有 P2 也不派修复，P2 只走行内 finding。
- 策略读不出（`required-policy-unknown`）和可合并（`merge-ready`）各在状态转换时出一条事件。

`handoff.e2e.test.mjs` 在隔离子进程中运行真实 CLI、Git 和状态机，GitHub/Host 传输使用替身。它验证交接、投递、取回、遗漏 Draft 的代次检查与查询失败路径，不代表真实 Host 会话已被中断。

派给修复 session 的消息要求全程用 Cindy 的 Keel 插件（`ghost_id=keel`），不再用 goal skill。当前契约是 v3（`keelFlowVersion=3`）：

- 每个任务的 Keel `run_id` 固定为 `run-<dispatchId 里的时间戳>-<dispatchId 哈希前 6 位>`（`keelRunIdFor`）。watcher 把它写进派工消息，helper 收口时重算，不接受别的值。
- 台账顺序不可颠倒：`prepare` 之后第一次判断必须是带这个 `run_id` 的 `pstack_decide(op:"decide", template:"J4")`。当前 Keel 只有这一步会建立 `runs/<run_id>/decisions.jsonl`（Jev 不可用时也会先写一行再报错）；然后用 `pstack_decide(op:"log")` 写入 `kind:"step"`、`summary:"vigil task=<dispatchId>"` 绑定任务。`op:"log"` 要求台账已存在，先 log 会得到 `RUN_NOT_FOUND`。可改代码的任务使用 `bug-fix` 手册，调查任务使用 `investigation`。
- 不要调用 `pstack_start`、`keel_run`、`keel_report`、`keel_wait`、`keel_gate`、`keel_status`：它们会另建 worktree 和图 run，与本流程无关。只允许 `jev`、`pstack_decide`（decide / log / read）、`pr_threads` 和手册；`pr_reply` 每次弹确认框、`pr_wait` 长轮询、`pr_status` 会读到作者转 Ready 时写的交接记录而停手，所以都禁止。GitHub 写操作仍只走 helper 与 `gh`。
- Jev 只在固定判断点给参考（严重度未知、CI 抖动还是真失败、P0/P1/P2 不成立的证据、修法选择），不能单独授权改代码。
- `finalize --keel-run <run_id>` 在推送前读取 `runs/<run_id>/decisions.jsonl`。v3 任务必须具有：固定的 `run_id`、任务创建后写入的精确绑定行、实际处置判断（Keel 写入的 `pstack_decide` 决策行，带 `state_sha256`、`answer`、`policy`；手写的 `decision` 行不算），以及绑定当前 `validated-head` 的 `vigil-flow` 证据。第一条决策必然先于绑定行（它建立台账文件），所以 v3 不要求决策晚于绑定，也不再要求启动记录。缺配置、缺记录、任务或提交不匹配均报 `KEEL_RUN_REQUIRED`；结果的 `keel.contractVersion=3` 表示通过 v3 契约。
- 收口证据通过 `pstack_decide(op:"log")` 的 `kind:"evidence"` 写入：`evidence` 包含 `kind:"vigil-flow"`、`version:3`、`taskId`、`head`、`playbook`、`manualPath`、`decisionRowIds` 和 `steps`。`decisionRowIds` 引用 `pstack_decide(op:"decide")` 返回的 `ledger_row`（形如 `<run_id>#<n>`）；`steps.reproduce`、`steps.repair` 写明实际复现/调查与处置证据；`steps.verify` 的 `head`、`receiptSha256` 必须匹配 helper `validate` 返回的验证收据。完整调用格式见派工消息。
- 全部 SC 为 `no-change` 且提交未变时，`steps.verify` 改为 `{status:"not-run",reason:"具体原因"}`，仍需调查证据和实际判断。后续同提交的 `recheck` 保留已验证的 `keel` 结果。
- Keel 台账本身不可用（工具缺失、`RUN_NOT_FOUND` 等）时，会话用 `blocked --reason "keel-unavailable: <原文>"`。reason 以 `keel-` 开头的 blocked 说明契约和已安装的 Keel 对不上，不是对反馈的判断。watcher 升级到更新的契约版本后，对仍在旧契约（v1/v2）上的这类任务，下一次扫描把它们的反馈退回游标并退还轮次（每个 `dispatchId` 只退一次，同一 PR 更早的同类任务一并退，状态里记 `keelReopened`），反馈会被重新投递。已在当前契约上的任务不会自动重投，避免 Keel 再次损坏时循环，只发 `repair-blocked` 事件等人处理。
- v3 依赖已安装的 Keel 提供 `pstack_decide` 的 `op`（`decide` / `log` / `read`）参数，即 `pstack_ledger` 已并入之后的版本。部署 v3 前先确认各机 Keel 版本；旧版 Keel 会把 `op:"log"` 当成 decide，会话会以 `keel-` 开头的原因 blocked，而 v3 任务不会自动重投。
- 在途旧任务不改写，各按自己的契约核对。v1（`keelFlow=true` 且没有 `keelFlowVersion`）沿用绑定检查，缺台账配置时仍为 `disabled`；配置存在且任务没有 `keelFlow=true` 时为 `not-required-legacy-task`。v2（`keelFlowVersion=2`）仍要求 `pstack_start` 写入的 `start <playbook>（` 行；当前 Keel 不再自动写这一行，v2 任务只能靠会话手写才能通过，这是升级 v3 的原因。这些旧契约结果不代表通过 v3。
- `prepare` 返回 `ciErrors`：失败必需检查所在 workflow run 的 `##[error]` 行（每个 run 最多 20 行），取不到时给出错误原因。

## 并行与跟进

发现器由 Cindy 脚本模式定时任务触发（建议 `* * * * *`，超时 180 秒）；一轮最多跑 165 秒。采集有硬上限:每次 gh 调用前检查「整轮截止 − 派发预留」,到了就中止该 PR 的采集(标 `collectRetry`,下一轮最先处理),所以一轮不会跑过约 165 秒;整轮最后约 40 秒(派发预留 25 秒 + 最小采集 15 秒)内才出现的变化不再启动采集,同样留到下一轮开头——「新反馈通常 30 秒内派发」只在其余时段成立,最坏情况下一轮开头才处理。宿主调度器在本轮结束后才排下一次触发（同一 schedule 不会重叠，也不会积压），所以选每分钟时两轮之间约 20–30 秒空档（选 `*/2` 时约 155 秒结束的一轮要到 240 秒才再触发，约 85 秒无人检测）；整轮预算须小于调度 `timeoutMs`。手工另起进程时，拿不到 `discover` 锁会直接返回 `lock-held`。

- **不设并发上限**：一轮里所有 open PR 同时采集、同时派发，一轮耗时约等于最慢的那个 PR，不再随 PR 数量线性增长；某个 PR 出错不影响其他 PR，错误在所有 PR 结束后再抛出。`gh` 和复查 helper 走异步子进程，不阻塞其他 PR。
- **同一轮共享仓库级查询**：分支规则、仓库变量、审查 workflow、钉住的 required-checks 文件和当前账号，每轮只查一次。
- **按间隔批量跟进，与全量处理并行**：一轮 discover 先取一次基线，再同时做两件事——对所有 open PR 全量处理，以及按 `followIntervalMs`（默认 15 秒）的节拍发**一次**批量查询（`gh api graphql` 的 search，一次覆盖全部 open PR：Draft、head、更新时间、标签和最新提交的 CI 汇总 state，只取汇总 state，不拉 contexts）。节拍不等慢采集：某个 PR 采集 100 秒时，其他 PR 的变化仍在下一个节拍内被发现并处理；正在处理的 PR 保留旧签名，空闲后下一拍再看。变化的 PR 先补一次 `gh pr list` 取完整信息再处理。没有变化时每个节拍只有这一次查询，一直查到整轮预算（上限 165 秒）末尾，节拍从启动后的基线算起、gh 的真实延迟会把最后一拍推到约 150–156 秒，所以一轮约 150–160 秒结束、两轮之间的检测空档约 20–30 秒；整轮最后约 40 秒（派发预留 25 秒 + 最小采集 15 秒）内查到的变化不再启动采集，只标 `collectRetry` 并记入 `index.deferredNumbers`，由下一轮开头最先处理。批量查询报错或被限流时按 2 倍间隔退避（上限 60 秒），连续失败 3 次（限流算 2 次）就不再跟进，本轮照常结束，不会因此失败。一轮上限 165 秒、实际约 150–160 秒结束，配合每分钟一次的 cron，两轮之间约 20–30 秒空档。
- **预算与派发预留**：采集可以用掉整轮预算里除派发预留（默认 25 秒）以外的全部时间，所以采集 60–100 秒的 PR 有新反馈时当轮就派发；只有采集结束时剩余不足派发预留才推迟（`dispatch-budget-deferred`），被推迟的 PR 下一轮排在最前面。
- **没有修复会话的 Ready PR 也先走指纹闸**：每轮先用一次轻量 GraphQL 查询取指纹，覆盖 PR 更新时间、最近 20 条评论 / 10 条 review 的 id 与更新时间（旧评论被编辑也会变）、各线程最近 5 条评论的更新时间、最新提交的 `statusCheckRollup.state`、legacy commit status 的 contexts，以及 CheckRun 状态；head、冲突状态、标签、Draft 也在内。指纹没变、也没有 `collectRetry`、待补投或其他本地待办时跳过全量采集（约 40 次 `gh`）。只有**完整、可信**的采集才算收口：CI `unknown`、策略未核实、采集失败、被推迟、台账未恢复、派发未确认等都保留旧指纹并标 `collectRetry`，下一轮重新采集。另有兜底：距上次完整采集超过 `fullCollectMs`（默认 10 分钟）就强制全量采集一次，指纹看不到的变化最多延迟这么久。
- **CI 终态缓存**：同一 PR 的多个必需检查的 job / run 查询并发执行；已完成（`completed`）的 job / run 按 `head SHA + job/run id` 缓存在 `state/kept-reads.json`（24 小时），同一 head 不再重复调用；未终态的每轮照常查询，run 被重跑（job 的 attempt 高于缓存的 run）时重新读取。
- **派发并发**：Python 包装同时转发多个 `sessions.dispatch`；宿主同时最多接 16 个调用，包装自己最多同时发 12 个，多出来的排队，不报错。

时间相关配置见上文「可选项」（`roundBudgetMs`、`dispatchReserveMs`、`followIntervalMs`、`fullCollectMs`、`scheduleTimeoutMs`）；`MIVO_WATCHER_FOLLOW_MS=0` 只跑全量一轮。

`waiting-ci` 不算在途：当前 head 出现新的必需 CI 失败、冲突或审查意见时，同一轮就会派新任务。被预算推迟的复查（`recheckDeferredAt`）下一轮即使指纹没变也会再查。补投只在该 dispatch 没有结果文件、且距最近 helper 活动或派发已超过 30 分钟时发生，上限仍为 3 次。session 写结果不抢 PR 状态锁。可合并与无自动出口的事件用 `bin/notify.mjs` 配独立调度发出，见 [`docs/operations.md`](../../docs/operations.md)。

## 规则版本与已开会话

修复会话是长期复用的，历史里留着旧版 watcher 投递的规则。每次投递的第一行都是 `盯梢规则版本 <12 位>`，并写明本条覆盖此前收到的规则；版本号是把当前全部规则文字渲染后取的摘要，规则一改版本就变。回执确认后，PR 状态记下这次实际投递的版本（`rulesVersion`，重投旧消息时记旧版本）。

已绑定会话的 PR 每轮检查一次：版本落后、手上没有任务在跑（不是 queued / accepted / prepared / running）、没有待投递的反馈、PR 不是可合并时，补发一条「规则更新，不是新任务」的消息，只带当前规则、不改代码不回评论；同一版本最多补发 3 次（`rulesRefresh` 记次数和错误）。有反馈要投递的会话不补发，因为那条投递本身就带当前规则。

## CLI

```sh
# 发现：扫描 targetRepo 下你自己的 open PR,找出需要处理的
node bin/mivo-watcher.mjs                       # 默认 discover 模式
MIVO_WATCHER_MODE=poll MIVO_WATCHER_PR=<N> node bin/mivo-watcher.mjs   # 单独轮询一个 PR

# 修复动作:clone/worktree、push、清理
node bin/mivo-repair.mjs <子命令> --home "$MIVO_WATCHER_HOME"

# 查询某个 PR 当前归哪个任务/session 管
node bin/mivo-ownership.mjs --repo your-org/your-plugin-repo --pr 123 --home "$MIVO_WATCHER_HOME"

# 通知：有未发事件 exit 0 并打印 CINDY_PRECHECK_OK,否则 exit 2;emit 发出并标记已发
node bin/notify.mjs check --home "$MIVO_WATCHER_HOME"
node bin/notify.mjs emit --home "$MIVO_WATCHER_HOME"
```

## 停止盯梢某个 PR

给该 PR 打标签 `mivo-watch:off`，发现器下一轮会跳过它。

## Mivo profile 约定（可按需适配）

以下严重度分级与标签名是这套工具原本运作所在团队（Mivo）的约定，代码里保留了这些具体名字，
但它们只是**可替换的配置**，不是协议的一部分：

- 审查反馈严重度 `P0`/`P1`/`P2`/`P3`:P0/P1/P2 视为必须改代码才能回复;P3 只需回复不改代码。
- 修复会话核实某条 P0/P1/P2 讨论不成立(已验证完成的结果里该 key 为 `no-change` 且附证据)或确认已修复(`fixed` 且 SC=`pass` 附证据)时,watcher 带证据回复并关闭该讨论;没有证据的不关。新审查机(`mivo-review:` 前缀)的行内线程同样走这条路径。收口在等 CI 的复查之后执行，CI 在本轮变绿就在本轮收口；线程里只要还有一条不属于已完成任务的外部意见(例如修复期间新加的回复)就不关，交给正常派工。本轮刚关闭的线程，其评论即使因修复推送变成 outdated 而重新出现，也不再当作新反馈派工。会话不要自己回复或 resolve thread。会话结果晚于上一次轮询写入时,即使 PR 指纹未变也会重新读取,避免任务停在 accepted、讨论永远挡住合并。等 CI 的复查需要约 15–20 秒;剩余扫描预算不足 40 秒时不硬跑(硬跑会被超时杀掉、排在后面的 PR 每轮同样失败),而是结束本轮并从该 PR 续扫,复查超时上限 60 秒。
- 本轮通过的标签名 `review:merge-ready`。
- 审查信号（`public-review.mjs`）：审查流程由前置协调器派发 `review-pr.yml`。判「可合并」要同时满足：当前 head 上最新一条 `review-pr` check（GitHub Actions 写入、关联到本仓 `review-pr.yml` 的 workflow_dispatch run）成功；`reviewerLogin` 在同一 head/base 上提交了干净报告（Approve，或带 `<!-- mivo-review:report head=… -->` 的 COMMENT）且晚于本次 Ready；其余条件同前（必需 CI、扫描门、可合并且非 BEHIND、讨论已解决、无否决、无未处置新反馈）。
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
