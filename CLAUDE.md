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
├── VERSIONING.md       # 版本管理规范
├── README.md           # 用户向项目说明
├── .gitignore          # Git 忽略规则
├── src/                # 源代码
├── docs/               # 文档
├── tests/              # 测试
├── data/               # 数据文件（大数据用 Git LFS 或外置存储）
├── config/             # 配置（不含 .env）
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

（按项目实际填写）

- 运行测试：`（待定）`
- Lint：`（待定）`
- 类型检查：`（待定）`

## 版本管理

详见 `VERSIONING.md`。

**核心约定**：
- 提交触发：手动喊"提交代码"/"commit" → `commit-projects` skill
- 分支策略：`main` 为主分支
- Push 策略：日常本地优先，push 到远端是独立决策；首次建仓例外由 init 脚本自动 push（见 VERSIONING.md §6）

---

## 项目特定记录

（在此追加项目的具体决策、踩坑、TODO）
