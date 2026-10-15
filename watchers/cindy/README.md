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
  交修复会话按 REVIEW.md 分级(`review-thread-triage`):必修才改,其余由 watcher 贴出会话的结论并 resolve。
  其它应用的状态评论、没有自己必修项的 Greptile 汇总不再单独开会话。
- 修复会话 `prepare` 先对齐 watch 树:落后 fork 就快进,与 fork 分叉就把旧分支打 bundle 存进
  `_backup/` 后按 fork 重建。
- 因环境原因 blocked(预检跑不起来、watch 树分叉、子代理路由被拒等,见 `INFRA_BLOCK_REASON`)的轮次退还轮次、
  把反馈放回队列重投,每个 Ready 代次最多 3 次;新的 Ready 代次重新计修复轮次。
- 终点仍是 `awaiting-maintainer-approval`:仓库要求有写权限的维护者批准并经合并队列合入,watcher 不代替审批。

等 CI 的复查需要约 15–20 秒;剩余扫描预算不足 40 秒时不硬跑(硬跑会被超时杀掉、排在后面的 PR
每轮同样失败),而是结束本轮并从该 PR 续扫,复查超时上限 60 秒。

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


拷一份 [`config/examples/cindy.profile.example.json`](../../config/examples/cindy.profile.example.json)
到 watcher home 下的 `config/profile.json`,把占位值换成真实路径即可。

其余环境变量(`CINDY_WATCHER_MODE`/`CINDY_WATCHER_PR`/`CINDY_WATCHER_NODE_ID`/
`CINDY_WATCHER_ENABLED`/`CINDY_WATCHER_DISPATCH`/`CINDY_WATCHER_BRIDGE`)是运行时/调度相关
的开关,不经过 profile 机制,直接读 `process.env`,具体含义见对应源码文件头部注释。

### 新版任务必需的 Keel 配置

| profile 字段 | 环境变量 | 要求 |
|---|---|---|
| `keelLedgerRoot` | `CINDY_KEEL_LEDGER_ROOT` | Keel 插件数据目录（包含 `runs/` 的那一层）；新派发的 `keelFlowVersion>=2` 任务缺少此配置时，`finalize` 报 `KEEL_RUN_REQUIRED`，拒绝收口和推送 |

## 修复 session 的 Keel 流程

派给修复 session 的消息要求全程用 Cindy 的 Keel 插件（`ghost_id=keel`），不再用 goal skill。当前契约是 v3（`keelFlowVersion=3`）：

- 每个任务的 Keel `run_id` 固定为 `run-<dispatchId 里的时间戳>-<dispatchId 哈希前 6 位>`（`keelRunIdFor`），同时写进 task 文件的 `keelRunId`。watcher 把它写进派工消息，helper 收口时重算，不接受别的值。
- 台账顺序不可颠倒：`prepare` 之后第一次判断必须是带这个 `run_id` 的 `pstack_decide(op:"decide", template:"J4")`。当前 Keel 只有这一步会建立 `runs/<run_id>/decisions.jsonl`（Jev 不可用时也会先写一行再报错）；然后用 `pstack_decide(op:"log")` 写入 `kind:"step"`、`summary:"vigil task=<dispatchId>"` 绑定任务。`op:"log"` 要求台账已存在，先 log 会得到 `RUN_NOT_FOUND`。可改代码的任务使用 `bug-fix` 手册，调查任务使用 `investigation`。
- 不要调用 `pstack_start`、`keel_run`、`keel_report`、`keel_wait`、`keel_gate`、`keel_status`：它们会另建 worktree 和图 run，与本流程无关。只允许 `jev`、`pstack_decide`（decide / log / read）、`pr_threads` 和手册；`pr_reply` 每次弹确认框、`pr_wait` 长轮询、`pr_status` 会读到作者转 Ready 时写的交接记录而停手，所以都禁止。GitHub 写操作仍只走 helper 与 `gh`。
- Jev 只在固定判断点给参考（严重度未知、CI 抖动还是真失败、P0/P1 不成立的证据、修法选择），不能单独授权改代码。
- `finalize --keel-run <run_id>` 在推送前读取 `runs/<run_id>/decisions.jsonl`。v3 任务必须具有：固定的 `run_id`、任务创建后写入的精确绑定行、实际处置判断（Keel 写入的 `pstack_decide` 决策行，带 `state_sha256`、`answer`、`policy`；手写的 `decision` 行不算），以及绑定当前 `validated-head` 的 `vigil-flow` 证据。第一条决策必然先于绑定行（它建立台账文件），所以 v3 不要求决策晚于绑定，也不再要求启动记录。缺配置、缺记录、任务或提交不匹配均报 `KEEL_RUN_REQUIRED`；结果的 `keel.contractVersion=3` 表示通过 v3 契约。
- 收口证据通过 `pstack_decide(op:"log")` 的 `kind:"evidence"` 写入：`evidence` 包含 `kind:"vigil-flow"`、`version:3`、`taskId`、`head`、`playbook`、`manualPath`、`decisionRowIds` 和 `steps`。`decisionRowIds` 引用 `pstack_decide(op:"decide")` 返回的 `ledger_row`（形如 `<run_id>#<n>`）；`steps.reproduce`、`steps.repair` 写明实际复现/调查与处置证据；`steps.verify` 的 `head`、`receiptSha256` 必须匹配 helper `validate` 返回的验证收据。完整调用格式见派工消息。
- 全部 SC 为 `no-change` 且提交未变时，`steps.verify` 改为 `{status:"not-run",reason:"具体原因"}`，仍需调查证据和实际判断。后续同提交的 `recheck` 保留已验证的 `keel` 结果。
- Keel 台账本身不可用（工具缺失、`RUN_NOT_FOUND` 等）时，会话用 `blocked --reason "keel-unavailable: <原文>"`。reason 以 `keel-` 开头的 blocked 说明契约和已安装的 Keel 对不上，不是对反馈的判断。watcher 升级到更新的契约版本后，对仍在旧契约（v1/v2）上的这类任务，下一次扫描把它们的反馈退回游标并退还轮次（每个 `dispatchId` 只退一次，同一 PR 更早的同类任务一并退，状态里记 `keelReopened`；指纹未变的 poll 也会走到这一步），反馈会被重新投递。已在当前契约上的任务不会自动重投，避免 Keel 再次损坏时循环，只发 `repair-blocked` 事件等人处理。
- v3 依赖已安装的 Keel 提供 `pstack_decide` 的 `op`（`decide` / `log` / `read`）参数，即 `pstack_ledger` 已并入之后的版本。部署 v3 前先确认各机 Keel 版本；旧版 Keel 会把 `op:"log"` 当成 decide，会话会以 `keel-` 开头的原因 blocked，而 v3 任务不会自动重投。
- 在途旧任务不改写，各按自己的契约核对。v1（`keelFlow=true` 且没有 `keelFlowVersion`）沿用绑定检查，缺台账配置时仍为 `disabled`；配置存在且任务没有 `keelFlow=true` 时为 `not-required-legacy-task`。v2（`keelFlowVersion=2`）仍要求 `pstack_start` 写入的 `start <playbook>（` 行；当前 Keel 不再自动写这一行，v2 任务只能靠会话手写才能通过，这是升级 v3 的原因。这些旧契约结果不代表通过 v3。
- `prepare` 返回 `ciErrors`：失败必需检查所在 workflow run 的 `##[error]` 行（每个 run 最多 20 行），取不到时给出错误原因。

## 并行与跟进

与 Mivo watcher 相同（详见 `../mivo/README.md`「并行与跟进」）：发现器每分钟触发一次（超时 180 秒），一轮里所有 open PR 同时采集、同时派发，不设并发上限；分支规则、仓库变量等仓库级查询每轮只查一次；两轮之间在启动后第 45 秒再跑一次 `gh pr list`，转 Ready、有新推送或有更新的 PR 立刻处理；Python 包装同时转发多个 `sessions.dispatch`（最多 12 个同时在途，宿主上限 16）。环境变量 `CINDY_WATCHER_FOLLOW_MS` 可改跟进间隔，`0` 只跑全量一轮。

## CLI

```sh
node bin/cindy-watcher.mjs                                     # 默认 discover 模式
CINDY_WATCHER_MODE=poll CINDY_WATCHER_PR=<N> node bin/cindy-watcher.mjs --node-id <id>   # 手动单跑一个 PR,排障用

node bin/cindy-repair.mjs <子命令> --home "$CINDY_WATCHER_HOME"

node bin/cindy-ownership.mjs --repo makecindy/cindy --pr 123 --home "$CINDY_WATCHER_HOME"
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
