# 舰队任务标准

清单里每条任务用同一份 YAML 头。必填字段是 `id`、`owner`、`check`、`deadline`、`escalate`、`evidence`。条目之间用单独一行的 `---` 分开。

`check` 是一行只读 shell，退出码 0 表示成立。需要人读改动的条目写成 `check: manual`，并且必须写 `sampler`（抽检人）和 `frequency`（频率）。`manual` 不会被执行，也不能当成机器已经查过。

示例清单：[`config/examples/fleet-checklist.example.md`](../config/examples/fleet-checklist.example.md)。

## 执行

```sh
node watchers/acceptance/bin/fleet-standard.mjs check \
  --list config/examples/fleet-checklist.example.md \
  --evidence-dir /path/to/evidence \
  --alerts-file /path/to/alerts.jsonl
```

`--evidence-dir` 和 `--alerts-file` 必须显式传入，没有默认的个人路径。默认超过 60 秒还没退出就判红，退出码记为 124。可以用 `--timeout-ms` 改这个上限。

执行器只跑清单里的命令，用来判断成立与否。它不走写闸，不读令牌文件，也不会把父进程里的令牌环境变量传给检查子进程。它不接入验收机的轮次、裁决和调度。

## 证据

每次检查追加一行 JSON 到 `--evidence-dir` 下的 `YYYY-MM-DD.jsonl`（按 `at` 的 UTC 日期）。每行至少有：

| 字段 | 含义 |
|---|---|
| `at` | 时间，ISO-8601 UTC |
| `source` | 来源，取该条目的 `evidence` 字段 |
| `result` | 结果：`pass`、`red` 或 `manual` |

一天一个文件。验收机上的约定是 `~/acceptance/evidence/<日期>.jsonl`；调用时用 `--evidence-dir` 指到那个目录，代码里不把这条路径当成默认值。

## 红灯

判红（退出码不是 0，或超时）追加到 `--alerts-file`。验收机上这个文件就是宿主的 `alerts.jsonl`。

| kind | 何时写 |
|---|---|
| `fleet-check-red` | 这一次判红 |
| `fleet-check-escalate` | 同一条红灯连续 2 小时没有变成通过。`escalate` 是催办人 |

中间有过 `pass` 或 `manual` 记录，红灯就从下一次重新计时，不会沿用旧的催办。

## 表格

```sh
node watchers/acceptance/bin/fleet-standard.mjs table \
  --list config/examples/fleet-checklist.example.md
```

`--list` 可以重复，多份清单拼成一张表。列是 `id`、`owner`、`check`、`deadline`、`escalate`、`evidence`、`sampler`、`frequency`。

## 箱上的过时条目

vigil#131 和 vigil#119 的过时条目在验收机的 `board.md` 和 fleet-checklist 里。这两份文件不在本仓库，示例清单里也没有它们。仓库里的脚本不会假装已经删掉。需要验收机上维护这两份清单的人自己清理。
