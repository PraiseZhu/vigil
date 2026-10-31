// 拉取（poll）期间的心跳（T18）：poll 单次最长 60 秒、超时整组掐掉重试一次（T23，合计约 124 秒），网络慢时整拍要两三分钟，
// 心跳只在拍尾写一次就会被体检（上限 180 秒）误报成「循环卡了」。这里在拉取期间定时刷新心跳，
// 心跳仍只表示「循环活着」；另记一个 polling：{ startedAt, startedUptimeS, elapsedS }（正在拉取、已多久）。
// 拉取超过 POLL_STALL_S 就不再刷新：超时掐不掉的真卡死照样表现为心跳过期，体检也按 polling 单独报红。

/**
 * 拉取时长上限（秒）。poll 单次 60 秒超时（SIGTERM，2 秒后 SIGKILL，整组），重试一次，正常绝不会超过 ~124 秒；
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

// T20：心跳覆盖整拍。拉取结束后同一拍还有修正轮（prbot）读 GitHub、清理卡住的轮次、写闸审计、通知等阶段，
// 任何一段挂住都会让心跳停在拉取那一刻、体检误说「拉取已 N 秒」。这里把上面的拉取心跳扩成整拍的阶段心跳：
// 心跳带 phase：{ name, startedAt, startedUptimeS, elapsedS }（当前阶段、已多久）；name 为 poll 时另写旧字段 polling（兼容）。
// 每个阶段（修正轮里每发起一次读取都重新起算）超过 POLL_STALL_S 就停刷，真卡死照样表现为心跳过期并被体检报红。

/** 阶段名 → 体检文案里的人话。 */
export const PHASE_LABELS = Object.freeze({
  poll: '拉取',
  abort: '清理卡住的轮次',
  prbot: '修正轮读取',
  dispatch: '派发',
  audit: '写闸审计',
  notify: '发通知',
});

export function phaseLabel(name) {
  return PHASE_LABELS[name] || `阶段 ${String(name || '未知')}`;
}

/** 心跳里的当前阶段：新字段 phase 优先；只有旧字段 polling 的心跳当成拉取阶段。 */
export function heartbeatPhase(heartbeat) {
  if (heartbeat?.phase && typeof heartbeat.phase === 'object') return heartbeat.phase;
  if (heartbeat?.polling && typeof heartbeat.polling === 'object') return { ...heartbeat.polling, name: 'poll' };
  return null;
}

/**
 * 一拍开始时调用：返回 { setPhase(name), stop() }。setPhase 立刻写一次心跳并从此刻重新计时；
 * 之后每 beatMs 刷新，当前阶段超过 POLL_STALL_S 就停刷（直到下一次 setPhase，说明这一段已经过去了）。
 * buildBeat(phase) 返回要写的完整心跳对象；write 负责落盘。写失败不影响这一拍。
 */
export function startTickBeat({ now, uptime, beatMs = POLL_BEAT_MS, buildBeat, write }) {
  let phase = null;
  let timer = null;
  let stopped = false;
  const clear = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const beat = () => {
    if (!phase || stopped) return;
    const elapsedS = pollingElapsedS(phase, { now, uptime });
    if (elapsedS !== null && elapsedS > POLL_STALL_S) {
      clear();
      return;
    }
    phase.elapsedS = elapsedS ?? 0;
    try {
      write(buildBeat({ ...phase }));
    } catch {
      // 心跳写不了不影响这一拍；拍尾还会再写一次。
    }
  };
  return {
    setPhase(name) {
      if (stopped) return;
      phase = { name, startedAt: new Date(now()).toISOString(), startedUptimeS: uptime(), elapsedS: 0 };
      beat();
      if (!timer) {
        timer = setInterval(beat, beatMs);
        timer.unref?.();
      }
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
