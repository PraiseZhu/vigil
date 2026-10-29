# 验收会话步骤（给接到派发消息的 agent 读）

这一轮验收只依赖命令行：`node`、`gh`、`git` 和本仓的 helper。除 helper 之外不要直接调 `gh` 写、不要改本地状态文件、不要自己发评论或推送。

## 派发消息里的字段

派发消息（`round.mjs start` 的输出，最后一行 JSON）会给你：

- `issue`：总 issue（独立任务就是它自己），形如 `owner/repo#号`。
- `kind`：`parent`（有子 issue）或 `standalone`（独立 issue）。
- `轮次：第 n 轮` 和 `轮次评论 id`：这一次认领的评论。
- `正文版本`：派发时总 issue 正文的版本（sha256）。
- `步骤文档`：就是本文件。

所有命令都带上 `--issue <root> --round <n>`（`collect` 除外，它不需要轮次）。下面两种写法不要混：

- `<root>`：**总 issue**，就是派发消息里的 `issue`（独立任务就是它自己）。`--issue` 永远写它。
- `<item>`：某条验收项的**出处 issue**（`collect` 里那条 SC 所在的 issue，可能是子 issue、跨仓子 issue，也可能就是总 issue），形如 `owner/repo#号`。逐条结论、`--item`、勾选清单里写的是它。

## 1. 先收集任务树

```sh
node watchers/acceptance/bin/helper.mjs collect --issue <root>
```

stdout 是 JSON：`root`（kind / tier / fork / 正文版本 / `verdictOnly` / `approveExec`）、`handoff`（批准执行 lead 的交接，没有就是 `null`）、`issues`（总 issue 在前，每条验收项的出处 issue、原文、验证层次、测试点、关联 PR）、`corrections`（修正子 issue）、`disputed`（有争议的条目）、`manual`（人工手测项）。按它决定这一轮验什么。

`root.verdictOnly` 为 `true` 的是**只出裁决**的任务（profile 的 `verdictOnlyIssues`，比如验收机自己的总 issue）：照常验、照常写看板，但**不关、不勾、不开修正、不推送**——这类任务**最后一步只写裁决**（`verdict` 再 `done`），`close` / `correct` / `push` 会以退出码 `1` 拒绝。裁决里会自动加一行「本 issue 由人工复核后关闭。」

**每做完一步写一次进度**：

```sh
node watchers/acceptance/bin/helper.mjs progress --issue <root> --round <n>
```

进度超过 `stallMinutes` 没写，宿主会认为这一轮卡住并中断它。

## 2. 怎么验

- 代码已由宿主检出：派发消息的「代码」一节列出本轮任务树里每个仓的绝对路径（宿主检出各仓最新 main 的工作树，带 `.git`），**只读**。直接在那里读代码、看 `git log`；需要可写副本（跑会写文件的测试）时复制到 `TMPDIR` 再用（`cp -a <路径> "$TMPDIR/"`），用完清理。沙箱里没有凭证，**不要**自己 `git clone`（私有仓克隆不下来），也不要往 `worktreeDir` 里检出。
- 依赖已由宿主预装：派发消息的「依赖」一节写明每个 npm 仓的情况。有 lockfile 的仓，`node_modules` 已按 lockfile 装好（`npm ci --ignore-scripts`）并只读挂在检出目录里，直接 `npm run build` / `npx tsc` / `npx vitest run` 即可。沙箱里 npm 一律离线、连不上 registry，**不要**再跑 `npm ci` / `npm install`。写着「没有预装依赖」的仓，或因为安装脚本没跑而缺的产物，要依赖才能跑的检查属**环境限制**：在证据里写明「环境限制：未预装依赖」，不能据此判不通过，也不能把没跑的检查当作已通过——见第 4 节「必需检查」：有一项因环境没跑，这一轮就**不能判通过**。
- `static`、`unit`、`contract`、`browser-fixture` 逐条跑，每条都留下证据：跑的命令 + 关键输出一行。
- `cindy-mac`、`cindy-windows`、`paid`、`github-live` 这几种层次**不验**，在裁决里列成「人工手测」；人工手测**不拦关闭**。
- 勾选框（`- [x]`）只算声称，不算证据：每条都要自己找证据。
- 正文里**没写验收标准的**：先从正文和关联 PR 里提炼标准，写进裁决时标 `extracted: true`，再按提炼出来的标准验。
- 目标仓自己的 `AGENTS.md`、PR 模板和合并门禁照常遵守。

### 批准执行的交接

`root.approveExec` 为 `true` 表示这棵树由「批准执行」推进：lead 派出会话时在总 issue 上发了「批准执行登记」。lead 验收完总 issue 后会再发一条交接评论（首行 `[批准执行] 交接验收 · 第 n 次`），`collect` 把最新一条放在 `handoff`：`{url, createdAt, n, focus}`，`focus` 是交接里「请重点查」的每一条原文。

- 交接**只当线索，不算证据**：每条 SC 照样自己验、自己留证据，和勾选框一样不因为 lead 说过就算通过。lead 写的「lead 没验到的」也照样自己验。
- `focus` 里每一条都要查，结论写进 `verdict.json` 的 `handoffChecks`：`[{"n":1,"result":"查了什么、结论"}]`，`n` 对应交接里的序号，一条重点项一条，缺了 `verdict` 以退出码 `1` 拒绝。裁决里会多一节「交接重点核对」逐条列出。
- 交接的「子 PR」表写着 lead 通过时的 head：合并进 main 的提交里，**lead 通过时的 head 之后新增的提交要重点查**（Ready 之后盯梢按审查意见推的修复，lead 没看过）。
- `approveExec` 为 `true`、`handoff` 却是 `null`：盘点已经等满 24 小时才开这一轮，照常验；裁决里会自动多一行「批准执行没有交接评论，等满 24 小时后照常验收。」

## 3. 有争议的条目

`collect` 的 `disputed` 会列出有争议的条目（来源可能是上一轮验收评论，也可能是修正轮的评论，两处同一套流程）。

- 不要自己定案：裁决里保持「有争议」，并写清双方理由。行格式：`- 有争议：<owner/repo#n> SC<k> · 验收方：… · 修正方：…`（`verdict.json` 里 `result` 写 `有争议`、`sides` 写双方理由）。
- 调度器会另起一次**只读**的裁决运行（模型 `anthropic/claude-opus-5-5`，推理 medium），结论写进下一轮裁决。

### 有裁决结果时

派发消息里有「裁决结果（第 n 轮的有争议条目，宿主只读裁决运行给出）」一节时，这些条目**按裁决定**，不再重复争议：

- `成立`：验收方对，这一条**要修**——照第 5 节 `correct` 开（或复用）修正子 issue，裁决里写「要修」，原因引用裁决理由。
- `不成立`：修正方对，这一条**通过**——裁决里写「通过」，证据里引用裁决（例如「按第 n 轮裁决：不成立，<理由>」）；照常勾选。
- 这两种都**不要**再写「有争议」行（也别在证据里写「有争议」这几个字）；裁决结果里没提到的条目照常验。
- 修正方（修正轮）认为某条「要修」不成立时，就不开修正 PR，在自己的轮次评论里把这一条标「有争议」并写双方理由。修正轮的轮次评论首行是 `[修正机] 第 n 轮：…`，`collect` 也会读它。

## 4. 通过

```sh
node watchers/acceptance/bin/helper.mjs close   --issue <root> --round <n> --verified <verified.json> --verdict <verdict.json>
node watchers/acceptance/bin/helper.mjs verdict --issue <root> --round <n> --file <verdict.json>
node watchers/acceptance/bin/helper.mjs done    --issue <root> --round <n>
```

`verified.json` 写 `{"items":[{"ref":"<item>","sc":3}],"manual":[{"ref":"<item>","sc":5}],"checks":{"build":"ran","typecheck":"ran","test":"ran"}}`：`items` 是验证通过要打勾的，`manual` 是人工手测项（行尾标「人工手测」）。`ref` 是出处 issue，不是总 issue。

`--verdict` 给的就是随后交给 `verdict` 的同一份 `verdict.json`（先写好它）：`close` 在写任何东西之前先查里面「通过」条目的证据，没给就退出码 `1`、什么都不写。

`close` 自己按 **勾选 → 看板（总 issue 和每个子 issue 写「通过」）→ 关总 issue** 的顺序做：看板写失败就停在关单之前，issue 还开着，不会「关了但看板没写」。

`verdict` 判「通过」时会回读总 issue：还开着就拒绝（退出码 1），说明 `close` 没做完——不要跳过 `close` 直接写裁决。

### 必需检查（checks）

判「通过」之前，`close` 的 `verified.json`、`verdict.json`、`board --acceptance 通过` 的 `--checks <file>`（可以直接给 `verdict.json`）都要写 `checks`，把三项必需检查各自的情况写实：

- `build`、`typecheck`、`test` 每项只能是 `ran`（真跑了）/ `not-applicable`（这个仓本来就没有这一项，比如没有 build 脚本、不是 TypeScript）/ `env-skipped`（因为环境原因没跑：依赖没装上、缺工具、连不上网……）。
- 缺项、写错：退出码 `1`，什么都不写；补齐再跑同一条命令。
- 证据里引用场景原文或别人的话（比如测试用例里写的「都没跑（依赖没装上）」），用「」、“”、"" 或反引号括起来：引号里的内容不算你自己说的「没跑」。没加引号、同一句里既写「没跑」又写环境原因（依赖、网络、沙箱……），就算因环境没跑。
- **只要有一项是 `env-skipped`，或者「通过」条目的证据里写着因环境没跑**：不能判「通过」。helper 会把这一轮标「中断」（原因以「环境问题（不是代码不通过）：」开头），退出码 `6`，不勾选、不写看板、不关单；宿主随后发「环境问题 / 未验证」提醒，按环境退避自动重验。**拿到 6 就停手**，不要改写 `checks` 重试、不要写裁决。
- 真跑了但没过是「要修」，不是环境问题；「要修」的裁决不检查 `checks`。

### build 项的 CI 口径

只管 build 一项，**只在派发消息末尾有「build 项 CI 口径」一段时适用**（宿主按仓开，给完整 build 在沙箱里跑不了的仓：要 electron 分发产物、fakeroot）；没有这一段就照上面的老规矩。typecheck、test 照旧。
那一段里的 CI 结论是宿主在沙箱外只读查 GitHub 得到的，以它为准，不要自己换别的说法。`checks.build` 这样写：

- **绿**，且消息里给的代码打包步骤在沙箱里离线跑通（exit 0）：写 `{"status":"ran","note":"代码打包步骤 <命令> 沙箱离线通过；<PR 链接> CI <检查名> 绿（宿主只读查询）"}`。完整打包没跑这件事只写在这条 note 里，不写进「通过」条目的证据。代码打包步骤跑了没过是代码问题，判「要修」；因环境原因跑不起来写 `env-skipped`。
- **红**：如实记不通过。`checks.build` 写 `ran`，裁决判「要修」，`why` 写明哪个 CI 检查红了（带 PR 链接）。
- **没跑**或**取不到**：build 项未验证。`checks.build` 写 `env-skipped`（note 写「CI 没跑」或「CI 结果取不到」），不得写 `ran`；helper 照旧标「中断」（环境问题）、退出码 `6`。

只出裁决的任务（`root.verdictOnly`）不跑 `close`：直接 `verdict` 再 `done`（要写看板就先 `board --target all --acceptance 通过 --checks <verdict.json>`）。

### 裁决文件 verdict.json

```json
{
  "extracted": false,
  "checks": { "build": "ran", "typecheck": "ran", "test": "ran" },
  "handoffChecks": [{ "n": 1, "result": "查了 lead 点的那处：…，没问题" }],
  "items": [
    { "ref": "<item>", "sc": 3, "result": "通过", "evidence": "跑的命令 + 关键输出一行" },
    { "ref": "<item>", "sc": 4, "result": "要修", "why": "没过的原因", "evidence": "…" },
    { "ref": "<item>", "sc": 5, "result": "人工手测", "layer": "cindy-mac" },
    { "ref": "<item>", "sc": 6, "result": "有争议", "sides": { "acceptance": "验收方理由", "correction": "修正方理由" } }
  ]
}
```

- `ref` 是出处 issue `<item>`，`sc` 是那条验收项的编号；`result` 只能是 `通过` / `要修` / `人工手测` / `有争议`。
- **`collect` 收到的任务树里每条 SC 都要有一条结论**：缺了 `verdict` 以退出码 `1` 拒绝，stderr 写清缺哪几条，什么都不写；`items` 为空也拒绝（空的不能判通过）。
- `extracted: true`：任务本来没写验收标准，`items` 是你提炼出来的标准。
- `handoffChecks`：只在 `collect` 的 `handoff.focus` 非空时必填，见第 2 节「批准执行的交接」。
- 结论由 `items` 推出：任一条「要修」或「有争议」、或本轮有「需人工处理」记录 → 要修；否则通过（人工手测不拦）。`--status` 可选，和推出的不一致就退出码 `1`。

## 5. 要修

```sh
node watchers/acceptance/bin/helper.mjs correct --issue <root> --round <n> --item "<item> SC<k>" --why "<没过的原因>"
node watchers/acceptance/bin/helper.mjs board   --issue <root> --round <n> --target all --acceptance 要修
node watchers/acceptance/bin/helper.mjs verdict --issue <root> --round <n> --file <verdict.json>
node watchers/acceptance/bin/helper.mjs done    --issue <root> --round <n>
```

`--item` 写**出处 issue**和验收项编号（比如子 issue 里的 SC4 就写 `"owner/repo#12 SC4"`），不是总 issue。`correct` 会先按「总 issue + 验收项」找开着的修正子 issue：有就复用（还没挂到总 issue 下的会补挂），没有才开。

**watch 档只出裁决、写看板**：`watchRepos` 里的仓不关 issue、不开修正子 issue、不开修正 PR，只写轮次评论和看板。watch 档里 `close` / `correct` / `push` 一律拒绝。

## 6. 修正 PR 的规则（修正轮做，你只需知道）

**验收轮不改代码、不推送、不开 PR。** 修正 PR 由**修正轮**（prbot，#60）根据你开的修正子 issue 推进；下面是它遵守的规则，写在这里是为了你读修正子 issue、修正 PR 和有争议条目时知道它们长什么样：

- 改代码、推送、开 PR 都经写操作出口，不绕过。
- 先按修正标记找已有的修正 PR：有就接着推，不重复开。
- 从最新 main 开分支、指向 main；分支名 `acceptance/<总 issue 号>-<出处 issue 号>-sc<k>`。
- 正文第一行写「任务 issue：<root>」（总 issue），最后一行照抄修正子 issue 上的修正标记（`[验收机] 修正 · 总 <root> · 项 <item> SC<k> · 第 n 轮`）；不写 `Closes <root>`——总 issue 只能由验收轮的 `close` 在验过之后关。
- 所有仓都先开 Draft（`pr.create` 必须带 `draft: true`，不带写闸就拒）；CI 全绿后由 prbot 自己转 Ready。Mivo 也一样，**不设审查机进场门禁**。
- 转 Ready 就是交接：之后由本地盯梢和审查机判断。PR 开出后看板「验收」写「修正中」。
- `makecindy/cindy` 从 fork 提：`pr.create` 的 head 写 `<ownerLogin>:<分支>`；其它仓 head 只写分支名，带别的前缀写闸就拒。
- 没有盯梢的仓转 Ready 后由我在 GitHub 里合并（Slack 消息带「打开 PR」链接）。
- **转 Ready 后不再推送、不回评论**；**任何情况下都不合并、不 Approve**。

## 7. 不推送

验收轮**不改代码、不推送**，这一轮不要调 `helper.mjs push`（只出裁决的任务和 watch 档它一律拒绝）。它还留在 helper 里，规则照旧：先扫要推的改动（有 gitleaks 就用，没有就用内置规则：私钥头、常见令牌格式），扫到退出码 `5`、什么都没推；写闸在沙箱外再扫一遍，扫到返回 `4`、`reason=secret-found`。

万一这一轮已经有「需人工处理」记录（扫到疑似密钥）：**不要重试**，这一轮**不标「中断」**，照常写 `verdict` 再 `done`——裁决会自动带上「需人工处理」并只列文件名，结论是「要修」，**绝不写密钥内容**。

## 8. 顺序

`close` / `correct` / `board` / `push` 都必须在 `verdict` 之前做完：`verdict` 一写，这一轮就结束了，之后所有写命令都会被认领检查拒绝。

- 通过：`close`（内部 勾选 → 看板 → 关单）→ `verdict` → `done`。
- 要修：`correct`（每条要修各一次）→ `board --target all --acceptance 要修` → `verdict` → `done`。
- 只出裁决（`root.verdictOnly`）：（可选 `board`）→ `verdict` → `done`，不跑 `close` / `correct` / `push`。
- `verdict` 写之前会核对任务树里每条 SC 都有结论，缺了退出码 `1`：补齐 `verdict.json` 再跑同一条命令。

## 9. 退出码

| 退出码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 成功 | 继续下一步 |
| `1` | 其他失败（参数错、配置错、watch 档或只出裁决的任务不许这个命令、裁决缺结论、写闸执行失败） | 读 stderr；裁决缺结论就补齐 `verdict.json` 再跑；其它不要重试同一轮 |
| `3` | 认领检查没过（不是本轮，或已不是「验收中」） | 停手：这一轮不是你的了 |
| `4` | 写闸拒绝 | 停手：这一轮已标「中断」。`reason=secret-found` / `reason=verdict-only` 除外：不标中断，照常写裁决再 `done`（secret-found 自动带「需人工处理」） |
| `5` | 本地扫到疑似密钥，什么都没推 | 不要重试推送；照第 7 节写裁决（自动带「需人工处理」）再 `done` |
| `6` | 必需检查因环境没跑（或证据写着因环境没跑），不能判通过 | 停手：这一轮已标「中断」（环境问题 / 未验证），宿主会告警并自动重验；不要改 `checks` 重试、不要写裁决 |

## 10. 评论和正文的规矩

- 所有写操作用我的账号，都经写闸；评论开头一律带「[验收机]」。
- 裁决和修正子 issue 里**不写**云端路径、令牌、运行 id、密钥内容；helper 会自动脱敏，你自己也别写。
- 看板只写「验收」和「裁决」两个字段，其它字段不碰。

## 11. 最后一步

最后一步必须是：

```sh
node watchers/acceptance/bin/helper.mjs done --issue <root> --round <n>
```

它把这一轮标成结束。没写裁决之前 `done` 会退出码 `3`。
