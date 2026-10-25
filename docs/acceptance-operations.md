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
| 常驻调度 | `watchers/acceptance/host/loop` | 单实例（flock），**每分钟**跑一拍 `host/tick.mjs`，顺序照 `docs/acceptance-scheduler.md` |
| 每小时巡检 | `watchers/acceptance/host/ensure.sh` | 给每小时一次的 routine 调用：心跳不超过 180 秒就不做事，否则把 `loop` 拉起来并写一条提醒 |
| 资源门 | `host/round.mjs` | 认领**之前**过内存门（MemAvailable ≥ 3 GiB）和测试锁（mivo 同时只跑一轮）；最多 2 轮同时跑 |
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
  "egressAllow": ["github.com:443", "codeload.github.com:443", "<LLM 网关 host>:443"],
  "maxRoundMinutes": 120,
  "adjudicateCommand": ["pi", "--model", "anthropic/claude-opus-5-5", "--thinking", "medium"],
  "adjudicateMaxMinutes": 30,
  "slackDailyCap": 30
}
```

`adjudicateCommand` / `adjudicateMaxMinutes` 见下面「模型」；`slackDailyCap` 见
[`docs/acceptance-slack.md`](acceptance-slack.md) 第 5 节。

`egressAllow` 是沙箱**唯一**能出网的名单（见第 4 节「网络」）：只写 `host:port`（小写，不认通配、不认 URL），
LLM 网关的 host 取 pi 的 `models.json` 里 `baseUrl` 的主机名；`git clone https://github.com/<公开仓>`
要 `github.com:443` 和 `codeload.github.com:443`。**不配就是空名单，pi 连不上模型网关，这一轮跑不起来。**
写错（通配、URL、缺端口）整轮直接起不来，不会悄悄放宽。

`maxRoundMinutes` 可选：一轮的总时长上限（分钟，宿主墙钟，从认领算起），缺了或不是正数按 120。

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
  `githubTokenFile` 换成占位文件，`appConfigPath` 和所有 `…TokenFile` 键删掉。
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

### 轮次生命周期

- **卡住**以宿主观察到的活动为准：宿主每个查进度的间隔看一次 `pi.log` 有没有长，并经一层转发 socket 数本轮写闸请求
  （沙箱里看到的 `<roundDir>/gate/gate.sock` 是宿主这一层，原样转给 `state/host/gates/` 下的写闸 serve，放行与否仍只由写闸决定）。
  有活动就刷新 `state/host/progress/<owner>__<repo>__<issue 号>__<轮次>.json`。超过 `stallMinutes` 没有活动：先结束 pi，
  再 `abort`（原因「卡住：超过 stallMinutes 没有进度」），提醒 `round-stalled`。`stateDir` 里模型写的 `lastProgressAt`
  只作参考，延不了期；tick 的卡死判定（`poll` 的 `stale`）用的也是这份宿主时间。
- **pi 退出**（任何退出码）：立即回读本轮状态。还是第 n 轮「验收中」→ `abort`（原因「pi 退出（code=…）但没写裁决」），
  提醒 `round-failed`；已是终态 → 正常收尾。
- **裁决写完 pi 不退**：宽限 2 分钟后先 SIGTERM、再 SIGKILL，收尾，不改裁决。
- **总时长上限**：从认领算起超过 `maxRoundMinutes`（默认 120）→ 停 pi、`abort`（原因「超过总时长上限（N 分钟）」），
  提醒 `round-timeout`。pi 一直有输出也逃不过这一条。

## 5. 提醒与通知的分工

本 issue 的提醒只**发现**：调度循环停摆、轮次卡住或卡死、写闸拒绝、扫到密钥、沙箱起不来，
一行一条写进 `state/host/alerts.jsonl`（`ts`、`kind`、`issue`、`round`、`reason`、`detail`）。
**不调 Slack。**

- 发 Slack 归 #61：Slack app 显示为 Jasper，发到 profile 的 `slackChannelId` 指的那个频道（频道名不写进仓库）；
  修正 PR 已 Ready 的消息只带「打开 PR」链接。怎么配频道、令牌、哪些事件立即发、哪些进摘要，
  见 [`docs/acceptance-slack.md`](acceptance-slack.md)。
- **验收结论不发通知**：通过/要修、中断都只在 GitHub 的轮次评论和看板里。

常见 `kind`：`loop-restarted`、`tick-failed`、`round-stale`、`round-stalled`、`round-failed`、`round-timeout`、
`prefetch-failed`、`sandbox-down`、`sandbox-unavailable`、`gate-unavailable`、`gate-rejected`、`secret-found`、`write-rejected`、`egress-denied`；裁决运行的
`adjudicate-failed`、`adjudicate-timeout`、`adjudicate-needs-human`、`adjudicate-not-configured`；
Slack 自己的 `slack-failed`（重试用完）、`slack-history-failed`（读频道历史失败）。

## 6. 上线顺序

1. **写配置**：`<home>/config/profile.json`（照 [`config/examples/acceptance.profile.example.json`](../config/examples/acceptance.profile.example.json)）
   和 `<home>/config/host.json`（`piCommand`）；令牌文件放好、`chmod 600`。
   **`state/write-gate/enabled` 先不要建**（总开关关着）。
2. **跑部署检查**：

   ```sh
   ACCEPTANCE_WATCHER_HOME=<home> node watchers/acceptance/bin/doctor.mjs
   ```

   逐项 `✓`/`✗`，缺哪项改哪项；全 `✓` 才继续。检查项见第 8 节。
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
6. **打开总开关，让常驻循环每分钟调度**：

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
- `常驻循环`：心跳里的 pid 活着且心跳不超过 3 分钟。
- `令牌文件`：`…TokenFile` / App 私钥文件全部通过 600、属主当前用户、非空检查。
- `Slack 频道`：只读——bot 令牌能过 `auth.test`，bot 在 `slackChannelId` 那个频道里（`conversations.info`
  的 `is_member`；令牌没有 `channels:read` / `groups:read` 就退到 `conversations.history limit=1`，bot 不在频道里
  会报 `not_in_channel`）。不发任何消息；没配 `slackChannelId` 就跳过（算通过）。
- `bwrap 遮罩`：在 bwrap 里跑一个读文件的小脚本，名单上的文件和凭证目录必须一个都读不到；
  bwrap 不可用算失败。遮罩名单按 `<home>/config/host.json` 算（`credentialDirs` 也遮），并且先查
  `credentialDirs` / `homeAllowDirs` 每一项都存在、不与可写绑定（`stateDir`、`worktreeDir`）互相包含。

## 9. 组织仓的开关

- 我确认组织允许代码进这台盒子之前，**不把组织仓加进 `autoRepos`**。
- 加进去之后的第一轮，要我在场看着跑（看 `pi.log`、`alerts.jsonl`、轮次评论）。
- 2026-10-24 已确认：组织仓代码可以检出到这台盒子；加仓仍然按上面两条来。

## 10. 排障

| 现象 | 先看 | 处理 |
|---|---|---|
| 心跳不更新 | `state/host/heartbeat.json` 的 `at`/`lastTick.error` | 跑 `ensure.sh`；还不行看 `loop.log`，`stop.sh` 后重起 |
| 轮次一直「验收中」 | `state/host/progress/` 里这一轮的 `lastActivityAt`（`round.mjs status` 的 `stalled` 按模型写的时间算，只作参考） | 等调度先杀进程再 abort；要手动就 `abort --reason` |
| `prefetch-failed` | 提醒的 `reason`（哪个仓）、`state/prbot/mirrors/acceptance__*` | 多半是令牌看不到这个仓或网络问题；`doctor` 的「仓可读」先过 |
| `sandbox-down` | `bwrap --ro-bind / / true` | 修好 bwrap 之前不会认领；提醒一小时一条 |
| 所有写都被拒 | `alerts.jsonl` 的 `gate-rejected` | 看 `reason`：`gate-disabled` → 建开关文件；`not-current-round` → 轮次已结束 |
| `sandbox-unavailable` | `pi.log`、`gate.log` | `bwrap --ro-bind / / true` 跑一下；参数拼错看 detail（含 `egressAllow` 写法不对） |
| `egress-denied` | 提醒里的 `reason`（被拒的 `host:port`）和 `detail`（`not-allowed` / `not-connect` / `blocked-address`） | 该放行就把 `host:port` 加进 `host.json` 的 `egressAllow`；不该放行的说明模型在往外连别处，看 `pi.log` |
| pi 连不上模型网关 | `pi.log`、`alerts.jsonl` 的 `egress-denied` | `egressAllow` 里要有 `models.json` 的 `baseUrl` 主机名 `:443` |
| `secret-found` | 提醒里的 `reason`（只有文件名） | 按 #46 SC7 记「需人工处理」，别自己推 |
| `tick-failed` | `heartbeat.lastTick.error` | 多半是 `poll.mjs` 或配置报错，跑一次 `poll.mjs --json` 看 |
| 任务一直不再验（最近裁决有「有争议」） | `poll.mjs --json` 的 `adjudicate` 条目、`state/host/adjudications/runs/` | 没配 `adjudicateCommand` 就补上；`adjudicate-needs-human` 后要人工裁决 |
| `adjudicate-timeout` / `adjudicate-failed` | `<home>/run/adj-*/pi.log`、`out.log` | 会自动重试（最多 3 次）；输出不合格多半是 pi 没按单行 JSON 收尾 |
