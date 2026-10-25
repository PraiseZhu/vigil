# 验收线与修正轮的 Slack 通知

对应本仓 issue #61。本文档写清谁能发、发到哪、发什么、不发什么，以及以后要不要加「合并」按钮。

相关文档：

- [`docs/acceptance-operations.md`](acceptance-operations.md)：宿主接入、写闸、提醒分工（第 5 节）。
- [`docs/acceptance-prbot.md`](acceptance-prbot.md)：修正轮的事件流（`state/prbot/events.jsonl`，本功能的输入）。
- [`watchers/acceptance/README.md`](../watchers/acceptance/README.md)：profile 的全部配置键。

## 1. 频道和 app

- 用**已经建好**的 Slack app，显示名 **Jasper**。消息全部由它的 bot 发，不经过任何第三方转发。
- 频道 **不写死在代码里**：profile 的 `slackChannelId`（`C` 开头的公开频道、`G` 开头的私有频道组）指到哪就发到哪。
  没配就不发，心跳里写 `not-configured`。
- 可选 `slackMentionUserId`（`U` 开头的大写字母数字）：配了以后**立即发（ping）**的消息开头带 `<@U…>`；
  **摘要永不 @**。
- 代码里没有任何仓名、频道名。占位符写法：`"slackChannelId": "C0123456789"`、`"slackMentionUserId": "U0123456789"`。

用途：验收线和修正轮卡住、能合并、做完了这三种情况在 Slack 上就能看到，不用一直盯 GitHub；
其余零碎动静攒成一条摘要，不刷屏。

## 2. 令牌

- **只用 bot 令牌**，放在这台盒子上的单独文件里，profile 用 `slackBotTokenFile`（绝对路径）指过去。
  文件权限必须**正好 600**、属主是跑验收机的用户、非空。
- **只有 `watchers/acceptance/host/slack-notify.mjs` 读这个文件**。它用
  `O_RDONLY | O_NOFOLLOW` 打开（符号链接直接拒绝），再 `fstat` 检查普通文件、属主、600、非空；
  任一不满足就不发，心跳里写 `token-file-unreadable` / `token-file-mode` / `token-file-empty` 这类原因。
  权限不对（不是 600）时**根本不读**令牌内容：只打开拿 fd 做 `fstat`，检查不过就关掉。
- 令牌文件坏了（权限不对、属主不对、符号链接、空文件、不存在、读不到）**只跳过通知，不让整台验收机停**：
  这一拍的验收调度照常跑，心跳 `slack.reason` 写上面的 `token-file-*` 原因。为此对 #47 的 profile 加载器
  （`bin/profile.mjs`）做了一处小改动：`slackBotTokenFile` 只校验是绝对路径，不再调 `checkSecretFile`
  （那会抛错，profile 加载失败整台机就停）。`githubTokenFile`、App 私钥的检查一字不改；`doctor` 照样把
  坏掉的 Slack 令牌文件报出来；沙箱遮罩不看权限，文件在就遮。
- **不读环境变量**：设了 `ACCEPTANCE_SLACK_BOT_TOKEN` 或 `SLACK_BOT_TOKEN` 也不会用。
- 令牌只出现在 HTTP 的 `Authorization: Bearer` 头里：**不进请求 body、不进日志、不进心跳、不进账本、
  不进异常信息**。本模块也不起子进程，所以令牌不会出现在任何子进程环境里。
- **bwrap 遮住它**：遮罩名单从 profile 算——每个以 `TokenFile` 结尾、`PrivateKeyFile` 结尾或正好是
  `privateKeyFile` 的键一律换成 `/dev/null`，`slackBotTokenFile` 自动在内。沙箱里的模型读不到令牌文件；
  沙箱环境变量白名单里也没有任何 Slack 相关变量。
- **以后要 app-level 令牌**（Socket Mode 收按钮点击时要用）同样放**单独的文件**，键名照样以 `TokenFile`
  结尾（例如 `slackAppTokenFile`）——这样 profile 校验和 bwrap 遮罩不用改代码就生效。**本 issue 不读它**，
  `slack-notify.mjs` 只认 `slackBotTokenFile`。

## 3. Slack app 需要的 scope

| scope | 干什么用 |
|---|---|
| `chat:write` | 发消息（`chat.postMessage`），这是唯一的写操作 |
| `channels:history` | 发到公开频道时要读频道历史（去重账本删了之后靠它重建） |
| `groups:history` | 发到私有频道时同上（私有频道要用这个，不是 `channels:history`） |

为什么需要读历史：账本丢了以后，用 `conversations.history`（`oldest` = `startAt` 的秒数、
`include_all_metadata=true`、按 `cursor` 分页、最多 20 页）把「我们发过的每条消息」的
`metadata.event_payload.ids` 收回来，按这些 id 认为已经发过。只读自己发的消息，不读别人的内容。

## 4. 事件表

`at` / `ts` 早于 profile `startAt` 的事件一律不看。事件 id =
`sha256(来源名 + "\n" + 原始行文本)` 的前 16 位十六进制（来源名 `prbot` / `alerts`）。

| 来源 | 事件 | 处理 |
|---|---|---|
| prbot | `needs-human` | **ping**（被卡住要人处理） |
| prbot | `interrupted-exhausted` | **ping**（重试用完，被卡住） |
| prbot | `ready-stalled` | **ping**（转 Ready 24 小时没人接） |
| prbot | `ready` 且 `handoff: "owner"` | **ping**（可以合并），只带「打开 PR」按钮 |
| prbot | `ready` 且 `handoff: "watcher"` | **ping**（做完了）：写「已交给 Mac mini 盯梢」 |
| prbot | `claimed`、`draft-opened` | **不发** |
| prbot | 未知 type | **忽略** |
| alerts | `secret-found` | **ping**（只列文件名） |
| alerts | `sandbox-unavailable` | **ping**（沙箱起不来） |
| alerts | `round-failed`、`gate-unavailable`、`sandbox-unavailable`、`round-stalled`、`round-stale` | 中断类：第 1 次进摘要（`sandbox-unavailable` 照上一行立即发）；同一 issue **6 小时内第 2 次及以上**合成一条「同一任务连续中断」立即发，每个 issue 每 6 小时窗口只发一次。6 小时按事件自己的时间算（循环停摆后一次补发积压时，隔得久的不算连续） |
| alerts | `gate-rejected`、`write-rejected`、`loop-restarted`、`tick-failed`、`prbot-tick-failed` | **摘要** |
| alerts | 其它未知 kind | **摘要**（未知的也进摘要，不丢） |
| — | 验收结论本身（通过 / 要修 / 中断） | **不发**：只在 GitHub 的轮次评论和看板里 |

摘要攒起来，**最多每 60 分钟**发一条汇总，摘要永不 @。

## 5. 去重、重试和心跳

- 账本 `<home>/state/slack/ledger.json`（目录 700、文件 600、原子写）：记已处理的 id、等摘要的条目、
  6 小时中断窗口、待重试的消息、最终失败的消息。
- 每条发出去的消息都带
  `metadata: { event_type: "vigil_acceptance_notice", event_payload: { ids: [...] } }`。
  账本删掉后靠它重建，同一事件 id 只发一次。
- **重建失败就这一拍不发**，心跳写 `ledger-rebuild-failed`；宁可不发，也不重发。
- 发送失败（网络错、HTTP 非 2xx、`ok:false`、429）按 **1、5、15 分钟**重试，不 sleep：
  下次时间记在账本里，后面几拍再试。第 4 次还失败就放弃，记进账本的 `failed` 并写心跳。
- 每拍在验收调度**之后**、写心跳之前发一次（#70 复审：Slack 卡住不能拖慢验收；这一拍新写的提醒也一起发）。
  结果写在 `state/host/heartbeat.json` 的 `slack` 字段：
  `{ ok, reason?, sent, digested, pending, deferred, failed: [{ id, kind, error }] }`。
  通知出错只进心跳，不影响这一拍的验收调度。
- 扫到密钥的提醒只列文件名（`reason` 里第一个全角冒号后面的那串）；所有发出去的文字都再过一遍
  `bin/redact.mjs`，令牌、私钥、本机路径不会漏出去。
- 事件里的文字（原因、细节、issue 名、文件名）可能来自模型或仓库内容，放进 blocks 和摘要前把 `& < >` 转义，
  `<!channel>`、`<!here>`、`<!subteam^…>`、`<@U…>`、`<https://别处|打开 PR>` 这类写法只会显示成字面文字；
  裸的 `@` 后面再插一个零宽字符，`@channel` / `@here` 也不会变成提醒。仓库名只认 `owner/repo`，
  CI 链接只认 `https://github.com/` 下面的地址。
- 消息的 `text`（手机锁屏 / 通知栏看到的那一行，Slack 也按 mrkdwn 解析）**只用校验过的字段拼**：固定标题、
  合规的 `owner/repo#n`、合规的 PR 链接、数字。原因、细节、文件名、issue 标题一律不进 `text`；
  事件类型只认小写字母、数字和连字符；拼完整行再转义一次兜底。扫到密钥的提醒在 `text` 里只写「N 个文件」。
  「打开 PR」的链接要事件给的 PR 地址里仓库名**和** PR 号都和事件字段对上才用，否则按字段自己拼。
- 每个 Slack 请求最多等 15 秒，超时按发送失败处理（进重试）。
- 一次通知总共最多 30 秒（`NOTIFY_BUDGET_MS`）：每个请求的超时取「15 秒」和「预算还剩多少」里小的那个；
  预算用完就停，没发的重试和到点的摘要原样留到下拍，新事件不记成已处理（下拍重新收），心跳写
  `notify-budget-exhausted`。验收拍这边再兜一层：等满 35 秒（`NOTIFY_WAIT_MS`）就不等了，心跳写
  `notify-timeout`；上一拍的通知还没结束，这一拍不再起新的，心跳写 `notify-busy`（免得两份同时写账本、重发）。

## 6. Ready 消息长什么样

标题「修正 PR 已 Ready：`owner/repo#n`」，字段：任务 issue（总 issue）、修正子 issue、head SHA 前 7 位、
`CI x/y 绿`（有 checks.url 就是链接）、改动文件数和增删行数（`N 个文件 +a −d`）、修了哪几条 SC（`SC3、SC5`）。

- `handoff: "owner"`：只有**一个**按钮，文字「打开 PR」，`url` 是 PR 链接。没有第二个按钮，
  消息里也没有「合并」字样。
- `handoff: "watcher"`：正文写「已交给 Mac mini 盯梢」，**没有按钮**，PR 链接作为文字给在正文里。

PR 链接只接受 `https://github.com/<repo>/pull/<pr>` 这个形状，而且 `repo`/`pr` 必须和事件字段一致；
对不上（伪造的、指向别的仓的、形状不对的）就按事件的 repo+pr 自己拼。

`ready-stalled` 的标题是「修正 PR 转 Ready 24 小时没人接：`owner/repo#n`」，正文写「多半是审查流程不在线
（review-ingress-missing），请看 Mac mini 和审查入口」，并附 PR 链接、转 Ready 时间（`readyAt`）、
head SHA 前 7 位。

## 7. 第一步只有「打开 PR」链接

合并仍然由我在 GitHub 里点：代码里没有 `pr.merge`，写闸的白名单里也没有这个动作。

以后要做「合并」按钮，必须同时满足这些条件才动：

1. 有一个**能合并的** GitHub 令牌（现在只有读写 issue/PR 的账号令牌，够不够另说）。
2. 用 **Socket Mode** 收按钮点击（所以要 app-level 令牌，见第 2 节，放单独文件）。
3. `pr.merge` 只经**写闸 exec** 执行，并且执行前逐条复核：
   - 点击人是我；
   - 仓在我名下、属于 auto 档；
   - PR 带修正标记，且**不是 Draft**；
   - head 等于按钮里带的 SHA；
   - 此刻检查**全绿、可合并**；
   - 按钮发出不超过 **24 小时**；
   - 这条点击的 **nonce 没用过**；
   - `PAUSED` 不存在；
   - 没超过每日合并上限；
   - 执行时带 `--match-head-commit`（头提交变了就不合）；
   - **不用 `--admin`**。

**伪造风险（如实写明）**：写闸的 `exec` 用法不在沙箱里跑——它是宿主上的进程。同一台机器上、同一个用户的
**非沙箱进程**可以自己拼一条动作交给 `write-gate.mjs exec`，从而伪造**一次**点击。上面那些复核
（nonce、24 小时、head 一致、全绿、每日上限）只能把窗口收窄，不能当鉴权用；真正的边界是「谁能在这台盒子
上以这个用户跑进程」。所以按钮的任何实现都必须假定这个前提，并保留 GitHub 上人工合并这条退路。

## 8. 排障

| 现象 | 先看 | 处理 |
|---|---|---|
| 一条都不发 | `state/host/heartbeat.json` 的 `slack.reason` | `not-configured` → 补 `slackChannelId` / `slackBotTokenFile`；`profile-error` → 跑一次 `node bin/doctor.mjs` |
| 心跳 `token-file-*` | 令牌文件的属主和权限 | `chown` 成跑验收机的用户，`chmod 600`，确认不是符号链接、不是空文件 |
| 心跳 `ledger-rebuild-failed` | 令牌的 scope、频道 id | 补 `channels:history`（私有频道 `groups:history`），确认 bot 在频道里 |
| 心跳 `send-failed` | 账本里的 `retry` / `failed` | 看 `error`：`http-…` / `rate-limited` / `slack-…`；1、5、15 分钟后自动重试，第 4 次放弃 |
| 消息重复 | 账本的 `ids` 和频道里的消息 metadata | 正常不该发生；删账本会走重建，重建失败时不发 |
| 摘要迟迟不来 | 账本的 `digestNextAt` | 第一条摘要要等 60 分钟；等不了就把账本里的 `digestNextAt` 改早一点 |
