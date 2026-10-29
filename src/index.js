import { login, callback, logout, whoami } from './auth.js';
import { Room } from './room.js';
import { match } from './match.js';
export { Room };

const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json' }
});

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;

    if (p === '/auth/login') return login(req, env);
    if (p === '/auth/callback') return callback(req, env);
    if (p === '/auth/logout') return logout(req, env);

    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);   // static files need no DB hit

    const me = await whoami(req, env, p === '/api/token' && u.searchParams.has('force'));
    if (!me) return json({ error: 'auth' }, 401);

    if (p === '/api/me') { const { access, exp, ...pub } = me; return json(pub); }
    if (p === '/api/token') return json({ token: me.access, exp: me.exp });

    if (p === '/api/match' && req.method === 'POST') {
      const { track } = await req.json();
      if (!track?.title) return json({ error: 'bad' }, 400);
      const cached = track.sp_id && await env.DB.prepare(
        'SELECT yt_id, conf, how FROM tracks WHERE id=? AND yt_id IS NOT NULL').bind(track.sp_id).first();
      if (cached) return json(cached);
      const hit = await match(track, env);
      if (!hit) return json({ error: 'nomatch' }, 404);
      await env.DB.prepare(
        `INSERT INTO tracks (id,isrc,title,artist,album,dur,sp_id,yt_id,cover,conf,how)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET yt_id=excluded.yt_id, conf=excluded.conf, how=excluded.how`
      ).bind(track.sp_id || track.tid, track.isrc || null, track.title, track.artist || null,
             track.album || null, track.dur || 0, track.sp_id || null, hit.id,
             track.cover || null, hit.conf, hit.how).run();
      return json({ yt_id: hit.id, conf: hit.conf, how: hit.how });
    }

    if (p === '/api/lyrics') {
      if (req.method === 'POST') {
        const b = await req.json();
        if (!b.tid || !b.lrc) return json({ error: 'bad' }, 400);
        await env.DB.prepare(
          `INSERT INTO lyrics (track_id,lrc,source,uploaded_by) VALUES (?,?,?,?)
           ON CONFLICT(track_id) DO UPDATE SET lrc=excluded.lrc, source=excluded.source, uploaded_by=excluded.uploaded_by`
        ).bind(b.tid, b.lrc, b.source || 'user', me.id).run();
        return json({ ok: true });
      }
      const row = await env.DB.prepare('SELECT lrc, source FROM lyrics WHERE track_id=?')
        .bind(u.searchParams.get('tid')).first();
      return row ? json(row) : json({ error: 'none' }, 404);
    }

    // everything else goes to the room's Durable Object
    const stub = env.ROOM.get(env.ROOM.idFromName(me.room));

    if (p === '/api/ws') {
      const h = new Headers(req.headers);
      h.set('x-member', me.id);
      return stub.fetch(new Request('https://do/ws', { headers: h, method: 'GET' }));
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null;
    return stub.fetch(new Request('https://do/' + p.slice(5), {
      method: req.method,
      headers: { 'content-type': 'application/json', 'x-member': me.id },
      body: body ? JSON.stringify(body) : null
    }));
  }
};
