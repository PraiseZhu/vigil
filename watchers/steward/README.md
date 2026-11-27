# PR 总管：巡检与跟进指令

需要 Node.js 24+、GitHub CLI 和能读取目标仓的 GitHub 身份。总管发现 PR、分类、记本地轮次并发出跟进指令；策略打开且身份获授权时会回复、关闭讨论串或重跑检查。覆盖阶段不直接控制跟进会话。

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
| `github` | 默认 `{"mode":"gh"}`，用本机 GitHub CLI 身份。旧的 `mode: "app"` 仍用单一安装做所有读取和 App 杂活。多账号用 `mode: "by-owner"`，在 `installations` 中按仓库所属账号或组织配置安装（不区分大小写）。每组安装必填 `appId`、`installationId` 和 `privateKeyFile`；密钥路径可相对配置文件，短期 installation token 不落盘。 |
| `policies` | 以 `owner/repo` 为键。未配置的仓不信任任何机器人、不标基建、不读取代码扫描。 |
| `policies.*.trustedReviewers`、`severityPatterns` | 可信机器人登录名或 `app/<slug>`；每级 `P0` 到 `P3` 是不区分大小写的正则数组，按严重等级从高到低命中，未命中为未分级。按讨论串首条评论判断，已过期但未解决的串仍纳入。 |
| `policies.*.infraPatterns` | 在失败检查的标题、摘要、正文、状态描述及失败级别注释中匹配的不区分大小写正则。没有明确匹配不当作基建错误。失败检查的注释超过读取上限时，该 PR 判「未知」，不当成没有注释。 |
| `policies.*.infraRequiresAllAnnotations` | 布尔值，默认 `false`。为真且失败检查有失败级别注释时，每条注释都命中 `infraPatterns` 才算基建错误；没有失败注释时仍按标题、摘要等文字判断。 |
| `policies.*.optionalChecks` | `block` 布尔值，默认 `false`。为真时，每个非必需 GitHub Actions 检查同名只看最新一次；结论为 `FAILURE`、`TIMED_OUT` 或 `STARTUP_FAILURE` 时记要修原因 `optional_check_failed` 并带检查名，命中 `infraPatterns` 的记为等待中的基建错误。`ignorePatterns` 是不区分大小写的正则数组，名称命中的检查不计。 |
| `policies.*.chores.syncBase` | 分支同步，默认关。`enabled` 布尔值；`bases` 是 base 分支名的不区分大小写正则数组，启用时不能为空；`minBehind` 正整数，默认 10；`maxAgeHours` 正数，默认 48。正式、可合并无冲突、不是「要修」、base 命中名单的 PR，落后提交数达到 `minBehind`、merge base 早于 `maxAgeHours` 或 GitHub 报 `BEHIND` 时，用 App 调用 update-branch 并带当前 head；同一 head 和 base 末端只调用一次。以下情况不调用，标准错误写明原因：本机记录里覆盖状态仍为活动（`repair_in_progress`）、有未回执的指令（`pending_dispatch`）；只是登记过跟进方不拦。head 分支规则要求走 PR 或规则读不到。GitHub 回报 head 已变时记 `held`，不重试；其他失败（如 403、其他 422）按同一 head 记 `failed` 和时间，1 小时内不再调用。开启后 `BEHIND` 判「等待中」，未开启判「要修」，原因都是 `behind_base`。 |
| `policies.*.chores.reverifiedSeverities`、`reverifiedKeyPattern` | 已复核关闭（`resolveReverified`）处理的等级，默认 `["P3"]`，可选 `P0` 到 `P3`。P0–P2 讨论串还需全部满足：最后回复与首条评论出自同一审查 App 且命中 `reverifiedPatterns`；回复至少写出一个提交号，且全部等于当前 head；用 `reverifiedKeyPattern`（恰好含一个捕获组的正则）从回复取出的全部 key 都等于首条评论里的最后一个 key。取不到 key 不关闭。 |
| `policies.*.codeScanning` | `enabled` 默认关；`threshold` 默认 `high`，可选 `low/medium/high/critical`。非安全告警的 `note/warning/error` 折算为前三档。只采纳当前 PR 开放实例，若扫描的是合并提交，验证其头部父提交。 |
| `policies.*.chores.followerLogin` | 可选，与杂活策略共用的 GitHub 登录名。该账号在 PR 讨论串里的新回复会重置停滞和在线催办计时；不配置就不按回复计时。 |
| `presence.commands` | 可选，按原设备标识设置本机可信探测命令。退出 0 表示设备可能已恢复，覆盖阶段才发 `pause_original`；未配置、超时或非零退出均视为不可达。示例里的 `false` 不会触发暂停，请在仓外本机配置中替换成部署用探测命令。 |

按账号或组织选身份时，有安装的仓用对应 App 读取事实、关闭讨论串和重跑检查；没有安装的仓仍用本机 `gh` 读取，启用的杂活会跳过并在标准错误说明原因。已配置的 App 若读取失败，不会回退到 `gh`。跨仓按作者搜索没有指定仓，仍用本机 `gh`；若私有仓只对 App 可见，把它明确加入 `repos`。P3 固定回帖仍由本机跟进方的 `gh` 身份发送。

客户端方法名记在 `client.calls`，供测试核对。GitHub 规则或事实读取失败、连接截断、提交不一致或无法解释的合并状态不会判为没事。规则集或旧式分支保护要求解决讨论串、且已读事实只剩 P3 或其他机器人讨论串时，即使 GitHub 报 `BLOCKED`，也判「没事」并保留讨论串。未出现的已声明必需检查视为等待；只将真正的 `SKIPPED` 计入假绿灯。代码扫描开启时需要告警读取权限。发现读取使用分页；超过 GitHub 搜索上限或搜索返回不完整时显示范围错误。单 PR 超过 GraphQL 读取上限时显式标未知。无界面改动。

## 本地记录

以小写 `owner/repo#号` 为 PR 主键，用其 SHA-256 作为文件名。 `state.mjs` 的 `readPr`、`writePr`、`withPrLock` 使用同一键；读取再更新须在同一把 PR 锁内，跨进程争锁失败显式报告。进程被强杀后如有残留锁，只能在确认对应进程已经退出后清除；不要删正在持有的锁。

- `prs/<key>.json`：`pr`、`head`、`classification`、`required_checks`、`observed_at`、`push_sequence`、`halted`。新状态的 `halted` 为 false，后续巡检保留原值。读失败和排除结果不改已确认状态。
- `rounds/<key>.jsonl`：每行一个事件，`round-log.mjs` 提供 `readRounds(directory, pr)`、`appendRound(directory, pr, event)`。追加须持 PR 锁。 `push` 有 `id`、`type`、`pr`、`at`、`before_head`、`after_head`、`before_classification`、`before_required_checks`、`after_required_checks`。首读/同头不追加。先追加后替换状态，重做同次转换不会重复记。
- `outbox/orders/<id>.json`：`{id, type, pr, head, reason, created_at, attempts, delivered, payload}`。用 `makeOrder` 生成：同一 PR、头、类型、`dedupeKey` 得到同一 ID。 `writeOrder` 不覆盖已有指令，`readOrder`、`readOrders` 读回。 `markDelivered` 标记一次投递并增加次数。
- `outbox/receipts/<id>.json`：`writeReceipt`、`readReceipt` 使用独立回执文件，保留指令结构不变。回执类型必须匹配指令类型。

当前覆盖阶段使用 `ensure_follower`、`check_follower`、`takeover`、`pause_original`、`nudge`、`forward_blocker` 和 `notify_human`。指令箱也预留守门指令 `checkpoint`、`swap`、`stop_and_notify`。
