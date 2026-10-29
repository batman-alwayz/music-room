import { join, logout, whoami } from './auth.js';
import { Room } from './room.js';
import { ytSearch, ytLookup, linkId } from './search.js';
export { Room };

const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json' }
});

export default {
  async fetch(req, env) {
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
      if (!env.YT_API_KEY) return json({ error: 'nokey' }, 503);
      const id = linkId(q);
      if (id) return json({ items: await ytLookup(id, env) });
      const key = 'srch:' + q.toLowerCase();
      const hit = await env.KV.get(key, 'json');
      if (hit) return json({ items: hit });
      const items = await ytSearch(q, env);
      if (items.length) await env.KV.put(key, JSON.stringify(items), { expirationTtl: 21600 });
      return json({ items });
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
