let offset = 0, seeded = false;

// server clock = Date.now() + offset
export const serverNow = () => Date.now() + offset;

export function setOffset(srvNow) {
  const sample = srvNow - Date.now();
  offset = seeded ? offset * 0.8 + sample * 0.2 : sample;   // first sample is taken as-is, then smoothed
  seeded = true;
}

// all positions are in milliseconds. `state` may be an object or a getter.
export function startLoop(player, state, onDrift) {
  let busy = false;
  return setInterval(async () => {
    const st = typeof state === 'function' ? state() : state;
    if (busy || !st.playing) return;
    busy = true;
    try {
      const target = serverNow() - st.startAt;
      if (target < 0 || target > st.playing.dur * 1000) return;
      const now = await player.position();                  // may be a promise
      if (now == null) return;                              // paused / unknown: don't fight the user
      const drift = now - target;
      if (Math.abs(drift) > 1500) await player.seek(target + 150);
      onDrift(drift);
    } catch {} finally { busy = false; }
  }, 2000);
}
