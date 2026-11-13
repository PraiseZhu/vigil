# 验收机运维：宿主接入、写闸、停用与回滚

对应本仓 issue #47。本文档写清怎么在这台盒子上把验收线跑起来、看着它、出问题时怎么停和怎么回滚。
命令一律在仓库根目录执行，`<home>` 是验收机的 home（环境变量 `ACCEPTANCE_WATCHER_HOME`），
示例里的仓库名、路径都是占位符。

相关文档：

- [`docs/acceptance-scheduler.md`](acceptance-scheduler.md)：调度命令的调用顺序与退出码（#45）。
- [`docs/acceptance-session.md`](acceptance-session.md) 与 [`watchers/acceptance/SESSION.md`](../watchers/acceptance/SESSION.md)：验收会话的步骤与裁决格式（#46）。
- [`docs/acceptance-slack.md`](acceptance-slack.md)：Slack 通知（Jasper、令牌、事件表、摘要与去重）（#61）。
- [`watchers/acceptance/README.md`](../watchers/acceptance/README.md)：配置、盘点、写操作出口。

## 1. 宿主接入清单

| 部分 | 落在哪 | 规则 |
|---|---|---|
| 常驻调度 | `watchers/acceptance/host/loop` | 单实例（flock），**每 180 秒**跑一拍 `host/tick.mjs`（#247 从 60 秒改成 180 秒，生效值写进心跳的 `tickIntervalS`），顺序照 `docs/acceptance-scheduler.md` |
| 每小时巡检 | `watchers/acceptance/host/ensure.sh` | 给每小时一次的 routine 调用：心跳不超过「拍间隔 + 60 秒余量」（默认 240 秒）就不做事；心跳过期但原循环进程还在、单实例锁还占着，只记一条「心跳延迟」（`heartbeat-delayed`，进摘要），不补起；其中墙钟跳了很久、按机器实际运行时间心跳还在同一上限内的，记 `host-frozen`（整机冻结），也不补起；其余情况把 `loop` 拉起来并写一条提醒（`stop.sh` 主动停过的记成部署重启 `loop-deploy-restarted`，进摘要；整机冻结后原循环已经不在的记 `heartbeat-stale-after-freeze`） |
| 资源门 | `host/round.mjs` | 认领**之前**过内存门（MemAvailable ≥ 3 GiB），不够时在 `state/host/rounds.log` 留一行 `<UTC 时间> mem-gate-defer issue=<owner/repo#号> availKiB=<KiB 或 unknown> thresholdMiB=3072 内存门：…，这一拍不认领`（阈值 3072 MiB = 3221225472 字节；issue 是这一拍被挡的待开轮）（统计用 `grep mem-gate-defer`，按行首时间筛近 24 小时；#147 之前的老行没有时间，不回填）和测试锁（mivo 同时只跑一轮；`host.json` 的 `serialRepos` 名单里的仓同样各自同时只跑一轮）；最多 2 轮同时跑 |
| 写闸 | `host/write-gate.mjs` | 所有写动作在沙箱外再查一遍，以它为准（见第 3 节） |
| 模型 | `host/round.mjs` + `<home>/config/host.json` | pi 用 **DeepSeek V4.1 Flash**，推理 **max**；有争议条目的裁决运行（`host/adjudicate.mjs`）用 `anthropic/claude-opus-5-5`，推理 **medium**（`adjudicateCommand`） |
| 卡住 | `host/tick.mjs`、`host/round.mjs` | 按**宿主观察到的活动**判卡住（见第 4 节「轮次生命周期」）；卡住时**先结束进程，再 `round.mjs abort`** |
| 代码 | `host/prefetch.mjs` | 认领之后、起 pi 之前，宿主把本轮任务树里每个仓的 main 检出好，只读挂进沙箱（见第 4 节） |
| 提醒 | `state/host/alerts.jsonl` | 本 issue 只**发现**并写文件，不调 Slack（见第 7 节） |

`<home>/config/host.json` 至少要有 `piCommand`（消息从标准输入喂给它）：

```json
{
  "piCommand": ["pi", "--model", "<model id>", "--thinking", "max"],
  "credentialDirs": ["<可选：额外要遮罩的绝对目录>"],
  "homeAllowDirs": ["<可选：沙箱里要只读看到的 HOME 内目录，比如 pi 的安装目录、pi 配置副本目录>"],
  "egressAllow": ["<LLM 网关 host>:443"],
  "maxRoundMinutes": 120,
  "serialRepos": ["<可选：吃内存重、同一时刻只跑一轮的仓，owner/repo>"],
  "buildCiPolicy": { "<可选：完整 build 在沙箱里跑不了的仓，owner/repo>": { "bundleStep": "<沙箱里要离线跑通的代码打包命令>", "ciChecks": { "build": ["<CI 检查名>"], "test": ["<CI 检查名>"] } } },
  "adjudicateCommand": ["pi", "--model", "anthropic/claude-opus-5-5", "--thinking", "medium"],
  "adjudicateMaxMinutes": 30,
  "slackDailyCap": 30
}
```

`adjudicateCommand` / `adjudicateMaxMinutes` 见下面「模型」；`slackDailyCap` 见
[`docs/acceptance-slack.md`](acceptance-slack.md) 第 5 节。

`egressAllow` 是沙箱**唯一**能出网的名单（见第 4 节「网络」）：只写 `host:port`（小写，不认通配、不认 URL），
LLM 网关的 host 取 pi 的 `models.json` 里 `baseUrl` 的主机名。代码由宿主预取、只读挂进沙箱（见下面「代码预取」），
pi 不用自己 `git clone`，所以**只放行网关就够**；名单越短越好（每个放行的主机都是一条潜在的外传通道）。
沙箱里固定关掉 npm 的更新检查（`NPM_CONFIG_UPDATE_NOTIFIER=false`），并让 npm 一律离线（`npm_config_offline=true`），
跑 `npm test` 不会去连 registry；依赖由宿主在沙箱外预装（见下面「依赖预装」），**不要为了 npm 往 `egressAllow` 里加 registry**。**不配就是空名单，pi 连不上模型网关，这一轮跑不起来。**
写错（通配、URL、缺端口）整轮直接起不来，不会悄悄放宽。

`maxRoundMinutes` 可选：一轮的总时长上限（分钟，宿主墙钟，从认领算起），缺了或不是正数按 120。

`serialRepos` 可选：`"owner/repo"` 数组（不分大小写，不认通配和 issue 号）。名单里的仓**同一时刻最多 1 轮**（验收轮 + 修正轮合计），
用的是和 mivo 测试锁同一套锁：整轮持有 `state/host/locks/serial-<owner>__<repo>.lock`（每个仓一把，不和 mivo 共用），
认领**之前**拿，拿不到这一拍就不认领（退出 3，不写评论、不算一轮、不进退避、不写提醒），等锁放了下一拍再认领；
tick 不给锁被占的仓起进程，这一拍空出来的槽照样给别的仓，等锁的 issue 记在心跳 `lastTick.serialWaiting`（没人等就没有这个字段）。
给内存吃得重的仓用（两个轮次同时跑 typecheck 会把整机内存吃光、被系统的内存保护杀掉）。不配就是空（老行为）；
mivo 不用配，照旧按仓名占 `mivo-test.lock`。写错整轮起不来（不认领），不会悄悄放开并发。

`buildCiPolicy` 可选，按仓开、默认关（不配就是老行为：不查、派发消息一字不差）。给完整 build 在沙箱里跑不了的仓用
（要 electron 分发产物——安装脚本按设计不跑；打包要 fakeroot——沙箱里没有），否则每轮都停在「环境问题」。开了之后**只有 build 一项**改口径：
代码打包步骤（`bundleStep`）在沙箱里离线跑通，**并且**关联 PR 自己 CI 的 build 检查（`ciChecks.build`）和测试检查（`ciChecks.test`）都是绿的才算过。
CI 结论由宿主在代码预取、依赖预装之后、起 pi 之前只读查（`host/build-ci.mjs`：任务树里本仓的关联 PR，取最后一个提交的
`statusCheckRollup`，检查名精确匹配；GraphQL 纯查询，瞬时故障按现有读重试一次），作为只读事实追加在派发消息末尾，评审按
`watchers/acceptance/SESSION.md`「build 项的 CI 口径」记：绿（列的检查全部成功）且打包步骤通过 → `ran`；红（有一个失败 / 超时 / 启动失败）→ 如实判「要修」；
没跑（缺检查、没跑完、被取消或跳过、没有关联 PR）或取不到（读失败、PR 找不到、配置写错）→ `env-skipped`，仍是未验证、按环境退避重验。
查不到绝不当成绿，也不中止本轮。只认总 issue 所在仓的配置；别的仓、typecheck、test、写闸、判定、沙箱出网都不变。配置里不放任何密钥。

未知键一律忽略；写 `"sandbox": false` 或 `"noSandbox": true` **没有任何作用**——沙箱只有一条路。

部署时踩过的两点：

- 沙箱里的 `HOME` 是每轮新建的空目录，pi 读不到宿主上的模型配置；配置目录又是只读的，pi 起来要
  在里面建锁文件会直接报 `EROFS`。做法是把**不含密钥**的模型配置（只引用 `$LLM_PROXY_API_KEY`
  这类环境变量）另放一份，`piCommand` 先拷进沙箱的 `HOME` 再起 pi：

  ```json
  "piCommand": ["sh", "-c", "mkdir -p \"$HOME/.pi/agent\" && cp <配置副本目录>/models.json <配置副本目录>/settings.json \"$HOME/.pi/agent/\" && exec pi \"$@\"", "pi", "--model", "<model id>", "--thinking", "max", "--no-session"]
  ```

- 宿主 `HOME` **默认整个看不见**（盖一层空 tmpfs），只有白名单只读挂回来：代码仓、node 的安装目录
  （装在 `HOME` 里时）、`host.json` 的 `homeAllowDirs`。pi 装在 `HOME` 里、或 `piCommand` 要从
  `HOME` 里拷配置副本，就把那两个目录写进 `homeAllowDirs`（只写需要的目录，别写整个 `HOME`——
  写 `HOME` 本身直接起不来，写它的上级不挂）。可写绑定（`roundDir`、`stateDir`、`worktreeDir`）照常可写。
  `credentialDirs` 仍然生效，管的是 `HOME` 之外的目录和白名单里面的子目录；白名单落在遮罩目录里直接起不来。
  写完用 `doctor` 的「bwrap 遮罩」和在沙箱里 `ls` 一遍 `HOME` 确认只剩白名单。

### 模型

- 验收轮：pi 用 DeepSeek V4.1 Flash，推理 max（写进 `piCommand`）。
- 有争议条目的裁决运行：`anthropic/claude-opus-5-5`，推理 medium（写进 `adjudicateCommand`，形状和
  `piCommand` 一样，要拷 pi 配置副本就照上面 `piCommand` 的 `sh -c` 写法）。
  **已实现**（`host/adjudicate.mjs`，#46 SC8；原先写的是「待实现，归 #60」，#60 只负责把修正轮的争议写成单行）：
  - 最近一次出结论的轮次评论里有 `- 有争议：<owner/repo#n> SC<k> · …` 行、宿主还没有这一轮的裁决结果时，
    `trigger` 判 `awaiting-adjudication`（不再判「已是最新」静默卡死），`poll --json` 报
    `{"issue","adjudicate":true,"round","items"}`，tick 用剩下的空槽起一个后台 `host/adjudicate.mjs run`。
  - 同一任务同一轮同时只跑一个（锁），出过结果不再起；和验收轮、修正轮共用两个槽和内存门。
  - 跑在和验收轮同一个 bwrap 沙箱里（同样的遮罩、`--unshare-net` + `egressAllow` 出网代理），但**没有写闸
    socket**：沙箱里的 `gh` 直接拒绝、helper 读不到 profile、沙箱里没有任何令牌——GitHub 一个字都写不了。
    争议条目、SC 原文、双方理由、相关 PR 由宿主在沙箱外只读收好，写进给 pi 的消息；代码和验收轮一样由宿主预取
    （`host/prefetch.mjs`）、只读挂进去（预取失败算一次失败）。
  - pi 最后一行输出 `{"items":[{"ref","sc","ruling":"成立"|"不成立","why"}]}`，宿主逐条校验（每条争议都要有结论）后
    写进 `<home>/state/host/adjudications/<owner>__<repo>__<号>__<轮次>.json`（宿主状态目录，沙箱里看不到也写不了）。
  - 下一轮：`trigger` 判 `adjudicated` 触发，`round.mjs start` 的派发消息带上「裁决结果」一节（结果文件在沙箱里
    看不到，所以直接写内容），验收会话按 `SESSION.md` 第 3 节照裁决定这些条目。
  - 总时长上限 `adjudicateMaxMinutes`（默认 30）：超时先结束进程，写 `adjudicate-timeout`；失败（输出不合格、
    pi 退出码非 0、沙箱起不来）写 `adjudicate-failed`，隔 5 分钟重试，一共最多 3 次（重试 2 次），用完写
    `adjudicate-needs-human`（Slack 立即发），之后不再起，由我人工裁决（手写结果文件或改裁决评论）。
  - 没配 `adjudicateCommand` 就不起，写 `adjudicate-not-configured` 提醒（一天一次），条目一直等着。
  - 只看**验收轮**的结论评论；修正轮（prbot）在修正子 issue 上标的「有争议」会让修正子 issue 停在开着
    （prbot 写「需人工处理」`all-disputed`），不会自动进裁决运行。

## 2. 令牌

- 用**我的账号**。令牌只放在这台盒子上的单独文件里（`githubTokenFile`，可选 `slackBotTokenFile`），
  权限必须是 **600**、属主是跑验收机的用户。
- **只有两处读 GitHub 令牌**：写闸 `host/write-gate.mjs`，和沙箱外的只读盘点（`bin/poll.mjs` 经
  `bin/github.mjs` 发读请求）。别的地方一律不读。
- 令牌**不进仓、不进日志、不进 bwrap**：沙箱里看到的是一个内容为
  `sandbox-placeholder-not-a-token` 的占位文件，`…TokenFile` / App 私钥一律被 bwrap 遮成 `/dev/null`。
- 提醒和裁决里的自由文本都过 `bin/redact.mjs`，不会带出令牌、私钥或本机路径。
- **GitHub 临时故障**：只读请求（`graphql` / `ownerGraphql` 里的纯 query）遇到 502/503/504、连接被断或超时，
  等 4 秒当次重试**一次**，还失败就照旧报错、记告警。mutation 和所有 `write()`（评论、关单、看板、推送、开 PR……）
  一律只发一次，绝不重试。

### 两种令牌方案

| 方案 | 能覆盖什么 | 缺点 |
|---|---|---|
| 细粒度令牌（fine-grained） | 目标仓的 contents / issues / pull_requests 读写，checks、statuses、actions、metadata 读 | 读不了个人账号名下 Projects v2 看板（`Resource not accessible by personal access token`），也看不到组织临时授权的仓 |
| classic 令牌（勾 `repo` + `project`） | 目标仓读写 + 个人账号名下的看板读写 | 权限面更大，需要按账号管理 |

2026-10-24 实测：给的细粒度令牌对个人仓能读写，但读不了个人账号下的 Projects v2 看板，
也看不到组织仓。**看板写入需要 classic 令牌**（勾 `repo` 和 `project`）。
最终用哪种我还没定；换法是：把新令牌写进同一个 `githubTokenFile`（保持 600），
再跑一次 `doctor`（第 6 节）确认「令牌账号」「仓可读」「看板」「看板写回」都过。
`appConfigPath` 配了的话读请求走 GitHub App 令牌，写仍然走账号令牌。

### 两级 App 配置：`apps`（app → owner）

App 装在多个 owner 上、读和写又是两个 App 时，用 `apps` 配。这是现在推荐的方式，其余字段不用动：

```json
"apps": {
  "read":  { "appId": "<①读 App 编号>",  "privateKeyFile": "/path/to/<①读 App 的私钥文件>",
             "owners": ["<owner A>", "<owner B>", "<owner C>", "<owner D>"] },
  "write": { "appId": "<②写 App 编号>", "privateKeyFile": "/path/to/<②写 App 的私钥文件>",
             "owners": ["<owner A>", "<owner B>"] }
}
```

- `read` 是 ①读 App，`write` 是 ②写 App；两个都可只配一个，`owners` 缺省是 `[ownerLogin]`。
- `appId` 只收**正的安全整数**（数字或纯数字字符串），数字串不收前导零：`appId` 会原样进 JWT 的 `iss`，
  `'00'` / `'007'` / `'1e+21'` / `1e21` / `1.5` / `true` 这类会在加载 profile 时直接报错，不会等到取令牌才 401。
- **安装号不在配置里**：运行时用私钥签 JWT 调 `GET /app/installations`，按 `account.login` 找这个 owner 的安装号。
- 私钥路径写在 profile 里（绝对路径、600），私钥内容不进仓库；找不到 / 不可读 / 权限不对时**不拦启动**：
  用的时候回退账号令牌并记一行（见下），整台验收机不会因为一枚没部署的私钥停摆。
  运行时按 `checkSecretFile` 判：必须是普通文件（目录、空文件、非 600 都是 `key-unreadable`）；
  符号链接跟着目标文件走，目标合规就照常读、目标不存在按 `key-missing` 回退（与 `githubTokenFile` 一致）。
- 令牌按 `(app, owner)` 各缓存 50 分钟，只放在进程内存里（本仓自己不落盘）；一个 `(app, owner)` 取不到不影响别的。
  取令牌整个过程（查安装 + 换令牌）上限 30 秒。owner 比较统一转小写，`ExampleUser` / `exampleuser` 命中同一份缓存。

分流规则（**读与写都切 App；按 owner 逐个开**）：

| 请求 | 走哪个令牌 |
|---|---|
| 落在 `apps.read.owners` 名下**单个仓**上的只读查询（议题正文、轮次评论、PR 检查等按 `owner/name` 定位的读） | ①读 App |
| 评论 / issue / sub-issue 写：`comment.create/update`、`issue.create/edit/close/reopen`、`subissue.add` | ②写 App |
| 推分支 / PR / workflow：`branch.push`、`pr.create`、`pr.ready`、`pr.update-branch`、`ci.rerun`、`pr.edit` | ②写 App |
| 跨仓盘点、搜索、`viewer`、看板读、别人组织的仓 | 账号令牌 |
| 看板写（`project.field.set`） | 账号令牌（App 看不到个人账号下的 Projects v2） |
| 合并（`pr.merge`）与其它没列出的写类型 | 账号令牌（不在表里就按账号令牌，不猜） |

开关粒度是 owner：某个 owner 要切写，只把它加进 `apps.write.owners`，别的 owner 继续账号令牌。
**开之前必须先把 ②写 App 的 `<app>[bot]` 登录名写进 `profile.trustedBotLogins`**：用 App 令牌写出来作者是
`<app>[bot]`，轮次评论 / 子 issue / 修正 issue 靠身份白名单（`bin/trusted-author.mjs`）认自己，白名单里没有
这个 bot 就会让轮次反复重开、`done/finish` 报 `NOT_CURRENT`、修正树消失。①读 App 只做读，不要拿它的私钥配 `apps.write`：
只读 App 通常没有 `issues: write` / `contents: write`，用它会一路 403 回退，白浪费一趟。

**开关顺序（顺序反了，本轮及之后的轮次评论就会被当成别人的）**：

1. 先拿到写 App 的 bot 登录名。profile 里不存这个名字，GitHub 给 App 的账号用户名是 `<slug>[bot]`，`slug` 只能用
   写 App 的私钥签 JWT 问 `GET /app`（`appBotLogin()`，`bin/github.mjs`）。配了 `apps.write` 就跑一次 `doctor`：
   「写 App 身份白名单」这一项会把查到的登录名写出来，不在白名单里直接报红。
2. 把这个登录名（整串，带 `[bot]`）加进 `profile.trustedBotLogins`，重跑 `doctor` 等这一项变绿。
3. 最后才把 owner 加进 `apps.write.owners`，重启写闸的 `serve`：`serve` 启动时只读一次 profile，
   已经开着的轮次要等本轮 gate 结束才换成 bot 身份（不是「立即」生效）。

回滚反过来：先从 `apps.write.owners` 删掉 owner（同样等本轮 gate 结束），再决定要不要把那个 bot 从
`trustedBotLogins` 去掉——留着无害，只是多认一个身份。

某个 `(app, owner)` 取不到令牌——没装、私钥缺失 / 不可读 / 权限不对、安装号查询失败、换令牌失败——或者
App 读到 401 / 403 / 404（读是 gh 的 HTTP 状态与 GraphQL 错误；`branch.push` 是 git 的
`Authentication failed` / `The requested URL returned error: 403` / `Permission to … denied` / `Repository not found`，
这两套文案都认），就回退账号令牌重试一次，并在 `<home>/state/host/loop.log` 记一行：

写路径只在 401 / 403 / 404 才回退重放：这三类是「请求被拒、没产生副作用」，重放安全。
5xx / 超时**不回退也不重放**：服务端可能已经把评论 / issue 写进去了，重放会重复写。

```
<UTC 时间> app-token-fallback kind=<token-failed|auth-401|auth-403|not-found> repo=<owner/name> app=<read|write> reason=<原因> <人话>，已改用原令牌重试一次
```

`reason` 是一个短码，方便 grep：`not-installed`、`owner-not-in-app-owners`、`key-missing`、`key-unreadable`、
`install-lookup-http-<状态>`、`install-lookup-network`、`install-lookup-timeout`、`install-lookup-bad-response`、
`install-lookup-failed`、`token-request-http-<状态>`、`token-request-network`、`token-request-timeout`、
`token-request-failed`、`empty-token`、`app-not-configured`、`app-401`/`app-403`/`app-404`，旧外部命令路径另有 `command-failed`
（日志里 `app=legacy`）。日志和报错里都不出现令牌。目标是 0 次回退；回退必须看得见。

### 只用 App 模式：`appOnly`

`profile.json` 写 `"appOnly": true`（默认 `false`，不写就是上面的老行为）后，**不再改用账号令牌**：

| 情况 | 老行为 | `appOnly: true` |
|---|---|---|
| App 取不到令牌、或读 / 写被拒（401/403/404） | 回退账号令牌重试一次，记 `app-token-fallback` | 不发请求，抛 `AppOnlyError`，记 `app-only-blocked` |
| 按 owner 盘点（只有 `$owner`）、搜索串只点名一个 owner（`repo:` / `user:` / `org:`） | 账号令牌 | 这个 owner 的 ①读 App；不在名单里就拒绝 |
| `ownerGraphql` 的非看板查询（事件发现、按仓搜 PR） | 账号令牌 / 优先级写令牌 | 按 owner 走 ①读 App |
| 宿主拉代码（`fetchBranch`，预取与修正轮镜像） | 账号令牌 | 这个 owner 的 ①读 App，不在 ①名单里用 ②写 App；都没有就拒绝 |
| `viewer`、跨 owner 搜索、名单外 owner、不在 App 表里的写（如 `pr.merge`） | 账号令牌 | 拒绝（`kind=no-app-route`） |
| **看板读写**（查询里有 `projectV2` / `ProjectV2` / `projectItems`，以及 `project.field.set`） | 账号令牌 / 优先级写令牌 | **不变，仍用账号令牌**：GitHub App 安装令牌访问不了个人账号名下的 Projects v2，这是唯一例外；看板迁到组织名下后才能去掉 |

```
<UTC 时间> app-only-blocked kind=<token-failed|auth-401|auth-403|not-found|no-app-route> repo=<owner/name 或 owner/*> app=<read|write> reason=<短码> 只用 App 模式：不改用账号令牌，这次请求没有发
```

- 必须同时配 `apps`；和 `appConfigPath` 互斥（它不按 owner 分流）。写错加载 profile 就报错。
- 只在宿主生效：沙箱 profile 副本删掉 `appOnly`（沙箱里没有令牌，读写都经写闸，由写闸按 `appOnly` 发请求）。
- `doctor` 的「令牌账号」一项在 `appOnly` 下不再用账号令牌查 `viewer`，直接标明开关已开。
- 看板同步（`prio-run` / `prio-sync`）在 `appOnly` 下只认 ①读 App 名单里的 owner：看板上别的 owner 的仓按 `exclude` 整仓跳过（不搜 PR、不改字段、保留上次状态），
  每拍在看板同步自己的 run 日志（`--state-dir` 下的 `run-<日期>.log`，与 stdout 同一份）记一行
  `<UTC 时间> app-only-skip component=<prio-run|prio-sync> repos=<owner/name,…> …`，不会再因为按仓搜 PR 被 `app-only-blocked` 拦下整轮报错（#364、#460）。
- 打开前先确认：`loop.log` 最近 24 小时的 `app-token-fallback` 都已消掉（每一条在 `appOnly` 下都会变成一次失败）；
  ①读 App 有 Contents 读权限（拉代码要用）。回滚：把 `appOnly` 改回 `false`（或删掉这一键），重启 `loop` 与写闸 `serve`。

**没装 App 的 owner 不要写进 `owners`**。读路径上名单外的 owner 直接用账号令牌（不浪费一趟）；写路径上如果该 App 配了
但 owner 不在名单里，会记一行 `reason=owner-not-in-app-owners` 再回退——这是有意的，写不出去必须留痕。

优先级（三处都配时按这个顺序，别混着配）：

1. `appConfigPath`：配了就**不做按仓分流**，所有读都换成那一枚安装令牌（旧模式；盘点、搜索、`viewer` 会跟着换，
   容易静默漏单、`doctor` 的「令牌账号」变成 `…[bot]`）。`apps`、`appTokenCommand` 都不生效。
2. `apps`：按上表分流。配了 `apps` 就不再走 `appTokenCommand`。
3. `appTokenCommand` + `appOwners`（旧形式，见下）：没有 `apps` 也没有 `appConfigPath` 时才生效。

### 取令牌脚本（运维侧，旧形式 / 外部调用）

`appTokenCommand`（argv 数组，例如 `["python3", "/path/to/print-app-token.py"]`）是让外部命令取令牌的旧办法：
命令把安装令牌打印到标准输出，验收机只把它放进那一次读 GitHub 的 gh 子进程的 `GH_TOKEN`，不进常驻进程环境、不进日志。
**命令的 argv 与上一版完全一致**：验收机不再追加任何位置参数（严格参数的旧脚本会直接非 0 退出，导致读静默降级）；
owner 只通过环境变量 `ACCEPTANCE_APP_OWNER` 告诉命令——认它的脚本能按 owner 各给一枚令牌，不认的旧脚本
照旧返回默认安装的令牌（每个 owner 各跑一次，读到的是同一枚）。令牌按 owner 在内存里各缓存一份。
`appOwners`（默认 `[ownerLogin]`）列这个 App 装在哪几个 owner 上；名单外的 owner 直接账号令牌。

脚本不在本仓里（属于运维侧）。它要满足的行为契约：

- 读环境变量 `ACCEPTANCE_APP_OWNER`（可选）：有就按这个 owner 找安装，没有就按配置里的默认 owner；
  验收机**不传位置参数**（严格参数的旧脚本不会再被多塞一个 OWNER）；
- **安装号在运行时查**：用 JWT 调 `GET /app/installations`，按 `account.login` 找这个 owner 的安装号；
- 令牌按 `(app, owner)` 各缓存 50 分钟，缓存文件按 `(app, owner)` 分开、权限 600，放在私有目录（目录 700）；
  安装列表也按 app 分开缓存；两个 App 的缓存互不串用；
- 这个 owner 没装这个 App：非零退出 + stderr 一句人话错误，stdout 不输出任何东西；
- 令牌只打印到 stdout（stdout 只有令牌一行）；过程信息和错误走 stderr，错误信息里不带令牌；
- 只认旧行为、不认 `ACCEPTANCE_APP_OWNER` 的脚本也照旧能跑（返回默认安装的令牌）；老的调用方（不带参数的脚本调用）不用改。

脚本写出来的安装列表缓存和令牌缓存也算凭证：它们得落在 `host.json` 的 `credentialDirs` 列出的目录里（整个目录遮住），
或者放在 `$HOME` 下本来就遮住的位置；两者都不满足时 bwrap 遮罩覆盖不到它。脚本和私钥本身也别放进 `homeAllowDirs` 这类白名单目录。

### 遮罩与 `apps` 的已知缺口（待补）

私钥文件本身由键名规则遮住：`maskList()` 递归收集 profile 里所有 `…PrivateKeyFile` / 正好叫 `privateKeyFile` 的键，
所以 `apps.read.privateKeyFile` / `apps.write.privateKeyFile` 都会进遮罩名单。但沙箱 profile 副本目前只删
`appConfigPath`、`appTokenCommand`、`appOwners`，还没有删 `apps`（它会把私钥路径字符串留在副本里；私钥内容仍被遮住）。
改这一处要动 `host/sandbox.mjs`（遮罩规则），按约定本轮不动，列在 PR 的待批清单里。

`doctor` 的「令牌文件」一项除了原始 profile 的**顶层**键，也会检查 `apps.read.privateKeyFile` /
`apps.write.privateKeyFile`（权限不是 600 时点名叫出来）。

## 3. 写闸

所有 GitHub 写操作和推送都经 `bin/github.mjs` 的 `write()`。验收轮里它被接成
`writeCommand = ["node", "host/gate-client.mjs", "--socket", "<roundDir>/gate/gate.sock"]`：
一条动作 JSON 从标准输入进沙箱里的 client，经 unix socket 交给**沙箱外**的写闸。

宿主这边的 `profile.json` 里把 `writeCommand` 指到写闸的 exec 用法（`doctor` 的探测走它；看板写回是只读判断，不走它）：

```json
"writeCommand": ["node", "<repo>/watchers/acceptance/host/write-gate.mjs", "exec", "--home", "<home>"]
```

验收轮的沙箱 profile 是自动生成的副本，里面的 `writeCommand` 会被换成 `gate-client.mjs`，不用手改。

`host/write-gate.mjs` 有三种用法：

- `write-gate.mjs exec`：当场执行一条动作（stdin 读动作 JSON），宿主侧的 `round.mjs start/abort`
  就是走这个。
- `write-gate.mjs serve --socket <p> --issue <总 issue> --round <n> --comment-id <id>`：绑定本轮，
  验收轮里跑；一条连接一个请求，串行处理，socket 权限 600。
- `write-gate.mjs probe [--repo <owner/repo>]`：只回一句「闸在」，不写任何东西。

放行的动作类型（`github.mjs` 的 11 类 + 只读 + 探测）：`comment.create`、`comment.update`、
`issue.create`、`issue.close`、`issue.reopen`、`issue.edit`、`subissue.add`、`project.field.set`、
`branch.push`、`pr.create`、`pr.ready`，以及 `read.graphql`、`probe`。
`pr.update-branch`、`ci.rerun` 在 #60 之前返回 4（`reason=not-implemented`），现在由
[`docs/acceptance-prbot.md`](acceptance-prbot.md) 的两个 gate-action 实现，只给 auto / fork 档；
watch 档仍然返回 4（`reason=tier-not-allowed`）。
不加 `pr.merge`：写闸对白名单外的类型一律返回 4（`reason=not-allowed`），合并先由我在 GitHub 里点。
`pr.create` 必须带 `draft: true`（否则 4 `not-allowed`），转 Ready 只能走 `pr.ready` 的 CI 复核；head 在非 fork 档只写分支名，
fork 档必须是 `<ownerLogin>:<分支>`，别的前缀一律 4 `not-in-tree`。

按档限制：

- `auto` 档（`autoRepos`、`forkRepos`）：上列动作全放行。
- `watch` 档（`watchRepos`）：只允许 `comment.create`、`comment.update`、`project.field.set`（和只读）。
- 三个名单都不在的仓，写闸不读不写（`reason=repo-not-allowed`）。

其它检查（顺序固定，全部在沙箱外）：

1. 动作必须是对象，`type` 必须是字符串；否则 `bad-action`。
2. 总开关：`state/write-gate/enabled` 不存在时**拒绝全部**验收动作，连只读和探测都拒（`gate-disabled`）。
3. 账本 `state/write-gate/ledger.jsonl`：读不出返回 1（`ledger-corrupt`）；同一个 `dedupeKey`
   再交来直接回第一次的结果，不再执行；写动作缺 `dedupeKey` 返回 4（`missing-dedupe-key`）。
4. 仓范围、看板归属（只许 `ownerLogin` + `projectNumber`）。
5. 只读只认登记过的查询（`ROOT_QUERY`、`SEARCH_QUERY`、`ISSUE_BODY_QUERY`、`COMMENTS_QUERY`、
   `ISSUE_COMMENTS_QUERY`），自己写的 GraphQL 文本返回 4（`query-not-allowed`）；搜索只放行
   本轮总 issue 的修正搜索（`search-not-allowed`）。
6. 执行锁 `state/write-gate/exec.lock`：30 秒拿不到返回 75（`busy`），什么都没执行。
   #60 新增的只读查询（PR 状态 / PR 头 / 按分支找 PR / Ready 后的 review 与 check run / main 同名检查）
   也走同一张登记表，调用方不能自带 GraphQL 文本。修正轮的写操作见
   [`docs/acceptance-prbot.md`](acceptance-prbot.md)。
7. 绑定本轮：回读最新轮次评论，不是第 n 轮或已不是「验收中」返回 4（`not-current-round`）；
   目标不在本轮任务树返回 4（`not-in-tree`）；裁决评论里的正文版本和当前正文不一致返回 4
   （`body-version-mismatch`，版本函数和 tasks/rounds 是同一个 `bodyVersion`）。
   轮次评论只认 `ownerLogin` 发的，别人伪造的不算。serve 模式里：`comment.create` 的首行不能像轮次评论
   （`[验收机] 第…`，返回 4 `round-comment-forbidden`）；`issue.edit` 只能把验收项在 `- [ ]` 和 `- [x]` 之间切换，
   其它字一个都不能改（4 `edit-not-allowed`）；`pr.ready` 只认本轮的修正 PR：不能是从 fork 来的（`isCrossRepository` 不是 false 就拒），head 分支是
   `acceptance/<总 issue 号>-…`、正文带本轮总 issue 的修正标记（否则 4 `not-in-tree`），再看检查是否全绿。
   exec 模式认领新一轮时，上一轮还在「验收中」就拒绝（4 `round-in-progress`）。
   `dedupeKey` 查重放在仓范围和分档之后：名单外的仓拿账本里已有的 key 也照样被拒。
8. `branch.push` 在写闸里再扫一遍密钥（内置规则每次都跑：列出新引入的每个对象、按字节扫内容，合并提交、含 NUL 的文件都算；本机有 `gitleaks` 再加扫）：扫到返回 4
   （`reason=secret-found`，只给文件名），**不推送**，并写一条提醒。写闸先把 bundle 复制进自己的
   临时目录，只扫这份副本里 `--branch` 指向的那个提交，推送的也是这份副本：扫完之后沙箱里的原文件被换掉
   也推不出去。扫描基准由写闸自己定，**不看动作里交来的 `base`**：写闸用固定查询读目标仓默认分支的头提交，
   它在 bundle 里就扫 `<默认分支头>..<分支提交>`；读不到、不是提交号或不在 bundle 里，就扫这条分支的全部历史
   （更严，宁可多拦）。
9. 执行成功才记账本（`ledger.jsonl`），返回 0。

退出码：`0` 成功；`4` 拒绝（不重试，这一轮标「中断」，`secret-found` 记「需人工处理」）；
`75` 忙（helper 每 30 秒重试一次、最多 6 次）；`1` 其它失败（含账本坏了）。

## 4. 沙箱（fail-closed）

`host/round.mjs` 是**唯一**起 pi 的入口，pi 一定在 `bwrap` 里：

- 认领之前先看写闸总开关、再跑 bwrap 探针：总开关关着就不认领、**不写**提醒（只读期每拍都会碰到，
  写提醒就是刷屏），心跳里记 `gate: disabled`；tick 这时验收轮、修正轮（prbot）都不起（修正轮的写同样全被拒，起了只会白耗重试次数）；探针不过就不认领（issue 上不会多一对「验收中 → 中断」评论），
  写一条 `sandbox-down` 提醒，一小时内只写一条。

- pi 起来之后宿主出错（查进度失败等）：先结束 pi（SIGTERM，宽限期后 SIGKILL），再 `abort`
  （原因「宿主出错：…」，提醒 `round-failed`），最后才收写闸。
- 认领之后沙箱参数拼不出来 → 不跑模型，这一轮 `abort` 成「中断」（原因「沙箱起不来：…」），
  并写一条提醒（`sandbox-unavailable`）。
- **没有任何环境变量或配置项能关掉沙箱**（`PI_NO_SANDBOX`、`ACCEPTANCE_NO_SANDBOX`、`host.json` 的
  `sandbox`/`noSandbox` 都无效）：代码里根本没有「不套 bwrap 跑 pi」这条路径。
- 只传白名单环境变量：`PATH`、`HOME`、`LANG`、`TZ`、`TERM`、`TMPDIR`、`LLM_PROXY_API_KEY`、
  `NODE_OPTIONS`，外加沙箱内部变量（`ACCEPTANCE_WATCHER_HOME`、`ACCEPTANCE_GATE_SOCKET`，
  都指向沙箱内的路径；出网变量见下面「网络」）。`HOME` 和 `TMPDIR` 每轮新开。
- **环境变量不进 bwrap 的命令行**：不用 `--clearenv` + `--setenv KEY VALUE`（值会出现在 bwrap 的
  `/proc/<pid>/cmdline` 里，`ps` 就能看到 `LLM_PROXY_API_KEY`），而是把白名单环境作为 spawn 的 `env`
  交给 bwrap 进程本身，bwrap 原样传给沙箱里的命令。验收轮（`host/round.mjs`）、修正轮的 pi 和预检
  （`host/prbot-sandbox.mjs`）、`doctor` 的遮罩探针都这样起；`buildBwrapArgs` 再收到 `env` 直接报错。
- **网络**：bwrap 用 `--unshare-net`，沙箱有自己的网络命名空间，里面只有 `lo`。宿主 `127.0.0.1` 上的
  所有端口（比如无鉴权的 Docker Engine API、VNC、adb、各种本地 daemon）和**抽象 unix socket**
  （比如 `Xvfb -ac` 的 `@/tmp/.X11-unix/X1`，抽象 socket 跟着网络命名空间走，遮文件遮不住）一律连不到。
  唯一的出网路：
  - 宿主侧的出网代理 `host/egress-proxy.mjs`，随轮次起停，监听轮次目录里的
    `egress/egress.sock`（权限 600，和写闸 socket 一样跟着 `roundDir` 挂进沙箱）。它**只认 HTTP CONNECT**，
    目标 `host:port` 必须在 `host.json` 的 `egressAllow` 里，别的一律 403；明文 HTTP 转发一律 405；
    域名在宿主侧解析，解析到环回 / `0.0.0.0` / 链路本地（含 `169.254.169.254`）的哪怕写进名单也拒绝；
    同时最多 32 条隧道、单条最长 30 分钟、请求头 10 秒 / 8 KiB 封顶。被拒时写提醒 `egress-denied`
    （同一目标一轮只记一条，一轮最多 5 条）。代理起不来就不跑模型（「沙箱起不来」）。
  - 沙箱里的出网桥 `host/sandbox-bin/egress-bridge.mjs`：pi 的命令前面先起它，在沙箱自己的
    `127.0.0.1:3128` 上听，把 TCP 流原样转进那个 socket，再起 `piCommand`（标准输入、退出码原样）。
  - 沙箱内部的出网变量（不从宿主环境抄，宿主上的同名变量不在白名单里）：`HTTPS_PROXY` / `https_proxy` /
    `HTTP_PROXY` / `http_proxy` 都是 `http://127.0.0.1:3128`，`NO_PROXY` / `no_proxy` 只含环回，
    `NODE_USE_ENV_PROXY=1`（node 22.21+ / 24 的 `fetch` 和 `https` 认这几个变量；会在 `pi.log` 里打一行
    `UNDICI-EHPA` 实验特性警告，无害）。沙箱里没有 DNS，也不需要：CONNECT 带的是主机名，git / curl / node
    都交给代理解析。
  - 修正轮的预检、打包、`handoffNew` 沙箱**完全不出网**：同样 `--unshare-net`，不起代理、不带出网变量。
    目标仓的推送前检查要是需要联网（装依赖之类），得先在宿主上准备好。
- **系统固定遮罩**（代码里写死，`host.json` 关不掉，只能用 `credentialDirs` 追加）：`/run` 整个换成空
  tmpfs（宿主的 `docker.sock`、`ssh-auth.sock` 转发、容器运行时、各种 rpc socket、凭证代理都在下面；
  pi、node、git 都不依赖 `/run`），`/opt/sand`、`/opt/sand-managed` 存在就盖空目录。
- 遮罩名单**从 profile 算**，不写死文件名：profile 里每个以 `TokenFile` 结尾、`PrivateKeyFile`
  结尾或正好是 `privateKeyFile` 的键（递归算，含 `githubTokenFile`、`slackBotTokenFile`）、
  App 配置里的 `privateKeyFile`，一律 `/dev/null`；`$HOME` 下的凭证目录（`.config/gh`、`.ssh`、
  `.gnupg`、`.aws`、`.config/gcloud`、`.docker`、`.kube`、`.config/git`）用空目录盖住，
  `.git-credentials`、`.netrc` 换成 `/dev/null`，外加 `host.json` 的 `credentialDirs` 和宿主状态目录
  `<home>/state`（模型看不到写闸开关、账本、提醒）。`appConfigPath` 指向的 App 配置文件本身也遮住。
  每条路径先解析成真实路径再遮（经符号链接指过去的令牌文件，链接和真实文件都读不到）；
  名单上不存在的路径跳过（bwrap 不能在只读根里新建挂载点）。
- 沙箱里的 `gh` 是 `host/sandbox-bin/gh`：只认 `gh api graphql --input -`，转成只读动作交给写闸；
  其它调用直接报「沙箱里只允许经写闸读」。它不看 `GH_TOKEN`。
- 沙箱里的 watcher home 是 profile 的副本：`writeCommand` 换成 `gate-client.mjs`，
  `githubTokenFile` 换成占位文件，`appConfigPath`、`appTokenCommand`、`appOwners` 和所有 `…TokenFile` 键删掉。
- 宿主 `HOME` 默认遮掉：`--tmpfs $HOME` 在只读根之后、可写绑定之前，白名单（`homeAllowDirs` + 代码仓 +
  node 安装目录）只读挂回。不在白名单上的 `HOME` 文件（比如各工具自己的配置、`.env` 文件）不用逐个列名单
  也读不到。拼参数时拿不到宿主 `HOME` 就直接拒绝，不退回「只遮名单」的老做法。
- `profile.stateDir` 或 `worktreeDir` 与 `<home>/state` 相互包含、或遮罩文件落在可写绑定里、
  可写绑定是宿主 `HOME` 本身或它的上级，直接拒绝（起不来）。

### 代码预取（私有 / internal 仓）

沙箱里没有凭证，组织的 internal 仓在沙箱里 `git clone` 不下来。所以认领之后、起 pi 之前，宿主替这一轮准备代码：

- 仓的范围：本轮任务树（总 issue、子 issue、修正 issue、关联 PR）涉及的仓，只取分档名单里的，最多 8 个；公开仓也走这条路。
- 带令牌的 fetch 只在宿主自己的镜像里跑，复用修正轮的那一套：镜像在 `<home>/state/prbot/mirrors/acceptance__<owner>__<repo>`
  （`<home>/state` 对沙箱遮住），目录检查、`github.fetchBranch`（令牌只在 `extraheader` 里、钩子 / 代理 / 凭据助手全关、
  只许 https、10 分钟超时、2 GiB 上限）都和修正轮一样。同一个镜像同时只取一份（`state/host/locks/mirror-*.lock`）。
- 宿主从镜像把 main 检出到 `<roundDir>/code/<owner>__<repo>`（新建目录、带 `.git`，配置里没有令牌），
  以 `--ro-bind` 挂进沙箱（挂在可写绑定之后，所以落在可写的 `roundDir` 里也是只读）。
- 派发消息末尾的「代码」一节写明每个仓的绝对路径；`SESSION.md` 让 pi 直接读，要可写副本就复制到 `TMPDIR`。
- 任何一个仓取不下来：这一轮 `abort`（原因「代码预取失败：…」），写提醒 `prefetch-failed`，不起 pi。
- 轮次收尾时 `roundDir` 里除 `pi.log` 外都清掉（含检出的代码）；镜像留着，下一轮只是增量取。

### 依赖预装（npm / pnpm）

沙箱只能连模型网关，在沙箱里 `npm ci` 必然卡住或失败。所以代码预取之后、起 pi 之前，宿主替这一轮装依赖（`host/predeps.mjs`）：

- 只在仓根有 `package.json` 且有 `npm-shrinkwrap.json` / `package-lock.json` / `pnpm-lock.yaml` 时装；没有 lockfile 就不装，
  派发消息里写明「没有预装依赖，要依赖的检查属环境限制，不能据此判不通过」。npm 和 pnpm 的 lockfile 并存时按 npm。
- pnpm 仓（仓根只有 `pnpm-lock.yaml`）：只跑 `pnpm install --frozen-lockfile --ignore-scripts --registry https://registry.npmjs.org/`，
  不改 lockfile、任何安装脚本都不跑。pnpm 用宿主上解析出的绝对路径跑：PATH 里的 `pnpm` 是 corepack 垫片时，改用 corepack 缓存
  （`COREPACK_HOME`、`~/.cache/node/corepack`、`/usr/local/share/corepack`）里的 `pnpm.cjs`，由 node 直接跑——垫片会按
  `packageManager` 字段去下载别的版本。另外固定 `manage-package-manager-versions=false`（pnpm 不自己切版本）、
  `COREPACK_ENABLE_STRICT=0`、`package-import-method=copy`。store 在 `<home>/cache/pnpm-store`、元数据缓存在 `<home>/cache/pnpm-cache`
  （都是 700，只在预装这一步可写，不进模型沙箱）。项目 `.npmrc` 照样不拷、不读源和令牌，只认 `node-linker`（isolated / hoisted）
  和 `shamefully-hoist` 两项布局设置。宿主上找不到 pnpm → 按环境问题中止本轮，原因写明哪个仓要 pnpm、怎么补。
  派发消息里告诉评审：已按 `pnpm-lock.yaml` 预装、不要再跑 `pnpm install`，沙箱里跑 pnpm 脚本用 `node <pnpm.cjs> run <脚本>`。
- 只跑 `npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org/`：任何安装脚本都不跑，
  源写死，项目和宿主的 `.npmrc` 都不读（项目 `.npmrc` 不拷进工作目录，`userconfig` / `globalconfig` 指向空文件）。
- 装在 `<roundDir>/deps/<owner>__<repo>`（检出目录的副本，不含 `.git`），npm 缓存在 `<home>/cache/npm`，都不进宿主 `HOME` 的点目录。
- npm 自己也跑在一个 bwrap 里（`--unshare-net`，凭证目录照样遮住），出网只走一个临时出网代理，放行名单写死为
  `registry.npmjs.org:443`，装完就关；`host.json` 的 `egressAllow` 不变。环境只带 `PATH` / `LANG` / `TZ` 和固定的
  `npm_config_*`，**不带任何令牌**（GitHub / LLM / Slack / npm 都不带）。每个仓最多 15 分钟，期间每分钟刷新本轮宿主进度。
- 装好的各级 `node_modules` 以 `--ro-bind` 挂到检出目录里同一位置（和代码一样只读）；`node_modules/.cache`、`.vite`、`.vitest`
  在沙箱里是空 tmpfs，给工具写缓存。沙箱里能直接 `npm run build` / `npx tsc` / `npx vitest run`，全程离线。
- 装不上（退出码非 0、超时、出网被拒）是**环境问题，不是代码不通过**：这一轮 `abort`（原因以「环境问题（不是代码不通过）：」开头），
  写提醒 `deps-failed`（四段式 Slack），不起 pi、不出任何结论。npm 输出的尾巴（路径换成 `<path>`、密钥脱敏）只进提醒的 `detail`。
  同一任务最近一次中断是环境问题时，重试间隔是 30 分钟 → 2 小时 → 6 小时封顶（普通中断仍是 0 → 5 → 15 → 60 分钟）。

### 轮次生命周期

- **卡住**以宿主观察到的活动为准：宿主每个查进度的间隔看一次 `pi.log` 有没有长，并经一层转发 socket 数本轮写闸请求
  （沙箱里看到的 `<roundDir>/gate/gate.sock` 是宿主这一层，原样转给 `state/host/gates/` 下的写闸 serve，放行与否仍只由写闸决定）。
  另外，沙箱里跑长命令（如 `npm run test:unit`）时 pi.log 不长、写闸也没请求，所以还看 pi 进程树（宿主看得见的 bwrap 及全部后代）
  的累计 CPU 时间、本轮目录下沙箱 `home/.npm/_logs`、`home`、`tmp` 及一层子项的最新 mtime（#149），任一变化都算活动。
  进度文件的 `activitySource` 记最近一次刷新的来源（`start`/`prepare`/`gate`/`pi-log`/`cpu`/`files`）。pi 空转吃 CPU 时
  卡住判定抓不到，靠总时长上限 `maxRoundMinutes` 兜底。
  有活动就刷新 `state/host/progress/<owner>__<repo>__<issue 号>__<轮次>.json`。超过 `stallMinutes` 没有活动：先结束 pi，
  再 `abort`（原因「卡住：超过 stallMinutes 没有进度」），提醒 `round-stalled`。`stateDir` 里模型写的 `lastProgressAt`
  只作参考，延不了期；tick 的卡死判定（`poll` 的 `stale`）用的也是这份宿主时间。
- **pi 退出**（任何退出码）：立即回读本轮状态。还是第 n 轮「验收中」→ `abort`（原因「pi 退出（code=…）但没写裁决」），
  提醒 `round-failed`；已是终态 → 正常收尾。
- **裁决写完 pi 不退**：宽限 2 分钟后先 SIGTERM、再 SIGKILL，收尾，不改裁决。
- **总时长上限**：从认领算起超过 `maxRoundMinutes`（默认 120）→ 停 pi、`abort`（原因「超过总时长上限（N 分钟）」），
  提醒 `round-timeout`。pi 一直有输出也逃不过这一条。

### 子 issue 事后验收

总 issue 还有未关子 issue 时，总 issue 自己仍因 `children-open` 不开轮。已经关闭、并且至少一个关联 PR 已合并的子 issue，单独当成 `kind: 'child'` 验收，轮次评论写在子 issue 自己身上。父 issue 作者不是 owner 的，仍按根任务处理，不走这条。

会开轮的子 issue 要同时满足：issue 作者是 owner、父作者也是 owner、状态已关闭、`closedByPullRequestsReferences` 里至少一个 `mergedAt` 有值、正文用 `parseMarker()` 解析不出验收机修正标记。修正子 issue 和普通子 issue 的标签、标题前缀一样，只认正文里的 `[验收机] 修正 · 总 <root> · 项 <item> SC<k> · 第 n 轮`。`startAt` 之前就关闭的，和根任务一样不收。

`shouldTrigger()` 对 `kind: 'child'` 的 reason：

| reason | 含义 |
|---|---|
| `child-merged` | 已关闭且 PR 已合并，自己还没有终局结论，开一轮 |
| `child-open` | 子 issue 还没关（PR 合并了也不开） |
| `correction-issue` | 正文是修正标记，不开；交给总 issue 在子 issue 都关了之后再验 |
| `no-merged-pr` | 没有已合并的关联 PR（PR 关掉但没合并也算） |
| `parent-in-progress` | 父 issue 最新一轮是「验收中」 |
| `parent-covered` | 父 issue 最后一次终局结论的完成时间晚于子 issue 的 `closedAt`（完成时间是轮次评论里的「完成：」，和总 issue 判 `children-closed-after-verdict` 用的是同一个字段；相等不算晚于） |
| `pr-merged-after-verdict` | 已有结论之后又有 PR 合并，只再开一轮 |
| `up-to-date` | 已有结论，之后没有新合并、正文也没变 |
| `body-changed` | 结论之后正文变了，沿用独立 issue 的判法 |
| `base-not-default` | 已合并的 PR 都合在**非默认分支**上（比如集成分支），等合入默认分支再验 |
| `base-unknown` | 关联 PR 的目标分支字段没取到，保守跳过（下一拍再查） |

父 issue 不在同一次盘点清单里时，父状态留空：不把「没看到父节点」当成正在验收或已经覆盖。结论之后的争议裁决、lead 交接等待，也沿用独立 issue 的判法。总 issue（`kind: 'parent'`）和独立 issue（`kind: 'standalone'`）的触发判定不变。

限速：`host/tick.mjs` 每一拍最多新认领 1 个 `kind: 'child'`（`MAX_CHILD_CLAIMS_PER_TICK`）。仍然先过槽位，进了 `runHostRound()` 再过内存门。槽满或内存不够就这一拍不认领：不写轮次评论、不算一轮、不另写提醒，下一拍再试。不对还开着或未合并的 PR 做检查、评论或状态写入。

只读盘点（不写 GitHub）：

```sh
node watchers/acceptance/bin/poll.mjs --json
```

输出里 `kind` 为 `child` 的条目数，就是这一拍会开轮的子 issue 数。

### 关联 PR 的目标分支（长期口径）

验收轮的代码是宿主按**默认分支**检出的（`host/prefetch.mjs` 固定取 `refs/remotes/origin/main`）。feature PR 先合到集成分支（`integration/…`）、之后才随集成分支合回默认分支时，按默认分支验会把还没进默认分支的改动判成「要修」，再开一张修正子单——整条链都是误报。所以触发判定里有一道防护（#379 加，#380 定为长期口径）：**关联 PR 的目标分支不是仓库默认分支就不进验收，等它合入默认分支再验**。为什么不改成按 PR 的目标分支检出代码验，见 [`docs/acceptance-pr-base-branch.md`](acceptance-pr-base-branch.md)。

- 数据从哪来：`bin/tasks.mjs` 的盘点查询自己的 `closedByPullRequestsReferences` 多取一个 `baseRefName`，`issue.repository` 多取一个 `defaultBranchRef { name }`。两者一个是标量、一个是单对象，**不新增 connection**，每拍盘点请求数不变（点数 = 请求数 × `GRAPHQL_COST_PER_REQUEST`，所以点数也不变）。
- 默认分支：用盘点里的 `defaultBranchRef.name`；取不到才退回 `main`。默认分支不叫 main 的仓按它自己的默认分支判。
- 判定只看一件事：**有没有一个已经合入默认分支的 PR**。有就照常验（其余 PR 不拦）；一个都没有、且都是已知的非默认分支，返回 `base-not-default`；一个都没有、目标分支又全取不到，返回 `base-unknown`（宁可不验，也不拿错分支的代码开出「要修」）。
- 总 issue：任一子单已合并的 PR 全都不在它自己仓的默认分支上时，总 issue 也不验（`base-not-default`，返回里带 `child`）。子单的 PR 目标分支来自同一份盘点里那个子单自己的工作节点，不额外发请求；盘点里没有这个子单（比如关闭时间早于 `startAt`）时不拦——拦了会把老总 issue 永久卡住。
- 后果：不认领、不写轮次评论、不开修正子单，也不写 GitHub。已有的轮次记录不变；**非默认分支上的后续合并（含要修之后的修复 PR）都不会再触发复验**，因为代码不在默认分支上，复验必然误判。
- 记录处：`<home>/state/host/loop.log` 一行一条，`kind` 就是 reason，不新增通知、不新增 GitHub 调用：

```
2026-11-10T08:50:26.000Z base-not-default issue=example-org/sample-repo#12 default=main base=integration/sample-feature prs=example-org/sample-repo#13@integration/sample-feature 验收机只按默认分支验代码，等合入默认分支后再验
2026-11-10T08:50:26.000Z base-unknown issue=example-org/sample-repo#14 default=main base=unknown prs=example-org/sample-repo#15@unknown 验收机只按默认分支验代码，等合入默认分支后再验
```

手工排查也可以直接用只读盘点：`node watchers/acceptance/bin/poll.mjs --json --with-inventory` 的 `baseSkipped`（数组，每条固定带 `issue`、`kind`、`state`、`url`、`mergedAt`、`reason`、`base`、`defaultBranch`、`prs`、`child`、`message`；`mergedAt` 是最近一次非默认分支合并的时间），或者 `node watchers/acceptance/bin/round.mjs start --issue <owner/repo#n>` 的 stderr（退出码 3）。

这是长期口径：选择「等合入默认分支再验」，不是「换成分支验」。合入默认分支之后不用任何开关、不用清状态，下一拍就自动恢复验收。修正轮（`host/prbot.mjs`）不受影响：修正 PR 的 base 只能是默认分支（写闸拦其它 base），不会出现「修正 PR 合到集成分支」这种组合。

#### 等不到默认分支的兜底：超过 3 天进每日汇总（#380）

集成分支被放弃、或者合回默认分支的 PR 正文不引用这些 issue 时，任务永远等不到「合入默认分支的合并」，也就永远不验。tick 每拍用这一拍 poll 已有的 `baseSkipped`（不新增 GitHub 调用）兜底：

- 条件：`reason` 是 `base-not-default`（目标分支已知、确实不是默认分支；`base-unknown` 下一拍再查，不进汇总），issue 还开着，且距最近一次非默认分支合并（`mergedAt`）**严格超过 3×24 小时**；正好 3 天不报，`mergedAt` 解析不出不报。子 issue 在盘点里都是已关闭的，所以不会单独进汇总；被子 issue 拦住、还开着的总 issue 会进。
- 去重：同一 issue 每个 UTC 日期只写一条，状态在 `<home>/state/host/base-pending.json`（`{ reported: { <issue>: <日期> } }`）；后来合入了默认分支或 issue 关了，下一拍从状态里清掉。
- 写到哪：`state/host/alerts.jsonl` 一条 `kind=base-not-default`，带 issue 链接、PR 链接、分支名和人话原因。它不在实时类名单里，打开 Slack 时只进每日汇总（不 @）；当前部署没配 Slack 频道时只在 `alerts.jsonl` 里。
- 出错：这一步出错只写心跳的 `lastTick.basePendingError`，不让这一拍失败；这一拍报了哪些写在 `lastTick.basePending`。

汇总里看到这一条，运维怎么办（三选一）：

1. 把工作合回默认分支：合回的 PR 正文引用这个 issue（`Closes …` 或任务 issue 行），下一拍自动开始验收。
2. 不做了：关掉 issue，下一拍就不再报。
3. 要验集成分支上的代码：人工点名验一次（`node watchers/acceptance/bin/round.mjs start --issue <owner/repo#n>` 现在会因为 `base-not-default` 退出 3，需要先把代码合回默认分支，或在 issue 上写明人工验收结论后关单）。

后果要知道：**非默认分支上的后续合并（包括「要修」之后的修复 PR）都不会自动复验**；合回默认分支后才一起验。

### 认领顺序（#62）

槽位只有 `MAX_ROUNDS`（2）个，先认谁不再只看盘点回来的 `UPDATED_AT` 倒序。`bin/poll.mjs` 在认领之前用 `bin/queue.mjs` 的纯函数
`sortTaskQueue()` 排一遍，键依次是：

1. 看板「优先级」：`P0` → `P1` → `P2` → `P3`；
2. 同档按 issue `createdAt` 旧的先（解析不出的排在同档最后）；
3. 仍相同按 `owner/repo#号` 升序，保证同一份输入每次排出来的顺序一样。

看板「优先级」为空、issue 不在看板上，都按 `P2` 算。优先级只读 `prio-run` 每拍写的看板快照
（`state/host/board-snapshot.json`，见 14 节）：**不新增 GraphQL 读**，一颗点数都不多花。快照缺失、过期、坏掉，
或看板值认不出（不是 `P0`..`P3`）时，这些任务按 `P2` 排，并在 `state/host/loop.log` 写一行：

```
<UTC 时间> queue-priority-fallback reason=missing tasks=3 看板优先级快照用不了，这些任务按 P2 排序
<UTC 时间> queue-priority-fallback reason=unrecognized tasks=1 看板值认不出，按 P2 排序：owner/repo#12=P9
```

读不到不让这一拍失败：顺序退回「`createdAt` 旧的先 + 号升序」。看板只读，这条路径不写看板。

## 5. 提醒与通知的分工

本 issue 的提醒只**发现**：调度循环停摆、轮次卡住或卡死、写闸拒绝、扫到密钥、沙箱起不来，
一行一条写进 `state/host/alerts.jsonl`（`ts`、`kind`、`issue`、`round`、`reason`、`detail`）。
**不调 Slack。**

- **当前 Slack 通报已关闭**：部署 profile 不配 `slackChannelId`，所有提醒只写 `alerts.jsonl`，一条都不发 Slack。
- 发 Slack 归 #61（打开时的行为）：Slack app 显示为 Jasper，发到 profile 的 `slackChannelId` 指的那个频道（频道名不写进仓库）；
  修正 PR 已 Ready 的消息只带「打开 PR」链接。怎么配频道、令牌、哪些事件立即发、哪些进摘要，
  见 [`docs/acceptance-slack.md`](acceptance-slack.md)。
- **验收结论不发通知**：通过/要修、中断都只在 GitHub 的轮次评论和看板里。

常见 `kind`：`loop-restarted`、`tick-failed`、`round-stale`、`round-stalled`、`round-failed`、`round-timeout`、
`prefetch-failed`、`deps-failed`、`env-unverified`、`sandbox-down`、`sandbox-unavailable`、`gate-unavailable`、`gate-rejected`、`secret-found`、`write-rejected`、`egress-denied`；裁决运行的
`adjudicate-failed`、`adjudicate-timeout`、`adjudicate-needs-human`、`adjudicate-not-configured`；
Slack 自己的 `slack-failed`（重试用完）、`slack-history-failed`（读频道历史失败）。

### 老根单每日汇总（#62）

开着超过 7 天、从来没进过验收（没有任何轮次记录）的根 issue（`kind` 为 `parent` / `standalone`，没有可信父 issue），
如果这一拍 `shouldTrigger()` 也不触发（最常见是 `no-merged-pr`：没有已合并的 PR），它不会自己动，也不会出现在别处。
这类单子由 `host/tick.mjs` 每拍算一遍（数据只用盘点已经在手里的任务清单，**不额外读 GitHub、不写看板**），
按本机日期去重后写一条 `kind: 'stale-root'` 到 `alerts.jsonl`：`issue`、`reason`（人话，例如「没有已合并的 PR，
验收机不会自动开始验收」）、`url`（完整 issue 链接）、`ageDays`。

- **只进摘要，不发即时通知**：`kind: 'stale-root'` 不在 ping / 中断类名单里，走摘要那条路（最多每 60 分钟一条，摘要永不 @），
  摘要行带单号、完整链接和原因；不新增实时告警路径。
- **同一个 issue 每个本机日只报一次**：状态记在 `state/host/stale-root-digest.json`（`{version, days: {ref: 'YYYY-MM-DD'}}`）。
  不再符合条件的（已有 PR 合并、已关单、已进过验收）从状态里删掉，之后重新符合条件可以当天再报一次。
- **阀值**：严格超过 7×24 小时（正好 7 天不报）；已关闭、有父的子 issue、已有轮次记录、这一拍就会触发的不报。
- 心跳里带 `lastTick.staleRoots: {candidates, reported}`；这一步自己出错只写 `lastTick.staleRootsError`，不影响这一拍。
- 「不触发原因」只落本地：`alerts.jsonl`（`kind: 'stale-root'`，含 `reason` / `url` / `ageDays`）+ 去重状态 `stale-root-digest.json`。这一步**不发任何 GitHub 请求**（读不读得到都不影响），也不写看板。

## 6. 上线顺序

1. **写配置**：`<home>/config/profile.json`（照 [`config/examples/acceptance.profile.example.json`](../config/examples/acceptance.profile.example.json)）
   和 `<home>/config/host.json`（`piCommand`）；令牌文件放好、`chmod 600`。
   **`state/write-gate/enabled` 先不要建**（总开关关着）。
2. **跑部署检查**：

   ```sh
   ACCEPTANCE_WATCHER_HOME=<home> node watchers/acceptance/bin/doctor.mjs
   ```

   逐项 `✓`/`✗`，缺哪项改哪项。这时「常驻循环」必然是 `✗`（第 6 步才起），某个仓故意不配 prbot 交接时「修正轮交接配置」也是 `✗`；除这两项外全 `✓` 才继续。检查项见第 8 节。
3. **部署 `host/`**：把 `watchers/acceptance/` 放到盒子上（`<home>` 之外），先让写闸总开关**关着只读运行 24 小时**：
   这一段时间里所有写动作都会被拒（`gate-disabled`），只读盘点、`doctor`、心跳、提醒都正常。
   看 `state/host/alerts.jsonl` 和 `state/host/heartbeat.json` 有没有异常。
4. **看一眼该验收的任务**：

   ```sh
   ACCEPTANCE_WATCHER_HOME=<home> node watchers/acceptance/bin/poll.mjs --json
   ```

   确认列出来的就是该验收的 issue；没有就等下一拍。
5. **手动跑一轮**（只跑一轮，不常驻）：

   ```sh
   ACCEPTANCE_WATCHER_HOME=<home> node watchers/acceptance/host/round.mjs --issue <owner/repo#n>
   ```

   写闸总开关关着时这一轮不认领、直接退出 3（不写提醒）；心跳里是 `gate: disabled`。
6. **打开总开关，让常驻循环每 180 秒调度**：

   ```sh
   : > <home>/state/write-gate/enabled      # 建这个文件就是打开
   ACCEPTANCE_WATCHER_HOME=<home> sh watchers/acceptance/host/loop >> <home>/state/host/loop.log 2>&1 &
   ```

   然后把每小时一次的 routine 指到 `sh watchers/acceptance/host/ensure.sh`（只查心跳、必要时拉起）。

首跑顺序按总 issue 决策表：先跑我名下那批 PR，本仓的总 issue 放最后，结论由我或
`anthropic/claude-opus-5-5`（high）复核。

## 7. 停用与回滚

**停**（按需要选一个）：

```sh
ACCEPTANCE_WATCHER_HOME=<home> sh watchers/acceptance/host/stop.sh   # 停常驻循环，按心跳里的 pid
rm -f <home>/state/write-gate/enabled                                # 关写闸总开关：所有写动作都拒
```

**回滚**（停掉之后，把还在「验收中」的轮次标成「中断」）：

```sh
ACCEPTANCE_WATCHER_HOME=<home> node watchers/acceptance/host/rollback.mjs
```

`rollback.mjs` 逐条读 `state/host/rounds/*.json` 里登记的在跑轮次，对每条跑
`round.mjs abort --reason 回滚：手动停用`；单条失败不影响其它条。跑完看一眼
`alerts.jsonl` 和 GitHub 上的轮次评论，确认没有还停在「验收中」的轮次。

恢复就是把第 6 节的第 6 步再做一遍；`ensure.sh` 也会在心跳过期时自己把循环拉起来。

注意：

- `abort` 也是经写闸写的：**总开关关着时回滚会被拒**。要回滚就先回滚、再关总开关（或临时打开总开关回滚完再关）。
- `stop.sh` 只停常驻循环，不停已经在跑的轮次；要连轮次一起停，结束对应的 `host/round.mjs` 进程（宿主看到 pi 退出会自己把这一轮标「中断」），或者等它跑完。
- 清场一律用 `abort` / `rollback.mjs`，**不要删 GitHub 上的轮次评论**：轮次以评论为准，删了会读不出当前轮次。

### 更新部署

1. 确认没有轮次在跑：`<home>/state/host/rounds/` 为空（或心跳里 `running` 为空）。有就等它跑完。
2. `stop.sh` 停常驻循环。它会留一个 `state/host/planned-stop.json` 标记（2 小时内有效、用一次就删；新循环起来也会清掉），之后保活拉起时记成「部署重启」（`loop-deploy-restarted`，只进摘要），不按意外重启立即提醒。
3. 在部署的检出里 `git pull --ff-only`（只快进；本地有改动就先查清楚，不要覆盖）。
4. 看新版本的 PR 有没有新配置项（`host.json` / `profile.json`），改配置前先备份。
5. 跑一遍 `doctor`。
6. 起常驻循环（第 6 节第 6 步），或等每小时的保活把它拉起来。

## 8. `doctor` 检查项

`doctor.mjs` 缺哪项报哪项，退出码非 0；配置读不出时只报一条「配置」，**不回落任何默认配置**。

- `node 版本`：≥ 22。
- `gh 在 PATH 上`、`git 在 PATH 上`。
- `令牌账号`：令牌对应的账号必须等于 `ownerLogin`。
- `仓可读`：`autoRepos`/`forkRepos`/`watchRepos` 里每个具体仓都读得到。
- `写闸探针`：配了 `writeCommand` 就用一条不改任何东西的探测动作确认它当场回结果——总开关开着
  返回 0，关着返回 4（两种都算正常，报出是哪种）；意外退出码算失败。
- `写闸探针（仓外）`：名单外的仓必须返回 4。探针动作带 `probe` 标记和随机 `dedupeKey`；写闸对探针只记日志（stderr），
  不写 `gate-rejected` 提醒（不进 Slack 摘要）、不记账本。
- `看板`：能读 `projectV2(projectNumber)`。
- `看板写回`：只读判断，不写 GitHub、不经写闸——用账号令牌查看板的 `viewerCanUpdate`，再看「验收」
  （单选，含 验收中 / 要修 / 修正中 / 通过）和「裁决」（文本）两个字段在不在。`--board-item` 不再需要。
  （以前是读一条条目的「裁决」原值再经 writeCommand 写回，但写闸 exec 只放行认领和中断，恒返回 4。）
- `fork 推送`：`forkRepos` 里每个仓对应的 fork 都存在且 `viewerPermission` 是
  `ADMIN`/`MAINTAIN`/`WRITE`。fork 默认是 `ownerLogin` 名下同名的仓；名字不同就在 profile 里写
  `"forkTargets": {"<上游 owner/repo>": "<ownerLogin>/<fork 名>"}`（键必须在 `forkRepos` 里，fork 必须在
  `ownerLogin` 名下）。修正轮推分支、写闸核对 PR head 用的都是同一个对照。
- `常驻循环`：心跳里的 pid 活着且心跳不超过「拍间隔 + 60 秒余量」（默认 180 秒拍 → 240 秒；`tickIntervalS` 只认 1..3600，见第 14 节「心跳年龄阈值」）。心跳只表示循环活着：一拍内每 30 秒刷新一次，并带 `phase`（`name`、`startedAt`、`startedUptimeS`、`elapsedS`，当前阶段、已多久；阶段有 `poll` 拉取、`abort` 清理卡住的轮次、`prbot` 修正轮读取、`dispatch` 派发、`audit` 写闸审计、`notify` 发通知），拉取阶段另带旧字段 `polling`（兼容），拍尾的心跳两者都不带。修正轮里每发起一次 GitHub 读取都重新计时，每次读取 45 秒没返回就连同它起的子进程整组掐掉，用新进程重试一次，重试也没返回才按读失败收尾、提醒里注明「已重试一次」；拉取（poll）同理，单次 60 秒、超时整组掐掉重试一次（写不加超时、不重试）。重试成功不写提醒，只在 `state/host/loop.log` 留一行 `<UTC 时间> read-retry-ok kind=<poll|prbot-read> totalMs=<毫秒> 读取超时已重试成功`，统计超时次数用 `grep -c read-retry-ok`。任何阶段按机器实际运行时间算超过 180 秒就不再刷新心跳，这一项也单独报红并写明阶段（例如「修正轮读取已 N 秒没结束，超过上限 180 秒」）。
- `写闸账本审计`：只读跑一次写闸账本审计（第 3 节的 `state/write-gate/ledger.jsonl`），看有没有越规写入；
  明细报「核对了多少行、基线是什么、基线后违规几条、拿不准几条、这次新发现哪几条」。只有**明确违规**让这一项变红；
  「拿不准」只记日志（明细里报出来），GitHub 只读核对没做成也照旧写进明细但不改变红绿。审计内部出错只报这一项失败。
  这一轮已经单独跑过审计时，加 `--skip-gate-audit`：这一项仍在，明细写「本次体检已单独跑过审计，这里跳过」，算通过，不再查 GitHub。不传则照旧跑一遍。
- `令牌文件`：`…TokenFile` / App 私钥文件全部通过 600、属主当前用户、非空检查。
- `写 App 身份白名单`：配了 `apps.write` 时，用写 App 的私钥签 JWT 调一次 `GET /app` 取 `slug`，
  确认 `<slug>[bot]` 在 `profile.trustedBotLogins` 里（大小写不敏感）。不在就报红并说明后果（评论 / issue 作者会变成
  那个 bot，白名单没它，轮次评论会被忽略），查不到 slug 也报红。没配 `apps.write` 就跳过（算通过，不查 GitHub）。
  开关顺序见第 2 节「两级 App 配置」。
- `Slack 频道`：只读——bot 令牌能过 `auth.test`，bot 在 `slackChannelId` 那个频道里（`conversations.info`
  的 `is_member`；令牌没有 `channels:read` / `groups:read` 就退到 `conversations.history limit=1`，bot 不在频道里
  会报 `not_in_channel`）。不发任何消息；没配 `slackChannelId` 就跳过（算通过）——当前部署就是这样：Slack 通报已关闭，告警只写 `alerts.jsonl`。
- `bwrap 遮罩`：在 bwrap 里跑一个读文件的小脚本，名单上的文件和凭证目录必须一个都读不到；
  bwrap 不可用算失败。遮罩名单按 `<home>/config/host.json` 算（`credentialDirs` 也遮），并且先查
  `credentialDirs` / `homeAllowDirs` 每一项都存在、不与可写绑定（`stateDir`、`worktreeDir`）互相包含。

### 写闸账本审计

`host/gate-audit.mjs` 旁路核对写闸账本（`state/write-gate/ledger.jsonl`）：每一条**已执行**的写入都要对得上写闸规则。
它**只能事后发现，拦不住**写入；不开关写闸、不改账本、不撤回任何东西。

审计发现分两级：

- **明确违规**（`level: violation`）：写闸规则写得死死的、不用补上下文就能判定的几种——`pr-merge`、`comment-delete`、
  `repo-out-of-scope`、`tier-not-allowed`、`verdict-only-write`、`round-comment-modified`、`round-comment-missing`，
  以及白名单之外的写类型 `type-not-allowed`、账本已审计部分被改写或截短 `ledger-rewritten`。
  这些写审计日志、写 `gate-audit-violation` 提醒（Slack 立即发），也让 `doctor` 变红、命令行退出码 1。
- **拿不准**（`level: uncertain`）：认不出记录格式、缺轮次上下文、或账本有读不出的行——`no-round`、`round-mismatch`、
  `unverifiable`、`ledger-corrupt`。这些**只记日志**，绝不写提醒、
  不让 `doctor` 变红；命令行报 2（只提示有人看一眼，不当事故）。不认识的规则按拿不准处理。

逐条核对的五条规则：

1. 写类型：只认写闸的白名单（`pr.merge` 根本不许、`comment.delete` 不许、白名单外的类型报 `type-not-allowed`）。
2. 仓范围与分档：只能写 `autoRepos` / `forkRepos` / `watchRepos` 里的仓；`watch` 档只许
   `comment.create`、`comment.update`、`project.field.set`。**按写入当时的范围判**：写闸记账时给每条记录带上
   `scope`（放行时那份 `autoRepos` / `forkRepos` / `watchRepos` / `verdictOnlyIssues` 的指纹），快照存在
   `state/write-gate/scopes/<指纹>.json`；审计用快照判，事后改 profile（比如临时把某个仓移出 `autoRepos`）
   不会把当时合规的写入（包括宿主自己标「中断」）误判成越权。快照内容和指纹对不上的不认；
   没有指纹的老记录只能按当前配置判。规则 3 也用同一份快照。
3. 只出裁决的总 issue（profile 的 `verdictOnlyIssues`）：不许关、勾、开修正、推送（和写闸同一份名单）。
4. 轮次绑定：每条写入都要对得上账本里登记过的轮次评论（开轮评论 / 修正轮认领评论），对不上报 `no-round` / `round-mismatch`。
5. 轮次评论只许本轮收尾改（裁决 / 中断各一次）；修正轮只许改自己认领评论。另外用固定查询**只读**看 GitHub
   上轮次评论还在不在（`round-comment-missing`；评论满 100 条且读取窗口没覆盖那一轮时不下结论）。

怎么跑：

- 常驻循环每拍跑一次（只读本地账本，**不查 GitHub**），结果写进 `heartbeat.lastTick.gateAudit`
  （`checked` / `found` / `sinceBaseline` / `uncertain`）；出错只写 `heartbeat.lastTick.gateAuditError`，不影响这一拍。
- 带 `--github` 时只审上次游标之后新增的轮次；某次查询失败（5xx / 限流 / 读不到评论）的轮次记进
  `state/host/gate-audit.json` 的 `pendingGithubRounds`，下一轮一定重查，不因游标推进而永久退出审计。
  待审集合上限 `AUDIT_PENDING_LIMIT = 500` 条；**超上限不静默丢**：审计游标退回到被丢掉的最早一轮之前
  （下一轮把它们当新增轮次重查），并在审计日志留一行 `level: info`、`rule: pending-overflow`（写明丢掉几条、退到第几行）。
- `doctor` 的「写闸账本审计」和手动运行会带上 `--github` 的只读评论核对。
  已经单独跑过时：`node watchers/acceptance/bin/doctor.mjs --skip-gate-audit`（项名不变，算通过，不再查一遍）。默认不跳过。
  评论按 issue 根有限并发读取（同时最多 4 个请求），只取 `databaseId` 和 `createdAt`，窗口仍是最后 100 条。
- 单独跑：`node watchers/acceptance/host/gate-audit.mjs [--github] [--no-alert] [--json]`
  （`--no-alert` 只写审计日志、不写提醒；`--json` 只打一行 JSON）。
- 只想看最近出了些啥：`node watchers/acceptance/host/gate-audit.mjs --summary [--hours N] [--json]`。
  它不跑审计、不拿锁、不写任何文件，只读审计日志和状态文件；日志不存在算空，坏行跳过。
- 判定规则升级（`AUDIT_RULES_VERSION`，v2 = 范围按写入当时判）后，常驻审计下一拍自动按新规则把基线后、
  上次游标前的账本重算一遍：旧规则下的误判消掉，真违规照算；GitHub 核对和账本被改写这两类账本算不出来，
  照审计日志沿用。重算在审计日志记一行 `level: info`、`rule: rules-recheck`（写明前后条数），不发提醒、
  不算拿不准。这不是 `--ack`：不看人、不清零，重算出几条就是几条。
- 处理完运行 `node watchers/acceptance/host/gate-audit.mjs --ack`：只把「基线后明确违规数」清零，日志和已报指纹保留，
  旧违规不会再报（「基线后拿不准数」不清，它只用于统计）。
- 退出码：`0` 没有新的明确违规且基线后已清零；`1` 有明确违规；`2` 只有拿不准 / GitHub 没查成 / 锁被占；
  `3` 运行出错（stderr 一行错误）。`--ack` / `--summary` 成功即 `0`。
- 边界：GitHub 只做只读查询；本地只写 `state/host` 下的审计状态、审计日志和提醒队列。

基线与增量：

- 第一次跑时以**当时账本末尾**为基线：基线前的记录只统计（`baseline.lines` / `baseline.violations` 只计明确违规，
  `baseline.uncertain` 计拿不准；`baseline.sample` 两类都可以带），不报、不发提醒。
- 之后只核对基线 / 上次之后新增的行（心跳里的 `checked` 就是这次核对了多少行）。
- 同一条发现按指纹（规则 + 行号 + 明细 + 原始行）只报一次，指纹留在状态文件里（最多 5000 条）；两类共用同一份已报指纹。
- 账本应只追加：已审计过的部分被改写或截短时报一次 `ledger-rewritten`（明确违规：发提醒、`doctor` 变红），然后从头重新核对（报过的不重复）。

状态与明细：

- 状态文件：`<home>/state/host/gate-audit.json`（基线、游标、前缀哈希、`sinceBaseline`（明确违规）、
  `uncertainSinceBaseline`（拿不准，只统计）、已报指纹）。
- 明细日志：`<home>/state/host/gate-audit.log`（一行一条 JSON：时间、`level`、规则、行号、类型、去重键、明细）。
  老日志行没有 `level`，汇总时按规则现算。
- 提醒：只有明确违规才在 `alerts.jsonl` 里写一条 `gate-audit-violation`（含前 5 条明细和总数），由 Slack 立即发
  （见 [`docs/acceptance-slack.md`](acceptance-slack.md)）；拿不准不写提醒。
- 账本坏行报 `ledger-corrupt`（拿不准）；认不出格式的记录报 `unverifiable`（拿不准）；类型已经报了 `pr-merge` /
  `comment-delete` / `type-not-allowed` 又认不出格式时只报那一条，不再补 `unverifiable`。

## 9. 组织仓的开关

- 我确认组织允许代码进这台盒子之前，**不把组织仓加进 `autoRepos`**。
- 加进去之后的第一轮，要我在场看着跑（看 `pi.log`、`alerts.jsonl`、轮次评论）。
- 2026-10-24 已确认：组织仓代码可以检出到这台盒子；加仓仍然按上面两条来。

## 10. 排障

| 现象 | 先看 | 处理 |
|---|---|---|
| 心跳不更新 | `state/host/heartbeat.json` 的 `at`/`lastTick.error` | 跑 `ensure.sh`；还不行看 `loop.log`（循环退出会记下时间和原因），`stop.sh` 后重起 |
| 轮次一直「验收中」 | `state/host/progress/` 里这一轮的 `lastActivityAt`（`round.mjs status` 的 `stalled` 按模型写的时间算，只作参考） | 等调度先杀进程再 abort；要手动就 `abort --reason` |
| `prefetch-failed` | 提醒的 `reason`（哪个仓）、`state/prbot/mirrors/acceptance__*` | 多半是令牌看不到这个仓或网络问题；`doctor` 的「仓可读」先过 |
| `env-unverified` | 提醒的 `reason`（哪几项必需检查因环境没跑 / 哪几条「通过」的证据写着因环境没跑） | 裁决防线：build / typecheck / 测试有一项因环境没跑就不能判通过，helper 把本轮标「中断」（环境问题）、退出码 6，宿主写这条提醒，按环境退避（30 分钟、2 小时、6 小时）自动重验。反复出现就查那项检查缺什么环境 |
| `deps-failed` | 提醒的 `reason`（哪个仓、退出码 / 超时 / 被拒的主机）和 `detail`（npm 输出尾巴） | 环境问题，不判代码；多半是 npm 官方源连不上，或 lockfile 里有官方源以外的 `resolved` 地址（被出网代理拒）。会按退避自动重试 |
| `sandbox-down` | `bwrap --ro-bind / / true` | 修好 bwrap 之前不会认领；提醒一小时一条 |
| 所有写都被拒 | `alerts.jsonl` 的 `gate-rejected` | 看 `reason`：`gate-disabled` → 建开关文件；`not-current-round` → 轮次已结束 |
| `sandbox-unavailable` | `pi.log`、`gate.log` | `bwrap --ro-bind / / true` 跑一下；参数拼错看 detail（含 `egressAllow` 写法不对） |
| `egress-denied` | 提醒里的 `reason`（被拒的 `host:port`）和 `detail`（`not-allowed` / `not-connect` / `blocked-address`） | 该放行就把 `host:port` 加进 `host.json` 的 `egressAllow`（npm 源除外：依赖走宿主预装）；不该放行的说明模型在往外连别处，看 `pi.log` |
| pi 连不上模型网关 | `pi.log`、`alerts.jsonl` 的 `egress-denied` | `egressAllow` 里要有 `models.json` 的 `baseUrl` 主机名 `:443` |
| `secret-found` | 提醒里的 `reason`（只有文件名） | 按 #46 SC7 记「需人工处理」，别自己推 |
| `tick-failed` | `heartbeat.lastTick.error` | 多半是 `poll.mjs` 或配置报错，跑一次 `poll.mjs --json` 看 |
| 任务一直不再验（最近裁决有「有争议」） | `poll.mjs --json` 的 `adjudicate` 条目、`state/host/adjudications/runs/` | 没配 `adjudicateCommand` 就补上；`adjudicate-needs-human` 后要人工裁决 |
| `adjudicate-timeout` / `adjudicate-failed` | `<home>/run/adj-*/pi.log`、`out.log` | 会自动重试（最多 3 次）；输出不合格多半是 pi 没按单行 JSON 收尾 |

## 11. 自动快进部署

`watchers/acceptance/deploy-ff.mjs` 每次启动只做一件事：现在能不能把部署目录快进到 `origin/main`。能，就快进并跑语法检查和 `doctor`；不能，就说明为什么然后退出。它不发通知、不装调度、不重启循环。脚本放在 `bin/` 外面，因为要跑 `git`、查进程和 `doctor`。

本 issue 不安装调度，安装需 lead / Praise 批准。已定方案是 cron 每 5 分钟跑一次本脚本、跑完就退出；合并并审过后，由 Issue Inspector 另行批准再安装。在那之前，第 7 节的手工更新步骤不变。

路径都不写死，由参数传入。下面的 `<deploy>` 是部署检出，`<home>` 是宿主家目录：

```sh
node watchers/acceptance/deploy-ff.mjs \
  --deploy-dir <deploy> \
  --host-state <home>/state/host \
  --self-lock <home>/state/host/deploy-ff.lock \
  --prio-lock <home>/state/host/prio-drill.lock \
  --state-file <home>/state/host/deploy-ff.json \
  --alerts <home>/state/host/alerts.jsonl \
  --approval-file <home>/state/host/deploy-ff-approval \
  --doctor-script <deploy>/watchers/acceptance/bin/doctor.mjs
```

- `--doctor-arg` 可以重复，原样传给 doctor。doctor 要的环境由调用方在启动本脚本前准备好；本脚本不读令牌。
- `--approve <完整 sha>` 或批准文件里单独一行写着目标提交的完整 sha，才放行敏感改动。批准文件必须在部署目录之外。短 sha、对不上的 sha、仓库里的同名文件、提交说明里的批准字样，都不算数。目标前进后旧批准失效。快进并且检查通过之后，用过的批准文件会删掉。
- `--prio-lock` 要和 prio-sync 演练用的是同一把锁。两把锁都是非阻塞的，进程退出就放开。
- 参数缺失时退出码 2，不部署。

每次运行标准输出通常是两行：第一行是 JSON（`status`、`head`、`target`、`behind`、`lagging`、`reportLag`、`files`、`lines`、`reason`、`ts`），第二行是中文人话。落后时人话里带给 lead 的那句。首读拿不到检查结果、同拍重读读到结果时，末尾再多一行说明（见下）。

| 状态 | 退出码 | 类别 |
|---|---|---|
| `deployed` | 0 | 已快进且检查通过 |
| `up-to-date` | 0 | 已经在目标提交 |
| `waiting` | 30 | 等待空档（轮次目录、锁目录、验收进程或演练锁） |
| `ci-pending` | 30 | 等待检查跑完 |
| `draining` | 30 | 落后超限、等不到空档：正在排空（占住空出来的轮次槽位，见下面「部署排空」） |
| `locked` | 20 | 另一个实例拿着本脚本的锁 |
| `blocked-dirty` | 10 | 工作区不干净，不动 |
| `blocked-diverged` | 11 | 分叉或本地超前，只接受快进 |
| `fetch-failed` | 12 | 拉取远端失败，不动 |
| `ci-red` | 13 | 检查失败，不拉 |
| `ci-unknown` | 14 | 检查读不到、对不上提交或格式不认得，不拉 |
| `needs-approval` | 15 | 敏感改动还没被点名批准 |
| `pull-failed` | 16 | 快进失败，不动 |
| `doctor-failed` | 17 | 已经快进，检查没过，不自动回退 |

`waiting` 和 `ci-pending` 同属等待，不算异常。检查必须全部完成且结论都是 success、neutral 或 skipped，才算绿；全部是 skipped 也算绿。每条 check run 的 `head_sha` 必须等于当时 `origin/main` 的完整 sha，对不上就不拉。只读 check-runs（`/repos/<owner>/<repo>/commits/<sha>/check-runs`），不读 commit statuses。请求不带身份头；仓名从部署目录 `origin` 的配置地址推出。读到结果之后如果轮次空档没了，或者远端又前进了，只合并刚才核对过的那个完整 sha，不会去追新的 `origin/main`。

读检查结果只读一次，例外只有一种：首读是 `ci-unknown`（空结果、`total_count` 和条数对不上、格式不认得、`head_sha` 对不上目标、非 200、超时、抛错）时，同一次运行里再读一次**同一个完整目标 sha**。第二次读到绿就照常快进并部署，不再等 5 分钟到下一拍；第二次读到 `ci-red` 或 `ci-pending` 就按那个状态收尾；两次都拿不到仍是 `ci-unknown`，不快进，照常写一条 `deploy-ci-unknown`。明确失败（`ci-red`）和等待（`ci-pending`）都是读到了的结论，不重读。重读只在读检查这一步发生，仍在差分、敏感批准、轮次空档复检和快进之前，不越过其中任何一道门；`fetch`、`merge --ff-only`、差分、`doctor` 都不重试。一次运行最多两个 GET（每个请求最多 `--timeout`，默认 15 秒）。重读拿到非 `ci-unknown` 结果时，标准输出在原来两行之后多一行 `检查结果首读读不到（ci-unknown）…` 说明；`deploy-ff.json` 的字段和告警去重键都不变。

敏感清单（命中任一就不拉，除非批准了这个完整 sha）：

- `watchers/acceptance/host/` 下的全部文件
- `watchers/acceptance/bin/trigger.mjs`
- `watchers/acceptance/bin/profile.mjs`、`github.mjs`、`redact.mjs`、`secretscan.mjs`
- `watchers/acceptance/bin/prio-sync.mjs`
- 仓根 `package.json`、仓根 `run-ensure.sh`
- 任意目录下的 `package-lock.json`、`npm-shrinkwrap.json`、`yarn.lock`、`pnpm-lock.yaml`
- 本脚本自己 `watchers/acceptance/deploy-ff.mjs`
- 任意路径下的 `token.json`、`.token`、`secrets/` 目录里的文件、以及文件名以 `.key` 结尾的文件
- 待拉提交的新增行（删除行不算；改名用 `--no-renames` 拆开算，挪走旧路径也算命中）按「旧规则减去白名单」判（#426，后收紧）：出现 `token`、`process.env`（不分大小写）就算敏感，只有每一处都落在白名单写法里才放过；白名单只有两种：按字面量名字读写普通环境变量（`process.env.X`、`process.env?.X`、`process.env['X']`，名字只认大写字母、数字、下划线，`valueOf` 这类对象方法名不算；读到名字就得结束，后面再接 `.`、`?.`、`[` 或调用的不算（`process.env.HOME.constructor…` 能拿到整张表，`process.env.X.split(',')` 也因此要批准）；名字里不能有 `TOKEN`、`SECRET`、`PASSW`、`KEY`、`APP`、`AUTH`、`CRED`、`PRAISEZHU`），以及模块文件名里的一段 token（`mivo-app-token.mjs` 这种 `.mjs/.js/.ts/.py/.sh/.md` 文件名；`token.json` 这类数据文件不算）。函数默认参数 `(env = process.env)` 不再放过，因为会把整张环境表交出去。另外，不管怎么读到的，出现全大写的密钥类名字就算（`GITHUB_TOKEN`、`X_API_KEY`、`APIKEY`、`DB_PASSWORD`、`DEPLOY_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、`AUTHORIZATION`、`GH_CREDS`、`MIVO_APP_ID`、`PRAISEZHU_FOO` / `PRAISEZHU_BOX` 这类 `PRAISEZHU_*` 无条件敏感；`KEY` 只认 `API_KEY`、`PRIVATE_KEY`、`ACCESS_KEY`、`DEPLOY_KEY`、`SIGNING_KEY`、`SESSION_KEY`、`ACCOUNT_KEY`、`STORAGE_KEY`、`HMAC_KEY` 和单独的 `KEY` 这类密钥叫法，`APP` 要跟着 `ID` / `INSTALLATION`，所以 `CONFLICT_FEEDBACK_KEY`、`FORBIDDEN_KEYS`、`WATCHED_BOT_APP`、`AUTHOR_LOGIN` 不算），没有字面量名字的读环境变量写法也算（`process['env']`、`globalThis…process`、`require('process')`、`const { env } = process`、`const p = process; p.env`、Python 的 `os.environ` / `getenv`、shell 的 `printenv`）；`secrets/` 路径、`*.key` / `*.pem` 等密钥文件、`token.json` / `.token` / `…/token` / `path.join(home, 'token')` / `` `${dir}/token` `` 这类令牌文件、`appOnly`、`listen(8080)` 或 `port: 3000` 这种端口配置照旧单独认。读法列不完（别名、解构、拼接、别的语言），所以默认拦、按白名单放。白名单按每一处触发词判断、不按整行：同一行里没有触发词的代码（比如 `readFileSync(credsPath)`）不靠这条规则拦，旧规则也只是碰巧因为同一行有 `process.env` 才拦到；读凭证文件靠路径规则和单独认的令牌文件、密钥文件、`secrets/`、全大写密钥名。任何目录下的 `*.test.mjs`、`*.test.py`、`*.fixture.mjs`，以及仓根 `docs/` 下一层的 `*.md`，新增行不做常规内容扫描（普通的 `token` 字样、按名字读非敏感环境变量仍放过；上面的路径规则仍然照查），但 `appOnly`、令牌文件、`secrets/`、`listen()` / 端口、`GITHUB_TOKEN` 在这些文件里照样拦；`docs/` 的子目录和别处的 `docs/` 目录照常扫。

多键解构补充：从 `process` 解构出 `env` 时，即使还带有 `argv` 等其他键，也属于读取整张环境表；`const` / `let` / `var`、赋值形式、重命名和默认值均需批准。比如 `const { argv, env: e = {} } = process` 不能用普通环境变量白名单放过。同一文件里行号连续的新增行按一段识别，跨行的解构也要拦；行号不连续的新增行不拼接。`{ argv } = process`、`{ env } = config`、`{ env } = process.argv`、`process.env.HOME` 和 `environment` 这种其他键名保持原规则，不因本补充被误拦。
端口键补充：JSON / 对象里的键可带单引号或双引号，数字值也可带引号；`"port": 8080`、`'port': '8080'` 与已有的 `port: 8080` 一样需要批准。明确的端口键包括 `listenPort`、`listen_port`、`httpPort`、`http_port`，已有 `listen(8080)` 仍要拦。这条端口红线在测试文件和仓根 `docs/*.md` 里也生效；`passport`、`report`、`port 字段说明`、没有数字值的 `port`、普通数字常量和没有括号的 `listen for connections` 不因本补充被误拦。本节只说明判定规则，不改变任何运行端口。

落后：本地比目标多超过 5 个提交，或最早一个未部署提交距今超过 2 小时，人话里带 `lagging`，并给 lead 一句。同一次落后（以当前本地 HEAD 为键）只在第一次把 `reportLag` 设为 true。快进成功后这份记忆清掉。

### 部署排空（#425）

验收轮一个接一个时，主循环在槽位空出的下一拍就起新轮次，本脚本可能一直等不到空档。排空借用主循环已有的槽位锁 `<host-state>/slots/slot-0`、`slot-1`。主循环起轮前会数活着的槽，单轮拿不到槽就这一拍不认领。所以占住空出来的槽，就能挡住新轮次，主循环一行不用改。

- **什么时候排空**：等不到空档（`rounds`、`locks` 不空或有验收进程），且同时满足两条。一是按上面的规则已算落后，超过 5 个提交或超过 2 小时。二是 `HEAD..origin/main` 没有敏感改动，或者已经点名批准了目标完整 sha。需要批准时不排空。算落后之前先 `git fetch origin`：只更新远端引用，不动工作区和 HEAD，所以一直等不到空档时落后数也是新的。fetch 失败时结局是 `fetch-failed`，已占的槽当场放掉。冷却期内、或下面说的「没有在跑的证据」时不 fetch。
- **只认活着的登记**：`rounds/`、`locks/` 里每个文件都要判活。内容里有正整数 `pid` 的，用 `kill(pid, 0)` 判活（EPERM 也算活）。读不出 `pid` 的（半截、空对象、不是 JSON），看文件修改时间：超过 10 分钟算残留，10 分钟内按正在写、算在跑。排空的条件是至少有一个活的登记，或者列进程看到了在跑的验收进程。两个目录读不了、或者列不出进程时，不排空。
- **有残留就不排空**：只要有一个残留文件（写的进程已经不在，比如轮次被 SIGKILL、OOM 或重启打断），就不排空、不占槽，已在排空的当场放槽。哪怕同时还有活的登记也一样，因为活的那轮结束后，残留仍会挡住空档判定。这时排空只会占满 120 分钟、冷却 30 分钟、再占满，验收大部分时间起不了轮次。另写一条 `deploy-drain-stale-locks` 提醒（人话，列出残留文件的相对路径），同一个 HEAD 和目标只写一次。本脚本不删这些文件，要人确认对应轮次已经结束后再删。宿主下一次拿同名锁时，也会自己清掉 pid 已死的锁。空档判定本身不变：目录不空就不部署，残留文件照样挡住部署。
- **怎么占**：起一个脱离 cron 的持有进程（命令行带 `deploy-ff-drain-holder` 标记），用它的 pid 按宿主锁的同一格式（O_EXCL 建文件，内容 `{pid, startedAt}`）去占空槽。写着活 pid 的槽是在跑的轮次，不抢；读不出内容的按占用处理。pid 已死的陈旧锁不能直接删：先 rename 到唯一临时名，再比对内容，还是观察过的那一份才删并重占；不是同一份（判死后、删前已被新轮次写成活锁）就 link 放回，不覆盖活锁。如果放回时原槽位上已经有了新锁（link 因文件已存在失败），临时文件和新锁都留下、都不删，并往提醒文件写一条 `deploy-drain-lock-restore-failed`（含临时文件路径和两份锁的进程号），等人核对后再删临时文件。持有进程补占空槽用同一条规则。不中止、不暂停任何轮次。持有进程活着时每秒自己看一次槽位，有空出来的（在跑的轮次结束删了槽文件，或留下写着死 pid 的槽）就立刻按同样规则占上：主循环每 3 分钟起一次轮次，本脚本 5 分钟才跑一拍，只靠本脚本补占，空出来的槽会被主循环先拿走，排空永远等不到空档（#425 复审）。
- **状态**：标准输出状态是 `draining`，退出码 30，人话说明占了几个槽、在等什么、截止时间。`deploy-ff.json` 多一个 `drain` 字段：`status`、`holderPid`、`target`、`startedAt`、`deadline`、`slots`。下一拍发现自己在排空时，沿用同一个持有进程和截止时间，补占新空出来的槽，重复跑结果不变。持有进程意外没了，就重起一个接着占，截止时间不变。开始排空时写一条 `deploy-draining` 提醒（人话），同一个 HEAD 和目标只写一次。
- **什么时候部署**：槽位被占后不会再起新轮；在跑的轮次结束、`rounds`、`locks` 都空、没有验收进程时，空档判定（不变）通过，照原流程 fetch、读检查、敏感批准、快进和 `doctor`。
- **什么时候放槽**：结局是 `deployed`、`up-to-date`，或者要人看（`needs-approval`、`doctor-failed`、`pull-failed`、`blocked-dirty`、`blocked-diverged`、`ci-red`、`ci-unknown`），或者暂时等不到结果（`fetch-failed`、`ci-pending`）时，当场让持有进程退出并删掉写着它 pid 的槽。后两种放槽后验收照常起轮次，下一拍还落后会再排空，截止时间重新算。`locked` 不放：那时另一个实例拿着本脚本的锁，排空归它管，它可能正在快进或跑 `doctor`。
- **最长持续时间**：从开始排空算 120 分钟，截止前 1 毫秒仍在排空，到截止时刻（含）的那一拍放槽，写一条 `deploy-drain-timeout` 提醒，状态回到 `waiting`。持有进程自己也在截止时间删槽退出，所以本脚本不再运行也不会一直占着。超时后冷却 30 分钟（`drainCooldownUntil`）才会再排空，保证等不到空档时验收照常起轮次。
- **和写闸无关**：排空不读、不写写闸总开关，也不改 `MAX_ROUNDS`、限流预算、账号余量暂停线、敏感判定和批准流程。
- **手动查看**：`jq .drain <home>/state/host/deploy-ff.json`；`cat <home>/state/host/slots/slot-*`（`holder` 为 `deploy-ff` 的是排空占的）；`ps -o pid,etime,args -p <holderPid>`。要提前放开，对 `holderPid` 发 SIGTERM，它会删掉自己的槽后退出。

提醒写到调用方传入的 `alerts.jsonl`，本脚本自己追加，不引用宿主目录里的模块。一行一个 JSON：`ts`、`kind`、`reason`、`detail`，另带 `head`、`target`。`kind` 以 `deploy-` 开头，例如 `deploy-needs-approval`、`deploy-blocked-dirty`、`deploy-doctor-failed`、`deploy-pull-failed`、`deploy-blocked-diverged`、`deploy-ci-red`、`deploy-ci-unknown`，首次落后另写 `deploy-lagging`。同一个本地 HEAD、目标 sha 和 kind 只写一行。`waiting`、`ci-pending`、`up-to-date`、`deployed` 不写；`locked` 和 `fetch-failed` 只出现在标准输出，不写提醒。状态文件用临时文件加 rename 写入，记下落后是否报过、以及已经写过的提醒键。

## 12. prio-sync 分批写

`watchers/acceptance/bin/prio-sync.mjs` 一次 `--write` 默认把这一拍所有计划变更都写出去。要先只写一个仓、或者只写一个字段、并且一次只写前几条，加上 `--only-repo`、`--only-field` 和 `--limit`。三个参数都可以单独用，也可以任意组合，不带 `--write` 时同样生效，只是不调用写闸。

处理顺序固定：排除档 → `--only-repo` → 算计划 → `--only-field` 过滤 → `--limit` 截取 → 逐条调写闸。

```sh
node watchers/acceptance/bin/prio-sync.mjs \
  --only-repo example/repo \
  --only-field '关联 PR' \
  --limit 1 \
  --write \
  --state-dir <state-dir>
```

取值里有空格，要整段用引号包起来，否则 shell 会把「关联 PR」拆成两个参数。

- `--only-repo` 的取值必须是 `owner/repo` 两段，字符只允许字母、数字、`_`、`.`、`-`，不能有空格，首尾不能有 `/`。比较仓名时不分大小写。其它仓的条目不打分、不进变更、不写、不提醒。它们在 `debounce.json` 里的状态原样保留，包括这一拍条目列表里没出现、但状态文件里已经有的条目。
- `--limit` 只保留前 N 条真会调用写闸的变更。顺序固定，和条目原来的先后无关：先按仓名小写，再按 issue 号的数值，再按字段名的 Unicode 码点（「优先级」在「关联 PR」前面）。同一批输入打乱顺序跑两次，写入的是同样的 N 条。N 至少是 1，最大是 1000（源码里的 `PRIO_LIMIT_MAX`）。看板目前大约一百条，1000 留足余量，同时挡住一次写得过多。
- `--only-field` 只写一个字段。取值只认「关联 PR」和「优先级」两个（看板可写的就这两个字段，源码里的 `ONLY_FIELD_NAMES`），精确相等：不 trim、不折大小写，也不接受逗号分隔的多值。过滤在计划算完之后、写闸调用之前：`runPrioSync` 里 `changes` 算完、`onPlan` 钩子看过完整计划、写循环开始之前，按 `change.field` 比。其它字段的变更本拍不调用写闸、不追加 `changes.jsonl`、也不占 `--limit` 名额。
- 被过滤的字段防抖按没写过退回（和 `--limit` 截掉、写失败同一条 `restoreUnwrittenDebounce` 路径），所以落盘后的 `debounce.json` 里该条目除放行字段外与开跑前一致，下一拍还会算出同样的变更。dry-run 也过滤：计划行和汇总里的「变更」数都只剩放行的字段。
- 过滤后一条都不剩时退出码是 0，不算失败拍，也不写 tick-failed 类告警。标准输出里「变更 0」「写入 0」照常出现，另起一行写「本拍按字段过滤后 0 条变更」，汇总行追加「，按字段过滤掉 X 条」。过滤掉 0 条时汇总行不出现这一段，所以计划里本来只有放行字段时，输出与不带 `--only-field` 时逐字节相同。
- 名额只数真会落闸的变更。没有 `.prio/mac-mini-stopped` 时，「关联 PR」只打印 hold、不调用写闸，不占名额。`prio:pin`、看板上的手动值、排除档都不进变更列表，也不占名额。
- 名额用完之后的变更不调用写闸，也不追加 `changes.jsonl`。标准输出仍打印这一行，行尾加上「（本拍上限截掉）」。防抖按没写过退回（和写失败时的 `restoreUnwrittenDebounce` 一样）。下一次运行还会再算出同样的变更。dry-run 也按这个顺序排序、按「将会写」计数，截掉的条数照样记进汇总；dry-run 本来就不写。`--limit N` 的 N 只数 `--only-field` 过滤之后真会调用写闸的条数。
- 汇总行只在给了对应参数时多相应的一段，顺序是「，按仓过滤掉 X 条」「，按字段过滤掉 Z 条」「，按上限截掉 Y 条」。X 是其它仓被跳过的条数，Z 是 `--only-field` 滤掉的条数，Y 是这一拍因为名额不够而没写的变更数。三个参数都不给时，汇总行和以前完全一样，不会出现这几段。
- 取值不合法就退出码非 0，一条都不写：不读令牌，不读看板，不创建 `changes.jsonl`、`debounce.json` 和 `run-*.log`。`--limit` 的空值、`0`、负数、小数、夹着非数字、大于 1000，`--only-repo` 的空值、只有一段、三段、首尾带 `/`、含空格，以及 `--only-field` 的未知字段（例如 `状态`）、空值、纯空格或制表符的取值，报错里都会写上参数名、期望格式和实际值。同一个参数出现两次，或者取值的位置是另一个以 `--` 开头的参数，同样退出码非 0。
- `--only-repo`、`--limit` 和 `--only-field` 都不能和 `--restore` 一起用。一起出现时退出码非 0，报错是「--only-repo / --limit 不能和 --restore 同用」，或者「--only-field 不能和 --restore 同用」，还原一条都不执行。
- 状态目录里已经有 `disabled` 时，带上这些参数也还是已停用，写入数是 0，过滤照算。

## 13. prio 持续运行

`watchers/acceptance/bin/prio-run.mjs` 是一拍一次的入口。进程自己不循环，也不安装 cron、也不改 `/etc/cron.d`。节拍按 5 分钟一次来设计，由人在验收机上决定什么时候挂上定时任务。

降档确认计数有有效期：只有彼此间隔不少于 15 分钟、且距最近一次被计入的观测不超过 60 分钟的多次观测才算确认，> 60 分钟才过期并从 1 重新数，间隔不到 15 分钟的观测不计入。

### 怎么开、怎么停

先只跑 dry-run（默认就是 dry-run）：

```sh
node watchers/acceptance/bin/prio-run.mjs --state-dir <state-dir>
```

dry-run 不改 `<state-dir>/debounce.json`。文件本来没有，跑完仍然没有。已经记下的降档确认计数（`consecutive`、`pending`、`pendingHeld`、`lastRecalcAt`）不会往前推，看板上没有的条目也不会从状态文件里删掉。`--write` 仍按原来的规则更新这份文件。

Inspector 看过至少 24 小时的 dry-run 之后，才在同一条命令上加 `--write`。`--write` 仍然只自动写「空优先级 → P1 或 P2」，并且只写授权清单里的仓。要写关联 PR 时单独挂 `--only-field "关联 PR"`（见下面的参数表）。

授权只放宽到「空 → P2」时，再加 `--only-empty-to-p2`（默认关，不带时行为与上面一致）：

```sh
node watchers/acceptance/bin/prio-run.mjs --write --only-empty-to-p2 --state-dir <state-dir>
```

带上它，计划里只留「`kind=fill`、`new=P2`、`old` 为空」的行；降级、改空、升级到任何值、空 → P1、关联 PR 一律静默排除：不 abort、不建 `<state-dir>/disabled`、不发 `prio-downgrade` / `prio-nonempty` 告警，只在 run 日志里记一行 `按 --only-empty-to-p2 排除 N 条（降级/清空 a、升 P1 b、空→P1 c、关联 PR d）`。授权清单、`--max-per-tick`、每小时 50 条上限、回读校验、备份流程都不变；已有 `<state-dir>/disabled` 仍然拦住写入。计划里有白名单字段或排除档仓这种范围外变更时，仍然整拍停写（那不是授权范围问题，是配置或字段错了）。配 `--dry-run` 时只把「会写哪几条」和排除分类打进入 run 日志，一条都不写，也不建开关。

停写：

```sh
touch <state-dir>/disabled
```

文件在，这一拍就 0 次写入，dry-run 照跑，输出里有「已停写」，退出码 0。这一拍同样不改 `debounce.json`：降档确认计数不往前推，看板上没有的条目也不会被删掉。程序自己停写也是写这个文件。要恢复，人看完告警后删掉它。本程序不创建 `mac-mini-stopped`。

下面两行只是示例，不要执行，本仓库不安装：

```sh
# */5 * * * * cd <repo> && node watchers/acceptance/bin/prio-run.mjs --state-dir <state-dir>
# */5 * * * * cd <repo> && node watchers/acceptance/bin/prio-run.mjs --write --state-dir <state-dir>
```

### 配置项

状态目录沿用 prio-sync，默认是当前用户主目录下的 `acceptance/tools/.prio`。测试和验收机都用 `--state-dir` 指到自己的目录。

| 文件或参数 | 作用 |
|---|---|
| `--max-per-tick N` 或 `<state-dir>/run.json` 的 `maxPerTick` | 每拍最多写入几条。默认 10。0、负数、非整数、大于 1000 都在读令牌之前报错，信息里有期望和实际值 |
| `--only-field 优先级` 或 `--only-field "关联 PR"` | 只让这一个字段进写闸。取值只认这两个（源码里的 `ONLY_FIELD_NAMES`），精确相等：不 trim、不折大小写，也不接受多值；未知值、空值、重复出现、取值位置是另一个 `--` 参数，都在读令牌和联网之前报错，信息里有允许取值和实际值。不带时行为不变（关联 PR 仍不写）。带「关联 PR」时 link 才走写闸，仍受逐条回读、停写开关、每小时 50 条约束；此时优先级侧的降级/改空本拍不写、不触发停写（降级告警由不带该参数的那一段 cron 负责，run 日志记一行排除计数）。和 `--only-empty-to-p2` 同时给会报错（「--only-empty-to-p2 不能和 --only-field 同用」，读令牌前退出） |
| `<state-dir>/changes.jsonl` | 每小时上限的计数依据。滚动 1 小时内最多 50 条（`PRIO_HOURLY_MAX`）。第 51 条不写，并自动停写 |
| `<state-dir>/authorized-repos.json` | `--write` 的授权清单。没有这个文件，或者仓名不在里面，该仓只做 dry-run |
| `<state-dir>/disabled` | 停写开关 |
| `<state-dir>/alerts.jsonl` | 告警。也可用 `--alerts-file` 换路径。不推到别处 |
| `--alert-dedupe-hours N` | 同一条告警（同 kind、同文案）多少小时内不重复写，默认 24。只看窗口内的旧行，过了窗口再发生会重新写一条；缺时间或时间不合法的旧行不算。0、负数、小数、非数字在读令牌之前报错，信息里有期望和实际值 |
| `<state-dir>/fail-streak` | 连续多少拍遇到找不到或 5xx。满 3 拍自动停写 |
| `<state-dir>/repo-class.json` | 仓分类，沿用 prio-sync。本入口不改这张表 |

授权清单的格式（仓名用虚构例子；验收机上那 4 个已授权仓写在机器本地的这份文件里，不要写进 git）：

```json
{
  "repos": ["example-org/sample-repo"]
}
```

不在 `repos` 里的仓，即使能解析，持续 `--write` 也只打 dry-run，不调用写入。

### 告警的含义

每条告警是一行 JSON：`ts`、`kind`、`text`。`text` 用大白话，说清发生了什么、有没有影响、要不要人处理。不写令牌、主机名、公司名，也不写被验收仓的全名。

| kind | 什么时候 | 人要做什么 |
|---|---|---|
| `prio-downgrade` | 计划里有一条要把已有优先级改低或改空 | **只拦这一条，没停写**（#248）：这一条没写，同拍其他条目、其他仓照常写，不建 `disabled`。每条一行，文案写 `#号` 和「从哪档到哪档」，不写仓全名（不同仓同号同变更合并成一行）。看完这条，该改就手动改 |
| `prio-out-of-scope` | 计划里有白名单以外的字段，或排除档的仓 | 已停写，这一拍一条都没写。核对字段和分类后再删 `disabled` |
| `prio-readback` | 写入后读回来的值对不上 | 已停写，剩下的没写，没有自动重试。核对看板后再删 `disabled` |
| `prio-hourly` | 滚动 1 小时已经到 50 条，还有下一条要写 | 已停写。确认是不是写得太多，再删 `disabled` |
| `prio-nonempty` | 有「非空 → 别的值」（含升级）或空 → P0/P3 | 没有停写。这些条没写。要改就手动跑 prio-sync |
| `prio-github` | GitHub 返回找不到或 5xx | 这一拍没继续写。不满 3 拍先不用处理，下一拍再试。满 3 拍会停写 |

相同的 `kind` 和 `text` 在去重窗口（`--alert-dedupe-hours`，默认 24 小时）内不重复追加；被拦的降级下一拍还被拦时，窗口内只有第一拍那一行。关联 PR 在没有 `mac-mini-stopped` 时只打印「扣住」，不算告警，也不写。持续 `--write` 不带 `--only-field "关联 PR"` 时不写关联 PR；带上才写，且仍受逐条回读、停写开关和每小时 50 条约束。

### 两段上线检查表

都由 Inspector 逐步审批。本仓库只提供入口和这份检查表，不替人勾。

**第一段：`--dry-run` 至少 24 小时**

- 每条变化都能用日志里的依据解释。
- 单条 24 小时内变化不超过 2 次。
- 结果交给 Inspector 看过，再决定是否开 `--write`。

**第二段：开 `--write` 后 1 小时内**

- 除 Done 和已关闭的 issue 外，看板没有空优先级。已关闭的 issue 程序不打分，这是现行规则。
- 「关联 PR」延迟 p95：Worker 路径不超过 10 秒，兜底路径不超过 90 秒。事件通道未接入前，这一项记为「未接入、不适用」。
- 心跳和轮次正常，验收机 CPU、内存变化小于 5%。
- 1 小时内改动不超过 50 条。

**回滚条件**（满足任一就回滚）

- 误写白名单以外的字段。
- 1 小时内改动超过 50 条。
- 心跳异常。
- p95 超过 90 秒并持续 30 分钟。

**回滚步骤**

1. `touch <state-dir>/disabled`
2. `node watchers/acceptance/bin/prio-sync.mjs --restore <开写时间> --state-dir <state-dir>`
3. 确认 dry-run 的还原清单之后，再加 `--write` 把值改回去。

github-live 的手测（真的看板上跑 24 小时、以及合并后确认没有新的 cron）由 Inspector 在验收机上做。本仓库的测试只覆盖入口、限额、停写和文档里的检查表。

## 14. 额度预算与按真实剩余退避

对应本仓 issue #247。额度是账号级的，本机所有读 GitHub 的组件共用同一枚用户令牌，所以这里只管本机一侧：每个组件一份预算、看板每拍只读一次、剩余额度只看响应头。

### 判定依据

只看最近一次只读 GraphQL 响应头 `x-ratelimit-remaining` 与 `x-ratelimit-reset`，**不看** `rate_limit` 表（实测表里能多报几千分）。响应头由 `bin/github.mjs` 的只读通道带回（`gh api graphql --include` 或 `fetch` 响应对象），组件身份标记一起记。

阈值常量集中写在 `watchers/acceptance/bin/rate-budget.mjs`，数值只有两档，严格小于才生效：

| 剩余额度 | 动作 |
|---|---|
| `remaining < 1500` | 这一拍跳过看板读（整板查询一次都不发），其余非必要读照跑 |
| `remaining < 800` | 这一拍全面暂停非必要读，只保留主循环 poll |
| 恰好 1500 / 800 | 不触发该档（严格小于） |
| 响应头缺失或不是数字 | 写一行 `rate-unknown`，不跳过、不暂停，不拿另一枚令牌的数顶替 |
| 响应头缺字段（读失败没有头块、502 页面、App 令牌回落） | 一条都不记：不拿空值覆盖上一次的有效剩余 |

过了 `x-ratelimit-reset` 之后进入限速恢复期：默认「重置后前 5 分钟」，恢复期内每拍最多 1 次非必要读，多个消费方按 `loop` → `prio-run` → `board-live` 的顺序轮转，不在重置瞬间集中补扫。恢复期结束后，本轮剩余以新窗口的实际响应头为准；新窗口还没拿到响应头时写 `rate-unknown`，不沿用旧窗口的暂停状态。

### 预算配置

必填文件 `<home>/config/rate-budget.json`（`rate-budget.mjs` 的 `readBudgetFile`），缺项、非整数、非正数都报可诊断错误，不按默认值猜：

```json
{
  "rateBudget": {
    "loop": 500,
    "prio-run": 300,
    "board-live": 140
  }
}
```

单位是这一小时的额度点数。`loop` 只记非必要读（修正轮发现、卡住检查等，一次请求 6 点），`prio-run` 一次整板读按 8 点记，`board-live` 按 REST 请求数记（它主要走 App 安装令牌的独立额度）。主循环每拍盘点（`purpose: 'essential'` 的 poll）按「响应头个数 × 6 点」记进 `components.poll`，**不计入** `loop` 的 500 点预算，也不占用另外两个组件的预算。三个值都是保守值，按 #247「待定」项取：主循环改后实测约 500 点/小时、prio-run 沿用 300、仓外看板组件落在用户令牌上约 140 请求/小时。超预算只有该组件自己跳过，同一小时里别的组件照常跑。注意「跳过」的粒度不是一拍：`used` 只增不减、UTC 整点才切窗，所以某个组件一旦在这一小时里超了预算，这一小时**剩余所有拍**它都不再做那一读（不是只丢刚才那一拍）；跨过 5 拍时写一条 `rate-skip-escalate` 提醒（同一段连跳只写一条：越过阈值后继续跳过不再重复提醒，恢复放行或切窗清零后重新计），见本节末尾。

**预算闸只约束非必要读**：`purpose: 'essential'`（只有主循环 poll）直接放行，越预算照跑——拦它会把这一小时剩下的 poll 连同心跳之外的 abort / 派发一起停掉，而心跳仍是 `ok: true`（复审报的 P1）。poll 的点数记在 `components.poll`，不进 `loop.used`，所以盘点本身不会把 `loop` 的 500 点顶满。`loop` 超预算的判定口径是本小时 `loop.used + 本拍 cost + reserve > 500` 才跳过非必要读，刚好等于 500 不跳。响应头闸的 `< 800` 一档同样只暂停非必要读，`essential` 不拦，两处口径一致。`prio-run` / `event-run` 仍记 `prio-run` 这一格，计费口径不变。

配置缺了或值不对时：`prio-run` 打一行「额度预算配置无法使用：…」并只走响应头闸；主循环把原因写进心跳的 `lastTick.rateBudgetError`，同样不猜默认值。

### 状态文件（按令牌分开）

`<home>/state/host/rate-budget.json`。`identities` 下每个令牌一格（`user` 账号令牌、`app` App 安装令牌），各记 `remaining` / `remainingRaw` / `reset` / `at` / `source`，互相不覆盖；某一枚没有记录时按缺头处理（`rate-unknown`）。`components` 下是各组件本小时（UTC 整点切窗）的 `used`，另有可选的 `components.poll`（主循环盘点用量；老格式文件没有这一项时按 0 读，不清空既有计数），`recovery` 是当前恢复期的轮转位置，`skips` 是连续「因额度跳过」的拍数：`skips.byKey` 按「组件:用途」分开数（判定连跳用这个），每一项记 `count`（连跳的**拍**数）、`lastAt`、`lastTick`（这一拍已经计过数，同一拍再判只算一拍）、`escalated`（这一段连跳已经提醒过，不再重复）、`reason`；`skips.count` 是**最近一次判定那个 key** 的连跳数，随判定顺序变化，外部要读连跳请看 `byKey`。

### 看板快照（每拍只整板读一次）

`<home>/state/host/board-snapshot.json`，由 `prio-run` 每拍开头写一次，字段固定为 `version`（状态格式版本，当前是 1）、`at`（抓取时间，ISO）、`items`、`excludedCount`、`nullContent`。同一拍里 dry-run、`--write` 和仓外看板读者共用这一份，不再各自发整板查询；PR 搜索不属于快照，照旧每次都拉。

读者只有两条路：`at` 距今不超过一个拍间隔（默认 180 秒）就直接用；过了就**重拉一次并覆盖**（`prio-run` 走这条），或者报「快照过期」不用（仓外读者走这条）。读接口是 `rate-budget.mjs` 的 `readBoardSnapshot`，返回 `{ok, reason, at, ageMs, items, excludedCount, nullContent}`，`reason` 是 `missing` / `stale` / `corrupt` / `clock-skew`。不许静默用旧数据。`ageMs` 为负（墙钟往回跳）按 `clock-skew` 处理：旧快照不能用，等下一拍重拉。快照里的 `items` 是抓取那一刻按 `repo-class.json` 分档过滤后的结果；拍内改分类表不影响这一份快照（下一拍重拉时生效）。用到快照的那一拍不按整板读记点数（真发请求时才记 8 点）。主循环的认领排序（4 节「认领顺序」）也是这条路的读者：只用这一份快照的「优先级」，不重拉、不额外发请求；快照不能用时按 `P2` 排并发一行 `queue-priority-fallback`。

### 日志行

跳过、缺头、重置恢复都写一行到 `state/host/loop.log`（`prio-run` 写自己的 `run-YYYY-MM-DD.log`），键值格式与「资源门」一致，统计用 `grep`：

```
<UTC 时间> rate-skip component=prio-run identity=user remaining=1400 action=remaining-below-1500 因额度跳过
<UTC 时间> rate-skip component=loop identity=user remaining=unknown action=over-budget budget=500 used=498 cost=6 因额度跳过
<UTC 时间> rate-unknown component=loop identity=app remaining=unknown raw=（缺失） reason=no-record 响应头缺失或不合法，本拍不跳过
<UTC 时间> rate-recovery component=loop identity=user remaining=438 resetAt=2026-11-03T19:07:00.000Z 重置后限速恢复：每拍最多 1 次非必要读
<UTC 时间> rate-poll component=poll used=42 cost=6 hourKey=15700 本小时 poll 用量（不计入 loop 预算）
```

`rate-poll` 是主循环每拍盘点记账后写的一行，只报告 `components.poll`，不表示跳过。doctor 的「poll 小时用量」一项读同一格，缺项或老格式按 0 计，这项本身不是红灯。

连续「因额度跳过」超过 5 拍（N=5）时行尾再带 `streak=<拍数>`，仍然只跳过、不抛错；连跳节数按「组件 + 用途」分开数（`skips.byKey`），同一拍里 `essential` 放行不会把非必要读的连跳清零，同一拍里同一个 key 判两次（`loop` 的修正轮发现 + 卡住检查）也只算一拍。跨过 5 拍时写一条 `rate-skip-escalate` 提醒（带 `count`、`component`），只写这一条：越过阈值后继续跳过不再重复写，恢复放行或切窗清零后重新计；心跳 `ok` 一直是 true，光看心跳发现不了「整小时没在推进」。

限流被识别出来（403 带 rate limit 文案、429、GraphQL 的 `RATE_LIMITED` 错误码）时：`poll.mjs` 以退出码 75 收尾；修正轮发现和卡住检查遇限流时那一段直接跳过。两种情况都记 `lastTick.rateSkipped = github-rate-limited`（具体哪一段看同一条心跳里的 `rateSkippedStage`），不写 `tick-failed` / `prbot-tick-failed`、不触发看门狗停循环。跳过的原因只有一个字段名 `rateSkipped`（不再另写 `skipped`），取值是 `over-budget` / `remaining-below-800` / `remaining-below-1500` / `recovery-turn` / `github-rate-limited` 之一。

额度判定自己出错（状态文件读不出、写不下去）时：这一拍照常跑（放行），原因写进心跳的 `lastTick.rateGateError`，并在 `loop.log` 写一行 `rate-unknown … reason=rate-gate-error`——不静默 fail-open。`prio-run` 同一口径：判定或写状态出错就放行，写一行 `rate-unknown component=prio-run … reason=rate-gate-error` 到它自己的 `run-YYYY-MM-DD.log`，返回值里带 `gateError`；看板快照写不下去（位置被目录占着、磁盘满、权限不对）也不挡这一拍，写一行 `board-snapshot-error component=prio-run reason=write-failed` 并带 `snapshotError`，这一拍用的是刚拉到的数据。

### 心跳年龄阈值

一拍的心跳时刻是「拍尾写 → sleep(拍间隔) → 下一拍 node 启动后才写」，所以「一个拍间隔」正好压在边界上。`bin/doctor.mjs` 的「常驻循环」和 `host/ensure.sh` 都按**心跳里的 `tickIntervalS` + 60 秒余量**判（默认 180 秒拍 → 240 秒上限），不写死 180000 ms；`tickIntervalS` 缺失时按默认 180 秒算。

上限不能由心跳内容无限放大：`tickIntervalS` 只认 **1..3600 的整数**（JSON 数字，字符串不算）。缺失、`null`、0、负数、非整数、非数字、字符串、超过 3600 一律回落默认 180 秒（上限 240 秒），doctor 的明细会写明「心跳里的 tickIntervalS=… 不可用，按默认拍间隔 180 秒算」。写入侧 `host/loop` / `host/tick.mjs` 先用同一档上界夹一次（`ACCEPTANCE_TICK_SECONDS` 是 `abc` / `0` / `180000` 都按 180 秒睡、按 180 秒写），读取侧 `bin/doctor.mjs` 与 `host/ensure.sh` 再用同一把尺判。不这样夹的话，一个误填的毫秒数（`180000`）会让心跳上限变成 50 小时、`86400` 会变成一天，看门狗在 pid 还活着这条分支上完全不判，而且没有任何告警。

## 15. 部署定时自检（#367）

部署靠一条规范化 crontab 条目按固定节拍拉起部署脚本。系统 crontab 不在仓里（仓里只有重启后恢复用的模板 `watchers/acceptance/crontab.template`，见第 16 节），被删、被注释、被改坏时验收机的其它检查只会说「部署落后 N 个提交」，读起来像在等空档或等批准。这一节的自检只做一件事：**只读核对那条条目，发现问题只告警，不写 cron、不修 cron、不动其它条目。**

它核对的边界：

- **缺失**：没有任何目标条目（文案会带实际行数与匹配数）。
- **被注释**：只剩注释掉的那一条。
- **重复**：有效条目出现两条以上。
- **读取失败**：`crontab -l` 退出码非 0 且 stderr 不是确定的 `no crontab for <用户>`。这种情况**不当缺失**：判断不了就说判断不了。
- **节拍不对**：分钟字段没覆盖每个小时，或相邻两拍间隔超过 5 分钟（小时/日/月/周字段必须是通配）。
- **参数不对**：七个必填参数（`--deploy-dir`、`--host-state`、`--self-lock`、`--prio-lock`、`--state-file`、`--alerts`、`--doctor-script`）缺项、取值与约定不一致，或解释器不可执行。
- **无法核实**：写法不在规范化结构里（变量拼接、认不出的节拍语法等）。这一项明确不等于缺失。

口径是最小校验，不是通用 shell 解析器：只按现有条目的形状取「脚本路径 token + 七个参数 + 节拍字段」，遇到不认识的形式就报无法核实，不去猜。

节奏：

- 首次就是正常：**不写任何东西**。
- 同一情形（同一分类、同一错法）只告警一次；分类或错法变了会再告警一次，不会被永久吞掉。无关的 cron 行、排序、行数变化不会让它重复报。
- 只有真的从异常回到正常，才写一次恢复通知。

示例（在仓根执行；路径与参数换成该机实际值）。先把 `crontab -l` 的输出、退出码、stderr 各自落到临时文件，再显式传进去——管道会把 `crontab` 的退出码换成下游进程的，`$?` 拿到的不是它：

```sh
tmpdir=$(mktemp -d) || exit 1
trap 'rm -rf "$tmpdir"' EXIT
crontab -l >"$tmpdir/crontab.txt" 2>"$tmpdir/crontab.err"
rc=$?

node watchers/acceptance/bin/deploy-cron-selfcheck.mjs --home <验收机 home> \
  --crontab-file "$tmpdir/crontab.txt" --exit-code "$rc" --stderr-text "$(cat "$tmpdir/crontab.err")" \
  --expect-script <部署脚本绝对路径> \
  --expect-arg --deploy-dir=<部署目录> --expect-arg --host-state=<宿主状态目录> \
  --expect-arg --self-lock=<自锁文件> --expect-arg --prio-lock=<优先级锁文件> \
  --expect-arg --state-file=<状态文件> --expect-arg --alerts=<告警文件> \
  --expect-arg --doctor-script=<体检脚本>
```

`--exit-code` 必须给（读取成功就写 0）：缺了它自检判「读不出 crontab」并告警，**不默认成 0**。否则权限、spool 之类的读失败会被误判成「条目缺失」，人照着处置建议补一条，反而补出重复条目。

告警只追加到宿主告警文件（复用 `host/paths.mjs` 的 `appendAlert`，字段过脱敏），不推送到别处。文案讲三件事：发生了什么、影响什么、要不要人处理。

**接线上线（仓外，人工步骤，不由本仓 PR 覆盖）**：把上面这条命令挂到 `run-ensure` 里（在它 `exec` 之前调用，`exec` 之后没有机会），由既有调用方负责调用频率；上线后要人工核实至少一小时被真实触发一次。本仓的测试只覆盖隔离环境（临时 home + 假 `crontab` 命令），不接触真实 crontab。

回滚分两层，互不牵连：

- 代码回滚：撤掉本节的三个文件改动——删掉 `watchers/acceptance/bin/deploy-cron-selfcheck.mjs` 与 `watchers/acceptance/deploy-cron-selfcheck.test.mjs`，**只撤掉这一节**，不要删整份运维文档，也不要动其它章节。
- 接线回滚：如果已经按上面的步骤挂到 `run-ensure`，删掉那一行调用即可。自检只读、不写 cron，不需要还原任何系统状态。

状态文件在宿主状态目录下的 `deploy-cron-selfcheck.json`，删掉后下一次会按「首次」处理（正常就静默）。

## 16. 重启后恢复 crontab

2026-11-11 17:14（北京）机器重启后验收机的用户 crontab 被清空，deploy-ff 停了约 1 小时，靠人工补装。仓里的 `watchers/acceptance/crontab.template` 是恢复依据，只含**验收机自己**的 5 条生效条目，每条上方有一行中文注释说明它干什么。

模板口径：

- 5 条各是什么：deploy-ff 每 5 分钟一拍（带 `--approval-file`）；prio 看板持续写入 `run.sh` 在 24、54 分；关联 PR 持续写入 `run-field.sh` 在 9、39 分；event-run 拉起脚本的 `@reboot` 一条与每分钟一条。
- 路径一律写 `$HOME`，不写死本机家目录、主机名、令牌。cron 执行条目时会把 `$HOME` 设成该用户的家目录，所以模板里的 `$HOME` 可以直接用，也用 `$HOME` **保持原样**直接交给 `crontab`，不要用 `sed` 展开成绝对路径——展开了就把本机路径写死，换机或改用户名后模板就错了。
- 以后新增条目时，命令里的 `%` 必须转义成 `\%`（现有 5 条都不含 `%`）。
- 别的 bot（pi-cron、ops-lane 等）的条目不属于验收机，仓外另管，不要写进模板。

模板本身先校验一遍（只读：只读模板文件，不读系统 crontab、不写任何文件）：

```sh
node watchers/acceptance/bin/crontab-template-check.mjs
```

它查五件事：5 条生效条目都在且每条上方有注释、deploy-ff 带 `--approval-file`、没有写死的用户家目录绝对路径（一律要写 `$HOME`）、没有疑似令牌、没有重复条目。退出码 0 = 通过，非 0 = 不通过并逐条打印原因。

恢复步骤（**人工步骤，不由本仓任何 PR 接线**；本仓不装 cron、不写 cron、不改系统状态）：

1. 先确认是「真的没有 crontab」，不是读失败。退出码与 stderr 分开落文件，不经管道（管道会把 `crontab` 的退出码换掉）：

```sh
crontab -l >/tmp/crontab.now 2>/tmp/crontab.err; echo "rc=$?"; cat /tmp/crontab.err
```

只有退出码非 0 且 stderr 是整段 `no crontab for <用户>` 时才按本节装。退出码非 0 但 stderr 另有内容（权限、spool 之类）按读取失败处理，先查原因。

2. 装之前先备份现有内容（当前为空时这条会失败，属正常）：

```sh
crontab -l >"$HOME/crontab.backup.$(date +%Y%m%dT%H%M%SZ)"
```

3. **已有非空 crontab 就不覆盖**：把 `crontab -l` 的输出与模板逐行比对，差异先人工确认。模板只写验收机自己的 5 条，直接 `crontab <模板>` 会连带丢掉别的 bot 的条目。

4. 确认是空的、且模板校验通过，再装（在 vigil 仓根执行，`$HOME` 保持原样）：

```sh
node watchers/acceptance/bin/crontab-template-check.mjs || exit 1
crontab watchers/acceptance/crontab.template
crontab -l | diff - watchers/acceptance/crontab.template && echo "装好了，与模板一致"
```

5. 盯一拍：下一个 5 分钟拍里 deploy-ff 日志有新行；`deploy-cron-selfcheck` 不再告警；event-run 的轮询在 1 分钟内被拉起来。

6. 仓外条目补装：别的 bot 的条目仓外另管，不在本仓的模板里，也不由本仓的 PR 负责。

回滚：装错了用备份盖回去（`crontab <备份文件>`）。装之前本来就是空、也没有备份的，`crontab -r` 回到没有 crontab 的状态。

本节边界：只提供模板和人工操作步骤。模板不被任何脚本读取，也没有任何自动化按它写 cron；本仓的测试只校验模板文本与本节措辞，不接触真实 crontab。
