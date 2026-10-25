# 验收机：盘点、调度、验收会话与宿主

本仓现在有三个 watcher：[`watchers/mivo`](../mivo/README.md)（同仓分支）、
[`watchers/cindy`](../cindy/README.md)（cross-repo fork）、以及本目录的验收机——它在 GitHub 上按轮次评论
认领任务、逐条验收、出裁决。三个 watcher 彼此独立，互不 import。

验收机分四层，各自分文档：

| 层 | 位置 | 文档 |
|---|---|---|
| 盘点与触发 | `bin/poll.mjs`、`bin/tasks.mjs`、`bin/rounds.mjs` | 本文件 |
| 调度接口 | `bin/round.mjs`（start/status/abort）、`bin/message.mjs` | [`docs/acceptance-scheduler.md`](../../docs/acceptance-scheduler.md) |
| 验收会话 | `bin/helper.mjs` 与步骤文档 | [`docs/acceptance-session.md`](../../docs/acceptance-session.md)、[`SESSION.md`](SESSION.md) |
| 宿主接入、写闸、部署检查 | `host/`、`bin/doctor.mjs` | [`docs/acceptance-operations.md`](../../docs/acceptance-operations.md) |
| 修正轮 prbot | `host/prbot.mjs`、`host/gate-actions/` | [`docs/acceptance-prbot.md`](../../docs/acceptance-prbot.md) |

对应 issue：#44（盘点与触发）、#45（调度接口）、#46（验收会话）、#47（宿主接入、写闸与首跑）。

宿主每分钟用一条只读命令找出「该验收的任务」，并用 GitHub 上的轮次评论认领一轮。状态以 GitHub 为准：
本地 `stateDir` 丢了也能重建，不会重复开轮。

## 配置

拷一份 [`config/examples/acceptance.profile.example.json`](../../config/examples/acceptance.profile.example.json) 到 watcher home 下的 `config/profile.json`。home 解析：环境变量 `ACCEPTANCE_WATCHER_HOME` > `bin/` 的上一级。**配置键和令牌都不从环境变量读**，缺必填项直接报错。

令牌文件约定：profile 只存路径、不读令牌内容（只看存在、属主、权限正好 600、非空）；GitHub 令牌只在 `bin/github.mjs` 真正发请求时才读。以后新增的令牌键名一律以 `TokenFile` 结尾，`tokenFiles(profile)` 会列出全部（连同 App 私钥文件 `appPrivateKeyFile`），方便宿主沙箱统一遮罩。

轮次评论只认 `ownerLogin` 自己发的：公开仓上任何人都能发首行同样的评论，别人发的一律当普通评论忽略（不算认领、不算裁决、不算中断、不参与编号）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `ownerLogin` | 是 | 我的 GitHub 账号 |
| `projectNumber` | 是 | 看板编号 |
| `stateDir` | 是 | 云端状态目录（绝对路径，只是缓存） |
| `worktreeDir` | 是 | 验收用的检出目录（绝对路径） |
| `startAt` | 是 | 上线时间（ISO-8601）。这之前已关闭的 issue 不补验 |
| `githubTokenFile` | 是 | 账号令牌文件（绝对路径，权限必须是 600） |
| `autoRepos` | 否 | 全自动仓，支持 `owner/*`；默认 `` `${ownerLogin}/*` `` |
| `forkRepos` | 否 | 也算全自动，默认 `["makecindy/cindy"]` |
| `watchRepos` | 否 | watch 档仓，默认 `[]` |
| `stallMinutes` | 否 | 卡住判定阈值，默认 30 |
| `writeCommand` | 否 | 写操作出口 argv；没配则直接用 `gh`/`git` |
| `appConfigPath` | 否 | GitHub App 配置 JSON；配了读请求走 App 令牌 |
| `slackBotTokenFile` | 否 | Slack bot 令牌文件（绝对路径）；配了就检查权限是 600，只有 `host/slack-notify.mjs` 读它 |
| `slackChannelId` | 否 | Slack 频道 id（`C` / `G` 开头）；没配就不发通知 |
| `slackMentionUserId` | 否 | 立即发（ping）时 @ 的用户 id（`U` 开头）；摘要不 @ |

Slack 通知怎么配、哪些事件立即发、哪些进摘要，见 [`docs/acceptance-slack.md`](../../docs/acceptance-slack.md)（#61）。

令牌文件必须存在、是普通文件、属主是当前用户、权限不含组/他人位、去空白后非空。`appConfigPath` 指向 `{ "appId", "installationId", "privateKeyFile" }`，其中私钥文件同样过密钥校验。

## 盘点输出

```sh
node watchers/acceptance/bin/poll.mjs --json
```

stdout 是 JSON 数组。该开始的任务：

```json
[{ "issue": "example-owner/example-repo#1", "kind": "parent", "tier": "auto", "fork": false, "nextRound": 4, "bodyVersion": "sha256:..." }]
```

卡住的轮次（最新一轮停在「验收中」且超过 `stallMinutes` 没有进度）：

```json
[{ "issue": "example-owner/example-repo#2", "round": 2, "stale": true, "lastProgressAt": "2026-10-24T01:00:00.000Z" }]
```

没有任务时输出 `[]`。不加 `--json` 则每条一行。`poll` **不发任何写请求、不写本地缓存、不调模型**。失败时往 stderr 写错误并退出码 1。

## 写操作出口

所有 GitHub 写操作和推送都只经过 `bin/github.mjs` 的 `write()`。配了 `writeCommand` 时，每个动作变成带 `dedupeKey` 的 JSON 从标准输入交给它：

- 退出码 0：stdout JSON 即结果
- 退出码 75：每 30 秒重试、最多 6 次（共 7 次尝试），`dedupeKey` 不变；用完抛 `WriteBusyError`（「外发忙」）
- 其它非 0：抛 `WriteRejectedError`（「外发被拒」），不重试，也不改成直接写

没配 `writeCommand` 时直接用 `gh` / `git`，写一律走账号令牌。

## 宿主（#47）

`host/` 是本仓的宿主接入，部署与运维见 [`docs/acceptance-operations.md`](../../docs/acceptance-operations.md)：

| 文件 | 作用 |
|---|---|
| `host/loop` | 常驻调度循环：单实例（flock），每分钟跑一拍 `host/tick.mjs` |
| `host/ensure.sh` | 每小时巡检：心跳不超过 180 秒就不做事，否则拉起循环并写一条提醒 |
| `host/stop.sh` | 停常驻循环（按心跳里的 pid）；回滚用 `host/rollback.mjs` |
| `host/tick.mjs` | 一拍调度：沙箱外跑 `poll.mjs` → 卡住先杀进程再 abort → 按空槽起轮次 → 写心跳 |
| `host/round.mjs` | 一轮验收：内存门、槽/测试锁、认领、写闸 serve、bwrap 里跑 pi |
| `host/write-gate.mjs` | 写闸：exec / serve / probe 三种用法，所有写动作在沙箱外再查一遍 |
| `host/gate-client.mjs` | 沙箱里的 `writeCommand`：动作 JSON 经 unix socket 交给写闸 |
| `host/sandbox.mjs` | bwrap 参数（宿主 HOME 默认遮掉、白名单只读挂回）、遮罩名单（从 profile 算）、环境变量白名单 |
| `host/sandbox-bin/gh` | 沙箱里的 `gh`：只允许 `gh api graphql --input -`，经写闸读 |
| `host/paths.mjs`、`host/proc.mjs`、`host/probes.mjs` | 状态文件与锁、唯一的子进程出口、部署检查探针 |
| `bin/doctor.mjs` | 部署检查：缺哪项报哪项，退出码非 0 |

宿主状态都在 `<home>/state/` 下：`write-gate/enabled`（总开关）、`write-gate/ledger.jsonl`（去重账本）、
`host/heartbeat.json`（心跳）、`host/alerts.jsonl`（提醒，一行一条）、`host/rounds/`（在跑的轮次）。
提醒只写文件、不调 Slack（发 Slack 归 #61）。
