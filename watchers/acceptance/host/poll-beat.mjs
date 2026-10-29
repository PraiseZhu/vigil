// 拉取（poll）期间的心跳（T18）：poll 最长跑 120 秒（proc.run 超时掐掉），网络慢时整拍要两三分钟，
// 心跳只在拍尾写一次就会被体检（上限 180 秒）误报成「循环卡了」。这里在拉取期间定时刷新心跳，
// 心跳仍只表示「循环活着」；另记一个 polling：{ startedAt, startedUptimeS, elapsedS }（正在拉取、已多久）。
// 拉取超过 POLL_STALL_S 就不再刷新：超时掐不掉的真卡死照样表现为心跳过期，体检也按 polling 单独报红。

/**
 * 拉取时长上限（秒）。poll 被 120 秒超时掐掉（SIGTERM，2 秒后 SIGKILL），正常绝不会超过 ~122 秒；
 * 超过 180 秒说明掐都掐不掉，是真卡死。180 秒和体检的心跳上限一致，给负载高的机器留了约 1 分钟余量。
 */
export const POLL_STALL_S = 180;

/** 拉取期间刷新心跳的间隔：30 秒，远小于 180 秒上限，正常拉取中体检永远看到新鲜心跳。 */
export const POLL_BEAT_MS = 30000;

/**
 * 拉取已经跑了多少秒：优先按开机时长（uptime）算，整机冻结（墙钟跳了、uptime 没走）不算进拉取时长；
 * uptime 往回走（重启过）或没记 uptime 时退回墙钟。
 */
export function pollingElapsedS(polling, { now = () => Date.now(), uptime } = {}) {
  if (!polling || typeof polling !== 'object') return null;
  const up = typeof uptime === 'function' ? Number(uptime()) : NaN;
  const startedUp = Number(polling.startedUptimeS);
  if (Number.isFinite(up) && Number.isFinite(startedUp) && polling.startedUptimeS !== null && up >= startedUp) {
    return Math.round(up - startedUp);
  }
  const startedAt = Date.parse(polling.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.round((now() - startedAt) / 1000));
}

/**
 * 开始拉取时调用：马上写一次心跳，之后每 beatMs 刷新一次，直到返回的 stop() 被调用或拉取超过上限。
 * buildBeat(polling) 返回要写的完整心跳对象；write 负责落盘。写失败不影响拉取。
 */
export function startPollBeat({ now, uptime, beatMs = POLL_BEAT_MS, buildBeat, write }) {
  const polling = { startedAt: new Date(now()).toISOString(), startedUptimeS: uptime(), elapsedS: 0 };
  let timer = null;
  const beat = () => {
    const elapsedS = pollingElapsedS(polling, { now, uptime });
    if (elapsedS !== null && elapsedS > POLL_STALL_S) {
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    polling.elapsedS = elapsedS ?? 0;
    try {
      write(buildBeat({ ...polling }));
    } catch {
      // 心跳写不了不影响拉取；拍尾还会再写一次。
    }
  };
  beat();
  timer = setInterval(beat, beatMs);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
