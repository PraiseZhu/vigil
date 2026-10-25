#!/bin/sh
# 停用（#47 SC4）：按心跳里的 pid 停掉常驻循环。写闸总开关没动，想连写一起停就删 state/write-gate/enabled。
set -u
HOME_DIR="${ACCEPTANCE_WATCHER_HOME:?需要 ACCEPTANCE_WATCHER_HOME}"
pid="$(node -e '
  const fs = require("node:fs");
  try {
    const hb = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (Number.isInteger(hb.pid) && hb.pid > 0) process.stdout.write(String(hb.pid));
  } catch {}
' "$HOME_DIR/state/host/heartbeat.json")"
if [ -z "$pid" ]; then
  echo "心跳里没有 pid，循环没在跑" >&2
  exit 0
fi
if kill "$pid" 2>/dev/null; then
  echo "已停常驻循环（pid $pid）"
else
  echo "pid $pid 已经不在" >&2
fi
exit 0
