// every player: position() -> ms, seek(ms), play(x, ms), pause(), end(durMs) -> Promise, cancel()

// connect: the official Spotify app is the player (Premium only)
export const connect = (api, device) => {
  let timer = null;
  const q = `device_id=${device}`;
  return {
    position: async () => {
      const r = await api.get('/me/player');
      if (!r || r.progress_ms == null || !r.is_playing) return null;
      const age = r.timestamp ? Math.min(5000, Math.max(0, Date.now() - r.timestamp)) : 0;
      return r.progress_ms + age;
    },
    seek: ms => api.put(`/me/player/seek?position_ms=${Math.round(ms)}&${q}`),
    play: (uri, ms) => api.put(`/me/player/play?${q}`, { uris: [uri], position_ms: Math.round(ms) }),
    pause: () => api.put(`/me/player/pause?${q}`),
    // only resolves AFTER we saw it playing near the end and then stop (old code fired instantly)
    end: dur => new Promise(res => {
      let last = 0, seen = false;
      clearInterval(timer);
      timer = setInterval(async () => {
        const s = await api.get('/me/player');
        if (!s) return;
        if (s.is_playing) { seen = true; last = s.progress_ms; return; }
        if (seen && last >= dur - 4000) { clearInterval(timer); res(); }
      }, 1000);
    }),
    cancel: () => clearInterval(timer)
  };
};

// ytm: native shell only, talks to the injected bridge
export const ytm = send => ({
  position: async () => Number(await send('position')) || 0,
  seek: ms => send('seek', ms),
  play: (id, ms) => send('load', { id, ms }),
  pause: () => send('pause'),
  end: () => new Promise(r => { window.onYtmEnd = r; }),
  cancel: () => { window.onYtmEnd = null; }
});

// browser fallback: countdown only, the user taps play in their own app
export const manual = (getState, now) => {
  let timer = null;
  return {
    position: () => now() - getState().startAt,
    seek: () => {}, play: () => {}, pause: () => {},
    end: dur => new Promise(r => {
      timer = setTimeout(r, Math.max(0, getState().startAt + dur - now()));
    }),
    cancel: () => clearTimeout(timer)
  };
};

// what each kind of member gets
export function routeFor(member) {
  if (member.provider === 'spotify') {
    return member.product === 'premium'
      ? { player: 'connect', ads: false }
      : { player: 'manual', ads: true, skip: false };      // Spotify free can't be remote-controlled
  }
  return { player: 'ytm-web', ads: member.product !== 'premium', skip: true };
}
