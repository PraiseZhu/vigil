# 验收机：盘点与触发

对应本仓 issue #44。合入后，宿主每分钟用一条只读命令找出「该验收的任务」，并用 GitHub 上的轮次评论认领一轮。状态以 GitHub 为准：本地 `stateDir` 丢了也能重建，不会重复开轮。

本目录只提供底座：配置、GitHub 读写与写操作出口、轮次记录、看板「验收」「裁决」字段、只读盘点。不做验收、不派发、不起 agent（见 #45、#46）。

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
| `slackBotTokenFile` | 否 | Slack 令牌文件（绝对路径）；配了就检查权限是 600，本 issue 不读不用 |

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
