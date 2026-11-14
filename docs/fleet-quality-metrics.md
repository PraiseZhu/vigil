# 舰队质量只读指标

并行组 C（本仓任务子 issue，见关联 PR）。这是**基线工具**：先能数，再谈提效。本文不承诺通过率、返工或重复唤醒会下降，也不用循环在跑、体检是绿、关上的单变多来证明达标。

心跳 / 保活不进入质量通过率。

## 怎么跑

路径必须显式传入。不读 `ACCEPTANCE_WATCHER_HOME`，不读令牌，不写 GitHub，不必改 `package.json`。

```sh
node watchers/acceptance/bin/fleet-quality-stats.mjs \
  --snapshot /path/to/readonly-dump \
  --timezone America/Los_Angeles \
  --now 2026-11-15T18:00:00Z
```

或：

```sh
node watchers/acceptance/bin/fleet-quality-stats.mjs \
  --comments comments.json \
  --issues issues.json \
  --events events.json \
  --alerts alerts.jsonl \
  --deploy-log deploy-log.jsonl \
  --heartbeat heartbeat.json \
  --from 2026-11-07 --to 2026-11-13 \
  --labeled-sample
```

`--snapshot` 可以是一份 JSON，也可以是目录（读其中的 `comments.json`、`issues.json`、`events.json`、`alerts.jsonl`、`deploy-log.jsonl`、`deploy-ff.json`、`heartbeat.json`，缺哪个就标 unknown）。

默认窗口：`--timezone`（默认 `America/Los_Angeles`）下、`--now` 所在「今天」之前的 **7 个完整本地日**。输出写明时区与 UTC 起止。这不是不加说明的 UTC 日。

## 输入适配（按现有真实结构，不是理想 schema）

| 来源 | 真实形状 | 本工具怎么认 |
|---|---|---|
| 轮次评论 | REST `GET /issues/{n}/comments`：`id`、`html_url`、`user.login`/`type`、`body`、`created_at`。GraphQL `issue.comments.nodes`：`databaseId`、`url`、`author { login __typename }`、`createdAt`。首行 `[验收机] 第 N 轮：验收中\|通过\|要修\|中断`，字段 `正文版本` / `开始` / `完成` / `原因`，结束评论可有 `## 逐条结果` | 两种都收。默认只计 `type=Bot`（GraphQL 的 bot login 会补 `[bot]`）。别人冒充首行的 User 评论不计 |
| 关单 | REST issue events：`event=closed\|reopened`、`id`、`created_at`、`actor`。issue 对象上的 `closed_at` / `closed_by` 可作补充 | 用于人工未验关单、返工（重开） |
| 告警 | `alerts.jsonl` 一行一条 JSON：`ts`、`kind`，可选 `issue`、`head`/`target`、`reason` | 显式 `--alerts`。没有文件 → 重复告警 unknown，不是 0 |
| 心跳 | `heartbeat.json`：`at`、`tickIntervalS`、`lastTick` | 保活：年龄 ≤ 拍间隔 + 60 秒（`tickIntervalS` 只认 1..3600 的整数）。**不进入质量通过率** |
| 部署 | 今天的 `deploy-ff.json` 是覆盖式状态 `{lagReportedFor, alerted, drain}` | **legacy 授权一律 unknown** |
| 部署（可选） | B 合入后的追加 JSONL：`ts`、`result`、`fromSha`、`toSha`、`sensitiveFiles`、`authorization: { commentUrl, authorType, sha }` | 可选适配。没有该文件不依赖 B 未合分支 |

父级在验收机上取数（本云端环境**没有**这些生产文件，工具用夹具验证，不声称已算全舰队七天）：

1. 用已有 `gh`（不要新装认证、不要越权、不要更新 issue）按窗口导出本仓 issue 的 comments 与 events。例如：`gh api repos/<owner>/<repo>/issues/<n>/comments`、`gh api repos/<owner>/<repo>/issues/<n>/events`。
2. 复制 `alerts.jsonl`、`heartbeat.json`；`deploy-ff.json` 只能证明授权未知。B 落地后改复制追加部署日志。
3. 轮次评论**没有** main SHA。完整「issue + 正文哈希 + 部署 SHA」重复唤醒还需要宿主日志，缺了就 unknown。

## 指标

每一项输出都带分子 / 分母 / `unknown` / `sources`（comment id/url、event id、log 行号或 ts、原始时间戳）。同一 issue 多轮**不夸分母**：有终局的单只看**第一次**终局（通过或要修）。纯中断（含预取失败）不进一次通过分母。环境等待（原因以 `环境问题（不是代码不通过）：` 开头的中断）另列。

| 键 | 分子 | 分母 | 去重 | 缺数据 |
|---|---|---|---|---|
| `firstPassOriginal` 原条件一次通过率 | 第一次终局是「通过」，且逐条都是带证据的通过（无人工手测、无空证据、无待核实的临时补测试） | 窗口内第一次终局可判定的单 | 一单一条 | 没有评论 → unknown |
| `rework` 返工 | 终局之后又出现要修，或通过之后被重开 | 有终局的单 | 一单最多一次 | 同左 |
| `emptyEvidencePass` 无证据通过 | 通过终局里存在空证据的通过项 | 可判定终局单 | 一单一条 | 没有评论 → unknown |
| `humanUnverifiedClose` 人工未验关单 | bot 关闭且该通过评论含人工手测 | 窗口内 bot 关闭的通过单 | 一单一条 | 没有 closed 事件 → unknown |
| `tempCopyUnverified` 临时副本补测试 | 证据匹配「临时副本补」测试/用例 | 可判定终局单 | 按项列出 | **待核实，不自动记作弊**。「可写副本」跑已入库测试不算 |
| `deployAuth` 授权不可核实的部署 | 已部署且敏感、授权不是 User 评论里的目标完整 SHA | 窗口内可判定的敏感部署次数 | 一次快进一条 | legacy 状态或无日志 → **unknown**，不是 0 |
| `deliveryLatency` 交付时延 | 分布（分钟） | 有 readyAt 与第一次终局的单 | 一单一次 | 缺 PR `mergedAt` → 该单 unknown。环境等待另列 `envWaitSeparate` |
| `repeatClaimSameBody` 重复唤醒（评论能看到的） | 同一 issue+正文版本的再次认领 | 窗口内认领次数 | 连续同一签名逐次计 | 没有评论 → unknown |
| `repeatWakeFullSignature` | 同上且带 main SHA | 认领次数 | 同左 | 评论无 main SHA → **unknown** |
| `repeatAlerts` 重复告警 | 同一 `kind + issue + 部署 SHA` 在 60 分钟内的第二条及以后 | 窗口内非心跳告警行数 | 按这个键 | 没有 `alerts.jsonl` → unknown |

`keepalive`：心跳是否新鲜、心跳类告警行。`notInQualityPassRate: true`。

本工具**从不**把 `coverage.productionSevenDayFleet` 设为 true。输入即使有七个本地日，也不能证明覆盖了整支舰队。

## 样例与实际统计

输出里 `samples.labeled` / `samples.doNotExtrapolate`。夹具按本仓公开总单第 16 轮评论与 bot `closed` 事件的**结构**建模，测试里仓库名是占位符。那是已确认样本，**不能外推舰队整体**。把 `--labeled-sample` 打开，避免和舰队统计混读。

## 回滚

删掉本工具与文档即可。不改历史评论、不改生产状态。
