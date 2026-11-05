#!/bin/sh
# 常驻事件拉取器的拉起脚本（W4-c 草稿：只提交代码，不装 crontab、不启动进程）。
# 形态照 ~/acceptance/tools/board-live-ensure.sh：flock -n 防并发、pgrep -fx 精确匹配防重复、
# setsid nohup 脱离会话。人工确认后再挂到 crontab 的 @reboot 与 */5 上，或并进 run-ensure.sh 的链。
#
# 开关：<stateDir>/event-run.disabled（默认 ~/acceptance/tools/.prio/event-run.disabled）存在时
# 进程照旧在，但一条事件都不处理，只在日志里说明 —— 停用靠这个文件，不靠杀进程。
#
# 可覆盖的环境变量（都有默认值，不写死任何本机路径）：
#   EVENT_RUN_SCRIPT   拉取器路径，默认 <homedir>/acceptance/vigil/watchers/acceptance/bin/event-run.mjs
#   EVENT_RUN_ARGS     传给拉取器的参数，默认空（空 = dry-run，只算不写）；要真写填 "--write"
#   EVENT_RUN_STATE_DIR 状态目录，默认 <homedir>/acceptance/tools/.prio
#   ACCEPTANCE_WATCHER_HOME 验收机 home，默认 <homedir>/acceptance/home
# 退出码：拉起或已在跑都是 0；锁被占、路径不对是 0 / 1，不重试（下一轮 cron 再来）。
set -u

HOME_DIR=${HOME:?}
SCRIPT=${EVENT_RUN_SCRIPT:-$HOME_DIR/acceptance/vigil/watchers/acceptance/bin/event-run.mjs}
STATE_DIR=${EVENT_RUN_STATE_DIR:-$HOME_DIR/acceptance/tools/.prio}
RUN_ARGS=${EVENT_RUN_ARGS:-}
NODE_BIN=${EVENT_RUN_NODE:-$HOME_DIR/.node22/bin/node}
NODE_PATH_DIR=$(dirname "$NODE_BIN")
LOG=$STATE_DIR/event-run-ensure.log

mkdir -p "$STATE_DIR" || exit 1
exec 9>"$STATE_DIR/event-run-ensure.lock"
flock -n 9 || exit 0

# pgrep -fx 按整条命令行精确匹配：RUN_ARGS 必须和进程实际参数一致，否则会重复拉起。
if [ -n "$RUN_ARGS" ]; then
  pgrep -fx "$NODE_BIN $SCRIPT $RUN_ARGS" >/dev/null && exit 0
else
  pgrep -fx "$NODE_BIN $SCRIPT" >/dev/null && exit 0
fi

[ -f "$SCRIPT" ] || { echo "$(date -Is) 找不到拉取器 $SCRIPT，没有拉起" >>"$LOG"; exit 1; }
[ -x "$NODE_BIN" ] || { echo "$(date -Is) 找不到 node $NODE_BIN，没有拉起" >>"$LOG"; exit 1; }

cd "$HOME_DIR/acceptance" || exit 1
# shellcheck disable=SC2086 # RUN_ARGS 允许写成一个词一个词的形式
setsid nohup env -i PATH="$NODE_PATH_DIR:/usr/local/bin:/usr/bin:/bin" HOME="$HOME_DIR" LANG=C.UTF-8 \
  ACCEPTANCE_WATCHER_HOME="${ACCEPTANCE_WATCHER_HOME:-$HOME_DIR/acceptance/home}" \
  "$NODE_BIN" "$SCRIPT" $RUN_ARGS >>"$STATE_DIR/event-run-ensure.log" 2>&1 9>&- &
echo "$(date -Is) event-run 已拉起（参数：${RUN_ARGS:-无，dry-run}）" >>"$LOG"
exit 0
