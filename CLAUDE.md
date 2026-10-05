# Vigil

> 创建日期：2026-10-02
> 技术栈：node

## 项目目标

PR 自动化盯梢：Mivo / Cindy 两套 watcher。发现器每 5 分钟用脚本轮询本人 PR，只有出现新审查反馈、CI 失败或冲突时才唤醒该 PR 的专属修复 session

## 技术栈

- **主语言**：node
- **框架/库**：（待补充）
- **运行环境**：（待补充）

## 目录约定

```
Project Vigil/
├── CLAUDE.md           # 本文件 — 项目指引
├── AGENTS.md           # 给 AI agent 的额外约束(sanitize(脱敏)硬规则等)
├── VERSIONING.md       # 版本管理规范
├── README.md           # 用户向项目说明(含英文介绍段)
├── LICENSE             # MIT
├── .gitignore          # Git 忽略规则
├── package.json        # type:module，无第三方依赖，scripts.test 跑全部测试
├── .github/workflows/test.yml   # CI：node --test ×2 + cindy 的 python 测试
├── watchers/
│   ├── mivo/           # 同仓分支场景 watcher：bin/、*.test.mjs、deploy.mjs、README.md
│   └── cindy/          # cross-repo fork 场景 watcher，结构与 mivo 一致
├── config/examples/    # 每个 watcher 一份 profile 配置样例(占位值)
├── docs/               # architecture.md + operations.md
├── src/                # 源代码(本项目实际代码都在 watchers/ 下，此目录暂空)
├── tests/              # 测试(本项目实际测试都在 watchers/<name>/*.test.mjs，此目录暂空)
├── data/               # 数据文件（大数据用 Git LFS 或外置存储）
└── history/            # ECC 会话数据（不入 git）
    ├── checkpoints/
    └── daily/
```

## 协作约定

- **AI 助手**：Claude Code（主），其他 provider 通过 `/ask` 调用
- **代码评审**：通过 `/review` 触发
- **测试覆盖**：参见 VERSIONING.md

## 代码规范

- 遵循 `~/.claude/rules/node/` 下的语言规范
- 全局规范：`~/.claude/rules/common/`
- 项目特定 invariants：本节后续追加

## 敏感数据保护

**绝不入 git 的内容**：
- `.env`、`*.key`、`*.pem`、`credentials/`、`*.token.json`、`.auth.json`
- 任何含 API key / OAuth token / 密码的文件
- 用户个人信息（PII）

`.gitignore` 已配置基础排除。新增敏感文件类型时同步更新。

## 测试与守卫

- 运行测试：`npm test`（等价于分别跑 `watchers/mivo` 与 `watchers/cindy` 的
  `node --env-file=<watcher>/test.env --test <watcher>/*.test.mjs`，再跑
  `python3 -B watchers/cindy/cindy-watch-script.test.py`）
- Lint：无（本项目无第三方依赖，未引入 lint 工具链）
- 类型检查：无（纯 JS，未使用 TypeScript）
- CI：`.github/workflows/test.yml`，PR 与 push 到 `main`/`feat/*` 时跑 `npm test`

## 版本管理

详见 `VERSIONING.md`。

**核心约定**：
- 提交触发：手动喊"提交代码"/"commit" → `commit-projects` skill
- 分支策略：`main` 为主分支
- Push 策略：日常本地优先，push 到远端是独立决策；首次建仓例外由 init 脚本自动 push（见 VERSIONING.md §6）

---

## 项目特定记录

- **来源**：`watchers/mivo` 与 `watchers/cindy` 的代码是从一个私有仓库(`approve-exec-src`)
  的 `integrations/mivo-watcher/`、`integrations/cindy-watcher/` 剥离出来的，以全新历史提交
  到本仓，不保留原仓库 commit 历史。sanitize(脱敏)的硬规则见 `AGENTS.md`。
- **配置机制**：两个 watcher 共享同一套 `bin/profile.mjs`：环境变量 > `<watcher
  home>/config/profile.json` > fail-closed 报错，不接受任何个人路径作为默认值。具体字段见
  各 watcher 的 README。
- **两个 watcher 故意不耦合**：`cindy` 历史上由 `mivo` 复制改造而来(加了 cross-repo fork
  支持)，但现在是两套独立实现，`bin/` 目录互不 import。重构成共享模块前要先确认这是明确
  要求，而不是顺手优化。
- **已知的两处非对称设计**(不是遗漏，是故意的)：
  1. `targetRepo`：mivo 用 `requireConfig`(完全 fail-closed，无默认值)，cindy 用
     `optionalConfig` 并有一个合法的公开仓库默认值 `makecindy/cindy`。
  2. `pluginRepoPath`(两边)与 `preflightFile`(仅 cindy)在函数内部先手动预检对应环境变量，
     命中就直接返回，否则才落到 `requireConfig`——这条路径上 `profile.mjs` 的报错文案只会
     提示 profile 字段名/hint，不会提示环境变量名，和 `targetRepo`/`watchHomes` 的报错路径
     不同。
- **验证基线**：`npm test` 应为 290(mivo) + 348(cindy) = 638 个 node 测试全绿，加 cindy 的
  2 个 python 测试；`node scripts/check-sanitized.mjs` 应退出 0（本机如果配置了私有词清单
  `config/sanitize-denylist.local`，该脚本会一并扫描；该文件本身绝不提交，CI 里不存在也是
  预期行为，脚本会打印提示并仅跑内置通用模式）。真正的私有组织名/仓库名/主机名**不要**
  写进本仓库任何被跟踪的文件（包括本文件和 `AGENTS.md`）——哪怕是作为"禁止出现的例子"写
  出来，一旦仓库公开，这些例子本身就是泄露；它们只应该出现在本机未跟踪的本地 denylist
  文件里。`PraiseZhu` 这个用户名的唯一例外仍是 `LICENSE` 与各 `README.md` 的作者署名行。
