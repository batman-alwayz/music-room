// Spotify: connect an account (login page also offers "Continue with Google"), import your own playlists and
// Liked Songs as playlists in this app, and hand the browser a token so "play on my Spotify" can work.
// Needs the SPOTIFY_CLIENT_ID secret (one Spotify app, no client secret: PKCE) and your Worker's
// /auth/spotify/callback added as a Redirect URI in that app.
import { musicSearch } from './search.js';
import { ensureTarget, addTracks } from './libsync.js';

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read user-read-playback-state user-modify-playback-state user-read-currently-playing';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const redirectUri = req => new URL('/auth/spotify/callback', req.url).href;
const back = (req, why) => new Response(null, { status: 302, headers: { location: new URL('/?sp=' + why, req.url).href } });
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });

export async function spLogin(req, env, me) {
  if (!env.SPOTIFY_CLIENT_ID) return back(req, 'noid');
  const v = b64(crypto.getRandomValues(new Uint8Array(32)));
  const ch = b64(await crypto.subtle.digest('SHA-256', enc.encode(v)));
  const state = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.KV.put('spkce:' + state, JSON.stringify({ v, m: me.id }), { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID, response_type: 'code', redirect_uri: redirectUri(req),
    code_challenge_method: 'S256', code_challenge: ch, state, scope: SCOPES
  });
  return new Response(null, { status: 302, headers: { location: 'https://accounts.spotify.com/authorize?' + q } });
}

export async function spCallback(req, env) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code'), state = u.searchParams.get('state');
  if (u.searchParams.get('error')) return back(req, 'denied');
  const saved = state && await env.KV.get('spkce:' + state, 'json');
  if (!code || !saved) return back(req, 'err');
  await env.KV.delete('spkce:' + state);
  const t = await fetch(TOKEN_URL, form({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(req),
    client_id: env.SPOTIFY_CLIENT_ID, code_verifier: saved.v
  })).then(r => r.json()).catch(() => ({}));
  if (!t.access_token) return back(req, 'err');
  const r = await fetch('https://api.spotify.com/v1/me', { headers: { authorization: 'Bearer ' + t.access_token } }).catch(() => null);
  if (!r || r.status === 403) return back(req, 'notallowed');       // not on the app's user list
  const me = await r.json().catch(() => ({}));
  if (!me.id) return back(req, 'err');
  await env.DB.prepare(
    `INSERT INTO links (member,provider,access,refresh,exp,ext_id,name) VALUES (?,'spotify',?,?,?,?,?)
     ON CONFLICT(member,provider) DO UPDATE SET access=excluded.access, refresh=COALESCE(excluded.refresh, refresh),
       exp=excluded.exp, ext_id=excluded.ext_id, name=excluded.name`
  ).bind(saved.m, t.access_token, t.refresh_token || null, Date.now() + t.expires_in * 1000, me.id, me.display_name || me.id).run();
  return back(req, 'ok');
}

export async function spToken(env, memberId, force = false) {
  const l = await env.DB.prepare("SELECT * FROM links WHERE member=? AND provider='spotify'").bind(memberId).first();
  if (!l) return null;
  if (!force && l.exp > Date.now() + 60000) return { token: l.access, exp: l.exp, link: l };
  const r = await fetch(TOKEN_URL, form({ grant_type: 'refresh_token', refresh_token: l.refresh, client_id: env.SPOTIFY_CLIENT_ID }))
    .then(x => x.json()).catch(() => ({}));
  if (!r.access_token) return null;
  const exp = Date.now() + r.expires_in * 1000;
  await env.DB.prepare("UPDATE links SET access=?, exp=?, refresh=COALESCE(?,refresh) WHERE member=? AND provider='spotify'")
    .bind(r.access_token, exp, r.refresh_token || null, memberId).run();
  return { token: r.access_token, exp, link: l };
}

async function spGet(env, memberId, path) {
  let t = await spToken(env, memberId);
  if (!t) return { status: 401 };
  const go = tok => fetch('https://api.spotify.com/v1' + path, { headers: { authorization: 'Bearer ' + tok } });
  let r = await go(t.token);
  if (r.status === 401) { t = await spToken(env, memberId, true); if (!t) return { status: 401 }; r = await go(t.token); }
  return { status: r.status, data: r.ok ? await r.json().catch(() => null) : null, link: t.link };
}

// ---- matching a Spotify song to its YouTube Music version (the room plays YouTube) ----
const tok = s => new Set(String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9\u00c0-\uffff ]+/g, ' ').split(/\s+/).filter(Boolean));
const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

export function pickMatch(cands, t) {
  const want = (t.duration_ms || 0) / 1000, tt = tok(t.name);
  let best = null, bs = -1;
  for (const c of cands || []) {
    const d = Math.abs(c.dur - want);
    if (want && d > 7) continue;                         // a different recording
    const sim = jac(tok(c.title), tt);
    if (sim < 0.34) continue;
    const sc = sim * 2 - d / 10;
    if (sc > bs) { bs = sc; best = c; }
  }
  return best;
}

async function matchOne(env, t) {
  const cached = await env.DB.prepare('SELECT yt_id,title,artist,dur,cover FROM tracks WHERE id=? AND yt_id IS NOT NULL').bind(t.id).first();
  if (cached) return { tid: cached.yt_id, title: cached.title, artist: cached.artist, dur: cached.dur, cover: cached.cover };
  const best = pickMatch(await musicSearch(`${t.name} ${t.artists?.[0]?.name || ''}`.trim()), t);
  if (!best) return null;
  await env.DB.prepare('INSERT OR REPLACE INTO tracks (id,title,artist,dur,sp_id,yt_id,cover,conf,how) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(t.id, best.title, best.artist, best.dur, t.id, best.tid, best.cover, 0.8, 'spotify').run();
  return best;
}

const LIM = 12;                                           // songs per request (each needs a YouTube Music search)

export async function spotifyApi(req, env, me, p) {
  const post = req.method === 'POST';
  const b = post ? await req.json().catch(() => ({})) : {};
  const link = () => env.DB.prepare("SELECT name, ext_id FROM links WHERE member=? AND provider='spotify'").bind(me.id).first();

  if (p === '/api/spotify/status') {
    const l = await link();
    // a real Spotify Client ID is 32 letters/numbers: catches a wrong value pasted as the secret
    return json({ hasId: !!env.SPOTIFY_CLIENT_ID, idOk: /^[a-f0-9]{32}$/i.test(env.SPOTIFY_CLIENT_ID || ''), connected: !!l, name: l?.name || null });
  }
  if (p === '/api/spotify/disconnect' && post) {
    await env.DB.prepare("DELETE FROM links WHERE member=? AND provider='spotify'").bind(me.id).run();
    return json({ ok: true });
  }
  if (p === '/api/spotify/token') {
    const t = await spToken(env, me.id, new URL(req.url).searchParams.has('force'));
    return t ? json({ token: t.token, exp: t.exp }) : json({ error: 'nolink' }, 404);
  }

  if (p === '/api/spotify/playlists') {                   // Spotify only shares the contents of playlists YOU own
    const r = await spGet(env, me.id, '/me/playlists?limit=50');
    if (!r.data) return json({ error: 'spotify', status: r.status }, 502);
    const mine = (r.data.items || []).filter(x => x && x.owner?.id === r.link.ext_id)
      .map(x => ({ id: x.id, name: x.name, n: x.items?.total ?? x.tracks?.total ?? 0 }));
    const liked = await spGet(env, me.id, '/me/tracks?limit=1');
    return json({ items: [{ id: 'liked', name: 'Liked songs', n: liked.data?.total ?? 0 }, ...mine] });
  }

  if (p === '/api/spotify/match' && post) {               // "I'm playing this on Spotify" -> the YouTube version for the room
    const id = String(b.id || '');
    if (!/^\w{10,40}$/.test(id) || !b.name) return json({ error: 'bad' }, 400);
    const m = await matchOne(env, { id, name: String(b.name), artists: [{ name: String(b.artist || '') }], duration_ms: +b.duration_ms || 0 }).catch(() => null);
    return m ? json({ track: m }) : json({ error: 'none' }, 404);
  }

  if (p === '/api/spotify/import' && post) {              // one batch; the page keeps calling until done
    const id = String(b.id || ''), offset = Math.max(0, +b.offset || 0);
    if (id !== 'liked' && !/^[\w]{10,40}$/.test(id)) return json({ error: 'bad' }, 400);
    const path = id === 'liked' ? `/me/tracks?limit=${LIM}&offset=${offset}` : `/playlists/${id}/items?limit=${LIM}&offset=${offset}`;
    const r = await spGet(env, me.id, path);
    if (!r.data) return json({ error: 'spotify', status: r.status }, 502);

    const tg = await ensureTarget(env, me, b.name || 'Spotify', String(b.target || ''));
    if (tg.error) return json({ error: tg.error }, tg.status);
    const target = tg.target, name = tg.name;

    const items = r.data.items || [];
    const total = r.data.total ?? 0;
    const tracks = items.map(x => x?.item || x?.track || x).filter(t => t && t.id && t.type !== 'episode');
    const matched = await Promise.all(tracks.map(t => matchOne(env, t).catch(() => null)));
    const { added, room } = await addTracks(env, target, matched);
    const next = offset + items.length;
    return json({ target, name, added, skipped: tracks.length - added, next, total, done: !items.length || next >= total || room <= 0 });
  }
  return json({ error: 'nf' }, 404);
}
