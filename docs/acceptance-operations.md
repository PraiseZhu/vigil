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
| 模型 | `host/round.mjs` + `<home>/config/host.json` | pi 用 **DeepSeek V4.1 Flash**，推理 **max**；有争议条目的裁决运行用 `anthropic/claude-opus-5-5`，推理 **medium** |
| 卡住 | `host/tick.mjs`、`host/round.mjs` | `round.mjs status` 报卡住时**先结束进程，再 `round.mjs abort`** |
| 提醒 | `state/host/alerts.jsonl` | 本 issue 只**发现**并写文件，不调 Slack（见第 7 节） |

`<home>/config/host.json` 至少要有 `piCommand`（消息从标准输入喂给它）：

```json
{
  "piCommand": ["pi", "--model", "<model id>", "--thinking", "max"],
  "credentialDirs": ["<可选：额外要遮罩的绝对目录>"]
}
```

未知键一律忽略；写 `"sandbox": false` 或 `"noSandbox": true` **没有任何作用**——沙箱只有一条路。

### 模型

- 验收轮：pi 用 DeepSeek V4.1 Flash，推理 max（写进 `piCommand`）。
- 有争议条目的裁决运行：`anthropic/claude-opus-5-5`，推理 medium。
  **待实现**：本 issue 只把规则写进文档和调度约定；裁决运行本身和 #60（修正轮）共用同一套流程，
  代码还没写（归 #60）。现在 `round.mjs status --json` 的 `disputed` 只会被记下来。

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

宿主这边的 `profile.json` 里把 `writeCommand` 指到写闸的 exec 用法（`doctor` 的探测和看板写回走它）：

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

- pi 起来之后宿主出错（查进度失败等）：先结束 pi（SIGTERM，宽限期后 SIGKILL），再 `abort`
  （原因「宿主出错：…」，提醒 `round-failed`），最后才收写闸。
- bwrap 不在、探针失败、参数拼不出来 → 不跑模型，这一轮 `abort` 成「中断」（原因「沙箱起不来：…」），
  并写一条提醒（`sandbox-unavailable`）。
- **没有任何环境变量或配置项能关掉沙箱**（`PI_NO_SANDBOX`、`ACCEPTANCE_NO_SANDBOX`、`host.json` 的
  `sandbox`/`noSandbox` 都无效）：代码里根本没有「不套 bwrap 跑 pi」这条路径。
- 只传白名单环境变量：`PATH`、`HOME`、`LANG`、`TZ`、`TERM`、`TMPDIR`、`LLM_PROXY_API_KEY`、
  `NODE_OPTIONS`，外加两个沙箱内部变量（`ACCEPTANCE_WATCHER_HOME`、`ACCEPTANCE_GATE_SOCKET`，
  都指向沙箱内的路径）。`HOME` 和 `TMPDIR` 每轮新开。
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
- `profile.stateDir` 或 `worktreeDir` 与 `<home>/state` 相互包含、或遮罩文件落在可写绑定里，
  直接拒绝（起不来）。

## 5. 提醒与通知的分工

本 issue 的提醒只**发现**：调度循环停摆、轮次卡住或卡死、写闸拒绝、扫到密钥、沙箱起不来，
一行一条写进 `state/host/alerts.jsonl`（`ts`、`kind`、`issue`、`round`、`reason`、`detail`）。
**不调 Slack。**

- 发 Slack 归 #61：Slack app 显示为 Jasper，发到 `#praise-automation-dashboard`；
  修正 PR 已 Ready 的消息只带「打开 PR」链接。怎么配频道、令牌、哪些事件立即发、哪些进摘要，
  见 [`docs/acceptance-slack.md`](acceptance-slack.md)。
- **验收结论不发通知**：通过/要修、中断都只在 GitHub 的轮次评论和看板里。

常见 `kind`：`loop-restarted`、`tick-failed`、`round-stale`、`round-stalled`、`sandbox-unavailable`、
`gate-unavailable`、`gate-rejected`、`secret-found`、`write-rejected`。

## 6. 上线顺序

1. **写配置**：`<home>/config/profile.json`（照 [`config/examples/acceptance.profile.example.json`](../config/examples/acceptance.profile.example.json)）
   和 `<home>/config/host.json`（`piCommand`）；令牌文件放好、`chmod 600`。
   **`state/write-gate/enabled` 先不要建**（总开关关着）。
2. **跑部署检查**：

   ```sh
   ACCEPTANCE_WATCHER_HOME=<home> node watchers/acceptance/bin/doctor.mjs --board-item <owner/repo#n>
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

   写闸总开关关着时这一轮会被拒（`write-rejected`），看提醒和日志确认链路通。
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
- `写闸探针（仓外）`：名单外的仓必须返回 4。
- `看板`：能读 `projectV2(projectNumber)`。
- `看板写回`：需要 `--board-item <owner/repo#n>`；读该条目的「裁决」原值再写回同一个值，缺这个
  参数就报失败。
- `fork 推送`：`forkRepos` 里每个仓在 `ownerLogin` 名下都存在且 `viewerPermission` 是
  `ADMIN`/`MAINTAIN`/`WRITE`。
- `常驻循环`：心跳里的 pid 活着且心跳不超过 3 分钟。
- `令牌文件`：`…TokenFile` / App 私钥文件全部通过 600、属主当前用户、非空检查。
- `bwrap 遮罩`：在 bwrap 里跑一个读文件的小脚本，名单上的文件和凭证目录必须一个都读不到；
  bwrap 不可用算失败。

## 9. 组织仓的开关

- 我确认组织允许代码进这台盒子之前，**不把组织仓加进 `autoRepos`**。
- 加进去之后的第一轮，要我在场看着跑（看 `pi.log`、`alerts.jsonl`、轮次评论）。
- 2026-10-24 已确认：组织仓代码可以检出到这台盒子；加仓仍然按上面两条来。

## 10. 排障

| 现象 | 先看 | 处理 |
|---|---|---|
| 心跳不更新 | `state/host/heartbeat.json` 的 `at`/`lastTick.error` | 跑 `ensure.sh`；还不行看 `loop.log`，`stop.sh` 后重起 |
| 轮次一直「验收中」 | `round.mjs status --issue <ref> --json` 的 `stalled` | 等调度先杀进程再 abort；要手动就 `abort --reason` |
| 所有写都被拒 | `alerts.jsonl` 的 `gate-rejected` | 看 `reason`：`gate-disabled` → 建开关文件；`not-current-round` → 轮次已结束 |
| `sandbox-unavailable` | `pi.log`、`gate.log` | `bwrap --ro-bind / / true` 跑一下；参数拼错看 detail |
| `secret-found` | 提醒里的 `reason`（只有文件名） | 按 #46 SC7 记「需人工处理」，别自己推 |
| `tick-failed` | `heartbeat.lastTick.error` | 多半是 `poll.mjs` 或配置报错，跑一次 `poll.mjs --json` 看 |
