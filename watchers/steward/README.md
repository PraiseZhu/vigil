# PR 总管：只读巡检

需要 Node.js 24+、GitHub CLI 和能读取目标仓的 GitHub 身份。本版本只发现、读事实、分类和记本地轮次；不会向 PR 写评论、关闭讨论串、重跑检查或产生指令。

```sh
STEWARD_PROFILE=path/to/local-profile.json node watchers/steward/bin/steward.mjs scan
STEWARD_PROFILE=path/to/local-profile.json node watchers/steward/bin/steward.mjs tick --dry-run
STEWARD_PROFILE=path/to/local-profile.json node watchers/steward/bin/steward.mjs tick
```

从 `config/examples/steward.profile.example.json` 复制样例到仓库外再填写真实值。标准输出是一行 JSON：`prs` 是候选及分类，`unknown` 是读不到事实的 PR 数，`discoveryErrors` 是未读完的发现范围，非空时不要把结果当成完整清单。阶段进度走标准错误。配置或命令无效时非零退出；单个有效范围的读取失败不会阻断其他范围。 `scan` 和 `tick --dry-run` 不写本地状态；`tick` 记本地已确认事实。

## 配置

| 键 | 含义 |
|---|---|
| `authors` | 必填，非空列表。用户用 GitHub 登录名，App 用 `app/<slug>`，不区分大小写。 |
| `repos` | 显式仓清单，只有打开作者搜索才可为空。 |
| `excludeRepos`、`discoverByAuthor` | 排除清单默认空；作者搜索默认关。重复发现按仓名和 PR 号去重，优先标 `explicit`，否则标 `search`。草稿和不在范围内的候选标「不管」，不再读取其详细事实；关闭的 PR 不列出。 |
| `stateDir` | 必填，本机状态目录。相对路径以配置文件所在目录为准。不要在多个设备间共用或同步。 |
| `github` | 默认 `{"mode":"gh"}`，用本机 GitHub CLI 身份。App 模式必须给 `appId`、`installationId` 和 `privateKeyFile`；密钥路径可相对配置文件，短期 installation token 不落盘。App 搜索只能发现该身份可见的仓库。 |
| `policies` | 以 `owner/repo` 为键。未配置的仓不信任任何机器人、不标基建、不读取代码扫描。 |
| `policies.*.trustedReviewers`、`severityPatterns` | 可信机器人登录名或 `app/<slug>`；每级 `P0` 到 `P3` 是不区分大小写的正则数组，按严重等级从高到低命中，未命中为未分级。按讨论串首条评论判断，已过期但未解决的串仍纳入。 |
| `policies.*.infraPatterns` | 在失败检查的标题、摘要、正文或状态描述中匹配的不区分大小写正则。没有明确匹配不当作基建错误。 |
| `policies.*.codeScanning` | `enabled` 默认关；`threshold` 默认 `high`，可选 `low/medium/high/critical`。非安全告警的 `note/warning/error` 折算为前三档。只采纳当前 PR 开放实例，若扫描的是合并提交，验证其头部父提交。 |

客户端方法名记在 `client.calls`，供测试核对。GitHub 规则或事实读取失败、连接截断、提交不一致或无法解释的合并状态不会判为没事。未出现的已声明必需检查视为等待；只将真正的 `SKIPPED` 计入假绿灯。代码扫描开启时需要告警读取权限。发现读取使用分页；超过 GitHub 搜索上限或搜索返回不完整时显示范围错误。单 PR 超过 GraphQL 读取上限时显式标未知。无界面改动。

## 本地记录

以小写 `owner/repo#号` 为 PR 主键，用其 SHA-256 作为文件名。 `state.mjs` 的 `readPr`、`writePr`、`withPrLock` 使用同一键；读取再更新须在同一把 PR 锁内，跨进程争锁失败显式报告。进程被强杀后如有残留锁，只能在确认对应进程已经退出后清除；不要删正在持有的锁。

- `prs/<key>.json`：`pr`、`head`、`classification`、`required_checks`、`observed_at`、`push_sequence`、`halted`。新状态的 `halted` 为 false，后续巡检保留原值。读失败和排除结果不改已确认状态。
- `rounds/<key>.jsonl`：每行一个事件，`round-log.mjs` 提供 `readRounds(directory, pr)`、`appendRound(directory, pr, event)`。追加须持 PR 锁。 `push` 有 `id`、`type`、`pr`、`at`、`before_head`、`after_head`、`before_classification`、`before_required_checks`、`after_required_checks`。首读/同头不追加。先追加后替换状态，重做同次转换不会重复记。
- `outbox/orders/<id>.json`：`{id, type, pr, head, reason, created_at, attempts, delivered, payload}`。用 `makeOrder` 生成：同一 PR、头、类型、`dedupeKey` 得到同一 ID。 `writeOrder` 不覆盖已有指令，`readOrder`、`readOrders` 读回。 `markDelivered` 标记一次投递并增加次数。
- `outbox/receipts/<id>.json`：`writeReceipt`、`readReceipt` 使用独立回执文件，保留指令结构不变。回执类型必须匹配指令类型。

指令仅允许 `ensure_follower`、`check_follower`、`takeover`、`pause_original`、`nudge`、`forward_blocker`、`checkpoint`、`swap`、`stop_and_notify`、`notify_human`。本版本的杂活、覆盖、守门阶段为空，不调用写接口。
