// Shared by the Spotify and Google/YouTube importers: find-or-create the target playlist, add songs in order.
export async function ensureTarget(env, me, name, target) {
  name = String(name || 'Imported').trim().slice(0, 30) || 'Imported';
  if (target) {
    const own = await env.DB.prepare('SELECT 1 x FROM playlists WHERE id=? AND owner=?').bind(target, me.id).first();
    return own ? { target, name } : { error: 'nf', status: 404 };
  }
  const ex = await env.DB.prepare('SELECT id FROM playlists WHERE owner=? AND name=?').bind(me.id, name).first();
  if (ex) return { target: ex.id, name };
  const c = await env.DB.prepare('SELECT COUNT(*) n FROM playlists WHERE owner=?').bind(me.id).first();
  if (c.n >= 30) return { error: 'limit', status: 409 };
  const id = crypto.randomUUID().slice(0, 8);
  await env.DB.prepare('INSERT INTO playlists (id,owner,name,created) VALUES (?,?,?,?)').bind(id, me.id, name, Date.now()).run();
  return { target: id, name };
}

// tracks: [{ tid, title, artist, dur, cover } | null]; returns how many were added and how much room is left (200 per playlist)
export async function addTracks(env, target, tracks) {
  const c = await env.DB.prepare('SELECT COUNT(*) n, COALESCE(MAX(pos),0) m FROM playlist_tracks WHERE playlist=?').bind(target).first();
  let pos = c.m, room = 200 - c.n, added = 0;
  for (const m of tracks) {
    if (!m || room <= 0) continue;
    await env.DB.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist,tid,title,artist,dur,cover,pos) VALUES (?,?,?,?,?,?,?)')
      .bind(target, m.tid, String(m.title).slice(0, 200), String(m.artist || '').slice(0, 100), Math.round(m.dur), m.cover || null, ++pos).run();
    added++; room--;
  }
  return { added, room };
}
