// Create / join / list / leave rooms. A room's code (6 chars) is its invite.
const json = (d, s = 200) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json' }
});
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // no 0/O/1/I to avoid mix-ups
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => CODE[b % 32]).join('');

export const isMember = (env, room, member) =>
  env.DB.prepare('SELECT 1 x FROM room_members WHERE room=? AND member=?').bind(room, member).first();

const isBlocked = (env, room, member) =>
  env.DB.prepare('SELECT 1 x FROM room_blocks WHERE room=? AND member=?').bind(room, member).first();
const stubOf = (env, room) => env.ROOM.get(env.ROOM.idFromName(room));

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
    if (await isBlocked(env, id, me.id)) return json({ error: 'blocked' }, 403);
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

  // ---- who is in the room (everyone) and the admin's powers: kick, block, unblock ----
  if (p === '/api/rooms/people' && !post) {
    const room = (new URL(req.url).searchParams.get('room') || '').toUpperCase();
    if (!(await isMember(env, room, me.id))) return json({ error: 'room' }, 403);
    const adminId = (await env.DB.prepare('SELECT admin_ids FROM rooms WHERE id=?').bind(room).first())?.admin_ids;
    const mem = (await env.DB.prepare('SELECT m.id, m.name FROM room_members rm JOIN members m ON m.id = rm.member WHERE rm.room = ? ORDER BY m.name').bind(room).all()).results || [];
    const st = await stubOf(env, room).fetch('https://do/state', { headers: { 'x-room': room } }).then(r => r.json()).catch(() => null);
    const here = new Set(Object.keys(st?.s?.present || {}));
    const owner = adminId === me.id;
    const out = { owner, people: mem.map(m => ({ id: m.id, name: m.name, online: here.has(m.id), admin: m.id === adminId, me: m.id === me.id })) };
    if (owner) {
      out.blocked = ((await env.DB.prepare('SELECT m.id, m.name FROM room_blocks b JOIN members m ON m.id = b.member WHERE b.room = ? ORDER BY m.name').bind(room).all()).results || []);
    }
    return json(out);
  }

  const act = ['/api/rooms/kick', '/api/rooms/block', '/api/rooms/unblock'].indexOf(p);
  if (act >= 0 && post) {
    const room = String(b.room || '').toUpperCase(), target = String(b.member || '');
    const adminId = (await env.DB.prepare('SELECT admin_ids FROM rooms WHERE id=?').bind(room).first())?.admin_ids;
    if (!adminId || adminId !== me.id) return json({ error: 'forbidden' }, 403);          // only the room's admin
    if (!target || target === me.id) return json({ error: 'self' }, 400);
    if (act === 2) {                                                                       // unblock: they may join again with the code
      await env.DB.prepare('DELETE FROM room_blocks WHERE room=? AND member=?').bind(room, target).run();
      return json({ ok: true });
    }
    if (act === 1) {
      await env.DB.prepare('INSERT OR REPLACE INTO room_blocks (room,member,blocked_by,at) VALUES (?,?,?,?)').bind(room, target, me.id, Date.now()).run();
    }
    await env.DB.prepare('DELETE FROM room_members WHERE room=? AND member=?').bind(room, target).run();
    await stubOf(env, room).fetch('https://do/kick', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-room': room }, body: JSON.stringify({ member: target })
    }).catch(() => {});
    return json({ ok: true });
  }
  return json({ error: 'nf' }, 404);
}
