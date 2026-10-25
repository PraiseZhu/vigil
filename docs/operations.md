# 运维指南

本文档说明如何在自己的环境里跑起 Vigil 的两个 watcher,以及一些排障场景。两套 watcher
(`mivo`/`cindy`)操作方式几乎一致,仅在"同仓分支"与"cross-repo fork"的部分有差异,见各自
README 的对比表。

## 1. 准备配置

每个 watcher 需要一个 "watcher home" 目录,用来存放运行态数据(`state/`、`deployments/`、
`config/profile.json`)。这个目录**不随代码仓库发布**,需要你自己创建。

```sh
mkdir -p /path/to/your/mivo-watcher-home/config
cp config/examples/mivo.profile.example.json /path/to/your/mivo-watcher-home/config/profile.json
# 编辑 profile.json,把占位值换成真实的仓库名、本地仓路径
```

cindy watcher 同理,用 `config/examples/cindy.profile.example.json`。

必填/可选字段的完整说明见 [`watchers/mivo/README.md`](../watchers/mivo/README.md#配置profilemjs-的-fail-closed-机制)
与 [`watchers/cindy/README.md`](../watchers/cindy/README.md#配置profilemjs-的-fail-closed-机制)。

## 2. 调度:在 Cindy 里创建发现器调度

Vigil 的两个 watcher **不是**可以配进任意 cron 的无状态脚本——discover 模式必须跑在 Cindy
桌面端的调度器之下,通过"script 模式"schedule 触发,原因见
[`docs/architecture.md`](architecture.md#调度依赖-cindy-桌面端的-script-模式调度器)。

### 前置条件

- 已安装并登录 Cindy 桌面端,且该账号的调度器可用。
- `gh` CLI 已登录,watcher 通过它调用 GitHub API。
- `node` ≥ 22、`python3` 已安装(discover 的入口是 Python 脚本,内部再 spawn Node watcher)。
- 已完成「1. 准备配置」,`<watcher home>/config/profile.json` 存在且字段齐全。

### 创建发现器调度:完整参数表

在 Cindy 里新建一条调度,各字段取值如下(字段名与类型取自 Cindy 调度器自身的
`schedule_create` 参数 schema,不是 Vigil 自定义的):

| 字段 | 取值 | 说明 |
|---|---|---|
| `executionMode` | `"script"` | 零 token 模式:宿主不起 agent,直接执行 `scriptConfig.command` |
| `cronExpr` | `"* * * * *"` | 每分钟触发;5 字段 cron(minute hour day-of-month month day-of-week)。一轮最多跑 165 秒(超时 180 秒减 15 秒余量),轮内与全量处理并行、每 15 秒用一次批量查询(含最新提交的 CI 汇总 state)复查全部 open PR,慢采集不挡节拍,一直查到整轮预算(上限 165 秒)末尾:节拍从启动后的基线算起,gh 的真实延迟会把最后一拍推到约 150–156 秒,整轮约 150–160 秒结束,所以两轮之间的检测空档约 20–30 秒。下一次触发要等本轮结束后才按 cron 排定(同一 schedule 不会重叠,也不会积压),所以选每分钟:一轮约 155 秒结束,下一次在 180 秒触发;若选 `*/2`,约 155 秒结束的一轮要等到 240 秒才再触发,中间约 85 秒无人检测。整轮预算须小于调度 timeoutMs(180 秒,留 15 秒余量)。上一轮没结束时新的触发不会出现;若手工另起进程,拿不到 `discover` 锁会直接返回 `lock-held` |
| `timezone` | 你所在时区的 IANA id,如 `"Asia/Shanghai"` | 必填 |
| `recurring` | `true` | discover 是常驻轮询,不是一次性任务 |
| `scriptConfig.command` | `python3 <watcher home>/bin/mivo-watch-script.py --mode discover`(cindy watcher 换成 `cindy-watch-script.py`) | 经系统 shell 执行,cwd 为 `workingDir`;该命令必须实现 `cindy-script/1` 协议(stdout 只能是协议帧,调试输出走 stderr) |
| `scriptConfig.capabilities` | `["sessions.dispatch"]` | 能力白名单,默认全拒;discover 只需要唤醒/派发修复 session 这一项能力,不要多授予 |
| `scriptConfig.timeoutMs` | 按需,可省略 | 整轮脚本超时;超时会杀进程树,run 记 failed |
| `workingDir` | `<watcher home>` 的绝对路径 | script 模式下作为 `scriptConfig.command` 的 cwd |
| `useWorktree` | `false` | script 模式不支持 ephemeral worktree |
| `notify` | `{"desktop": false, "feishu": false}` | discover 建议静默;失败轮仍会记进调度日志 |

discover 一次调用会扫描 `targetRepo` 下你自己的所有 open PR,不需要"每个 PR 一个调度项"。

### 通知调度

需要人处理的事件(首次可合并、同因 blocked 升级、Keel 台账读不到导致派发暂停、needs-human / 三次补投无结果 / `missing-result-reset-limit`（自动复位次数用尽，仍无结果）/ 结果无效 / 派发无回执)写进 watcher home 的 `state/notices/pending.json`。另建一条 script 调度,前置检查有未发事件才跑,并把通知发到飞书:

| 字段 | 取值 |
|---|---|
| `executionMode` | `"script"` |
| `cronExpr` | `"* * * * *"` |
| `scriptConfig.command` | `node <watcher home>/bin/notify.mjs emit --home <watcher home>` |
| `preRunHook` | `node <watcher home>/bin/notify.mjs check --home <watcher home>`（检查完整成功都打印 `CINDY_PRECHECK_OK`；有未发事件 exit 0，空队列 exit 2。宿主字段是 `preRunHook` / `schedule_set_pre_run_hook`，不是 `scriptConfig.precheck`） |
| `scriptConfig.capabilities` | `[]` |
| `notify` | `{"desktop": false, "feishu": true}` |
| `workingDir` | `<watcher home>` |

`emit` 按 `cindy-script/1` 输出一个 complete 帧,`resultText` 用简体中文写清 PR 号、链接、发生了什么、需要做什么(可合并就写可以点合并了),然后把这些事件标为已发,重复运行不重复发。

### poll 模式

`poll` 模式(`--mode poll --pr <N> --node-id <id>`)用于手动单独排障某一个 PR,不建议配进
常规调度,通常是你本地手动跑一次来看某个 PR 的详细判断过程。

### Keel 重装或迁移后的处理

Keel 插件重装到企业命名空间（如 `xd`）后，台账目录和调用方式都会变。按下面三步让盯梢跟上：

1. 在 profile（或环境变量）里更新 `keelLedgerRoot` 为新的台账目录，并设置 `keelNamespace`
   （mivo 用 `MIVO_KEEL_NAMESPACE`，cindy 用 `CINDY_KEEL_NAMESPACE`）。未配置 `keelNamespace` 时，派工消息要求修复会话
   省略 `namespace` 参数，不得传 `null`。值不合法（含点、空格、以 `-` 开头、超过 128 位等）会直接报配置错误，不会被当作未配置。
2. 重新部署（`deploy.mjs`）。派工消息变了，规则版本随之变化，卡在 `external` 的 PR 会被重开一次。
3. 不用手工清理状态：
   - `keelLedgerRoot` 没配置或目录读不到时，盯梢不向修复会话派发、不扣轮次、不发 `blocked` 阻塞播报，只写一条 `keel-unavailable` 通知（每个 PR 每天一条）；配置好或目录恢复后下一轮自动派发。这道门禁只拦「派发修复会话」，与 Keel 无关的确定性处理（如 P3 线程的自动回复与 resolve）照常执行。
   - `prepare` 对 Keel 流程任务在建 worktree 前也会核对台账根（未配置、不存在、不可读），不满足就以 `keel-unavailable:` 开头的原因报 blocked。
   - 以 `keel-` 开头原因阻塞的任务，距离阻塞满 30 分钟且台账目录此时可读，才自动重开（台账仍读不到时不消耗重开次数），同一 PR 同一次准入最多 3 次；重开时交回该任务的反馈，只有修复会话真正派发出去（拿到回执）才计入次数并退还轮次，因预算推迟等原因本轮没派发则什么都不消耗，下一轮继续重开。
   - Jev 缺 key（`JEV_NOT_CONFIGURED`）时，`finalize` 门禁照旧要求被引用的决策行带 Jev 结论；修复会话应立即以 `keel-jev-unavailable:` 报 blocked，再按上一条退避重开。补上 Jev 配置后无需其他操作。

## 3. 运行锁排障

如果怀疑一个 PR 的处理被卡住(比如进程异常退出没释放锁),用 `lock-doctor` 子命令查看:

```sh
node watchers/<mivo|cindy>/bin/<mivo|cindy>-repair.mjs lock-doctor --home "$WATCHER_HOME"
```

它会列出当前所有锁和"接管守卫"(reclaim guard),以及哪些守卫的持有进程已经不存在
(`orphanGuards`)。只有 owner 进程确实已死、且文件修改时间超过 10 分钟的守卫才能被
`--clear-guard <lockName>` 清除——这是故意保守的设计,避免误删一个仍在工作的进程的锁。

### GitHub 读请求与缓存

发现器每轮最多 165 秒,每分钟排一次触发(上一轮结束后才排下一次)。采集有硬上限:每次 gh 调用前检查「整轮截止 − 派发预留」,到了就中止该 PR 的采集(标 `collectRetry`,下一轮最先处理),所以一轮不会跑过约 165 秒;整轮最后约 40 秒(派发预留 25 秒 + 最小采集 15 秒)内才出现的变化不再启动采集,同样留到下一轮开头——「新反馈通常 30 秒内派发」只在其余时段成立,最坏情况下一轮开头才处理。下面两类读请求只能用 `gh` 登录的个人账号发(GitHub App 令牌调不了
`/user`,读分支保护要管理权限),所以跨轮缓存在 `state/kept-reads.json`:

- 登录名(`gh api user`):6 小时。
- 分支规则、分支对象、分支保护:10 分钟。改了必需检查,watcher 最多晚 10 分钟看到。

`gh` 换了登录账号或想立即重读时,删掉这个文件即可,下一轮自动重建。

两个 watcher 读 PR 时都不请求 `headRepository` / `headRepositoryOwner`,这样经 GitHub App
分流时整条读请求可以走 App。mivo 只用 `isCrossRepository` 区分同仓分支与 fork;cindy 要知道
fork 的归属,头仓改从 REST `repos/<repo>/pulls/<n>` 读,读不到(fork 已删)时按原来一样不放行。

## 4. 部署脚本

`deploy.mjs` 的四个子命令是纯文件系统操作(校验哈希、原子安装、失败回滚),不依赖任何
外部数据库或调度器:

```sh
node watchers/<mivo|cindy>/deploy.mjs verify                 # 只校验源码内部的 import 闭包
node watchers/<mivo|cindy>/deploy.mjs bootstrap --home <dir>
node watchers/<mivo|cindy>/deploy.mjs preview --home <dir> --database <sqlite file> --id <id> --plan <file>
node watchers/<mivo|cindy>/deploy.mjs apply --plan <file>
```

`--database` 指向的 sqlite3 文件只用于一个可选的"目标会话是否空闲"安全检查(`idle()` 函数),
如果你的部署场景不需要这层检查,可以直接改这个函数或传一个空库。

## 5. 停止盯梢某个 PR

- Mivo:给 PR 打标签 `mivo-watch:off`。
- Cindy(fork 场景,你可能没有打标签权限):在 watcher home 的 `config/optout.json` 里加入
  PR 号,或让 PR 作者本人发一条正文恰为 `/cindy-watch off` 的 issue comment。

## 6. 机器生成的 PR（Mivo 每日更新日志）

分支名以 `chore/changelog-` 开头的 PR 由每日更新日志工作流生成，只改 `public/changelog.json`。这个工作流开完 PR 就结束，不看 CI、不合并。盯梢对它的处理和普通 PR 不同：

- 不派修复会话：改动只有数据文件，会话只能去「修」与它无关的测试。
- 必需检查变红时，对每个失败检查所在的 Actions run 调一次 `rerun-failed-jobs`；同一个 head、同一个 run 只重跑一次。只等上游的门（如 `pr-ci-freshness`）在上游没跑完时按分诊暂缓，不计入。
- 重跑后的新一轮尝试仍然红，或失败的必需检查不是 Actions（没法重跑），就通知一次（通知类型 `excluded-head-ci-red`，按 PR 号和 head 去重）。
- PR 被下一天的更新覆盖（head 变化）后重新计算。状态记在该 PR 条目的 `excludedHead` 字段。

## 7. 本地 validate 的并发、日志与收据

两个 watcher 的 `validate` 由异步命令执行，证据都在 watcher home 的 `state/validations/` 下：

| 目录 | 内容 |
|---|---|
| `slots/` | 并发槽位（`slot-<n>.json`，记录 pid 与进程组）；持有进程已死会被下一个申请者回收，并终止遗留进程组（命令经 `sh` 先落盘进程组号到 `slot-<n>.json.pgid` 再 `exec`，持有者在 spawn 后任意时刻崩溃都能回收） |
| `logs/` | 每次运行的流式日志，0600、不可变；收据里有 `logSha256` |
| `<dispatchId>/` | 验证收据与按 head 的指针（既有结构） |
| `pass-cache/` | 通过收据的复用索引（不可信，每次复用都重新校验收据、日志与全部键） |
| `baseline-cache/`、`baseline-locks/`、`baseline/`、`baseline-worktrees/` | 仅 Mivo：基线结果缓存、同键锁、基线收据、基线临时 worktree（用完即清） |

配置键（默认值与非法值行为见各 watcher README）：`validateConcurrency`（默认 2）、`validateStallMinutes`（默认 10）、`preflightTimeoutMinutes`（默认 60）。改小并发后只影响新申请的 validate，已有的合法任务不会被杀。

运维要点：

- 日志与收据按「不可变证据」保留，本版本不做自动清理；磁盘紧张时由人工清理已结束派发的目录。
- 排队的 validate 不是故障：心跳仍在写，不要因为它没产出结果就补投。
- `validate-stalled`（长时间无输出）与 `validate-timeout`（总超时）是环境/卡死问题，不是测试失败；它们的失败集合记 `unparsed`，不会参与基线比较。
- Mivo 的 `baseline-only-failure` 是机器判定的状态，需要 `git merge-base` 能解析（validate 会有界地 fetch 目标 base 分支）；它不放宽远端必需 CI。Cindy 不实现该状态，原因见 Cindy README。
- validate 类阻塞的重开改为按证据判断（head、merge-base、policy、运行指纹、失败集合；base 分支 tip 前进而 merge-base 不变不算变化）；升级前留下的、没有 `validationBlock` 的旧阻塞只在远端 head 变化时才会重开。带 `validationBlock` 但原因是 pathspec、submodule、worktree HEAD 等环境/配置故障的阻塞，按原有 infra 规则重开，不套五要素。当前 base 随每轮采集写进 PR 状态条目（`baseRefOid`/`baseRefName`）；升级前的旧条目没有这两个字段，首轮 merge-base 为未知，下一轮写入后才能比较。validate 类 = 原因不属于环境/配置故障，且（带 `validationBlock` 或原因含 preflight/validat）；原因不必命中 infra 关键词，infra 重开与 external 的 `rulesVersion` 重开共用这一判定。部署新版（`rulesVersion` 变化）不会重投 validate 类阻塞，也不会与五要素判据重复退还轮次。

## 8. 测试环境变量

`watchers/mivo/test.env` 与 `watchers/cindy/test.env` 是跑测试时用的占位环境变量
(`node --env-file=...`),指向 `/tmp/...` 之类的不存在路径——这些路径仅用于触发 fail-closed
分支的断言,不需要真实存在。不要把真实路径写进这两个文件。
