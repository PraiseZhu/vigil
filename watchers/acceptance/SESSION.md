# 验收会话步骤（给接到派发消息的 agent 读）

这一轮验收只依赖命令行：`node`、`gh`、`git` 和本仓的 helper。除 helper 之外不要直接调 `gh` 写、不要改本地状态文件、不要自己发评论或推送。

## 派发消息里的字段

派发消息（`round.mjs start` 的输出，最后一行 JSON）会给你：

- `issue`：总 issue（独立任务就是它自己），形如 `owner/repo#号`。
- `kind`：`parent`（有子 issue）或 `standalone`（独立 issue）。
- `轮次：第 n 轮` 和 `轮次评论 id`：这一次认领的评论。
- `正文版本`：派发时总 issue 正文的版本（sha256）。
- `步骤文档`：就是本文件。

所有命令都带上 `--issue <总 issue> --round <n>`（`collect` 除外，它不需要轮次）。下面的 `<ref>` 都指总 issue。

## 1. 先收集任务树

```sh
node watchers/acceptance/bin/helper.mjs collect --issue <ref>
```

stdout 是 JSON：`root`（kind / tier / fork / 正文版本）、`issues`（总 issue 在前，每条验收项的出处 issue、原文、验证层次、测试点、关联 PR）、`corrections`（修正子 issue）、`disputed`（有争议的条目）、`manual`（人工手测项）。按它决定这一轮验什么。

**每做完一步写一次进度**：

```sh
node watchers/acceptance/bin/helper.mjs progress --issue <ref> --round <n>
```

进度超过 `stallMinutes` 没写，宿主会认为这一轮卡住并中断它。

## 2. 怎么验

- 在 `worktreeDir` 下检出各仓最新 main（`git clone`、`git worktree` 都行，读是安全的），**用完清理**。
- `static`、`unit`、`contract`、`browser-fixture` 逐条跑，每条都留下证据：跑的命令 + 关键输出一行。
- `cindy-mac`、`cindy-windows`、`paid`、`github-live` 这几种层次**不验**，在裁决里列成「人工手测」；人工手测**不拦关闭**。
- 勾选框（`- [x]`）只算声称，不算证据：每条都要自己找证据。
- 正文里**没写验收标准的**：先从正文和关联 PR 里提炼标准，写进裁决时标 `extracted: true`，再按提炼出来的标准验。
- 目标仓自己的 `AGENTS.md`、PR 模板和合并门禁照常遵守。

## 3. 有争议的条目

`collect` 的 `disputed` 会列出有争议的条目（来源可能是上一轮验收评论，也可能是修正轮的评论，两处同一套流程）。

- 不要自己定案：裁决里保持「有争议」，并写清双方理由。
- 调度器会另起一次**只读**的裁决运行（模型 `anthropic/claude-opus-5-5`，推理 medium），结论写进下一轮裁决。
- 修正方（修正轮）认为某条「要修」不成立时，就不开修正 PR，在自己的轮次评论里把这一条标「有争议」并写双方理由。修正轮的轮次评论首行是 `[修正机] 第 n 轮：…`，`collect` 也会读它。

## 4. 通过

```sh
node watchers/acceptance/bin/helper.mjs close   --issue <ref> --round <n> --verified <verified.json>
node watchers/acceptance/bin/helper.mjs board   --issue <ref> --round <n> --target all --acceptance 通过
node watchers/acceptance/bin/helper.mjs verdict --issue <ref> --round <n> --file <verdict.json>
node watchers/acceptance/bin/helper.mjs done    --issue <ref> --round <n>
```

`verified.json` 写 `{"items":[{"ref":"…","sc":3}],"manual":[{"ref":"…","sc":5}]}`：`items` 是验证通过要打勾的，`manual` 是人工手测项（行尾标「人工手测」）。

## 5. 要修

```sh
node watchers/acceptance/bin/helper.mjs correct --issue <ref> --round <n> --item "<ref> SC<k>" --why "<没过的原因>"
node watchers/acceptance/bin/helper.mjs board   --issue <ref> --round <n> --target all --acceptance 要修
node watchers/acceptance/bin/helper.mjs verdict --issue <ref> --round <n> --file <verdict.json>
node watchers/acceptance/bin/helper.mjs done    --issue <ref> --round <n>
```

`correct` 会先按「总 issue + 验收项」找开着的修正子 issue：有就复用，没有才开。

**watch 档只出裁决、写看板**：`watchRepos` 里的仓不关 issue、不开修正子 issue、不开修正 PR，只写轮次评论和看板。watch 档里 `close` / `correct` / `push` 一律拒绝。

## 6. 修正 PR 的规则

修正 PR 由**修正轮**（prbot，#60）推进，不是这一轮验收运行去改代码。这一轮只把规则照做：

- 改代码、推送、开 PR 都经写操作出口，不绕过。
- 先按修正标记找已有的修正 PR：有就接着推，不重复开。
- 从最新 main 开分支、指向 main；分支名 `acceptance/<总 issue 号>-<出处 issue 号>-sc<k>`。
- 正文写「任务 issue：<ref>」和「Closes <ref>」两行，再加修正标记那一行。
- 所有仓都先开 Draft（`pr.create` 必须带 `draft: true`，不带写闸就拒）；CI 全绿后由 prbot 自己转 Ready。Mivo 也一样，**不设审查机进场门禁**。
- 转 Ready 就是交接：之后由本地盯梢和审查机判断。PR 开出后看板「验收」写「修正中」。
- `makecindy/cindy` 从 fork 提：`pr.create` 的 head 写 `<ownerLogin>:<分支>`；其它仓 head 只写分支名，带别的前缀写闸就拒。
- 没有盯梢的仓转 Ready 后由我在 GitHub 里合并（Slack 消息带「打开 PR」链接）。
- **转 Ready 后不再推送、不回评论**；**任何情况下都不合并、不 Approve**。

## 7. 推送前的密钥扫描

```sh
node watchers/acceptance/bin/helper.mjs push --issue <ref> --round <n> --repo <owner/repo> \
  --branch acceptance/<总 issue 号>-<出处 issue 号>-sc<k> --worktree <目录>
```

`helper push` 先扫要推的改动：有 gitleaks 就用，没有就用内置规则（私钥头、常见令牌格式）。

- 扫到（退出码 `5`）就**不要重试**，也没推。
- 写闸在沙箱外再扫一遍，扫到返回 `4`、`reason=secret-found`，同样不要重试；这种情况这一轮**不标「中断」**。
- 两种情况都照常写 `verdict` 再 `done`：裁决会自动带上「需人工处理」并只列文件名，结论是「要修」，**绝不写密钥内容**。

## 8. 顺序

`close` / `correct` / `board` / `push` 都必须在 `verdict` 之前做完：`verdict` 一写，这一轮就结束了，之后所有写命令都会被认领检查拒绝。

## 9. 退出码

| 退出码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 成功 | 继续下一步 |
| `1` | 其他失败（参数错、配置错、watch 档不许这个命令） | 读 stderr，不要重试同一轮 |
| `3` | 认领检查没过（不是本轮，或已不是「验收中」） | 停手：这一轮不是你的了 |
| `4` | 写闸拒绝 | 停手：这一轮已标「中断」。`reason=secret-found` 除外：不标中断，照第 7 节继续写裁决（自动带「需人工处理」）再 `done` |
| `5` | 本地扫到疑似密钥，什么都没推 | 不要重试推送；照第 7 节写裁决（自动带「需人工处理」）再 `done` |

## 10. 评论和正文的规矩

- 所有写操作用我的账号，都经写闸；评论开头一律带「[验收机]」。
- 裁决和修正子 issue 里**不写**云端路径、令牌、运行 id、密钥内容；helper 会自动脱敏，你自己也别写。
- 看板只写「验收」和「裁决」两个字段，其它字段不碰。

## 11. 最后一步

最后一步必须是：

```sh
node watchers/acceptance/bin/helper.mjs done --issue <ref> --round <n>
```

它把这一轮标成结束。没写裁决之前 `done` 会退出码 `3`。
