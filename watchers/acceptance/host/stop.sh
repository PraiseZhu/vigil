#!/bin/sh
# 停用（#47 SC4）：按心跳里的 pid 停掉常驻循环。写闸总开关没动，想连写一起停就删 state/write-gate/enabled。
# 停成功会写 state/host/planned-stop.json，告诉 ensure.sh 这是主动停（部署更新等），拉起时不当意外重启。
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
  # 留一个「主动停的」标记：之后 ensure.sh 拉起循环时按部署重启记，不按意外重启提醒（标记 2 小时内有效，用一次就删）。
  node -e '
    const fs = require("node:fs");
    const [file, pid] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), by: "stop.sh", pid: Number(pid) }) + "\n", { mode: 0o600 });
  ' "$HOME_DIR/state/host/planned-stop.json" "$pid" || true
  echo "已停常驻循环（pid $pid）"
else
  echo "pid $pid 已经不在" >&2
fi
exit 0
