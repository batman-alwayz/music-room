import { join, logout, whoami } from './auth.js';
import { Room } from './room.js';
import { rooms, isMember } from './rooms.js';
import { playlists } from './playlists.js';
import { ytSearch, ytLookup, linkId } from './search.js';
import { lrclib } from './lyrics.js';
export { Room };

const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json' }
});

export default {
  async fetch(req, env) {
    try { return await route(req, env); }
    catch (e) { return json({ error: 'server', detail: String(e?.message || e).slice(0, 200) }, 500); }
  }
};

async function route(req, env) {
    const u = new URL(req.url);
    const p = u.pathname;

    if (p === '/auth/join') return join(req, env);
    if (p === '/auth/logout') return logout(req, env);

    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);   // static files need no DB hit

    const me = await whoami(req, env);
    if (!me) return json({ error: 'auth' }, 401);
    if (p === '/api/me') return json(me);

    if (p === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 120);
      if (!q) return json({ items: [] });
      const id = linkId(q);
      if (id) return json({ items: await ytLookup(id, env) });
      const key = 'srch2:' + q.toLowerCase();
      const hit = await env.KV.get(key, 'json');
      if (hit) return json({ items: hit });
      const items = await ytSearch(q, env);
      if (items.length) await env.KV.put(key, JSON.stringify(items), { expirationTtl: 21600 });
      return json({ items });
    }

    // album art (the video thumbnail), served from our own origin so the page may read its pixels
    if (p === '/api/cover') {
      const id = u.searchParams.get('id') || '';
      if (!/^[\w-]{11}$/.test(id)) return json({ error: 'bad' }, 400);
      const r = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, { cf: { cacheTtl: 86400, cacheEverything: true } });
      if (!r.ok) return json({ error: 'nf' }, 404);
      return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
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
      const tid = u.searchParams.get('tid') || '';
      const row = await env.DB.prepare('SELECT lrc, source FROM lyrics WHERE track_id=?').bind(tid).first();
      if (row?.lrc) return json(row);
      const title = u.searchParams.get('title') || '';
      if (!/^[\w-]{11}$/.test(tid) || !title) return json({ error: 'none' }, 404);
      if (await env.KV.get('lyr1:' + tid)) return json({ error: 'none' }, 404);        // recently not found
      const hit = await lrclib(title, u.searchParams.get('artist') || '', +u.searchParams.get('dur') || 0);
      if (hit === 'error') return json({ error: 'unavailable' }, 502);                   // never remember a failure
      if (!hit) { await env.KV.put('lyr1:' + tid, '1', { expirationTtl: 21600 }); return json({ error: 'none' }, 404); }
      const source = hit.synced ? 'lrclib-synced' : 'lrclib-plain';
      await env.DB.prepare(
        `INSERT INTO lyrics (track_id,lrc,source,uploaded_by) VALUES (?,?,?,?)
         ON CONFLICT(track_id) DO UPDATE SET lrc=excluded.lrc, source=excluded.source`
      ).bind(tid, hit.lrc, source, me.id).run();
      return json({ lrc: hit.lrc, source });
    }

    if (p.startsWith('/api/rooms')) return rooms(req, env, me, p);
    if (p.startsWith('/api/playlists')) return playlists(req, env, me, p);

    // everything else talks to one room's Durable Object (you must have joined that room)
    const roomId = (u.searchParams.get('room') || '').toUpperCase();
    if (!roomId || !(await isMember(env, roomId, me.id))) return json({ error: 'room' }, 403);
    const stub = env.ROOM.get(env.ROOM.idFromName(roomId));

    if (p === '/api/ws') {
      const h = new Headers(req.headers);
      h.set('x-member', me.id);
      h.set('x-room', roomId);
      return stub.fetch(new Request('https://do/ws', { headers: h, method: 'GET' }));
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null;
    return stub.fetch(new Request('https://do/' + p.slice(5), {
      method: req.method,
      headers: { 'content-type': 'application/json', 'x-member': me.id, 'x-room': roomId },
      body: body ? JSON.stringify(body) : null
    }));
}
