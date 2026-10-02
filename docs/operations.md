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
| `cronExpr` | `"*/5 * * * *"` | 每 5 分钟触发一次;5 字段 cron(minute hour day-of-month month day-of-week) |
| `timezone` | 你所在时区的 IANA id,如 `"Asia/Shanghai"` | 必填 |
| `recurring` | `true` | discover 是常驻轮询,不是一次性任务 |
| `scriptConfig.command` | `python3 <watcher home>/bin/mivo-watch-script.py --mode discover`(cindy watcher 换成 `cindy-watch-script.py`) | 经系统 shell 执行,cwd 为 `workingDir`;该命令必须实现 `cindy-script/1` 协议(stdout 只能是协议帧,调试输出走 stderr) |
| `scriptConfig.capabilities` | `["sessions.dispatch"]` | 能力白名单,默认全拒;discover 只需要唤醒/派发修复 session 这一项能力,不要多授予 |
| `scriptConfig.timeoutMs` | 按需,可省略 | 整轮脚本超时;超时会杀进程树,run 记 failed |
| `workingDir` | `<watcher home>` 的绝对路径 | script 模式下作为 `scriptConfig.command` 的 cwd |
| `useWorktree` | `false` | script 模式不支持 ephemeral worktree |
| `notify` | `{"desktop": true, "feishu": false}` 或按你自己的通知偏好 | 必填对象,discover 本身建议静默(见下),失败轮仍会通知 |

discover 一次调用会扫描 `targetRepo` 下你自己的所有 open PR,不需要"每个 PR 一个调度项"。

### poll 模式

`poll` 模式(`--mode poll --pr <N> --node-id <id>`)用于手动单独排障某一个 PR,不建议配进
常规调度,通常是你本地手动跑一次来看某个 PR 的详细判断过程。

## 3. 运行锁排障

如果怀疑一个 PR 的处理被卡住(比如进程异常退出没释放锁),用 `lock-doctor` 子命令查看:

```sh
node watchers/<mivo|cindy>/bin/<mivo|cindy>-repair.mjs lock-doctor --home "$WATCHER_HOME"
```

它会列出当前所有锁和"接管守卫"(reclaim guard),以及哪些守卫的持有进程已经不存在
(`orphanGuards`)。只有 owner 进程确实已死、且文件修改时间超过 10 分钟的守卫才能被
`--clear-guard <lockName>` 清除——这是故意保守的设计,避免误删一个仍在工作的进程的锁。

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
