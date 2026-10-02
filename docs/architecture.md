# 架构说明

## 整体结构

```
watchers/
├── mivo/     同仓分支场景
└── cindy/    cross-repo fork 场景(mivo 的变体)

config/examples/   每个 watcher 一份 profile 配置样例(占位值)
docs/              本文档 + 运维指南
```

两个 watcher 彼此独立,互不 import,各自一套完整的 `bin/*.mjs` + 测试文件。`cindy` 历史上
是从 `mivo` 复制而来并改造出 cross-repo fork 支持,但现在是两份独立代码,修改一边不会自动
同步到另一边。

## 单个 watcher 内部的模块划分(两边结构一致)

| 模块 | 职责 |
|---|---|
| `bin/profile.mjs` | 配置解析:环境变量 > `config/profile.json` > fail-closed 报错 |
| `bin/<name>-watcher.mjs` | discover/poll 工作流:轮询 PR、判断是否有新反馈、生成任务 |
| `bin/<name>-repair.mjs` | 具体 Git 操作:clone/worktree、push、冲突处理、worktree 清理、锁与 lock-doctor |
| `bin/<name>-ownership.mjs` | 查询某个 PR/session 当前的归属状态,独立 CLI |
| `bin/<name>-pr-policy.mjs` | 可信审查来源、严重度分级等策略判断 |
| `bin/<name>-feedback-policy.mjs` | 哪些反馈需要触发修复、哪些只需 reply |
| `bin/<name>-ci.mjs` | CI 状态查询与(mivo 场景下)rerun 封装 |
| `bin/<name>-pr-snapshot.mjs` | PR 快照的拉取与裁剪 |
| `bin/<name>-review-resolve.mjs` | review thread 的 resolve/unresolve 判定 |
| `bin/<name>-state.mjs` | 状态文件读写、锁实现(`acquireLock`/`acquireDeployExclusive`) |
| `deploy.mjs` | 无数据库依赖的部署脚本:校验、原子安装、回滚 |

## 状态存储

每个 PR 的状态是独立的 JSON 文件(`state/prs/<nodeId>.json`),而不是单个大状态文件——这样
并发处理多个 PR 时互不阻塞。遗留的单文件格式(`state/state.json`)仍被读取支持(向后兼容),
但新写入只用 per-PR 文件。

## 调度:依赖 Cindy 桌面端的 script 模式调度器

两个 watcher 不是"裸脚本,自己决定怎么跑",而是**专门为 Cindy 桌面端的调度器设计**的:

- Cindy 侧创建一条 `executionMode: "script"` 的 schedule,`cronExpr` 设为每 5 分钟一次
  (`*/5 * * * *`),`scriptConfig.command` 指向 `python3 <watcher home>/bin/<name>-watch-script.py
  --mode discover`。
- 这条 schedule 的 `scriptConfig.capabilities` 只授予 `sessions.dispatch` 这一项能力(白名单
  默认全拒),discover 脚本因此**只能**唤醒/派发修复 session,不能调用任何其他宿主能力。
- `*-watch-script.py` 与 Cindy 宿主之间走 `cindy-script/1` JSONL 双工协议(`bin/protocol.py`):
  脚本把 Node watcher(`*-watcher.mjs`)当子进程启动,把其 stdout 里 `type: "dispatch"` 的帧
  转发给宿主的 `sessions.dispatch` RPC,再把结果回写到 Node 进程的 stdin。
- 完整的创建参数(字段表)、安装步骤见 [`docs/operations.md`](operations.md#2-调度在-cindy-里创建发现器调度)。

这意味着"调度"和"PR 盯梢业务逻辑"仍是两个代码层(Cindy 的调度器 vs. watcher 的
discover/poll 工作流),但 Vigil 的 discover 流程**假定自己跑在 Cindy script 模式之下**
(`*-watch-script.py` 的 `main()` 会检查 `CINDY_SCRIPT_PROTOCOL=1`/`XDT_MAKER_SCRIPT_PROTOCOL=1`
环境变量,没有就直接拒绝空跑),不是一个可以随意换成任意 cron 的无状态脚本。
