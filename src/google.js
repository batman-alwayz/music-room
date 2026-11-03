// Google sign-in for YouTube Music / YouTube: import your playlists and liked videos.
// There is no official YouTube Music library API, but playlists you make in YouTube Music are normal YouTube playlists,
// and those the YouTube Data API can read. Needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (a Google Cloud OAuth "Web application"
// client with <your Worker>/auth/google/callback as redirect URI and the YouTube Data API v3 enabled).
import { isoSecs } from './search.js';
import { ensureTarget, addTracks } from './libsync.js';

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth', TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const API = 'https://www.googleapis.com/youtube/v3';
const redirectUri = req => new URL('/auth/google/callback', req.url).href;
const back = (req, why) => new Response(null, { status: 302, headers: { location: new URL('/?gg=' + why, req.url).href } });
const form = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
const ready = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const thumb = id => `https://i.ytimg.com/vi/${id}/default.jpg`;

export async function ggLogin(req, env, me) {
  if (!ready(env)) return back(req, 'noid');
  const v = b64(crypto.getRandomValues(new Uint8Array(32)));
  const ch = b64(await crypto.subtle.digest('SHA-256', enc.encode(v)));
  const state = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.KV.put('ggpkce:' + state, JSON.stringify({ v, m: me.id }), { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(req), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', code_challenge: ch, code_challenge_method: 'S256', state
  });
  return new Response(null, { status: 302, headers: { location: AUTH + '?' + q } });
}

export async function ggCallback(req, env) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code'), state = u.searchParams.get('state');
  if (u.searchParams.get('error')) return back(req, 'denied');
  const saved = state && await env.KV.get('ggpkce:' + state, 'json');
  if (!code || !saved) return back(req, 'err');
  await env.KV.delete('ggpkce:' + state);
  const t = await fetch(TOKEN, form({
    code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(req), grant_type: 'authorization_code', code_verifier: saved.v
  })).then(r => r.json()).catch(() => ({}));
  if (!t.access_token) return back(req, 'err');
  const ch = await fetch(`${API}/channels?part=snippet&mine=true`, { headers: { authorization: 'Bearer ' + t.access_token } })
    .then(r => r.json()).catch(() => ({}));
  if (ch?.error?.code === 403) return back(req, 'notallowed');
  const c = ch?.items?.[0];
  await env.DB.prepare(
    `INSERT INTO links (member,provider,access,refresh,exp,ext_id,name) VALUES (?,'google',?,?,?,?,?)
     ON CONFLICT(member,provider) DO UPDATE SET access=excluded.access, refresh=COALESCE(excluded.refresh, refresh),
       exp=excluded.exp, ext_id=excluded.ext_id, name=excluded.name`
  ).bind(saved.m, t.access_token, t.refresh_token || null, Date.now() + (t.expires_in || 3600) * 1000, c?.id || '', c?.snippet?.title || 'Google account').run();
  return back(req, 'ok');
}

export async function ggToken(env, memberId, force = false) {
  const l = await env.DB.prepare("SELECT * FROM links WHERE member=? AND provider='google'").bind(memberId).first();
  if (!l) return null;
  if (!force && l.exp > Date.now() + 60000) return { token: l.access, link: l };
  if (!l.refresh) return null;                              // no refresh token: sign in again
  const r = await fetch(TOKEN, form({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: l.refresh, grant_type: 'refresh_token' }))
    .then(x => x.json()).catch(() => ({}));
  if (!r.access_token) return null;
  const exp = Date.now() + (r.expires_in || 3600) * 1000;
  await env.DB.prepare("UPDATE links SET access=?, exp=? WHERE member=? AND provider='google'").bind(r.access_token, exp, memberId).run();
  return { token: r.access_token, link: l };
}

async function ggGet(env, memberId, path) {
  let t = await ggToken(env, memberId);
  if (!t) return { status: 401 };
  const go = tok => fetch(API + path, { headers: { authorization: 'Bearer ' + tok } });
  let r = await go(t.token);
  if (r.status === 401) { t = await ggToken(env, memberId, true); if (!t) return { status: 401 }; r = await go(t.token); }
  return { status: r.status, data: r.ok ? await r.json().catch(() => null) : null };
}

export async function googleApi(req, env, me, p) {
  const post = req.method === 'POST';
  const b = post ? await req.json().catch(() => ({})) : {};
  const link = () => env.DB.prepare("SELECT name FROM links WHERE member=? AND provider='google'").bind(me.id).first();

  if (p === '/api/google/status') {
    const l = await link();
    return json({ hasId: ready(env), idOk: /\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID || ''), connected: !!l, name: l?.name || null });
  }
  if (p === '/api/google/disconnect' && post) {
    await env.DB.prepare("DELETE FROM links WHERE member=? AND provider='google'").bind(me.id).run();
    return json({ ok: true });
  }
  if (p === '/api/google/playlists') {
    const r = await ggGet(env, me.id, '/playlists?part=snippet,contentDetails&mine=true&maxResults=50');
    if (!r.data) return json({ error: 'google', status: r.status }, 502);
    const liked = await ggGet(env, me.id, '/playlistItems?part=id&maxResults=1&playlistId=LL');
    const items = (r.data.items || []).map(x => ({ id: x.id, name: x.snippet?.title || 'Playlist', n: x.contentDetails?.itemCount ?? 0 }));
    return json({ items: [{ id: 'LL', name: 'Liked videos', n: liked.data?.pageInfo?.totalResults ?? 0 }, ...items] });
  }
  if (p === '/api/google/import' && post) {                  // one page (25 songs) per call; the page keeps calling until done
    const id = String(b.id || ''), page = String(b.page || '');
    if (id !== 'LL' && !/^[\w-]{10,60}$/.test(id)) return json({ error: 'bad' }, 400);
    const r = await ggGet(env, me.id, `/playlistItems?part=snippet,contentDetails&maxResults=25&playlistId=${id}${page ? '&pageToken=' + encodeURIComponent(page) : ''}`);
    if (!r.data) return json({ error: 'google', status: r.status }, 502);
    const tg = await ensureTarget(env, me, b.name || 'YouTube', String(b.target || ''));
    if (tg.error) return json({ error: tg.error }, tg.status);

    const items = (r.data.items || []).filter(i => i.contentDetails?.videoId);
    const ids = items.map(i => i.contentDetails.videoId);
    const v = ids.length ? await ggGet(env, me.id, `/videos?part=contentDetails&maxResults=50&id=${ids.join(',')}`) : { data: { items: [] } };
    const dur = new Map((v.data?.items || []).map(x => [x.id, isoSecs(x.contentDetails?.duration)]));
    const tracks = items.map(i => {
      const tid = i.contentDetails.videoId, d = dur.get(tid) || 0, title = i.snippet?.title || '';
      if (d < 20 || d > 1200 || /^(Deleted|Private) video$/.test(title)) return null;       // not a song, or no longer available
      return { tid, title, artist: (i.snippet?.videoOwnerChannelTitle || '').replace(/ - Topic$/, ''), dur: d, cover: thumb(tid) };
    });
    const { added, room } = await addTracks(env, tg.target, tracks);
    const next = r.data.nextPageToken || '';
    return json({ target: tg.target, name: tg.name, added, skipped: items.length - added, next, total: r.data.pageInfo?.totalResults ?? 0, done: !next || room <= 0 });
  }
  return json({ error: 'nf' }, 404);
}
