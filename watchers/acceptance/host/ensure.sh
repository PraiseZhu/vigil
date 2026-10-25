#!/bin/sh
# 每小时一次的 routine 调用这个脚本（#47 SC12）：心跳正常就什么都不做；心跳过期或循环不在就拉起来。
# ACCEPTANCE_NOW_MS 只给测试用，可以冒充「现在」。连跑两次也只有一个循环（loop 自己是单实例）。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${ACCEPTANCE_WATCHER_HOME:?需要 ACCEPTANCE_WATCHER_HOME}"
HB="$HOME_DIR/state/host/heartbeat.json"
mkdir -p "$HOME_DIR/state/host"

# 输出 "<ageMs> <alive 0|1>"；心跳读不出时输出 "missing"。
read_heartbeat() {
  node -e '
    const fs = require("node:fs");
    const [file, nowRaw] = process.argv.slice(1);
    let hb = null;
    try { hb = JSON.parse(fs.readFileSync(file, "utf8")); } catch { hb = null; }
    if (!hb) { process.stdout.write("missing"); process.exit(0); }
    const now = Number(nowRaw) > 0 ? Number(nowRaw) : Date.now();
    const at = Date.parse(hb.at || 0);
    const age = Number.isFinite(at) ? now - at : 999999999;
    let alive = 0;
    const pid = Number(hb.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = 1; } catch {}
    }
    process.stdout.write(age + " " + alive);
  ' "$HB" "${ACCEPTANCE_NOW_MS:-}"
}

state="$(read_heartbeat)"
case "$state" in
  missing)
    reason=heartbeat-stale
    ;;
  *)
    # shellcheck disable=SC2086
    set -- $state
    age="$1"
    alive="$2"
    if [ "$alive" = "1" ] && [ "$age" -le 180000 ]; then
      exit 0
    fi
    if [ "$age" -le 180000 ]; then
      reason=loop-not-running
    else
      reason=heartbeat-stale
    fi
    ;;
esac

setsid nohup "$DIR/loop" >> "$HOME_DIR/state/host/loop.log" 2>&1 &
node "$DIR/paths.mjs" alert loop-restarted "$reason" || true
exit 0
