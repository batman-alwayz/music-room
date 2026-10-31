// Create / join / list / leave rooms. A room's code (6 chars) is its invite.
const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json' }
});
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // no 0/O/1/I to avoid mix-ups
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => CODE[b % 32]).join('');

export const isMember = (env, room, member) =>
  env.DB.prepare('SELECT 1 x FROM room_members WHERE room=? AND member=?').bind(room, member).first();

export async function rooms(req, env, me, p) {
  const post = req.method === 'POST';
  const b = post ? await req.json().catch(() => ({})) : {};

  if (p === '/api/rooms' && !post) {
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.name, r.admin_ids FROM room_members m JOIN rooms r ON r.id = m.room
       WHERE m.member = ? ORDER BY m.joined DESC`).bind(me.id).all();
    return json({ items: results.map(r => ({ id: r.id, name: r.name, owner: r.admin_ids === me.id })) });
  }

  if (p === '/api/rooms' && post) {
    const name = String(b.name || '').trim().slice(0, 30);
    if (!name) return json({ error: 'name' }, 400);
    const c = await env.DB.prepare('SELECT COUNT(*) n FROM rooms WHERE admin_ids = ?').bind(me.id).first();
    if (c.n >= 5) return json({ error: 'limit' }, 409);
    for (let i = 0; i < 5; i++) {
      const id = newCode();
      try {
        await env.DB.prepare('INSERT INTO rooms (id,name,created,admin_ids) VALUES (?,?,?,?)')
          .bind(id, name, Date.now(), me.id).run();
        await env.DB.prepare('INSERT INTO room_members (room,member,joined) VALUES (?,?,?)')
          .bind(id, me.id, Date.now()).run();
        return json({ id, name, owner: true });
      } catch {}                                            // code already taken -> try another
    }
    return json({ error: 'busy' }, 500);
  }

  if (p === '/api/rooms/join' && post) {
    const id = String(b.code || '').trim().toUpperCase();
    const r = await env.DB.prepare('SELECT id,name,admin_ids FROM rooms WHERE id=?').bind(id).first();
    if (!r) return json({ error: 'none' }, 404);
    await env.DB.prepare(
      `INSERT INTO room_members (room,member,joined) VALUES (?,?,?)
       ON CONFLICT(room,member) DO UPDATE SET joined=excluded.joined`).bind(id, me.id, Date.now()).run();
    return json({ id: r.id, name: r.name, owner: r.admin_ids === me.id });
  }

  if (p === '/api/rooms/leave' && post) {
    await env.DB.prepare('DELETE FROM room_members WHERE room=? AND member=?')
      .bind(String(b.id || '').toUpperCase(), me.id).run();
    return json({ ok: true });
  }
  return json({ error: 'nf' }, 404);
}
