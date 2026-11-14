# 舰队敏感部署授予与审计

本文件是 `watchers/acceptance/deploy-ff.mjs` 在「敏感快进」上的授予与审计说明。不改生产 crontab、不写生产授予文件、不自动部署。`docs/acceptance-operations.md` 第 11 节仍描述旧的 SHA 文件针脚；本文件是本轮合同 B 路的同伴文档。

## 1. 选择与理由

仓内已经有的闸：敏感路径/内容清单、完整 40 位 SHA 的 `--approve` / `--approval-file`、CI 必须绿、只快进、部署后 doctor、`needs-approval` 退出码 15。缺口是：SHA 文件可被同用户进程写入、用过即删、不记来源与区间、状态文件覆盖写、`doctor-failed` 停在新 SHA 且不回滚却没有可恢复的授权账本。

本轮不能做的：新密钥或新 secret、扩大账号权限、把每次常规合并/部署都推回用户手打评论、把 Jasper 委托扩成未来全部敏感操作、把 GitHub 登录名加 `User` 类型当成「人亲自批准」（代理可以同一身份写）、把普通同用户文件当成不可伪造信任根。

最小充分机制：

1. **保留**全部现有敏感规则和 SHA 针脚。针脚仍然必要（若提供必须等于目标完整 SHA），但**单独不再充分**。
2. **授予记录**（`--grant-file` 或 `--approval-file` 里一份 JSON，schema `vigil-deploy-grant/v1`）必须同时绑定：当前 HEAD（base）、目标完整 SHA、`git rev-list --reverse HEAD..target` 的全部提交、敏感规则版本、本轮用户委托、范围、Jasper 对本枚 SHA 的裁决、Grok4.7 xhigh 且 Fast=false 的独验证据（非空命令且退出码 0）、过期时间。
3. **追加式审计**（默认写在状态文件旁的 `deploy-ff-audit.jsonl`）。快进前写失败则失败关闭，工作区不动。
4. 明确执行路径：运维仍调用现有 `deploy-ff`；把绑定完整的授予记录交给脚本。不是 bot 自述、不是 `approved` 文本。

本轮可信用户来源只有父级可核实的 `t710u` 与 `t711u`，范围只有 `deploy-after-independent-verification`（独立验收通过后部署）。扩来源或扩范围必须再改敏感代码，并另走授予。

## 2. 威胁模型与残余风险

**不是密码学保证。** 当前环境没有独立于「跑 deploy-ff 的那个用户」的身份边界：不引入新密钥、不读现有密钥、不扩大权限。因此同用户进程仍可能伪造一份字段齐全的授予 JSON。本机制保证的是：

- 可检查的绑定失败关闭（旧 SHA / 短 SHA / 区间不符 / 过期 / 缺独验 / 超出 t710u+t711u 范围 / bot 评论 / 自写 approved / 仅 User 登录名 / 仅 SHA 文件 / 新机制自证旧门禁）。
- 每一次敏感决定留下不可覆盖的审计，父级能对照 t710u/t711u 原文和 Grok4.7 独验复跑。
- 日志先于快进；写不出日志就不快进。

**残余风险（交父级，不在本路削门槛）：** 同用户伪造授予记录；GitHub 上同一登录名的人与代理无法区分；独验证据里的命令退出码无法在部署机上密码学复验，只能由父级对照独验任务；过期判断只看本机时钟，把时钟拨回去等同于改了过期时间，属于同用户范围内的残余风险。若以后要强身份，需要单独批准的密钥或硬件边界，不在本 PR。

## 3. 门禁行为

敏感命中后：

| 输入 | 结果 |
|---|---|
| 无授予记录，即使 `--approve` 或 SHA 文件等于目标 | `needs-approval`，HEAD 不动，不排空不占槽 |
| 授予记录目标/base/区间/过期/独验/范围任一不符 | 同上 |
| bot 评论、`approved` 文本、GitHub User 登录名单独、SHA 文本 | 同上 |
| 授予记录完整绑定且针脚（若提供）等于目标 | 允许排空与快进 |
| 审计 JSONL 在快进前写失败 | `needs-approval`，原因写明审计失败，HEAD 不动 |

非敏感快进仍不需要授予记录。敏感规则本身（host、写闸、仓根 `package.json`、内容规则等）不因本文件放宽。

CLI 增加 `--grant-file` 与 `--audit-log`（可选；审计默认与 `deploy-ff.json` 同目录）。现有 crontab 仍可只传 `--approval-file`：若该文件仍是一行 SHA，敏感快进会停在 `needs-approval`；若改为授予 JSON，则按上表校验。本轮不改 crontab、不写那份生产文件。

`deploy-ff.mjs` 源码静态约束禁止出现 `authorization` 字样，所以字段和 CLI 用 grant。

## 4. 审计字段

一行一个 JSON，只追加。典型字段：`schema`（`vigil-deploy-audit/v1`）、`ts`、`attemptId`、`outcome`（`rejected` / `attempt` / `deployed` / `doctor-failed` / `pull-failed`）、`previousSha`、`targetSha`、`commits`、`sensitiveFiles`、`sensitiveRuleVersion`、`grantSource`、`grantScope`、`jasperVerdict`、`independentVerification`、`workspaceChanged`、`autoRollback`（恒为 false）、`recoverable`、`associatedFailure`。

`doctor-failed` 行：`workspaceChanged=true`，`autoRollback=false`，`associatedFailure` 含前后完整 SHA，可用 `attemptId` 找回对应的 `attempt` 行。只读统计（C 路）可以直接读这份 JSONL；本路不实现统计。

## 5. 自举

新机制**不能**证明旧门禁已经批准。`legacy-sha-file`、`bootstrap`、`provesLegacy`、只有 SHA 的批准文件，一律拒绝。

上线顺序：

1. 本 PR 合入后，生产机仍运行旧代码。第一次把生产快进到本 SHA，仍走**当时机器上的旧门禁**（完整 SHA 文件），外加父级 Grok4.7 独验与用户「独立验收通过后部署」的条件式批准。本 PR **不包含**那份生产 SHA 文件，也不代为部署。
2. 新代码上线之后，再做敏感快进必须带有效授予记录。只放 SHA 文件会停在 `needs-approval`，循环继续跑。

不要把本 PR 的授予模块拿来给「旧 SHA 文件曾经存在」补写一条通过。

## 6. 回滚与 doctor-failed 恢复

- 回滚是**新的 revert 提交**，目标是新的完整 SHA，再走同一套授予（新的 Jasper 裁决与独验）。不 `reset --hard`、不强推改历史。
- `doctor-failed`：工作区**已经**快进到目标 SHA，脚本不自动回滚。标准输出原因含「工作区已从（前 SHA）快进到（目标 SHA），未自动回滚」。审计行可恢复。下一拍若 HEAD 已等于 `origin/main`，现有逻辑会报 `up-to-date` 且不再跑 doctor；这是原行为。要从坏 SHA 离开：按审计里的 `previousSha` 做 revert 提交，或运维按授予后再快进到修复 SHA。
- 循环保持工作：本脚本不重启循环、不关自动化；`doctor-failed` 会放掉排空槽；主循环照常起轮次。

## 7. 本轮不做

不改 appOnly / 令牌文件 / 端口判定的宽严；不改宿主、验收关单、只读统计、调度模板；不读不生成不轮换密钥；不自动部署。
