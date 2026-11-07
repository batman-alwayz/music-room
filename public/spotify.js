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
    return { ok: r.ok, status: r.status, data, reason: data?.error?.reason, message: data?.error?.message };
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
    state: async () => {
      const s = await api.get('/me/player');
      if (!s) return null;
      if (s.device?.id) device = s.device.id;                // follow Spotify Connect device transfers
      return {
        trackId: s.item?.id || null, uri: s.item?.uri || null,
        paused: !s.is_playing, position: Number(s.progress_ms) || 0,
        duration: Number(s.item?.duration_ms) || 0,
        timestamp: Number(s.timestamp) || 0, source: 'api'
      };
    },
    position: async () => {
      const s = await api.get('/me/player');
      if (!s || s.progress_ms == null) return null;
      if (s.device?.id) device = s.device.id;
      return s.progress_ms + (s.is_playing && s.timestamp ? Math.min(5000, Math.max(0, Date.now() - s.timestamp)) : 0);
    },
    seek: async ms => {
      if (!device) await pick();
      return device && api.put(`/me/player/seek?position_ms=${Math.round(ms)}&${q()}`);
    },
    play: async (uri, ms) => {
      if (!device) await pick();
      return api.put(`/me/player/play?${q()}`, { uris: [uri], position_ms: Math.round(ms) });   // { ok, status, reason, message }
    },
    pause: async () => {
      if (!device) await pick();
      return device && api.put(`/me/player/pause?${q()}`);
    },
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

// say what went wrong in words a person can act on
export function whyNot(res, name) {
  const reason = res?.reason || '', msg = res?.message || '';
  if (reason === 'PREMIUM_REQUIRED' || /premium/i.test(msg))
    return `Spotify says the account connected here${name ? ' (' + name + ')' : ''} has no Premium. If your Premium is another Spotify account, use “Use a different Spotify account”.`;
  if (reason === 'NO_ACTIVE_DEVICE' || res?.status === 404)
    return 'Spotify cannot find a player. Choose “play in this browser”, or open Spotify on this device and press play once.';
  if (res?.status === 401 || res?.status === 403)
    return 'Spotify refused. Reconnect Spotify so it can ask for the playback permission again.';
  return `Spotify error${res?.status ? ' ' + res.status : ''}${msg ? ': ' + msg : ''}`;
}

// Spotify's own player inside this browser tab (Premium). No Spotify app needed, and the position is read locally.
export function sdkConnect(api, getToken, onAutoplay, onState) {
  let player = null, device = null, err = null, vol = 0.8, timer = null, booting = null;
  const load = () => new Promise((res, rej) => {
    if (window.Spotify?.Player) return res();
    window.onSpotifyWebPlaybackSDKReady = res;
    const s = document.createElement('script'); s.src = 'https://sdk.scdn.co/spotify-player.js'; s.onerror = () => rej(new Error('sdk'));
    document.head.append(s);
    setTimeout(() => rej(new Error('timeout')), 8000);           // never wait forever
  });
  const boot = () => booting ||= (async () => {
    await load();
    player = new window.Spotify.Player({ name: 'Room (this browser)', getOAuthToken: cb => { getToken().then(cb); }, volume: vol });
    await new Promise(res => {
      let done = false; const fin = v => { if (!done) { done = true; res(v); } };
      player.addListener('ready', e => { device = e.device_id; fin(true); });
      player.addListener('not_ready', () => { device = null; });
      player.addListener('player_state_changed', s => {
        const t = s?.track_window?.current_track;
        if (!s || !t) { onState?.(null); return; }
        onState?.({
          trackId: t.id || null, uri: t.uri || null, paused: !!s.paused,
          position: Number(s.position) || 0, duration: Number(s.duration) || 0,
          timestamp: 0, source: 'sdk'
        });
      });
      for (const k of ['initialization_error', 'authentication_error', 'account_error', 'playback_error'])
        player.addListener(k, e => { err = { kind: k, message: e?.message }; if (k !== 'playback_error') fin(false); });
      player.addListener('autoplay_failed', () => { err = { kind: 'autoplay_failed' }; onAutoplay?.(); });
      Promise.resolve(player.connect()).then(ok => { if (!ok) fin(false); });
      setTimeout(() => fin(false), 10000);
    });
  })();
  return {
    ready: async () => { try { await boot(); } catch { err = { kind: 'load' }; } return !!device; },
    error: () => err,
    activate: () => player?.activateElement?.(),
    disconnect: () => player?.disconnect?.(),
    state: async () => {
      const s = await api.get('/me/player');
      if (!s) return null;
      return {
        trackId: s.item?.id || null, uri: s.item?.uri || null,
        paused: !s.is_playing, position: Number(s.progress_ms) || 0,
        duration: Number(s.item?.duration_ms) || 0,
        timestamp: Number(s.timestamp) || 0, source: 'api'
      };
    },
    position: async () => {
      const s = await api.get('/me/player');
      return !s || s.progress_ms == null ? null : s.progress_ms;
    },
    seek: ms => api.put(`/me/player/seek?position_ms=${Math.round(ms)}`),
    play: async (uri, ms) => {
      const current = await api.get('/me/player');
      const target = current?.device?.id || device;
      const r = await api.put(`/me/player/play?device_id=${target}`, { uris: [uri], position_ms: Math.round(ms) });
      if (!r.ok && !r.reason && err?.kind === 'account_error') return { ...r, reason: 'PREMIUM_REQUIRED', message: err.message };
      return r;
    },
    pause: () => api.put('/me/player/pause'),
    setMuted: m => { vol = m ? 0 : 0.8; return player?.setVolume?.(vol); },
    end: dur => new Promise(res => {                         // only after we saw it playing near the end and then stop
      let last = 0, seen = false;
      clearInterval(timer);
      timer = setInterval(async () => {
        const s = await player?.getCurrentState?.();
        if (!s) return;
        if (!s.paused) { seen = true; last = s.position; return; }
        if (seen && last >= dur - 5000) { clearInterval(timer); res(); }
      }, 700);
    }),
    cancel: () => clearInterval(timer)
  };
}

// songs the person just added to their Spotify queue: new entries that did NOT appear at the very end
// (Spotify tops the end up by itself after each song; its own additions land at the front)
export function queueAdds(prev, cur) {
  if (!prev || cur.length < 2) return [];
  const had = new Set(prev);
  return cur.filter((u, i) => !had.has(u) && i < cur.length - 1);
}
