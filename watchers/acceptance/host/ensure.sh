#!/bin/sh
# 每小时一次的 routine 调用这个脚本（#47 SC12）：心跳正常就什么都不做；循环不在就拉起来。
# 心跳过期但原循环进程还在、锁还占着：只记「心跳延迟」，不补起、不发重启提醒。
# 墙钟跳了很久、机器实际运行时间却只过了一小段（整机冻结/快照恢复）：记 host-frozen，也不补起。
# ACCEPTANCE_NOW_MS / ACCEPTANCE_UPTIME_S 只给测试用，可以冒充「现在」和开机秒数。连跑两次也只有一个循环（loop 自己是单实例）。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${ACCEPTANCE_WATCHER_HOME:?需要 ACCEPTANCE_WATCHER_HOME}"
HB="$HOME_DIR/state/host/heartbeat.json"
LOCK="$HOME_DIR/state/host/loop.lock"
# stop.sh 主动停循环时留下的标记（部署、手动停用）：ensure 据此把这次拉起记成「部署重启」，不按意外重启提醒。
PLANNED="$HOME_DIR/state/host/planned-stop.json"
PLANNED_MAX_MS=7200000
mkdir -p "$HOME_DIR/state/host"

# 输出 "<ageMs> <alive 0|1> <frozenMs> <monoAgeMs>"；心跳读不出时输出 "missing"。
# frozenMs / monoAgeMs：心跳里有 uptimeS、且机器没重启过（现在 uptime >= 心跳 uptime）才算；
# 否则都是 -1，后面当没有冻结信息，行为和改之前一样。ACCEPTANCE_UPTIME_S 只给测试用。
read_heartbeat() {
  node -e '
    const os = require("node:os");
    const fs = require("node:fs");
    const [file, nowRaw, uptimeRaw] = process.argv.slice(1);
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
    // 没设 ACCEPTANCE_UPTIME_S 时传进来的是空串，Number("") 是 0，不能当成开机 0 秒，要用真实 uptime。
    const nowUptime = Number(uptimeRaw) > 0 ? Number(uptimeRaw) : os.uptime();
    const hbUptime = Number(hb.uptimeS);
    let frozenMs = -1;
    let monoAgeMs = -1;
    if (Number.isFinite(hbUptime) && nowUptime >= hbUptime) {
      monoAgeMs = Math.round((nowUptime - hbUptime) * 1000);
      frozenMs = Math.max(0, age - monoAgeMs);
    }
    process.stdout.write(age + " " + alive + " " + frozenMs + " " + monoAgeMs);
  ' "$HB" "${ACCEPTANCE_NOW_MS:-}" "${ACCEPTANCE_UPTIME_S:-}"
}

# Slack 发送失败（重试用完，#61）：心跳的 slackFailing 一直留到下一次发成功。有就打一行到标准输出，
# routine 每小时跑这个脚本时就能看到（不管循环在不在）。
report_slack_failing() {
  node -e '
    const fs = require("node:fs");
    let hb = null;
    try { hb = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { hb = null; }
    const f = hb && hb.slackFailing;
    if (!f || typeof f !== "object") process.exit(0);
    const clean = (v) => String(v ?? "").replace(/[^A-Za-z0-9_:.+-]/g, "").slice(0, 80);
    process.stdout.write("slack-failed: since=" + clean(f.since) + " last=" + clean(f.lastAt) + " kind=" + clean(f.kind) + " error=" + clean(f.error) + " count=" + (Number(f.count) || 0) + "\n");
  ' "$HB" || true
}

# 单实例锁有没有人占着：loop 拿着 flock 跑；能当场拿到锁 = 没有循环在跑。锁文件不在也算没人占。
lock_held() {
  [ -e "$LOCK" ] || return 1
  if flock -n "$LOCK" true 2>/dev/null; then
    return 1
  fi
  return 0
}

# 输出 stop.sh 标记的年龄（毫秒）；没有标记或读不出输出 "none"。
read_planned_stop() {
  node -e '
    const fs = require("node:fs");
    const [file, nowRaw] = process.argv.slice(1);
    let mark = null;
    try { mark = JSON.parse(fs.readFileSync(file, "utf8")); } catch { mark = null; }
    const at = mark ? Date.parse(mark.at || 0) : NaN;
    if (!Number.isFinite(at)) { process.stdout.write("none"); process.exit(0); }
    const now = Number(nowRaw) > 0 ? Number(nowRaw) : Date.now();
    process.stdout.write(String(Math.max(0, now - at)));
  ' "$PLANNED" "${ACCEPTANCE_NOW_MS:-}"
}

log_line() {
  printf '%s ensure: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$HOME_DIR/state/host/loop.log"
}

state="$(read_heartbeat)"
report_slack_failing
pid_alive=0
frozenMs=-1
monoAgeMs=-1
case "$state" in
  missing)
    reason=heartbeat-stale
    ;;
  *)
    # shellcheck disable=SC2086
    set -- $state
    age="$1"
    pid_alive="$2"
    frozenMs="${3:--1}"
    monoAgeMs="${4:--1}"
    if [ "$pid_alive" = "1" ] && [ "$age" -le 180000 ]; then
      exit 0
    fi
    if [ "$age" -le 180000 ]; then
      reason=loop-not-running
    else
      reason=heartbeat-stale
    fi
    ;;
esac

# 保守：只有「心跳里的 pid 还活着」且「单实例锁还被占着」两条同时成立，才认为原循环还在、只是心跳慢了
# （常见是整机被暂停/快照恢复，或某一拍跑得久）。这时不补起新循环（补起的也拿不到锁、会直接退出）。
# 墙钟跳了 ≥60 秒、按机器实际运行时间心跳还在 180 秒内：是整机冻结，记 host-frozen，不当心跳延迟。
# 任何一条不成立都按原来的方式拉起并提醒，真挂掉的循环不会被漏掉。
if [ "$reason" = "heartbeat-stale" ] && [ "$pid_alive" = "1" ] && lock_held; then
  secs=$((age / 1000))
  if [ "$frozenMs" -ge 60000 ] && [ "$monoAgeMs" -ge 0 ] && [ "$monoAgeMs" -le 180000 ]; then
    frozenSecs=$((frozenMs / 1000))
    monoSecs=$((monoAgeMs / 1000))
    log_line "整机冻结 ${frozenSecs} 秒，循环无异常（按机器实际运行时间算心跳只隔了 ${monoSecs} 秒），没有补起新循环"
    node "$DIR/paths.mjs" alert host-frozen "frozen-${frozenSecs}s" || true
    exit 0
  fi
  log_line "心跳延迟 ${secs} 秒，但原循环进程还在、单实例锁也还占着，判断是心跳慢了而不是循环挂了，没有补起新循环"
  node "$DIR/paths.mjs" alert heartbeat-delayed "delay-${secs}s" || true
  exit 0
fi

# 心跳过期、原循环已经不在：整机冻结过且冻结 ≥60 秒，reason 改成 heartbeat-stale-after-freeze。
# planned-stop（部署重启）优先级更高，标记有效时仍记 loop-deploy-restarted / planned-stop。
if [ "$reason" = "heartbeat-stale" ] && [ "$frozenMs" -ge 60000 ]; then
  frozenSecs=$((frozenMs / 1000))
  reason=heartbeat-stale-after-freeze
fi

# stop.sh 主动停过（部署更新等）且标记不超过 2 小时：这次拉起是预期内的部署重启。标记用一次就删。
kind=loop-restarted
planned="$(read_planned_stop)"
if [ "$planned" != "none" ]; then
  rm -f "$PLANNED"
  if [ "$planned" -le "$PLANNED_MAX_MS" ]; then
    kind=loop-deploy-restarted
    reason=planned-stop
  fi
fi

setsid nohup "$DIR/loop" >> "$HOME_DIR/state/host/loop.log" 2>&1 &
if [ "$kind" = "loop-deploy-restarted" ]; then
  log_line "调度循环是用 stop.sh 主动停的（部署更新等），已重新拉起，按部署重启记录"
elif [ "$reason" = "heartbeat-stale-after-freeze" ]; then
  log_line "整机冻结 ${frozenSecs} 秒后原循环已不在，已补起新循环"
fi
node "$DIR/paths.mjs" alert "$kind" "$reason" || true
exit 0
