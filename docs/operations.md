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
| `cronExpr` | `"* * * * *"` | 每分钟触发;5 字段 cron(minute hour day-of-month month day-of-week)。一轮最多跑 165 秒(超时 180 秒减 15 秒余量),轮内与全量处理并行、每 15 秒用一次批量查询(含最新提交的 CI 汇总 state)复查全部 open PR,慢采集不挡节拍,一直查到整轮预算(165 秒)用尽,所以两轮之间的检测空档约 15 秒。下一次触发要等本轮结束后才按 cron 排定(同一 schedule 不会重叠,也不会积压),所以选每分钟:一轮约 165 秒结束时,下一次最晚 15 秒后触发;若选 `*/2`,2:45 结束的一轮要等到 4:00 才再触发,中间约 75 秒无人检测。整轮预算须小于调度 timeoutMs(180 秒,留 15 秒余量)。上一轮没结束时新的触发不会出现;若手工另起进程,拿不到 `discover` 锁会直接返回 `lock-held` |
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

需要人处理的事件(首次可合并、同因 blocked 升级、Keel 台账读不到导致派发暂停、needs-human / 三次补投无结果 / 结果无效 / 派发无回执)写进 watcher home 的 `state/notices/pending.json`。另建一条 script 调度,前置检查有未发事件才跑,并把通知发到飞书:

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
   - 台账目录读不到时，盯梢不向修复会话派发、不扣轮次、不在 PR 上发评论，只写一条 `keel-unavailable` 通知（每个 PR 每天一条）；目录恢复后下一轮自动派发。
   - `prepare` 在建 worktree 前也会核对台账目录，读不到就以 `keel-unavailable:` 开头的原因报 blocked。
   - 以 `keel-` 开头原因阻塞的任务，距离阻塞满 30 分钟且台账目录此时可读，才自动重开（台账仍读不到时不消耗重开次数），同一 PR 同一次准入最多 3 次；重开时退还轮次并交回该任务的反馈。
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

## 6. 测试环境变量

`watchers/mivo/test.env` 与 `watchers/cindy/test.env` 是跑测试时用的占位环境变量
(`node --env-file=...`),指向 `/tmp/...` 之类的不存在路径——这些路径仅用于触发 fail-closed
分支的断言,不需要真实存在。不要把真实路径写进这两个文件。
