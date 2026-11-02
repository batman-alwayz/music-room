// Spotify Connect on the person's own device: the Spotify app plays the song, so it counts in their Spotify history.
// Spotify only allows this for Premium accounts. Everything goes through the token the Worker keeps fresh.
export function spApi(getToken) {
  async function raw(method, path, body, retry = true) {
    const t = await getToken(!retry);
    if (!t) return { ok: false, status: 401 };
    const r = await fetch('https://api.spotify.com/v1' + path, {
      method, headers: { authorization: 'Bearer ' + t, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    }).catch(() => null);
    if (!r) return { ok: false, status: 0 };
    if (r.status === 401 && retry) return raw(method, path, body, false);
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  }
  return { raw, get: async p => (await raw('GET', p)).data, put: (p, b) => raw('PUT', p, b) };
}

const tokens = s => new Set(String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9\u00c0-\uffff ]+/g, ' ').split(/\s+/).filter(Boolean));
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
const uriCache = new Map();

// the Spotify version of a song: right title and almost the same length
export async function findUri(api, t) {
  if (uriCache.has(t.tid)) return uriCache.get(t.tid);
  const q = encodeURIComponent(`${t.title} ${t.artist || ''}`.replace(/\(.*?\)|\[.*?\]/g, ' ').trim());
  const r = await api.get(`/search?type=track&limit=10&q=${q}`);
  let best = null, bs = -1;
  for (const x of r?.tracks?.items || []) {
    const d = Math.abs(x.duration_ms / 1000 - t.dur);
    if (d > 6) continue;
    const sim = jac(tokens(x.name), tokens(t.title));
    if (sim < 0.34) continue;
    const sc = sim * 2 - d / 10;
    if (sc > bs) { bs = sc; best = x.uri; }
  }
  uriCache.set(t.tid, best);
  return best;
}

// same shape as the YouTube players: position / seek / play / pause / setMuted / end / cancel
export const connect = api => {
  let timer = null, device = null, prevVol = null;
  const pick = async () => {
    const r = await api.get('/me/player/devices');
    const l = r?.devices || [];
    device = (l.find(d => d.is_active) || l.find(d => !d.is_restricted))?.id || null;
    return device;
  };
  const q = () => `device_id=${device}`;
  return {
    ready: async () => !!(await pick()),                     // false = open the Spotify app first
    position: async () => {
      const s = await api.get('/me/player');
      if (!s || s.progress_ms == null || !s.is_playing) return null;
      return s.progress_ms + (s.timestamp ? Math.min(5000, Math.max(0, Date.now() - s.timestamp)) : 0);
    },
    seek: ms => device && api.put(`/me/player/seek?position_ms=${Math.round(ms)}&${q()}`),
    play: async (uri, ms) => {
      if (!device) await pick();
      const r = await api.put(`/me/player/play?${q()}`, { uris: [uri], position_ms: Math.round(ms) });
      return r.ok;                                           // false: no Premium, or the device went away
    },
    pause: () => device && api.put(`/me/player/pause?${q()}`),
    setMuted: async m => {                                   // Spotify has no mute: use volume, and put it back after
      if (!device) return;
      if (m) {
        const s = await api.get('/me/player');
        const v = s?.device?.volume_percent;
        if (prevVol == null && v > 0) prevVol = v;
        await api.put(`/me/player/volume?volume_percent=0&${q()}`);
      } else if (prevVol != null) { await api.put(`/me/player/volume?volume_percent=${prevVol}&${q()}`); prevVol = null; }
    },
    end: dur => new Promise(res => {                         // only after we saw it playing near the end and then stop
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
