# 验收调度：宿主调用约定

对应本仓 issue #45。合入后，宿主调度器（2026-10-24 起是本仓 `watchers/acceptance/host/loop`，#47）每分钟按下面的顺序调几条命令，就能把验收跑起来。本 issue 只提供命令和调用约定，**不自带调度循环、进程管理、重试和告警**。

## 1. 每分钟的顺序

1. `node watchers/acceptance/bin/poll.mjs --json`：拿到该开始的任务和卡死的轮次（#44）。
2. 过宿主**资源门**（内存门 + 测试锁）。**资源门放在认领之前**：资源不够就等下一分钟，不认领、不发评论。
3. `node watchers/acceptance/bin/round.mjs start --issue <owner/repo#n>`：认领一轮，拿到派发消息。
4. 用 pi（模型见 #46/#47）跑这条消息；消息从标准输入交给 agent。
5. 跑的过程中定期 `node watchers/acceptance/bin/round.mjs status --issue <owner/repo#n> --json` 看有没有卡住。卡住时**先结束进程再 abort**：先 kill 掉 agent 进程，等它退出，再 `round.mjs abort`。
   本仓的宿主（`host/round.mjs`，#47）不信 `status` 的 `stalled`：那是按 `stateDir` 里模型写的 `lastProgressAt` 算的，
   而 `stateDir` 对沙箱可写、能伪造。宿主自己的卡住判定见第 5 节。

`start` 的标准输出：先打印派发消息，**最后一行**是 JSON（`issue`、`round`、`commentId`、`bodyVersion`）。宿主把除最后一行以外的内容当消息，把最后一行当轮次信息。

## 2. 退出码

| 退出码 | 含义 | 调度器怎么做 |
|---|---|---|
| `0` | 成功 | `start` 拿到了消息，继续跑 agent；`status`/`abort` 正常完成 |
| `1` | 其他失败（配置错、参数错、未知错误） | 写日志，等下一分钟；不要自动重试同一轮 |
| `3` | 无事可做，或已被认领（不该验收、第 n 轮不存在/已结束） | 跳过这一条，等下一分钟；**不发评论** |
| `4` | 外发闸拒绝（`WriteRejectedError`） | 写日志并跳过；不要绕开写闸直接写 |

注意：`75`（外发忙）只由写闸返回，helper 按 #44 SC15 在内部重试，**不是 `round.mjs` 的退出码**；宿主看不到 75。

## 3. 中断后什么时候重开

由 #44 的**退避**（`trigger.mjs` 的 `BACKOFF_MINUTES`）决定：连续「中断」的轮次越多，等待越久。宿主**只看 `poll` 的输出：`poll` 不列出就不开**，不要自己算时间、也不要绕过 `poll` 直接重开。

## 4. 并发

- 同一时间**最多 2 轮**（验收轮和修正轮合计）。
- **mivo 最多 1 轮**（由测试锁保证）。
- `host.json` 的 **`serialRepos` 名单里的仓各自最多 1 轮**（同一套锁，每个仓一把，见 `docs/acceptance-operations.md`）。
- 两条之外还要过宿主的**内存门**。

示例脚本按顺序逐条处理任务，因此不会超过上面的上限。

## 5. 卡死的轮次（#44 SC17）

`poll --json` 里带 `stale: true` 的条目表示最新一轮停在「验收中」且超过 `stallMinutes` 没有进度。

「进度」以**宿主观察到的活动**为准（#47 SC11）：宿主跑一轮时盯着 pi 的输出（`pi.log` 在长）和本轮写闸 socket
上的请求，有活动就把时间写进 `<home>/state/host/progress/<owner>__<repo>__<issue 号>__<轮次>.json`（`<home>/state`
对沙箱整个遮住，模型写不了）。`poll` 的起算点取轮次评论的创建时间和这个宿主时间里较晚的那个；
`stateDir` 缓存里模型经 `helper progress` 写的 `lastProgressAt` **只作参考**（输出里的 `modelProgressAt`），
伪造到未来也延不了期。`helper progress` 本身要经写闸读一次轮次，所以照常写进度仍然算宿主看到的活动。
输出里的 `lastProgressAt` 是实际用来判定的时间，`hostProgressAt` 是宿主进度文件里的原值（没有就是 `null`）。

- 宿主**没有**这一轮的活进程：直接 `round.mjs abort --reason "卡死：进程不在"`。
- 宿主**有**活进程：先 kill 进程、等它退出，再 `round.mjs abort`。
- `abort` 会把轮次评论改成「中断」并写上原因、释放锁；这一轮之后的重开仍由 `poll` 的退避决定。
- 写闸总开关关着时宿主不 abort（abort 也是写，必被拒），也不起新轮次，只在心跳里记 `gate: disabled`。

## 6. 有争议、待裁决

`status --json` 的 `disputed` 列出本轮评论里带「有争议」的行，`pending` 列出带「待裁决」的行。`abort`/`status` 都不改裁决内容。

有争议时宿主另起一个**只读的裁决运行**（**已实现**：`host/adjudicate.mjs`，模型 `anthropic/claude-opus-5-5`、推理 medium，配在 host.json 的 `adjudicateCommand`），裁决结果写进下一轮的裁决评论：

- 最近一次出结论的轮次评论里有 `- 有争议：<owner/repo#n> SC<k> · …` 行、还没有裁决结果时，`trigger` 判 `awaiting-adjudication`，`poll --json` 不报「该开始」，而是报一条 `{"issue": "...", "adjudicate": true, "round": n, "items": ["owner/repo#n SC<k>", ...]}`。这种条目**不要** `round.mjs start`（start 也会以 `3` 退出）。
- 宿主（`host/tick.mjs`）用剩下的空槽起 `host/adjudicate.mjs run --issue <ref> --round <n> --item "<ref> SC<k>" ...`：过同一个内存门、占同一组槽；同一任务同一轮同时只有一个，出过结果不再起；沙箱里没有写闸 socket，GitHub 写不了。
- 结果写进宿主状态目录 `<home>/state/host/adjudications/<owner>__<repo>__<号>__<轮次>.json`；之后 `trigger` 判 `adjudicated`，`poll` 照常报「该开始」，`round.mjs start` 的派发消息带上裁决结果。
- 总时长上限 host.json `adjudicateMaxMinutes`（默认 30），超时先结束进程再写 `adjudicate-timeout`；一共最多跑 3 次，用完写 `adjudicate-needs-human`。没配 `adjudicateCommand` 就不起，写 `adjudicate-not-configured`（一天一次）。

## 7. 最小调度脚本示例

下面这段可以直接给 `sh` 跑。它每次只处理一轮、按顺序处理任务；`host/loop`（#47）可以照这个结构补上常驻循环、日志和告警。

```sh scheduler-example
#!/bin/sh
# 宿主调度器最小示例。必填：
#   ACCEPTANCE_BIN  watchers/acceptance/bin 目录
#   AGENT_CMD       接收派发消息（标准输入）的命令
# 可选：
#   RESOURCE_GATE   资源门命令；非 0 表示这一分钟先不跑（默认 true）
#   STATUS_INTERVAL 看进度的间隔秒数（默认 60）
set -u

: "${ACCEPTANCE_BIN:?需要 ACCEPTANCE_BIN}"
: "${AGENT_CMD:?需要 AGENT_CMD}"
RESOURCE_GATE="${RESOURCE_GATE:-true}"
STATUS_INTERVAL="${STATUS_INTERVAL:-60}"

work="$(mktemp -d "${TMPDIR:-/tmp}/acceptance-scheduler.XXXXXX")" || exit 1
trap 'rm -rf "$work"' EXIT HUP INT TERM

json_field() {
  node -e 'const fs = require("node:fs"); const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(data[process.argv[2]]));' "$1" "$2"
}

poll_json="$(node "$ACCEPTANCE_BIN/poll.mjs" --json)" || { echo "poll 失败" >&2; exit 1; }
printf '%s\n' "$poll_json" > "$work/poll.json"

# 卡死轮次（#44 SC17）：没有活进程就直接 abort；有活进程时先结束进程再 abort。
node -e '
const fs = require("node:fs");
const entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "[]");
for (const entry of entries) {
  if (entry && entry.stale) process.stdout.write(JSON.stringify(entry) + "\n");
}
' "$work/poll.json" > "$work/stale.jsonl"

while IFS= read -r line; do
  [ -n "$line" ] || continue
  printf '%s\n' "$line" > "$work/one.json"
  issue="$(json_field "$work/one.json" issue)"
  round="$(json_field "$work/one.json" round)"
  echo "卡死轮次：$issue 第 $round 轮，先结束进程再 abort" >&2
  node "$ACCEPTANCE_BIN/round.mjs" abort --issue "$issue" --round "$round" --reason "卡死：进程不在" < /dev/null >&2 \
    || echo "abort 失败：$issue" >&2
done < "$work/stale.jsonl"

# 该开始的任务：每行一个 issue 引用。有争议等裁决的条目（adjudicate）不认领，由宿主起裁决运行（第 6 节）。
node -e '
const fs = require("node:fs");
const entries = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "[]");
for (const entry of entries) {
  if (entry && !entry.stale && !entry.adjudicate) process.stdout.write(entry.issue + "\n");
}
' "$work/poll.json" > "$work/refs.txt"

# 顺序处理，保证同一时间最多 2 轮（验收轮与修正轮合计）、mivo 最多 1 轮。
while IFS= read -r issue; do
  [ -n "$issue" ] || continue

  # 资源门在认领之前：内存门或测试锁不过，就等下一分钟。
  if ! $RESOURCE_GATE < /dev/null; then
    echo "资源不够，跳过这一分钟：$issue" >&2
    continue
  fi

  if node "$ACCEPTANCE_BIN/round.mjs" start --issue "$issue" < /dev/null > "$work/start.out" 2> "$work/start.err"; then
    :
  else
    code=$?
    case "$code" in
      3) continue ;;
      4) echo "外发闸拒绝，跳过：$issue" >&2; continue ;;
      *) echo "start 失败（$code）：$issue" >&2; cat "$work/start.err" >&2; continue ;;
    esac
  fi

  # 标准输出：前面是派发消息，最后一行是 JSON。
  if [ "$(wc -l < "$work/start.out" | tr -d ' ')" -lt 2 ]; then
    echo "start 输出不完整：$issue" >&2
    continue
  fi
  sed '$d' "$work/start.out" > "$work/message.txt"
  tail -n 1 "$work/start.out" > "$work/round.json"
  round="$(json_field "$work/round.json" round)"

  # 后台跑 agent，派发消息从标准输入喂进去。
  $AGENT_CMD < "$work/message.txt" > "$work/agent.log" 2>&1 &
  agent_pid=$!

  while :; do
    sleep "$STATUS_INTERVAL"
    if ! kill -0 "$agent_pid" 2>/dev/null; then
      break
    fi
    stalled=0
    if node "$ACCEPTANCE_BIN/round.mjs" status --issue "$issue" --json < /dev/null > "$work/status.json" 2>/dev/null; then
      stalled="$(json_field "$work/status.json" stalled)"
    fi
    if [ "$stalled" = "true" ]; then
      # 卡住：先结束进程，再 abort。
      kill "$agent_pid" 2>/dev/null
      wait "$agent_pid" 2>/dev/null
      node "$ACCEPTANCE_BIN/round.mjs" abort --issue "$issue" --round "$round" --reason "卡住：超过 stallMinutes 没有进度" < /dev/null >&2 \
        || echo "abort 失败：$issue" >&2
      break
    fi
  done
done < "$work/refs.txt"
```

脚本里没有 `set -e`：单条命令失败只跳过这一条，不拖垮整分钟的调度。循环里的命令都显式 `< /dev/null`，避免它们读走 `while read` 的任务列表。

agent 正常退出后，如果它没把轮次评论改成终态，这一轮会停在「验收中」，超过 `stallMinutes` 没有进度后 `poll` 会把它报成卡死，由第 5 节处理。
本仓的宿主（`host/round.mjs`）不等这一步：agent 一退（任何退出码）就回读本轮状态，还是第 n 轮「验收中」就当场
`abort`（原因「pi 退出（code=…）但没写裁决」）并写提醒 `round-failed`；裁决写完 agent 却不退，宽限 2 分钟后先
SIGTERM 再 SIGKILL；从认领算起超过 `host.json` 的 `maxRoundMinutes`（默认 120）就停掉 agent、`abort`
（原因「超过总时长上限（N 分钟）」）并写提醒 `round-timeout`。见 [`acceptance-operations.md`](acceptance-operations.md) 第 4 节。
