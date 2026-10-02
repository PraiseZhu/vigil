# Cindy PR 盯梢修复工具

[Mivo watcher](../mivo/README.md) 的 fork 场景变体：PR 的 head 在你自己的 fork 上,base 在
一个你没有写权限的上游仓库(默认目标是公开仓库 `makecindy/cindy`)。轮询你自己的 open PR,
发现新的审查反馈 / CI 失败 / 与上游的冲突时整理成结构化任务;**绝不 push 到 base 仓**,只
fast-forward 到你 fork 上的 PR 分支。本轮通过只代表"修复 session 认为可以请维护者审批了",
不会代替维护者做任何审批动作。

## 与 Mivo watcher 的核心差异

| 项 | Mivo(同仓分支) | Cindy(cross-repo fork) |
|----|------|-------|
| origin | 插件仓本身 | PR head 所在的 fork;`upstream` 远程只用来 `fetch`,不 push |
| push 目标 | origin 上的 PR 分支 | 只允许 fast-forward 到 fork 的 `headRefName`;硬编码拒绝向 base 仓 push |
| 冲突处理 | `git merge origin/main` | `git fetch upstream main` 后在 PR 分支上 merge,再 push 回 fork |
| 本轮通过 | 打标签 | 等待一个外部状态位(默认约定名 `awaiting-maintainer-approval`),仍需维护者人工 approve |
| 停止盯梢 | 打标签(有仓库写权限) | 走 `config/optout.json` 配置,或作者本人在 issue comment 里发 `/cindy-watch off`(fork 场景下你可能没有打标签权限) |

可信审查来源的判断方式:GraphQL 返回的 Bot 账号 `login` 不带 `[bot]` 后缀,代码按
`__typename === "Bot"` 归一化后再与白名单比较(见 `cindy-pr-policy.mjs`)。

与 [mivo watcher 相同](../mivo/README.md#这是什么不是什么),discover 模式不是可以配进任意
cron 的无状态脚本,而是专门为 Cindy 桌面端的调度器("script 模式")设计的,机制与安装步骤见
根目录 [`README.md`](../../README.md#安装与部署)。

Review thread 的"已处理"判定:thread 一旦被标记 `resolved` 就视为已处理,不再据此派发修复
(混合优先级评论不会被这套工具自动 resolve,所以 resolve 只可能来自人工操作);
`resolved → unresolved` 的高优先级 thread 会重新进入待处理队列。

## 配置:profile.mjs 的 fail-closed 机制

机制与 [mivo watcher 完全一致](../mivo/README.md#配置profilemjs-的-fail-closed-机制),
`watcher home` 解析为 `CINDY_WATCHER_HOME` 环境变量 > `bin/` 目录的上一级目录。

### 必填项

| profile 字段 | 环境变量 | 用途 |
|---|---|---|
| `pluginRepoPath` | `CINDY_WATCHER_REPO`(函数内手动预检,不经过 `profile.mjs` 的 fail-closed 报错路径) | 本地项目工作仓的绝对路径 |
| `preflightFile` | `CINDY_PREFLIGHT_BIN`(同上,函数内手动预检) | 推送前预检脚本的绝对路径 |

### 可选项(有安全/合理默认值)

| profile 字段 | 环境变量 | 默认值 |
|---|---|---|
| `targetRepo` | `CINDY_WATCHER_TARGET_REPO` | `makecindy/cindy`(公开仓库,可直接用,也可覆盖成别的仓) |
| `watchHomes` | `CINDY_WATCHER_WATCH_HOMES`(逗号分隔) | `[]`(不内置任何路径) |

拷一份 [`config/examples/cindy.profile.example.json`](../../config/examples/cindy.profile.example.json)
到 watcher home 下的 `config/profile.json`,把占位值换成真实路径即可。

其余环境变量(`CINDY_WATCHER_MODE`/`CINDY_WATCHER_PR`/`CINDY_WATCHER_NODE_ID`/
`CINDY_WATCHER_ENABLED`/`CINDY_WATCHER_DISPATCH`/`CINDY_WATCHER_BRIDGE`)是运行时/调度相关
的开关,不经过 profile 机制,直接读 `process.env`,具体含义见对应源码文件头部注释。

## CLI

```sh
node bin/cindy-watcher.mjs                                     # 默认 discover 模式
CINDY_WATCHER_MODE=poll CINDY_WATCHER_PR=<N> node bin/cindy-watcher.mjs --node-id <id>   # 手动单跑一个 PR,排障用

node bin/cindy-repair.mjs <子命令> --home "$CINDY_WATCHER_HOME"

node bin/cindy-ownership.mjs --repo makecindy/cindy --pr 123 --home "$CINDY_WATCHER_HOME"
```

## 运行锁与 lock-doctor

`state/locks/<name>.lock` 用于防止同一个 PR 被并发处理两次;锁文件内容是 JSON
`{pid, token, createdAt}`。接管一个疑似失效的锁时,先用 `mkdir <name>.lock.reclaim` 占一个
"接管守卫"(`EEXIST` 即说明别人正在接管,直接判 busy)——**锁层从不自动删除别人的守卫**,
避免两个进程同时拿到锁的竞态。

人工清理卡死的接管守卫:

```sh
node bin/cindy-repair.mjs lock-doctor --home "$CINDY_WATCHER_HOME"
node bin/cindy-repair.mjs lock-doctor --home "$CINDY_WATCHER_HOME" --clear-guard discover
```

`--clear-guard` 只有在守卫的进程确实已经不存在、且文件修改时间超过 10 分钟时才会清除,
清除前会先独占 `state/locks/maintenance.lock` 防止并发清理。

## 部署脚本(可选)

与 [mivo 的 `deploy.mjs`](../mivo/README.md#部署脚本可选) 用法一致,四个子命令
`verify`/`bootstrap`/`preview`/`apply` 都是纯文件系统操作加哈希校验,不绑定具体调度器。
`--database` 指向的 sqlite3 文件只用于一个可选的"目标会话是否空闲"检查,不需要可以自行移除。

## 测试

```sh
node --env-file=watchers/cindy/test.env --test watchers/cindy/*.test.mjs
python3 -B watchers/cindy/cindy-watch-script.test.py
```

测试里的仓库名、fork 用户名、session id 均为占位数据(`ExampleUser/cindy-fork` 等),
不对应任何真实账号或仓库。`repair-lifecycle.test.mjs` 里的 Git/文件操作是真实执行在临时
本地仓上的,GitHub API 与下游任务派发是受控 fixture,不代表真实网络调用。
