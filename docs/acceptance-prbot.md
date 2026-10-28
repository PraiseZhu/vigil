# 修正轮 prbot：验收没过时跟进修正 PR

本文件是 `watchers/acceptance/host/prbot.mjs` 的运维说明。prbot 只处理**修正子 issue**：验收裁决是
「要修」、修正标记对得上、仓在 auto / fork 档。watch 档的仓永远不认领。

对应 issue：#60。依赖 #46 的修正子 issue / 修正标记 / 修正 PR 语义，和 #47 的 `host/loop`、写闸、
`gate-actions`。与 #61 只经 `state/prbot/events.jsonl` 和写闸动作对接，prbot 不调 Slack。

## 11 个阶段

| 阶段 | 做什么 | 停手条件 |
|---|---|---|
| 1 发现 | tick 只读盘点（修正轮和验收轮共用 `slot-0`/`slot-1`，开跑前过 3 GiB 内存门；tick 先给这一拍该开始的验收轮留槽，剩下的才起修正轮）：总 issue 最新自己发的裁决是「要修」、修正标记对得上、修正子 issue 开着、仓是 auto / fork 档；认领时发「[修正机] 第 m 轮：修正中」。上一修正轮还没收尾（不是已 Ready / 需人工处理 / 中断）不能认领下一轮；收尾后总 issue 上要有**比它更新**的「要修」裁决才开下一轮。本地状态丢了就接手 GitHub 上进行中的那条轮次评论，不重开。这些检查在**占槽之前**做（发现阶段和修正轮进程共用一套）：已收尾的修正、要报的「需人工处理」已经报过的修正，tick 不再起进程。Mivo 仓（修正子 issue 或总 issue 的仓名以 `mivo` 开头，和验收轮同一判定）整轮持 `mivo-test.lock`：验收轮 + 修正轮合计同时最多 1 轮，锁被占这一拍不认领 | watch 档 / 标记不对 / 不是「要修」/ 没有新裁决：不认领；交接方式没在 `host.json` 显式配置：不认领，`needs-human`（`handoff-unconfigured`）只报一次 |
| 2 评估 | 从最新裁决取「要修」的 SC；人工手测层不修；pi 认为某条不成立就标「有争议」并写明理由（裁决本身仍归 #46 SC8，本 issue 不另起裁决流程） | 同一修正子 issue 最多 2 个修正轮，第 3 轮写「需人工处理」 |
| 3 修复 | 沙箱外从 **PR 所在仓**（fork 模式是上游）的 main 建工作树；远端修正分支已经在、而且从我们推的仓开着 PR（同一 PR 上再修、`pr.update-branch` 之后、第 2 轮沿用 PR）就接着远端 head 建，复用工作树时远端被挪过就先在沙箱里快进（分叉了就停，`worktree-failed`，不覆盖）；分支还在但 PR 已合并 / 已关就从最新 main 重建（带 `.acc-owned.json`，写进 `.git/info/exclude`，不会被提交；提交身份写在工作树自己的配置里），pi 只在 bwrap 里跑一个入口：先写会变红的复现测试，再最小修复，`git commit -s`；最多 4 次 pi。pi 一个文件都没改 →「需人工处理」`no-change`（全部有争议则 `all-disputed`）；读不出改动 → `diff-failed` | bwrap 不可用 → 不跑模型，这一轮「中断」+ 提醒 `sandbox-unavailable`；没有任何环境变量 / 配置能关掉沙箱 |
| 4 本地预检 | 在**新的** bwrap 里跑目标仓自己的推送前检查（`prbot.repos[repo].preflight`，默认没有就跳过；每项一条命令：字符串或 argv 数组，写错了 `preflight-config-invalid` 需人工处理，进程不崩）；环境白名单只有 PATH、HOME、LANG、TZ、TERM、TMPDIR、NODE_OPTIONS（bwrap 自己会加一个 PWD），凭证全遮 | 红了返工最多 2 次，仍红 →「需人工处理」；bwrap 不可用 → 不跑预检，这一轮「中断」 |
| 5 提交和建 Draft | 沙箱里打 git bundle（宿主只读复制出来的副本），先过改动 / 禁改路径检查，再经写闸 `branch.push`（带租约 `--force-with-lease=<本轮分支>:<上次已知的远端 head>`，远端还没有这条分支就是空租约），再 `pr.create`（一定 `draft: true`，正文带 `Closes <修正子 issue>`）；都带 `dedupeKey`；同一标记 / 分支已有 PR 就复用。PR 开出后经写闸把修正子 issue 和总 issue 的看板「验收」写成「修正中」（写不上只记一步，不拦修正轮） | GitHub 报错按 1、2、4、8、16 分钟退避，5 次后「中断」+ `interrupted-exhausted`（`write-failed`）；写闸 75 按 #44 SC15 重试，用完也是「中断」+ `interrupted-exhausted`（`gate-busy`） |
| 6 盯 Draft CI | 每 2 分钟经写闸读 head 检查。还在排队 / 跑的检查只等，不算失败；**全部**跑完且有失败才进入重跑 / 再修（有一条失败、别的还在跑也先等）。Actions 的 workflow 已经排上、job 还没出来（check suite 有 `workflowRun`、一条 check run 都没有）也算还在跑；没有 `workflowRun` 的 suite（别的 App 自动建、可能永远不出 run）不算。落后 main 发 `pr.update-branch`；和 main 冲突（DIRTY）交给 pi 先取回最新 main 再 `git merge origin/main` 解决，同一 head 只叫一次 pi；两者共用 3 次额度。同一个 head 上第一次看到失败先 `ci.rerun` 一次（写闸自己查 run id 是否属于这个 PR 当前 head）；单个 head 最多等 60 分钟 | 超时 / 冲突额度用完 →「需人工处理」 |
| 7 自动再修 | 每个 PR 最多 2 次再修；只有 head 变了或出现新的失败指纹才再修；main 上同名检查也红就不改代码，附检查名 / main SHA / 链接写「需人工处理」 | 同一 head + 同一失败再看到只计一次再修额度、不再叫 pi；超过上限 → 停下写「需人工处理」，不空转。再修 / 解决冲突后的重推沿用同一个 PR，不再发 `draft-opened` |
| 8 转 Ready | 写闸执行 `pr.ready` 前复核：仍是 Draft、head 和动作里的 SHA 一致、head 上至少 1 条检查且全部完成、全绿（排队中、还没有 run 的 workflow suite 也算没完成）；交接方式没显式配置就不转（`handoff-unconfigured`） | 任意一条不满足 → 4 `reason=ready-precondition`，保持 Draft 继续盯 |
| 9 Ready 之后 | 按 `handoff` 交接；写一条 `ready` 事件；转 Ready 后不再推送、不回 PR 评论、不调 `mivo-handoff.mjs` | watcher 档满 24 小时没人接 → 一条 `ready-stalled` 事件。「有人接」只算转 Ready 之后、不是机器人（`Bot` / `…[bot]`）的 review 和评论，以及名字匹配 `reviewCheckPattern` 的 check run；有过活动或 PR 已合并 / 已关就记下来，之后不再每拍重查 |
| 10 合并 | **永远不做**。没有 `pr.merge`、不 Approve；合并由我在 GitHub 里点 | — |
| 11 清理 | 只回收 `profile.worktreeDir/prbot/*` 里带 prbot 的 `.acc-owned.json`、且那一轮已经收尾（状态文件是终态或已进入下一轮）、没有活着的进程拿着锁的工作树；连同它在 `<home>/state/prbot/mirrors/` 下的宿主镜像一起删 | 没有标记 / 还在跑 / 还没收尾的一概不动 |

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

- **同一修正子 issue、同一修正轮、同一原因的 `needs-human` / `interrupted-exhausted` 只发一次**（去重记录在
  `<home>/state/prbot/notified/`）：终态评论没写上、下一拍再停，只重试写评论，不重发事件（每条事件都会进 Slack）。
- 两轮用完又来了新的「要修」：不认领、GitHub 上不写（修正轮绑定只认第 1、2 轮的认领），`needs-human`
  （`limit-correction-rounds`）只报一次，也不占槽。
- 写闸总开关关着（`gate-disabled`，只读运行）：认领或任何写被拒都**安静停手**（返回 3），不写评论、不发事件、
  不在状态里留标志；开闸后下一拍接着跑。认领被写闸拒绝（4）也不发 `needs-human`（写闸自己记提醒），不留状态。
- 状态文件里「这一拍的」标志（写闸拒绝 / 关着 / 忙、退避用完、PAUSED）每次开跑都清掉：条件消失了就不再挡着。
- `PAUSED` 在开跑前就在：这一拍不跑（不占槽、不写）；跑到一半出现才按上面写「需人工处理」。
- 修正轮里冒出没预料到的异常：`needs-human`（`internal-error`）只报一次，进程正常退出，下一拍再试。

## `events.jsonl`（#61 的接口）

一行一条 JSON，路径 `<home>/state/prbot/events.jsonl`，目录 700、文件 600，字符串写前过
`bin/redact.mjs`。类型只有六种：

`claimed`、`draft-opened`、`ready`、`needs-human`、`interrupted-exhausted`、`ready-stalled`。

字段：

| 字段 | 说明 |
|---|---|
| `type` | 上面六种之一 |
| `at` | 事件时间（ISO-8601，北京时间 `+08:00`；旧的 UTC `Z` 格式照样能读） |
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
        "preflight": [".githooks/pre-push", ["npm", "test"]],
        "handoffNew": ["node", "scripts/new.mjs", "--pr", "{pr}"],
        "forbiddenPaths": [".github/workflows/**"]
      },
      "makecindy/cindy": { "handoff": "watcher" }
    }
  }
}
```

- `handoff` **必须显式写**（`owner` / `watcher`）：没写的仓修正轮不认领、不转 Ready，`needs-human`
  （`handoff-unconfigured`）只报一次；`bin/doctor.mjs` 的「修正轮交接配置」会逐个查 `prbot.repos` 和名单里写明的具体仓
  （通配名单里的仓要在 `prbot.repos` 里逐个写明）。以前没写就当 `owner`，没标 `watcher` 的 Mivo 仓会收到「可合并 + 打开 PR」。
- `preflight`：命令列表，每项是一条命令——字符串（只有程序本身，如 `".githooks/pre-push"`）或 argv 数组（如 `["npm", "test"]`）。
  没写就没有预检。
- Mivo 测试锁不用配：仓名以 `mivo` 开头的仓（和验收轮同一判定）整个修正轮都持 `<home>/state/host/locks/mivo-test.lock`。
- `host.json` 的 `serialRepos` 名单里的仓（修正子 issue 或总 issue 的仓在名单里）整个修正轮都持这个仓自己的 `<home>/state/host/locks/serial-<owner>__<repo>.lock`，和验收轮共用：合计同时最多 1 轮，锁被占这一拍不认领。
  以前的 `testLock` 键不再读。
- `handoffNew`：拿到 PR 号后在预检沙箱里跑这条命令，再 `git commit -s`、重新打包推送。
- `reviewCheckPattern`：`ready-stalled` 判「审查 check run」用的名字匹配，默认 `/review/i`。
- `piCommand` 缺了 prbot 会 fail-closed，不跑模型。

## 交接（SC10）

| `handoff` | 谁合并 | prbot 做什么 |
|---|---|---|
| `owner` | 我在 GitHub 里点 | 追加 `ready` 事件，带 `prUrl`；#61 发「打开 PR」链接 |
| `watcher`（例如 mivo、cindy 这类有本地盯梢的仓） | Mac mini 的盯梢 / 审查机判断 | 停在 Ready，追加 `handoff:"watcher"` 的 `ready` 事件；之后不推送、不回评论；24 小时没人接追加一次 `ready-stalled` |

`makecindy/cindy` 只是文档里的例子；代码里没有任何仓名写死，交接只看 `host.json`。

## fork 模式

`profile.forkRepos` 列的是**上游**仓（例如 `makecindy/cindy`）。fork 仓默认是
`<ownerLogin>/<上游仓名>`，`profile.forkTargets` 可以把上游映射到 `ownerLogin` 名下别的名字（例如
`{"makecindy/cindy": "<ownerLogin>/cindy-fork"}`）：`branch.push` 只能推到这个 fork，PR 开在上游、head 写
`<ownerLogin>:<分支>`。写闸的 `pr.ready` 只放行 head 仓正好是这个 fork 的跨仓 PR（仓名不分大小写）；别人 fork 里同名分支
开的 PR 既不会被沿用，也不能被转 Ready。非 fork 模式推送和 PR 都在修正子 issue 所在的仓。

fork 档的修正子 issue 是开在上游仓里的普通 issue（不挂子 issue），修正 PR 也开在上游：正文写同仓的 `Closes #n`，
上游维护者把 PR 合进上游 main（默认分支）时 GitHub 按这一行关掉它（GitHub 只认目标是默认分支的 PR 正文里的关闭关键字，
和 head 在不在 fork 无关）。

## 宿主上的 git

pi 写过的工作树不可信：它的 `.git/config`、钩子、`origin/main` 都可能被改过。规则是
**沙箱跑过之后，宿主再也不在工作树里跑任何 git**：

- 带令牌的 `fetch` 只在宿主自己的镜像仓里跑：`<home>/state/prbot/mirrors/<工作树名>`。`<home>/state` 对所有沙箱都被遮住，
  验收轮沙箱（可写挂整个 `worktreeDir`）和修正轮沙箱都看不见、写不了。以前放在 `worktreeDir/prbot/.mirror/`，
  #68 第四轮复审复现过：验收轮的模型在那里预埋 `reference-transaction` 钩子，宿主带令牌的 fetch 跑了它，钩子拿到了
  AUTHORIZATION 头（假令牌）。现在的防线：
  - 镜像目录从 `<home>/state` 一路往下必须是宿主自己的：真目录、不是符号链接、属主是宿主用户；`mirrors/` 和镜像本身 700。
    不是就拒绝（`mirror-tampered`），不去「修」。镜像根也不能和 `stateDir` / `worktreeDir` 重叠。
  - `fetchBranch` 自己加固：`--git-dir <镜像>/.git`、`-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.sshCommand=false
    -c credential.helper= -c http.proxy= -c protocol.allow=never -c protocol.https.allow=always`，环境
    `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null`。镜像建好后 `.git/config` 换成固定内容，以后每次带令牌取之前
    逐字节比对；`.git` 顶层有符号链接、有 `commondir` / `objects/info/alternates` 也拒绝。检查在读令牌之前。
  - 取 10 分钟超时；镜像超过 2 GiB 就删掉、报 `mirror-too-large`。仍取全量历史（打出来的 bundle 才能在写闸的空仓里单独导入）。
- 宿主**一次都不**在工作树里跑 git（包括全新的工作树：验收轮的模型可以预先在 `worktreeDir` 里建好同名目录和恶意 `.git/config`）。
  新工作树：宿主以「不递归、已存在就报错」建目录，把镜像的 `origin/main` 打成 `main.bundle` 复制进一个全新的轮次目录，
  再在预检沙箱里 `git init`、从 bundle 取 main、建分支、写提交身份、把 `.acc-owned.json` 加进 `.git/info/exclude`。
  复用已有工作树要求镜像目录里有宿主自己记的 `owned.json`（沙箱伪造得了工作树里的标记，伪造不了这个）；工作树是符号链接就拒绝。
- 解决冲突前：宿主把最新 main 取进镜像，打成 `main.bundle` 复制进全新的轮次目录，再在沙箱里从这份 bundle 导进工作树；沙箱看不见镜像本身。
- 打包（`git bundle create`）、`handoffNew` 之后的 `status` / `add` / `commit` 都在预检沙箱里跑。宿主只用纯 JS 读
  bundle 头（不跟符号链接，只认自带全部对象的 bundle，超过 512 MiB 不读），复制进自己的临时目录。
- 改动 / 禁改路径检查对着**真正要推的那个 bundle**做（预检之后、推之前），在镜像里导入 bundle、
  和宿主自己取的 `origin/main` 比；镜像上的 git 不读全局 / 系统配置。读不出 → `diff-failed`，打包失败 → `bundle-failed`，
  导入 main 失败 → `main-import-failed`。

修正 PR 正文第一行是「任务 issue：<总 issue>」，第二行是「Closes <修正子 issue>」（同仓 `#n`，跨仓 `owner/repo#n`：
合并后修正子 issue 才会关，trigger 才会再验），最后一行照抄修正子 issue 上的修正标记
（轮次是验收轮，不是修正轮），所以真写闸的 `pr.create` 认得。修正 PR 只由 prbot 开，这三行都由 prbot
（`correctionPrBody`）写，写闸的修正轮绑定校验标记和 `Closes` 行；验收会话不开修正 PR，也不写这一行。

中间是 task-pr/v1 正文（2026-10-26，#93），和修正子 issue 逐段对应：改了什么（没过的验收项、原因和改动文件）、范围对照
（真正要推的 bundle 里的改动文件，最多列 30 个；再照抄修正子 issue 的「范围（可改）」「不做」「依赖」）、验收对照
（只有一行 SC1，原文照抄修正子 issue 的 SC1；预检通过写「通过」和预检命令，没配预检写「待验证」）、定下的决定
（有争议没修的条目，行头是「争议未修：」，不用验收机解析的「- 有争议：」）、未执行的验证（开 PR 时 CI 还没跑完，
build / typecheck / test 的结果看本 PR 的检查，正文不写没发生的 CI 结果；SC1 由验收机在本 PR 合并后再验）、
风险与回滚。写闸没有改 PR 正文的动作，正文只在 `pr.create` 时写一次，所以状态只写开 PR 时已有的证据，CI 结果看
PR 的检查。

修正轮写动作的 `dedupeKey` 都带修正子 issue、轮次号和认领评论 id（认领本身带这次的开始时间，改评论再带正文摘要）：
同一轮次号重放、本地状态丢了从头数，都不会从写闸账本里拿回旧结果。

轮次评论里的争议条目是单行：`- 有争议：<owner/repo#n> SC<k> · 验收方：<裁决里的原因> · 修正方：<pi 的理由>`，
和 `docs/acceptance-session.md` 的格式一样，`collect` 和 `round.mjs status` 按这一行认条目。轮次评论、状态文件里的时间都是北京时间 `+08:00`。

## 写闸（#60 新增）

- `pr.update-branch`：`PUT /repos/{o}/{r}/pulls/{n}/update-branch`，带 `expected_head_sha`。
- `ci.rerun`：`POST /repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs`；写闸先查这个 PR 当前 head 的检查，run id 不在里面就拒（`not-allowed`）。
- 两者只给 auto / fork 档；watch 档返回 4 `tier-not-allowed`。仍然要有修正轮绑定、账本、执行锁。
- 更新分支 / 重跑 / 转 Ready 都先查 PR 头：head 分支名必须是本轮分支、base 必须是 `main`；更新分支 / 重跑还要求
  head 所在仓是同一个仓（fork 模式是 `<ownerLogin>/<仓名>`），别人 fork 里的同名分支一律 `not-allowed`（转 Ready 的 head 仓由 `pr.ready` 复核）。
- `pr.create` 的 `base` 只能是 `main`（不写就是 main），修正轮和验收轮都一样；修正轮的 `pr.create` 正文还必须有一行
  正好是 `Closes <本轮修正子 issue>`（同仓 `#n`，跨仓 `owner/repo#n`）。
- `branch.push` 的强推：只有修正轮绑定、只限本轮修正分支、只认带租约的（`forceWithLease` 是提交 SHA 或空串，
  `github.mjs` 只对 `acceptance/` 分支加 `--force-with-lease=refs/heads/<分支>:<租约>`）；裸 `force`、乱写的租约、验收轮的强推一律 4。
- `project.field.set`：修正轮绑定只放行「验收 = 修正中」，只写本轮修正子 issue 和它所属总 issue 的看板条目。
- 写闸核心 `write-gate.mjs` 只做接线：修正轮的检查都在 `host/prbot-gate-check.mjs`；
  核心里唯一新增的判断是验收轮 `pr.create` 的 base 检查（两行），因为验收轮的 `pr.create` 检查本来就在核心里，挪出去改动更大。
- `pr.ready` 的检查复核（`PR_READY_QUERY`）在写闸里做；以前 #47 的 `checks-not-green` 换成
  `ready-precondition`。
- 登记过的只读查询新增：PR 状态、PR 头、按分支找 PR、Ready 后的 review / review comment / check run、
  main 分支同名检查。调用方永远不能自带 GraphQL 文本。
- `pr.merge` 不出现在写闸、gate-actions、prbot 里。

## 待上线验证

以下必须在有真 GitHub、真 bwrap、真 pi 模型的机器上再确认（单测只覆盖夹具）：

- 真 GitHub 的 Draft PR、`update-branch`、`rerun-failed-jobs` 退出码和权限。
- `github.mjs` 的 `fetchBranch` 用账号令牌拉真仓（令牌只在 `GIT_CONFIG_*` extraheader，不进 argv / URL / 日志），
  加固参数（`protocol.allow=never` 等）下真 https 能取；全量历史的真实耗时 / 体积是否在 10 分钟 / 2 GiB 之内。
- 真 bwrap 里从 `main.bundle` 建工作树（`git init` / `fetch` / `checkout` / `sh -c` 追加 exclude）。
- 真 pi 模型按 prompt 先写复现测试、再最小修复，并 `commit -s`。
- 目标仓 `.githooks/pre-push` 的真实耗时和输出。
- fork 仓（例如 `makecindy/cindy`）的推送 / PR head 写法，以及真 GitHub 返回的 `isCrossRepository` / `headRepository`。
- 真 pi 解决和 main 的冲突（DIRTY）。
- Ready 后 24 小时 `ready-stalled` 在真实时钟上的行为。
- `handoffNew` 对真实仓的交接文件生成。
- 真 GitHub 上 `--force-with-lease=<分支>:<sha>` 从写闸的空临时仓推（不带远端跟踪引用）能正常比对租约；update-branch 之后再修是快进。
- fork 档：上游维护者合并修正 PR 后，正文里的 `Closes #n` 真的关掉上游仓里的修正子 issue。
- 真 GitHub 上排队中的 workflow（还没有 job）在 `checkSuites` 里是否带 `workflowRun`、`status` 是否为 `QUEUED`；
  没有 `workflowRun` 的 App suite 是否会一直挂着。
- 看板「验收」字段有「修正中」选项。
