// Per-person playlists (they follow you into any room).
const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json' }
});

export async function playlists(req, env, me, p) {
  const post = req.method === 'POST';
  const b = post ? await req.json().catch(() => ({})) : {};

  if (p === '/api/playlists') {
    if (!post) {
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.name, COUNT(t.tid) AS n FROM playlists p
         LEFT JOIN playlist_tracks t ON t.playlist = p.id
         WHERE p.owner = ? GROUP BY p.id ORDER BY p.created DESC`).bind(me.id).all();
      return json({ items: results });
    }
    const name = String(b.name || '').trim().slice(0, 30);
    if (!name) return json({ error: 'name' }, 400);
    const c = await env.DB.prepare('SELECT COUNT(*) n FROM playlists WHERE owner=?').bind(me.id).first();
    if (c.n >= 30) return json({ error: 'limit' }, 409);
    const id = crypto.randomUUID().slice(0, 8);
    await env.DB.prepare('INSERT INTO playlists (id,owner,name,created) VALUES (?,?,?,?)')
      .bind(id, me.id, name, Date.now()).run();
    return json({ id, name });
  }

  const m = p.match(/^\/api\/playlists\/([\w-]+)(?:\/(\w+))?$/);
  if (!m) return json({ error: 'nf' }, 404);
  const [, id, action] = m;
  const own = await env.DB.prepare('SELECT 1 x FROM playlists WHERE id=? AND owner=?').bind(id, me.id).first();
  if (!own) return json({ error: 'nf' }, 404);

  if (!action && !post) {
    const { results } = await env.DB.prepare(
      'SELECT tid,title,artist,dur,cover FROM playlist_tracks WHERE playlist=? ORDER BY pos').bind(id).all();
    return json({ items: results });
  }
  if (!post) return json({ error: 'nf' }, 404);

  if (action === 'add') {
    const t = b.track || {};
    if (!/^[\w-]{11}$/.test(t.tid || '') || !(Number(t.dur) > 0) || !t.title) return json({ error: 'bad' }, 400);
    const c = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(MAX(pos),0) m FROM playlist_tracks WHERE playlist=?').bind(id).first();
    if (c.n >= 200) return json({ error: 'limit' }, 409);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO playlist_tracks (playlist,tid,title,artist,dur,cover,pos) VALUES (?,?,?,?,?,?,?)`
    ).bind(id, t.tid, String(t.title).slice(0, 200), String(t.artist || '').slice(0, 100),
           Math.round(t.dur), t.cover || null, c.m + 1).run();
    return json({ ok: true });
  }
  if (action === 'remove') {
    await env.DB.prepare('DELETE FROM playlist_tracks WHERE playlist=? AND tid=?').bind(id, b.tid).run();
    return json({ ok: true });
  }
  if (action === 'rename') {
    const name = String(b.name || '').trim().slice(0, 30);
    if (!name) return json({ error: 'name' }, 400);
    await env.DB.prepare('UPDATE playlists SET name=? WHERE id=?').bind(name, id).run();
    return json({ ok: true });
  }
  if (action === 'delete') {
    await env.DB.prepare('DELETE FROM playlist_tracks WHERE playlist=?').bind(id).run();
    await env.DB.prepare('DELETE FROM playlists WHERE id=?').bind(id).run();
    return json({ ok: true });
  }
  return json({ error: 'nf' }, 404);
}
