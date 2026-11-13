# Project Vigil

Vigil is a small collection of PR-watching tools: pollers that notice new review feedback, CI
failures, or merge conflicts on your own pull requests and turn them into structured repair
tasks for a human or an agent to act on. They never merge, auto-merge, delete branches, or act
as a maintainer's approval on your behalf. See [`watchers/mivo`](watchers/mivo/README.md),
[`watchers/cindy`](watchers/cindy/README.md) and [`watchers/acceptance`](watchers/acceptance/README.md)
for the three included variants.

---

Vigil 收录三个独立的自动化工具,从内部私有仓库里剥离出来、sanitize(脱敏)后发布:

- **[`watchers/mivo`](watchers/mivo/README.md)** —— 同仓分支场景:你对目标仓库有写权限,
  PR 的 head 和 base 在同一个仓库。
- **[`watchers/cindy`](watchers/cindy/README.md)** —— cross-repo fork 场景:PR 的 head 在
  你自己的 fork 上,base 是一个你没有写权限的上游仓库(默认目标是公开仓库 `makecindy/cindy`)。
- **[`watchers/acceptance`](watchers/acceptance/README.md)** —— 验收机:在 GitHub 上用轮次评论认领
  任务、逐条验收、出裁决;宿主循环、写闸和 bwrap 沙箱在 `watchers/acceptance/host/`,运维见
  [`docs/acceptance-operations.md`](docs/acceptance-operations.md)。

两者负责**发现**(轮询 PR、判断是否有新的待处理反馈)和**修复动作的具体执行**(clone/
worktree/push/清理),但它们**不是可以配进任意 cron 的无状态脚本**——discover 模式是专门
为 Cindy 桌面端的调度器("script 模式")设计的,只有在那套协议下才会真正唤醒修复 session。
原因与完整安装步骤见下文「安装与部署」,以及
[`docs/architecture.md`](docs/architecture.md#调度依赖-cindy-桌面端的-script-模式调度器)。

## 它们做什么、不做什么

- 轮询你自己的 open PR,识别新的审查反馈、CI 失败、与主干/上游的冲突。
- 按可信来源与严重度分级,把需要改代码的反馈整理成结构化任务。
- 执行具体的 Git 操作:建 worktree、push 到正确的分支、冲突 merge、清理已合并/已关闭的
  worktree。
- 提供运行锁(防止同一个 PR 被并发处理两次)、归属查询 CLI、以及一个无数据库依赖的部署脚本。

它们**不会**:合并 PR、开 auto-merge、删除远端分支、修改 CI 配置、代替维护者审批、或在没有
显式配置的情况下使用任何人的本地路径/仓库名。

## 快速开始

```sh
npm install   # 本项目无第三方依赖,这一步只是确认 Node 版本
npm test      # 跑全部测试(mivo + cindy + acceptance 三套 Node 测试 + 两份 Python 测试)
```

每个 watcher 的具体配置(`profile.mjs` 的 fail-closed 机制)、CLI 用法、测试方式见各自的
README:[`watchers/mivo/README.md`](watchers/mivo/README.md)、
[`watchers/cindy/README.md`](watchers/cindy/README.md)、
[`watchers/acceptance/README.md`](watchers/acceptance/README.md)。

## 配置

两个 watcher 共享同一套配置机制:环境变量优先,其次是 `<watcher home>/config/profile.json`,
都没有则在用到该配置的地方直接报错(fail-closed,不会静默落到任何人的个人路径)。配置样例见
[`config/examples/`](config/examples/)。

## 前置条件

- **Cindy 桌面端**:discover 轮询必须跑在 Cindy 调度器的"script 模式"下,见下文。
- **`gh` CLI** 已登录(watcher 用它查询/操作 GitHub PR)。
- **node ≥ 22**、**python3**(discover 的入口是 Python 脚本,内部再 spawn Node watcher)。

## 安装与部署

下面以 mivo watcher 为例，写的是线上实际在用的做法。cindy watcher 步骤相同，命令和环境变量把 `mivo` 换成 `cindy`；它的 `deploy.mjs` 多一个 `bootstrap` 子命令，见 [`watchers/cindy/README.md`](watchers/cindy/README.md)。

### 1. 准备 watcher home

watcher home 是一个不随代码仓库发布的运行目录：`bin/` 放部署进来的代码，`config/profile.json` 放配置，`state/` 放运行状态，`deployments/` 放每次部署的记录和备份。第一次安装要先建好 `bin/` 和 `state/prs/`：缺 `state/prs/` 时部署预检读不到状态直接失败，缺 `bin/` 时安装写不进文件、整次回滚。

```sh
HOME_DIR=/path/to/your/mivo-watcher-home
mkdir -p "$HOME_DIR/bin" "$HOME_DIR/config" "$HOME_DIR/state/prs" "$HOME_DIR/deployments"
cp config/examples/mivo.profile.example.json "$HOME_DIR/config/profile.json"
# 编辑 profile.json，把占位值换成真实值
```

`profile.json` 的字段（每项都可以用右列的环境变量覆盖，环境变量优先）：

| 字段 | 必填 | 环境变量 | 作用 |
|---|---|---|---|
| `targetRepo` | 是 | `MIVO_WATCHER_TARGET_REPO` | 要盯的仓库，`owner/repo` |
| `pluginRepoPath` | 是 | `MIVO_PLUGIN_REPO` | 目标仓在本机的检出目录（绝对路径），修复会话的 worktree 从这里开 |
| `reviewerLogin` | 是 | `MIVO_WATCHER_REVIEWER_LOGIN` | 审查流程提交 review 的 GitHub 账号，用来判断「审查通过」和识别审查意见 |
| `severityStandardPath` | 建议 | `MIVO_SEVERITY_STANDARD_PATH` | 分级标准（severity.md）的本机路径，派给修复会话的规则里带上它的全文；不配就不带 |
| `preflightSelfReview` | 否 | `MIVO_PREFLIGHT_SELF_REVIEW` | 推送前自审试点，默认 `false`。打开后，可改代码的修复轮在规则里多一段：推送前按分级标准审一遍本轮自己的改动（最多 2 遍），并在 SC 报告顶层写 `selfReview`；有改动的提交（只为重跑 CI 的空提交不算）却没有这条记录时 `finalize` 拒绝。是否要求自审在派发时写进任务文件，之后改开关不影响已派出的任务。只接受 `true` / `false`（或 `1` / `0`），写成别的值按关闭处理，每轮运行结果的 `events` 里有一条 `config-invalid` 写明字段名。建议同时配好 `severityStandardPath`，否则规则里没有分级标准全文。开关对运行机上所有 PR 生效 |
| `keelLedgerRoot` / `keelNamespace` | 用 KEEL 时 | `MIVO_KEEL_LEDGER_ROOT` / `MIVO_KEEL_NAMESPACE` | KEEL 台账目录和命名空间，修复会话按它们找 KEEL run |
| `watchHomes` | 否 | `MIVO_WATCHER_WATCH_HOMES` | 本机所有 watcher home 列表，默认 `[]` |
| `validateConcurrency` / `validateStallMinutes` / `preflightTimeoutMinutes` / `prePushLockWaitMinutes` | 否 | `MIVO_VALIDATE_CONCURRENCY` 等 | 本地验证的并发数和各类超时，默认值与含义见 [`docs/operations.md`](docs/operations.md#7-本地-validate-的并发日志与收据) |
| `resolveFixedThreadsWithApp` | 否 | `MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP` | 用 GitHub App 关闭「审查机已复核修好」的讨论串，默认关；打开时还要配 `praisebuildAppId`、`praisebuildInstallationId`、`praisebuildPrivateKeyPath`（App ID、安装 ID、私钥文件路径），读取逻辑在 [`watchers/mivo/bin/mivo-app-token.mjs`](watchers/mivo/bin/mivo-app-token.mjs) |

缺了必填项不会落到默认值：用到它的地方直接报错，并在错误里写明字段名。

### 2. 部署代码

`deploy.mjs` 把源码 `watchers/mivo/bin/` 下清单里的文件装进 `<watcher home>/bin/`，安装前后都按哈希核对，中途失败自动回滚。它从**脚本自己所在的检出**取文件，所以先检出要部署的那个提交，再在里面跑：

```sh
git worktree add --detach .worktrees/deploy-<sha7> <commit>   # 干净检出，不要用有改动的工作树
cd .worktrees/deploy-<sha7>

HOME_DIR=/path/to/your/mivo-watcher-home
DB="$HOME/Library/Application Support/Cindy/cindy-<账号>.db"   # Cindy 的本地数据库（macOS 位置）
ID=vigil-<sha7>-<YYYYMMDD>-r1                                  # 每次部署一个新 id，不能重复

node watchers/mivo/deploy.mjs verify --home "$HOME_DIR"        # 看哪些文件会变（match:false 表示有更新）
node watchers/mivo/deploy.mjs preview --home "$HOME_DIR" --database "$DB" --id "$ID" \
  --plan "$HOME_DIR/deployments/$ID.plan.json" && \
node watchers/mivo/deploy.mjs apply --plan "$HOME_DIR/deployments/$ID.plan.json" # 预览后立即安装
node watchers/mivo/deploy.mjs verify --home "$HOME_DIR"        # 部署后应为 match:true
```

- `--database` 只用来确认修复会话都空闲（需要 `sqlite3` 命令）。有会话正在跑时 `preview` / `apply` 报 `Host session active or missing`，等它跑完再试即可；`apply` 期间状态或文件被改动也会拒绝并回滚。预览输出还会列出当前已安装提交到本次提交之间的提交标题；如果状态在两步之间变化，重新生成 plan，并把 `preview && apply` 连着执行。
- `--plan` 必须是绝对路径，文件不能已存在；`--id` 只能用小写字母、数字和 `-`。
- `apply` 成功后在 `<watcher home>/deployments/<id>/` 留下 `before/`（被替换的旧文件）、`manifest.json` 和 `receipt.json`（`status: installed`）。要退回上一版，把 `before/` 里的文件拷回 `bin/`，或者检出旧提交用新的 id 再部署一次。
- 部署只换代码，不碰 `state/`、`config/` 和调度；正在跑的一轮不受影响，下一轮起用新代码。部署完删掉临时检出即可。

### 3. 在 Cindy 里创建调度

需要两条 script 模式的调度：**发现器**（每轮扫一遍 open PR，有新反馈就派修复会话）和**通知**（把盯梢事件发给你）。通知调度的参数见 [`docs/operations.md`](docs/operations.md#通知调度)。发现器的字段取值如下（字段名取自 Cindy 调度器自身的 `schedule_create` 参数 schema）：

| 字段 | 取值 | 说明 |
|---|---|---|
| `executionMode` | `"script"` | 零 token 模式：宿主不起 agent，直接执行 `scriptConfig.command` |
| `cronExpr` | `"* * * * *"` | 每分钟触发；一轮最多跑 165 秒，同一条调度不重叠、不积压。改成 `*/2`、`*/4` 也能跑，代价是两轮之间无人检测的空档变长。节拍细节见 [`docs/operations.md`](docs/operations.md#2-调度在-cindy-里创建发现器调度) |
| `timezone` | 如 `"Asia/Shanghai"` | 必填，IANA 时区 id |
| `recurring` | `true` | discover 是常驻轮询 |
| `scriptConfig.command` | 见下 | cwd 为 `workingDir`；stdout 只能是 `cindy-script/1` 协议帧，调试输出走 stderr |
| `scriptConfig.capabilities` | `["sessions.dispatch"]` | 能力白名单，默认全拒，discover 只需要这一项 |
| `scriptConfig.timeoutMs` | `180000` | 整轮预算 165 秒，须小于它 |
| `workingDir` | `<watcher home>` 的绝对路径 | script 模式下作为命令的 cwd |
| `useWorktree` | `false` | script 模式不支持 ephemeral worktree |
| `notify` | `{"desktop": false, "feishu": false}` | discover 建议静默，失败轮仍会记进调度日志 |
| `agentKind` / `model` / `providerId` / `effort` / `fastMode` | 修复会话要用的模型配置 | 新建的修复会话沿用这几项（`agentKind` 填 `codex` 或 `pi`）；不填落到宿主默认模型；改了只影响之后新建的会话 |

`scriptConfig.command` 要带环境变量，调度器不会替你设：

```sh
env MIVO_WATCHER_LIVE=1 \
  MIVO_WATCHER_HOME=<watcher home> \
  MIVO_NODE_BIN=<node 的绝对路径> \
  GH_BIN=<gh 的绝对路径> \
  PATH=<node、gh、git、python3 所在目录> \
  python3 <watcher home>/bin/mivo-watch-script.py --mode discover
```

| 变量 | 必需 | 作用 |
|---|---|---|
| `MIVO_WATCHER_LIVE=1` | 是 | 真正派发修复会话的开关。不设时 discover 照常扫描，但**一个修复会话都不派**，界面上看不出异常 |
| `MIVO_WATCHER_HOME` | 建议 | watcher home 路径；不设时按脚本所在位置推断 |
| `MIVO_NODE_BIN` | 建议 | Node 可执行文件；不设时在 `PATH` 里找 `node` |
| `GH_BIN` | 否 | 要用的 `gh`（例如一个按账号分流的包装脚本）；不设时用 `PATH` 里的 `gh` |
| `PATH` | 是 | 调度器的进程环境很干净，`node`、`gh`、`git`、`python3` 要能找到 |

### 4. 上线后确认

- `node watchers/mivo/deploy.mjs verify --home <watcher home>` 输出 `match: true`。
- 在 Cindy 的调度运行记录里，部署之后第一轮状态是成功，结果是一行以 `{"mode":"discover"` 开头的 JSON，`prs` 里列出了目标仓你名下的 open PR。
- 有新审查意见的 PR，对应条目的 `dispatch.attempted` 为 `true`，Cindy 里出现标题以 `#<PR号>-` 开头的修复会话。如果一直是 `false`，先查调度命令里有没有 `MIVO_WATCHER_LIVE=1`。

## 修复 session 如何工作

discover 发现需要处理的反馈后,通过 `sessions.dispatch` 唤醒一个**专属该 PR 的修复 session**
(不是把所有 PR 塞进一个 session),dispatch 消息里带上该 PR 的结构化任务(待处理反馈列表、
严重度、PR 快照)。修复 session 完成修复后,通过各 watcher 的 `*-repair.mjs` CLI 走完整条收口
链路:

| 子命令 | 作用 |
|---|---|
| `prepare --task <file>` | 校验任务文件、建/复用 worktree,返回当前仓库状态是否需要先同步 |
| `validate --task <file> --validated-head <sha>` | 在本地 worktree 跑验证,记录一份带 SHA256 的验证凭据(receipt),防止"声称验证过但其实没跑" |
| `finalize --task <file> --sc-report <file> --validated-head <sha> [--validation-receipt <file>]` | 读取 SC(success-criteria,成功标准)报告、推送(如需要)、查 CI 状态,写最终结果 |
| `recheck --task <file> [--validated-head <sha>]` | 不改代码,只重新查一次之前 finalize 结果的 CI 状态 |
| `blocked --task <file> --reason <text>` | 修复 session 判断自己无法继续时,显式报告阻塞原因(而不是静默挂起) |
| `cleanup --pr <N>` | PR 合并/关闭后清理对应 worktree 与分支 |

**SC 报告格式**:`finalize` 要求的 `--sc-report` 是 `{ scs: [{ id, status: "pass"|"no-change",
evidence: [...], feedbackKeys: [...] }] }`。每一条 feedback 必须被某个 SC 的 `feedbackKeys`
覆盖(覆盖不全直接 fail);`status: "pass"` 只允许用在"该反馈的权限允许改代码"的 key 上——
两套 watcher 都只有 **P0/P1/P2** 允许改代码判 `pass`,P3、混合优先级、未经确认的发现只能判
`no-change`,否则 `finalize` 会报 `REPAIR_SCOPE_NO_CODE` 拒绝。
这个权限表来自各自的 `*-pr-policy.mjs`/`*-feedback-policy.mjs`,不是 `finalize` 自己硬编码的。

## 省 token 设计

- discover 一次调用覆盖 `targetRepo` 下所有 open PR,不是"一个 PR 一个调度项"。
- 只有检测到真正的新变化(新审查反馈、CI 状态变化、冲突)才会 `sessions.dispatch` 唤醒修复
  session;没有变化的轮询不产生任何 agent 调用。
- discover 对 PR 做的是指纹式比对(新反馈/新 CI 结果的内容哈希),低优先级反馈(如 P3)只记录
  为"no-change",不会触发修复 session。
- 修复 session 走完 `finalize` 收口后应立即结束当前 turn,不继续空转。
- 派给修复 session 的反馈文本在拼入 dispatch 消息前会做脱敏与长度截断,避免把超长 PR 评论
  原文整段塞进 prompt。
- PR 的详细信息(review thread、CI 结果等)落在任务文件里,dispatch 消息本身只带摘要,不是
  整份 PR 快照。
- PR 合并或关闭后,`cleanup` 子命令会清掉对应的 worktree 与分支,不留长期占用的工作区。

## 停止盯梢

- Mivo(有仓库写权限):给 PR 打标签 `mivo-watch:off`。
- Cindy(fork 场景,可能没有打标签权限):在 watcher home 的 `config/optout.json` 里加入 PR
  号,或让 PR 作者本人发一条正文恰为 `/cindy-watch off` 的 issue comment。

## 安全边界

- 两个 watcher **都不会**:合并 PR、开 auto-merge、删除远端分支、修改 CI 配置、代替维护者
  审批。
- Cindy watcher(cross-repo fork 场景)**硬编码拒绝**向 base/上游仓库 push,只允许 fast-forward
  到你自己 fork 上的 PR 分支。
- discover 调度拿到的 Cindy 能力白名单只有 `sessions.dispatch` 一项,不能用这条调度去调用
  任何其他宿主能力。
- 所有需要本地路径/仓库名的配置项都走 `profile.mjs` 的 fail-closed 解析,缺配置直接报错,
  不会静默落到任何人的个人路径。

## 排障 FAQ

- **discover 一直没反应**:确认 Cindy 调度确实在跑(script 模式),以及该 schedule 的
  `scriptConfig.capabilities` 里有 `sessions.dispatch`;再检查 `*-watch-script.py` 的
  `main()` 是否因为缺 `CINDY_SCRIPT_PROTOCOL=1`/`XDT_MAKER_SCRIPT_PROTOCOL=1` 环境变量而
  拒绝空跑。
- **怀疑某个 PR 被卡住**:用 `lock-doctor` 子命令查看锁和"接管守卫"状态,见
  [`docs/operations.md`](docs/operations.md#3-运行锁排障)。
- **`finalize` 报 `REPAIR_SCOPE_NO_CODE`**:说明 SC 报告里把一条无权限改代码的反馈(如 P3)
  标成了 `pass`,应改成 `no-change`。
- **配置报错但不知道该填哪个字段**:`profile.mjs` 的报错信息会写明该填的 profile 字段名或
  环境变量名;`pluginRepoPath`/`preflightFile` 这两个字段是先手动预检环境变量,报错文案只会
  提示 profile 字段名,不会提示环境变量名(两边设计不对称,是故意的)。

## 目录结构

```
watchers/
├── mivo/     同仓分支场景(bin/*.mjs + *.test.mjs + deploy.mjs + README.md)
└── cindy/    cross-repo fork 场景,结构与 mivo 一致

config/examples/   每个 watcher 一份 profile 配置样例(占位值)
docs/              architecture.md(模块划分、调度机制)+ operations.md(安装、运维、排障)
```

## 架构与运维文档

详见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/operations.md`](docs/operations.md)。

## License

[MIT](LICENSE)
