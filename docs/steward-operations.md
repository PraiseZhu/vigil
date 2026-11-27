# PR 总管：安装、验证和回滚

这套调度只在常驻机跑。每轮脚本直接执行，不启动模型；只有指令箱有未投递指令时，才给「PR 总管」伙伴的主对话发一条批量消息。实际修复仍由跟进会话经 GitHub 插件完成。

## 安装前体检

1. 按上线顺序等巡检、杂活、覆盖、守门及原会话跟进流程合入；选常驻机上一份固定检出，记录部署 SHA。不要把自动化指向临时开发工作树。任何换版本或生产切换须有对应授权，参见[部署授权边界](fleet-deploy-authorization.md)。
2. 复制[`steward.profile.example.json`](../config/examples/steward.profile.example.json) 到仓库外，以本机权限保护该配置与状态目录。填入 `authors`、`repos`、`stateDir`，为每个要巡检的仓设置 `policies.<repo>.chores.followerLogin`，它是该仓跟进方的 GitHub 登录名字符串，要与常驻机的 `gh` 登录一致。配置 `presence.commands` 时只用本机信任的探测命令。第一阶段用明确仓库列表（`discoverByAuthor: false`），不加入仍有老盯梢运行的仓；启用按作者发现时，同样检查 `excludeRepos` 和新发现仓的策略，不可借自动发现提前纳管。
3. 零消耗杂活默认关闭。四项开关放在 `policies.<repo>.chores`：`p3Close`、`resolveReverified`、`rerunInfra`、`rerunFalseGreen`。单一安装可继续用 `github.mode: "app"`；多个账号或组织用 `github.mode: "by-owner"`，在 `github.installations` 中按仓库所属账号或组织填写已授权安装的 `appId`、`installationId`、`privateKeyFile`。没有安装的仓继续用本机 `gh` 读取但不跑杂活；纯读取也可保留 `github.mode: "gh"`。密钥只留本机，示例里的安装 ID 和路径要替换后才能使用。P3 回复用 `p3Reply` 配置文案，由与 `followerLogin` 匹配的本机 `gh` 身份发送。用 `reverifiedPatterns` 配置已复核标记；`falseGreenNeeds` 必须把被跳过的检查名映射到前置 job 名列表，不能在同一轮 Actions 中定位唯一失败或取消项时不重跑。
4. 在选定检出目录设置 `STEWARD_PROFILE` 为本机配置的绝对路径，运行：

   ```sh
   node watchers/steward/deploy.mjs --check
   node watchers/steward/deploy.mjs --print-schedule
   ```

   体检会验证调度可用的 Node、Python、`gh`、配置、跟进账号和状态目录可写性，并逐项检查 App 密钥是否为可读文件。多账号配置中有密钥不可读时，错误会标出对应账号或组织。体检不证明 GitHub App 已获每个仓的权限，也不证明调度能使用同一 `PATH`；这些需在常驻机首轮验证。打印命令只输出参数，不创建伙伴或定时任务。

## 配置伙伴与调度

1. 在常驻机先查 Cindy 的伙伴和 `schedule_list`，按名称、用途、绑定会话和脚本命令核对是否已有「PR 总管」或同职能伙伴／巡检定时任务。发现现有实例先核对沿用对象；不再开一套并行巡检。
2. 经授权后由运维创建或沿用「PR 总管」伙伴，把[工作说明](../watchers/steward/companion/PROMPT.md)设为工作指令。给伙伴同一份本机 `STEWARD_PROFILE` 和部署检出路径，以及经授权的飞书通知会话和目标仓项目映射，不把设备、会话、群标识写进仓库。
3. 在常驻机用 Cindy 创建或更新**一条**巡检任务。以 `--print-schedule` 输出为准：用伙伴**主对话**的 ID 替换 `targetSessionId`，使用部署检出目录作为 `workingDir`，按需核对时区和伙伴引擎。确认执行模式 `script`、间隔 `180000` 毫秒、整轮超时 `165000` 毫秒、能力仅 `sessions.dispatch`。三分钟从上轮结束起算；不要再加一条 cron 并行跑。用 `schedule_get` 回读确认。
4. 逐台电脑打开 Cindy 的 GitHub 插件设置，确认「发完自动跟进」已开启；记下设备、核对时间和状态。未开启的交运维核实后恢复，不在部署脚本里改插件设置。

## 首轮真实验证

部署当天由 lead 在常驻机核对两项：

1. 打开巡检定时任务的运行记录，最新一轮状态为成功。空指令箱不应唤醒伙伴；如有指令，宿主接受投递不等于伙伴已办完。
2. 核对 `stateDir/last-scan.json` 的 `scanned_at` 属于该次运行，检查 `prs` 和分类。若 `discoveryErrors` 非空或有未知项，先查任务标准错误和 GitHub 权限，不把部分结果当完整结果。投递成功时间与批次键另存 `stateDir/outbox/deliveries/<ID>.json`；业务回执在 `outbox/receipts/<ID>.json`。已停手的 PR 只投递停手通知，旧指令不删、不标已投递。

首轮不临时伪造线上故障或离线。先观察至少三天；需要切换仍有老盯梢的仓时，等用户当次点名，按上线清单暂停该仓旧发现器、合入并同步跟进流程，再把该仓纳入总管并按授权打开杂活。

## 暂停与回滚

- 暂停巡检：用 `schedule_get` 核对 ID、设备和伙伴绑定，对这条巡检用 `schedule_pause`，回读确认并检查在途运行及伙伴待处理批次已经结束或停止；暂停不删除任务、状态、指令或回执。
- 回滚到老盯梢：先暂停总管或从本机配置排除要回滚的仓，核对该仓没有总管继续投递；检查是否仍有该仓专属会话在自动跟进，按授权停止其对应任务，确认没有双重跟进。再恢复之前暂停的旧发现器（未切换过则不改），按上线清单回退切换时同步的规则和跟进流程。保留旧状态与总管状态作为排障证据。
- 恢复巡检前重新体检、查重、核对绑定和仓库范围；保留旧扫描记录以便区分新一轮，不把旧文件当成运行成功。
