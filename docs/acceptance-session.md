# 验收会话：裁决、修正与写操作

对应本仓 issue #46。`watchers/acceptance/SESSION.md` 是给 pi 读的步骤；本文件写清格式和规则，方便人查、也方便 #60（修正轮）、#61（通知）对接。

命令一律是：

```sh
node watchers/acceptance/bin/helper.mjs <collect|progress|verdict|close|correct|push|board|done> \
  --issue <总 issue，owner/repo#号> --round <n> [...]
```

`--issue` 永远是**总 issue**（独立任务就是它自己）；`--round` 除 `collect` 外都必填。所有写操作都经 `bin/github.mjs` 的 `write()`，没配 `writeCommand` 就直接写，配了就整段交给写闸。

## 1. 裁决

`verdict --file <verdict.json>` 把**本轮的轮次评论就地改掉**（不新发评论）：

```
[验收机] 第 n 轮：通过|要修
正文版本：sha256:…（总 issue 正文「现在」的版本）
开始：<原有轮次评论里的开始时间>
完成：<结束时间，北京时间，例如 2026-10-25T19:43:23+08:00>

## 逐条结果
- 通过：owner/repo#12 SC3 · 证据：…
- 要修：owner/repo#12 SC4 · 原因：… · 证据：…
- 人工手测：owner/repo#12 SC5（cindy-mac）
- 有争议：owner/repo#12 SC6 · 验收方：… · 修正方：…

批准执行没有交接评论，等满 24 小时后照常验收。   ← 只有批准执行推进、又没有交接时有这一行
## 交接重点核对                                       ← 只有 lead 交接里有「请重点查」时有这一节
对照 lead 交接第 1 次：https://github.com/…
- 1. <重点项原文> → <查了什么、结论>

## 需人工处理
- 扫到疑似密钥，没推：path/a, path/b

本 issue 由人工复核后关闭。      ← 只有 verdictOnlyIssues 里的 issue 有这一行
```

- 时间（轮次评论的「开始」「完成」、裁决的「完成」）一律写**北京时间**的 ISO-8601，带 `+08:00` 偏移（#43 决策）；`trigger` / `poll` 用 `Date.parse` 读，旧的 UTC `…Z` 格式照样认。

- `verdict.json`：`{"extracted": false, "items":[{"ref":"owner/repo#n","sc":3,"text":"…","result":"通过|要修|人工手测|有争议","evidence":"…","why":"…","layer":"cindy-mac","sides":{"acceptance":"…","correction":"…"}}]}`。
- `ref` 是验收项的**出处 issue**（`collect` 里那条 SC 所在的 issue），不是总 issue。
- **覆盖率**：写之前按 `collect` 重新收一遍任务树，树里（总 issue、子 issue、挂着的修正子 issue）每条 SC 都要有一条结论（通过 / 要修 / 人工手测 / 有争议）；缺了就退出码 `1`，stderr 列出缺的 `owner/repo#n SC<k>`，什么都不写。`items` 为空一律拒绝，不得判通过。
- `extracted: true` 表示任务本来没写验收标准，标准是验收机从正文和关联 PR 提炼的；裁决里会多一行说明。
- `handoffChecks`（#140）：`[{"n":1,"result":"…"}]`，`collect` 的 `handoff.focus` 非空时每条重点项一条（`n` 是交接里的序号），缺了退出码 `1`、什么都不写；渲染成「交接重点核对」一节。`root.approveExec` 为真、`handoff` 为空时裁决自动带「没有交接评论」那一行。
- 状态推导：任一条「要修」或「有争议」→ 要修；本轮有「需人工处理」记录 → 要修；否则通过。人工手测**不拦**通过。
- 去重键：`verdict:<总 issue>:<n>:<轮次评论 id>:<结论>`（带评论 id：轮次评论被删后同号重新认领，不会命中旧记录）。
- `--status 通过|要修` 可选；写错（和逐条结果不一致）直接退出码 `1`。
- 正文版本按**改完之后**的正文算：验收机自己勾选或关 issue 改了正文，就用改后的版本，`trigger` 不会因此重验。
- 写完放锁、更新缓存（`lastVerdict`）。**不调 `rounds.finish`**：那会保留旧的正文版本行。

### 批准执行的交接（#140）

「批准执行」（approve-exec）推进的总 issue：lead 派出会话时在总 issue 上发 `批准执行登记：…`，验收完总 issue 后发交接评论，首行 `[批准执行] 交接验收 · 第 n 次`，正文里「## 请重点查」一节是编号列表。都只认 `ownerLogin` 发的。

- **等交接**：有登记评论、还没有晚于最后一条登记的交接时，`trigger` 判 `awaiting-lead-handoff`，不开轮；从子 issue 全关（独立 issue 是关联 PR 合并）起满 24 小时仍没交接，照常开轮。已经出过晚于最后一条登记的裁决，就不再等。
- **读交接**：`collect` 输出 `handoff: {url, createdAt, n, focus}`（最新一条，且晚于最后一条登记；早于它的算过期，输出 `null`，裁决按没有交接写）和 `root.approveExec`。验收会话只把它当线索，每条 SC 照样自己验。
- 盘点只看总 issue 最近 50 条评论：登记评论落在 50 条之外时按「不是批准执行推进的」处理，和以前一样直接验。`collect` 拉了 100 条，判断登记和交接时也只用最近 50 条（`LEAD_HANDOFF_COMMENT_WINDOW`），两处结论一致。

### 有争议的行格式

`- 有争议：<owner/repo#n> SC<k> · 验收方：… · 修正方：…`

`collect`（`disputed`）和 #45 的 `round.mjs status --json`（`disputed`）都按这一行认条目：行里必须出现「有争议」，条目用 `owner/repo#n SC<k>` 取。有争议时由调度器另起一次只读裁决运行（模型 `anthropic/claude-opus-5-5`，推理 medium），结论写进下一轮裁决。

### 裁决运行（已实现，`host/adjudicate.mjs`）

- **触发**：最近一次出结论（通过 / 要修）的验收轮评论里有上面这种行（`trigger` 只认 `- 有争议：<owner/repo#n> SC<k>` 开头的行，证据里顺带提到「有争议」不算），宿主还没有这一轮的裁决结果 → `trigger` 判 `awaiting-adjudication`（以前这里判「已是最新」，任务静默卡死），`poll` 报 `adjudicate` 条目，宿主起一次裁决运行。同一任务同一轮只起一次，和验收轮共用槽和内存门。
- **只读**：和验收轮同一个 bwrap 沙箱，但不给写闸 socket，GitHub 写不了；输入是争议条目、SC 原文、双方理由、相关 PR，代码和验收轮一样由宿主预取、只读挂进去。
- **结果**：pi 最后一行输出 `{"items":[{"ref":"owner/repo#n","sc":3,"ruling":"成立|不成立","why":"…"}]}`，宿主校验后写进 `<home>/state/host/adjudications/<owner>__<repo>__<号>__<轮次>.json`（宿主状态目录，模型不可写）。
- **下一轮**：`trigger` 判 `adjudicated` 触发，派发消息里多一节「裁决结果（第 n 轮的有争议条目……）」，逐条写 `- <ref> SC<k>：成立|不成立 · 理由：…`。验收会话按裁决定这些条目：**成立 = 要修**（照第 3 节开修正子 issue），**不成立 = 通过**，证据里引用裁决（例如「按第 n 轮裁决：不成立，<理由>」）；**不再写「有争议」行**。
- **配置**：host.json `adjudicateCommand`（形如 `piCommand` 的数组，默认文档写法 `["pi","--model","anthropic/claude-opus-5-5","--thinking","medium"]`；没配就不起，写 `adjudicate-not-configured`，一天一次）、`adjudicateMaxMinutes`（默认 30，超时写 `adjudicate-timeout`）；失败最多重试 2 次，用完写 `adjudicate-needs-human`。

## 2. 通过（SC4）

`close --verified <verified.json> --verdict <verdict.json>`：

0. 写任何东西之前先过裁决防线：`verified.json` 的 `checks` 有 `env-skipped`，或 `--verdict` 给的 `verdict.json` 里「通过」条目的证据写着因环境没跑（去掉「」、“”、""、反引号里的引用后，同一句里同时有「没跑」类说法和环境原因），就标「中断」（环境问题）、退出码 `6`，不勾选、不写看板、不关单。没给 `--verdict` 退出码 `1`、零写入。（以前证据只在 `verdict` 才查，那时已经关单了，vigil#105 第 2 轮就是这样留下「关了单、看板通过、轮次却中断」。）
1. 在列出的 issue（子 issue 或总 issue 自己，只限本轮任务树；清单里有树外的 issue 就整条拒绝、什么都不写）里，把验证过的 `- [ ] SC<k>` 改成 `- [x] SC<k>`；人工手测项在行尾补「 人工手测」。只有正文真的变了才写 `issue.edit`。正文是 CRLF 的也一样（写闸逐行比对时行尾的 `\r` 不算改动）。
2. 看板：总 issue 和每个子 issue 都写「验收」= 通过、「裁决」= 本轮评论链接（和 `board --target all --acceptance 通过` 同一个范围）。
3. **最后**才 `issue.close` 关总 issue（`reason=completed`）。顺序是 勾选 → 看板 → 关单：看板写失败就停在关单之前，issue 还开着，下一轮能接着验；不会出现「关了但看板没写」。

### 只出裁决（verdictOnlyIssues）

profile 的 `verdictOnlyIssues`（显式 issue 名单，形如 `["owner/repo#43"]`，不收通配）里的总 issue：照常验收、发轮次评论、写看板和裁决，但**不关、不勾、不开修正、不推送**——`close` / `correct` / `push` 在 helper 里直接退出码 `1` 并写清原因；写闸对绑定到这些根的轮次拒绝 `issue.close` / `issue.edit` / `issue.create` / `issue.reopen` / `subissue.add` / `branch.push` / `pr.create` / `pr.ready`（`4`，`reason=verdict-only`，helper 不因此标中断）。`collect` 的 `root.verdictOnly` 为 `true`，裁决末尾多一行「本 issue 由人工复核后关闭。」（#43 决策：最后验、结论由人或 opus(high) 复核后才关。）

`verified.json`：`{"items":[{"ref":"owner/repo#n","sc":3}],"manual":[{"ref":"…","sc":5}]}`。

## 3. 要修（SC5）

`correct --item "<owner/repo#n> SC<k>" --why <原因> [--title <标题>]`：

1. 先按「总 issue + 验收项」找**开着的**修正子 issue（挂着的子 issue 和搜索到的都算）：有就复用，不再开。搜索到、还没挂上的（上一轮在 `issue.create` 之后、`subissue.add` 之前中断）非 fork 档会补一次 `subissue.add`，不留孤儿。
2. 没有才新开，正文按下面的模板，并带上修正标记。
3. 独立 issue 已经关了：先 `issue.reopen` 重开，再挂修正子 issue。
4. 非 fork 档：新 issue 开在**原属验收项的仓**里，再 `subissue.add` 挂到同一个总 issue 下；原来的子 issue **不重开**。
5. fork 档（`makecindy/cindy`）：开在总 issue 所在的仓里，正文第一行链回原 issue，**不** `subissue.add`。
6. 看板：「验收」= 要修（总 issue 和新建的修正子 issue）。

### 修正子 issue 模板

按子 issue 模板（task-issue/v1，2026-10-26，#96）写，五个锚点标题和本地 `check-pr-issue.sh` 一致。正文里**只能有一行** `- [ ] SC1`：
`parseItems` 会把任何 SC 行都当验收项。#96 之前开的修正子 issue 复用时保持原文（旧模板是「没过的验收项 / 没过的原因 / 验收标准」），
prbot 两种都认。

```md
原 issue：<总 issue 链接>            ← 只有 fork 档有这一行

> 修正子 issue · 总 issue <owner/repo#n> · 原属 <owner/repo#n> SC<k> · 对应 1 个修正 PR（prbot 开，指向 main）

## 目标

让验收没过的 <owner/repo#n> SC<k> 重新验收通过：<原验收项原文（含验证层次）>

## 原因

<脱敏后的原因>

## 范围（可改）

- 修好 <owner/repo#n> SC<k> 所需的最小代码改动和复现测试，限原属 issue 的范围内（目标仓禁改路径照旧不碰）

## 不做

- 不改 <owner/repo#n> 的其它验收项，不扩大原属 issue 的范围

## 依赖

无，随时可开工。

## 验收标准

- [ ] SC1 <原验收项原文（含验证层次）>

[验收机] 修正 · 总 <owner/repo#n> · 项 <owner/repo#n> SC<k> · 第 n 轮
```

### 修正标记与复用

- 修正子 issue 和修正 PR 的正文都带一行：
  `[验收机] 修正 · 总 <owner/repo#n> · 项 <owner/repo#n> SC<k> · 第 n 轮`
- 开之前先按「总 issue + 验收项」找开着的修正子 issue 和修正 PR，有就复用，不重复开。上一轮中断留下的修正子 issue 会被直接接手。
- 修正 PR 的分支名：`acceptance/<总 issue 号>-<出处 issue 号>-sc<k>`。

## 4. 推送（SC7）

`push --repo <owner/repo> --branch acceptance/<总>-<出处>-sc<k> --worktree <目录> [--base origin/main]`：

0. 先把 `--branch` 解析成提交（只认本地 `refs/heads/<branch>`，没有就不推）。扫的、打包的、去重键用的都是这个提交，**不是**当前检出的 HEAD —— 检出停在别的分支也不会漏扫。
1. 先扫：内置规则每次都跑，不解析补丁，而是列出 `<base>` 够不到、分支提交新引入的**每个对象**（`git rev-list --objects <分支提交> ^<base>`，合并提交带进来的也在内），用 `git cat-file --batch` 按字节取内容逐个扫（私钥头、GitHub 令牌、PAT、Slack 令牌、AWS key、sk- 风格密钥；含 NUL 的「二进制」文件、提交说明也扫）。本机有 `gitleaks` 再加扫一遍（退出码 0 = 没扫到，1 = 扫到；别的退出码算扫描失败，不推） `gitleaks git --log-opts=<base>..<分支提交> --redact --report-format json`。
2. 扫到：不推，退出码 `5`，在 `<stateDir>/session/<owner>__<repo>__<号>.json` 记一条「需人工处理」，stdout 只列文件名。
3. 没扫到：`git bundle create <文件> refs/heads/<branch>` 打包，再用 `git bundle list-heads` 核对包里的提交就是扫过的那个（中途分支被挪就不推），交给写闸的 `branch.push`（`dedupeKey` = `push:<repo>:<branch>:<分支提交 sha>`）；bundle 放在系统临时目录，用完删掉。
4. 写闸返回 `4` + `reason=secret-found`：同样记「需人工处理」（写闸回的文件名一并记下），**不**标「中断」。

验收轮本身不改代码、不推送（修正 PR 由 #60 的修正轮开），`push` 留给需要时用；只出裁决的任务和 watch 档一律拒绝。

本地只跑 `git` 和 `gitleaks`（`bin/localgit.mjs`），环境里剥掉所有令牌和 askpass；git 子命令是**允许名单**：只有 `rev-parse`、`rev-list`、`cat-file`、`bundle create`、`bundle list-heads`，其余（fetch、push、clone、remote、config、checkout……）一律拒绝 —— 推送只经写闸。

## 5. 需人工处理

记录在 `<stateDir>/session/<owner>__<repo>__<号>.json`（按总 issue 和轮次存）：`{"round":n,"needsHuman":[{"reason":"secret-found","files":["path/a"]}]}`。裁决里的「## 需人工处理」只列文件名，不列密钥内容；同一轮再记一条就往后追加。写闸返回 `secret-found` 时会带回文件名（`files`，只有文件名），裁决里照样列出；万一没带，裁决里写「扫到疑似密钥，没推（写闸在沙箱外扫到）」。

## 6. 脱敏（SC11）

写进 GitHub 的自由文本都过 `redact(text, profile)`：本机绝对路径（`/home`、`/Users`、`/tmp`、`/var`、`/root`、Windows 盘符）、`stateDir` / `worktreeDir` / 家目录前缀、令牌格式、`Bearer …`、整段私钥、`run-id: …` 一律换成「（已隐去）」。评论开头一律「[验收机]」。

## 7. 顺序

`close` / `correct` / `board` / `push` 都要在 `verdict` **之前**做完：`verdict` 一写，轮次评论就变成通过/要修，之后任何写命令都会被认领检查拒绝（退出码 `3`）。`done` 是最后一步，只能在裁决之后跑。`close` 内部是 勾选 → 看板 → 关单；只出裁决的任务最后一步只写裁决（`verdict` → `done`）。

认领（`round.mjs start`）成功后，宿主把看板「验收」写成「验收中」（总 issue 和任务树里的子 issue，和 `close` 写「通过」的范围一致）；这一步经写闸 exec 模式，只许写「验收」=「验收中」，写闸回「外发失败」（写 GitHub 时出错，比如 TLS 超时）时，先只读查看板：已经是「验收中」就不再写，确认没写成才经写闸、用同一个去重键重试一次（只此一处例外，别的写一律不重试）；查不清、被拒或重试仍失败都不让认领失败，记一条 `board-claim-failed` 提醒。

## 8. 退出码

| 退出码 | 含义 | 处理 |
|---|---|---|
| `0` | 成功 | 继续 |
| `1` | 其他失败（参数、配置、未知错误；watch 档或只出裁决的任务跑了不许的命令、裁决缺结论、写闸退出码 `1` 也在这里） | 读 stderr，不自动重试同一轮；写闸失败会尽力标「中断」（`写操作失败：<reason>`） |
| `3` | 认领检查没过（`RoundError` NOT_CURRENT / NOT_FOUND）：消息里写清期望轮次和实际轮次 | 停手，这一轮不是你的 |
| `4` | 写闸拒绝 | 停手；非 `secret-found` / `verdict-only` 会把这一轮标「中断」并写原因（`写闸拒绝：<reason>`）；`secret-found` 走「需人工处理」，`verdict-only` 照常写裁决，都不标中断 |
| `5` | 本地扫到疑似密钥（只有 `push`），什么都没推 | 不要重试推送；照常写裁决（自动带「需人工处理」，结论要修）再 `done` |

写闸忙（`75`）由 `github.mjs` 内部重试，重试用完抛 `WriteBusyError`，helper 退出码 `1` 并尽力把这一轮标「中断」，原因写「写闸忙」。写闸退出码 `4` 才是拒绝（`WriteRejectedError`，带 `reason`、`files`）；`1` 和别的非 0 是其他失败（`WriteFailedError`）。
