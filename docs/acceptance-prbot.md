# 修正轮 prbot：验收没过时跟进修正 PR

本文件是 `watchers/acceptance/host/prbot.mjs` 的运维说明。prbot 只处理**修正子 issue**：验收裁决是
「要修」、修正标记对得上、仓在 auto / fork 档。watch 档的仓永远不认领。

对应 issue：#60。依赖 #46 的修正子 issue / 修正标记 / 修正 PR 语义，和 #47 的 `host/loop`、写闸、
`gate-actions`。与 #61 只经 `state/prbot/events.jsonl` 和写闸动作对接，prbot 不调 Slack。

## 11 个阶段

| 阶段 | 做什么 | 停手条件 |
|---|---|---|
| 1 发现 | tick 只读盘点（修正轮和验收轮共用 `slot-0`/`slot-1`，开跑前过 3 GiB 内存门）：总 issue 最新自己发的裁决是「要修」、修正标记对得上、修正子 issue 开着、仓是 auto / fork 档；认领时发「[修正机] 第 m 轮：修正中」。上一修正轮还没收尾（不是已 Ready / 需人工处理 / 中断）不能认领下一轮；收尾后总 issue 上要有**比它更新**的「要修」裁决才开下一轮。本地状态丢了就接手 GitHub 上进行中的那条轮次评论，不重开 | watch 档 / 标记不对 / 不是「要修」/ 没有新裁决：不认领 |
| 2 评估 | 从最新裁决取「要修」的 SC；人工手测层不修；pi 认为某条不成立就标「有争议」并写明理由（裁决本身仍归 #46 SC8，本 issue 不另起裁决流程） | 同一修正子 issue 最多 2 个修正轮，第 3 轮写「需人工处理」 |
| 3 修复 | 沙箱外从 **PR 所在仓**（fork 模式是上游）的 main 建工作树（带 `.acc-owned.json`，写进 `.git/info/exclude`，不会被提交；提交身份写在工作树自己的配置里），pi 只在 bwrap 里跑一个入口：先写会变红的复现测试，再最小修复，`git commit -s`；最多 4 次 pi。pi 一个文件都没改 →「需人工处理」`no-change`（全部有争议则 `all-disputed`）；读不出改动 → `diff-failed` | bwrap 不可用 → 不跑模型，这一轮「中断」+ 提醒 `sandbox-unavailable`；没有任何环境变量 / 配置能关掉沙箱 |
| 4 本地预检 | 在**新的** bwrap 里跑目标仓自己的推送前检查（`prbot.repos[repo].preflight`，默认没有就跳过）；环境白名单只有 PATH、HOME、LANG、TZ、TERM、TMPDIR、NODE_OPTIONS（bwrap 自己会加一个 PWD），凭证全遮 | 红了返工最多 2 次，仍红 →「需人工处理」；bwrap 不可用 → 不跑预检，这一轮「中断」 |
| 5 提交和建 Draft | host 打 git bundle，经写闸 `branch.push`，再 `pr.create`（一定 `draft: true`）；都带 `dedupeKey`；同一标记 / 分支已有 PR 就复用 | GitHub 报错按 1、2、4、8、16 分钟退避，5 次后「中断」+ `interrupted-exhausted`；写闸 75 按 #44 SC15 重试 |
| 6 盯 Draft CI | 每 2 分钟经写闸读 head 检查。还在排队 / 跑的检查只等，不算失败；全部跑完且有失败才进入重跑 / 再修。落后 main 发 `pr.update-branch`；和 main 冲突（DIRTY）交给 pi 先取回最新 main 再 `git merge origin/main` 解决，同一 head 只叫一次 pi；两者共用 3 次额度。同一个 head 上第一次看到失败先 `ci.rerun` 一次（写闸自己查 run id 是否属于这个 PR 当前 head）；单个 head 最多等 60 分钟 | 超时 / 冲突额度用完 →「需人工处理」 |
| 7 自动再修 | 每个 PR 最多 2 次再修；只有 head 变了或出现新的失败指纹才再修；main 上同名检查也红就不改代码，附检查名 / main SHA / 链接写「需人工处理」 | 同一 head + 同一失败再看到只计一次再修额度、不再叫 pi；超过上限 → 停下写「需人工处理」，不空转。再修 / 解决冲突后的重推沿用同一个 PR，不再发 `draft-opened` |
| 8 转 Ready | 写闸执行 `pr.ready` 前复核：仍是 Draft、head 和动作里的 SHA 一致、head 上至少 1 条检查且全部完成、全绿 | 任意一条不满足 → 4 `reason=ready-precondition`，保持 Draft 继续盯 |
| 9 Ready 之后 | 按 `handoff` 交接；写一条 `ready` 事件；转 Ready 后不再推送、不回 PR 评论、不调 `mivo-handoff.mjs` | watcher 档满 24 小时没人接 → 一条 `ready-stalled` 事件 |
| 10 合并 | **永远不做**。没有 `pr.merge`、不 Approve；合并由我在 GitHub 里点 | — |
| 11 清理 | 只回收 `profile.worktreeDir/prbot/*` 里带 prbot 的 `.acc-owned.json`、且那一轮已经收尾（状态文件是终态或已进入下一轮）、没有活着的进程拿着锁的工作树 | 没有标记 / 还在跑 / 还没收尾的一概不动 |

## 上限

| 项目 | 上限 |
|---|---|
| 修正轮（同一个修正子 issue） | 2（第 3 轮「需人工处理」） |
| pi 迭代 | 4 |
| 预检返工 | 2 |
| 每个 PR 再修 | 2 |
| 冲突 / 落后 main 更新分支 | 3 |
| 单个 head 等 CI | 60 分钟 |
| GitHub 写失败退避 | 1、2、4、8、16 分钟；5 次后「中断」 |
| 一个修正轮总时长 | 3 小时 |

## 停止条件（SC12，`stopReason`）

达到 Ready；写闸返回 4；任一上限用完；红不是这次改动引起的（main 同名检查也红）；改动碰到
`prbot.repos[repo].forbiddenPaths`（代码里叫「禁改路径」）；扫到密钥；修正子 issue 被关或裁决不再是
「要修」；`<home>/state/prbot/PAUSED` 存在；一个修正轮超过 3 小时。除 Ready 和可退避的中断外，
一律写「需人工处理」并追加 `needs-human` 事件。

## `events.jsonl`（#61 的接口）

一行一条 JSON，路径 `<home>/state/prbot/events.jsonl`，目录 700、文件 600，字符串写前过
`bin/redact.mjs`。类型只有六种：

`claimed`、`draft-opened`、`ready`、`needs-human`、`interrupted-exhausted`、`ready-stalled`。

字段：

| 字段 | 说明 |
|---|---|
| `type` | 上面六种之一 |
| `at` | 事件时间（ISO-8601） |
| `issue` | 修正子 issue（`owner/repo#n`） |
| `root` / `item` | 总 issue / 验收项出处 |
| `sc` | 修了哪几条 SC（数组） |
| `repo` / `pr` / `prUrl` / `headSha` | PR 信息 |
| `checks` | `{ green, total, url }` |
| `diff` | `{ files, additions, deletions }` |
| `handoff` | `owner` 或 `watcher` |
| `reason` / `detail` | 需人工处理或中断的原因 |
| `readyAt` | 仅 `ready-stalled`：转 Ready 的时间 |

Draft 已开、每次 CI 结果、再修开始、每轮进度**不发** Slack；#61 只按上面六种事件发消息。
`ready` 的 Slack 消息只带「打开 PR」链接，没有「合并」按钮。

## `host.json` 的 `prbot` 块

```json
{
  "prbot": {
    "piCommand": ["pi", "--model", "<deepseek-v4.1-flash id>", "--thinking", "high"],
    "reviewCheckPattern": "review",
    "repos": {
      "example-owner/example-repo": {
        "handoff": "watcher",
        "preflight": [".githooks/pre-push"],
        "testLock": true,
        "handoffNew": ["node", "scripts/new.mjs", "--pr", "{pr}"],
        "forbiddenPaths": [".github/workflows/**"]
      }
    }
  }
}
```

- 没列出的仓：`handoff: "owner"`，没有预检。
- `testLock: true`：预检在 `<home>/state/host/locks/mivo-test.lock` 下跑（同一时间最多 1 个）。
- `handoffNew`：拿到 PR 号后在预检沙箱里跑这条命令，再 `git commit -s`、重新打包推送。
- `reviewCheckPattern`：`ready-stalled` 判「审查 check run」用的名字匹配，默认 `/review/i`。
- `piCommand` 缺了 prbot 会 fail-closed，不跑模型。

## 交接（SC10）

| `handoff` | 谁合并 | prbot 做什么 |
|---|---|---|
| `owner`（默认） | 我在 GitHub 里点 | 追加 `ready` 事件，带 `prUrl`；#61 发「打开 PR」链接 |
| `watcher`（例如 mivo、cindy 这类有本地盯梢的仓） | Mac mini 的盯梢 / 审查机判断 | 停在 Ready，追加 `handoff:"watcher"` 的 `ready` 事件；之后不推送、不回评论；24 小时没人接追加一次 `ready-stalled` |

`makecindy/cindy` 只是文档里的例子；代码里没有任何仓名写死，交接只看 `host.json`。

## fork 模式

`profile.forkRepos` 列的是**上游**仓（例如 `makecindy/cindy`）。fork 仓固定是
`<ownerLogin>/<上游仓名>`：`branch.push` 只能推到这个 fork，PR 开在上游、head 写
`<ownerLogin>:<分支>`。写闸的 `pr.ready` 只放行 head 仓正好是这个 fork 的跨仓 PR；别人 fork 里同名分支
开的 PR 既不会被沿用，也不能被转 Ready。非 fork 模式推送和 PR 都在修正子 issue 所在的仓。

## 宿主上的 git

pi 写过的工作树不可信。宿主上对它跑的 git（建分支、`diff`）一律带
`-c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external= -c core.pager=cat`，环境用
`localgit` 收窄过的白名单（没有令牌）。`handoffNew` 生成文件之后的 `git add` / `git commit` 在预检沙箱里跑，
不在宿主上跑。修正 PR 正文第一行是「任务 issue：<总 issue>」，最后一行照抄修正子 issue 上的修正标记
（轮次是验收轮，不是修正轮），所以真写闸的 `pr.create` 认得。

## 写闸（#60 新增）

- `pr.update-branch`：`PUT /repos/{o}/{r}/pulls/{n}/update-branch`，带 `expected_head_sha`。
- `ci.rerun`：`POST /repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs`；写闸先查这个 PR 当前 head 的检查，run id 不在里面就拒（`not-allowed`）。
- 两者只给 auto / fork 档；watch 档返回 4 `tier-not-allowed`。仍然要有修正轮绑定、账本、执行锁。
- `pr.ready` 的检查复核（`PR_READY_QUERY`）在写闸里做；以前 #47 的 `checks-not-green` 换成
  `ready-precondition`。
- 登记过的只读查询新增：PR 状态、PR 头、按分支找 PR、Ready 后的 review / review comment / check run、
  main 分支同名检查。调用方永远不能自带 GraphQL 文本。
- `pr.merge` 不出现在写闸、gate-actions、prbot 里。

## 待上线验证

以下必须在有真 GitHub、真 bwrap、真 pi 模型的机器上再确认（单测只覆盖夹具）：

- 真 GitHub 的 Draft PR、`update-branch`、`rerun-failed-jobs` 退出码和权限。
- `github.mjs` 的 `fetchBranch` 用账号令牌拉真仓（令牌只在 `GIT_CONFIG_*` extraheader，不进 argv / URL / 日志）。
- 真 pi 模型按 prompt 先写复现测试、再最小修复，并 `commit -s`。
- 目标仓 `.githooks/pre-push` 的真实耗时和输出。
- fork 仓（例如 `makecindy/cindy`）的推送 / PR head 写法，以及真 GitHub 返回的 `isCrossRepository` / `headRepository`。
- 真 pi 解决和 main 的冲突（DIRTY）。
- Ready 后 24 小时 `ready-stalled` 在真实时钟上的行为。
- `handoffNew` 对真实仓的交接文件生成。
