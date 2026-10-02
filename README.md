# Project Vigil

Vigil is a small collection of PR-watching tools: pollers that notice new review feedback, CI
failures, or merge conflicts on your own pull requests and turn them into structured repair
tasks for a human or an agent to act on. They never merge, auto-merge, delete branches, or act
as a maintainer's approval on your behalf. See [`watchers/mivo`](watchers/mivo/README.md) and
[`watchers/cindy`](watchers/cindy/README.md) for the two included variants.

---

Vigil 收录两个独立的 PR 自动化盯梢工具,从内部私有仓库里剥离出来、sanitize(脱敏)后发布:

- **[`watchers/mivo`](watchers/mivo/README.md)** —— 同仓分支场景:你对目标仓库有写权限,
  PR 的 head 和 base 在同一个仓库。
- **[`watchers/cindy`](watchers/cindy/README.md)** —— cross-repo fork 场景:PR 的 head 在
  你自己的 fork 上,base 是一个你没有写权限的上游仓库(默认目标是公开仓库 `makecindy/cindy`)。

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
npm test      # 跑全部测试(mivo + cindy 两套 Node 测试 + cindy 的 Python 测试)
```

每个 watcher 的具体配置(`profile.mjs` 的 fail-closed 机制)、CLI 用法、测试方式见各自的
README:[`watchers/mivo/README.md`](watchers/mivo/README.md)、
[`watchers/cindy/README.md`](watchers/cindy/README.md)。

## 配置

两个 watcher 共享同一套配置机制:环境变量优先,其次是 `<watcher home>/config/profile.json`,
都没有则在用到该配置的地方直接报错(fail-closed,不会静默落到任何人的个人路径)。配置样例见
[`config/examples/`](config/examples/)。

## 前置条件

- **Cindy 桌面端**:discover 轮询必须跑在 Cindy 调度器的"script 模式"下,见下文。
- **`gh` CLI** 已登录(watcher 用它查询/操作 GitHub PR)。
- **node ≥ 22**、**python3**(discover 的入口是 Python 脚本,内部再 spawn Node watcher)。

## 安装与部署

1. **准备 watcher home**:一个不随代码仓库发布的运行目录,存放 `state/`、`deployments/`、
   `config/profile.json`。

   ```sh
   mkdir -p /path/to/your/mivo-watcher-home/config
   cp config/examples/mivo.profile.example.json /path/to/your/mivo-watcher-home/config/profile.json
   # 编辑 profile.json,把占位值换成真实的仓库名、本地仓路径
   ```

2. **部署代码**:`deploy.mjs` 是无数据库依赖的"校验 + 原子安装"脚本。

   ```sh
   node watchers/mivo/deploy.mjs verify                 # 校验 import 闭包
   node watchers/mivo/deploy.mjs bootstrap --home <dir>
   node watchers/mivo/deploy.mjs preview --home <dir> --database <sqlite file> --id <id> --plan <file>
   node watchers/mivo/deploy.mjs apply --plan <file>
   ```

3. **在 Cindy 里创建发现器调度**:新建一条 schedule,字段取值如下(字段名取自 Cindy 调度器
   自身的 `schedule_create` 参数 schema):

   | 字段 | 取值 | 说明 |
   |---|---|---|
   | `executionMode` | `"script"` | 零 token 模式:宿主不起 agent,直接执行 `scriptConfig.command` |
   | `cronExpr` | `"*/5 * * * *"` | 每 5 分钟触发一次 |
   | `timezone` | 如 `"Asia/Shanghai"` | 必填,IANA 时区 id |
   | `recurring` | `true` | discover 是常驻轮询 |
   | `scriptConfig.command` | `python3 <watcher home>/bin/mivo-watch-script.py --mode discover` | cwd 为 `workingDir`;必须实现 `cindy-script/1` 协议(stdout 只能是协议帧,调试输出走 stderr) |
   | `scriptConfig.capabilities` | `["sessions.dispatch"]` | 能力白名单,默认全拒,discover 只需要这一项 |
   | `workingDir` | `<watcher home>` 的绝对路径 | script 模式下作为命令的 cwd |
   | `useWorktree` | `false` | script 模式不支持 ephemeral worktree |
   | `notify` | 按需 | 必填对象 `{desktop, feishu}` |

   完整字段说明与排障见 [`docs/operations.md`](docs/operations.md#2-调度在-cindy-里创建发现器调度)。

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
Mivo 场景下只有 **P0/P1** 允许改代码判 `pass`,Cindy 场景下 **P0/P1/P2** 允许,其余(P3、混合
优先级、未经确认的发现)只能判 `no-change`,否则 `finalize` 会报 `REPAIR_SCOPE_NO_CODE` 拒绝。
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
