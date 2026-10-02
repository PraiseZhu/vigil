# AGENTS.md

本仓库是公开仓库,给 AI agent 的额外约束(优先于通用默认行为,不优先于用户当次明确指令):

## 这是什么仓库

两个 PR 盯梢工具(`watchers/mivo`、`watchers/cindy`)的开源发布版。源码从一个私有仓库剥离、
sanitize(脱敏)后以全新历史提交到这里,不保留原仓库的 commit 历史。

## 硬规则:禁止引入的内容

修改本仓库时,**不得**引入以下任何内容:

- 任何本机绝对路径(形如 `/Users/<username>/...`)、真实主机名。
- 任何真实私有仓库名、组织名(占位符一律用 `your-org/your-plugin-repo`、`example-org/...` 之类)。
- 真实的 token、密钥、session id、内部调度/派发 id。
- `PraiseZhu` 这个用户名只允许出现在 `LICENSE` 和 `README.md` 的作者信息里,**不得**作为
  测试夹具数据或硬编码在任何 `.mjs`/`.py` 源码或测试文件里——测试里需要一个"假的 GitHub
  用户名"时用 `ExampleUser` 之类的占位符。
- `makecindy/cindy` 是例外,是合法的公开仓库,可以作为 cindy watcher 的默认 `targetRepo`。

提交前跑:

```sh
node scripts/check-sanitized.mjs
```

这个脚本内置通用模式检查(本机绝对路径、私钥头、常见 token 格式),并会额外扫描
git 提交元数据(`author`/`committer` 的姓名与邮箱)。真正私有的组织名/仓库名/主机名**不要
写进本文件或任何被跟踪的文件**——它们只应该存在于你自己机器上、未被 git 跟踪的
`config/sanitize-denylist.local` 文件里(每行一个正则,该文件已在 `.gitignore` 中排除,
脚本检测到它存在时会自动一并加载)。退出码非 0 时按打印的 `file:line` 定位并修复。

## 配置机制:不要破坏 fail-closed

两个 watcher 的 `bin/profile.mjs` 是故意设计成"缺配置就报错",而不是"缺配置就用某个默认
路径"。新增任何需要本地路径/仓库名的功能时,遵循同样的模式:
`requireConfig(key, { env, envVar, hint })` 用于必填项,`optionalConfig` 仅用于确实有安全
默认值的字段(比如 `[]`、公开仓库名)。**不要**为必填项加个人路径作为默认值。

## 测试

```sh
npm test
```

等价于:

```sh
node --env-file=watchers/mivo/test.env --test watchers/mivo/*.test.mjs
node --env-file=watchers/cindy/test.env --test watchers/cindy/*.test.mjs
python3 -B watchers/cindy/cindy-watch-script.test.py
```

新增测试时,夹具数据(仓库名、用户名、路径)一律用占位符,不要引用真实数据,即便只是本机
开发时顺手写的"我自己的仓库名"。

## 两个 watcher 的源码不要互相耦合

`watchers/mivo` 和 `watchers/cindy` 是两套独立的实现(cindy 是 mivo 的 cross-repo fork 变体,
历史上由 mivo 复制而来,但彼此的 `bin/` 目录互不 import)。修改一边时不要假设另一边会同步
修改;如果发现两边有重复逻辑想要抽公共模块,先确认这是用户明确要求的重构,而不是顺手做的
"顺便优化"。

## 文档语言

面向用户的文档(README、docs/、本文件)以中文为主;根 `README.md` 顶部保留一段英文介绍,
供不读中文的使用者快速判断这是什么项目。
