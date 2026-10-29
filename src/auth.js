// Invite-code login: friends type a name + the shared code. No Spotify/Google app, no API keys for them.
const json = (d, s = 200, headers = {}) => new Response(JSON.stringify(d), {
  status: s, headers: { 'content-type': 'application/json', ...headers }
});
const cookie = (req, name) =>
  (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))?.[1];

export async function join(req, env) {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  const tries = +(await env.KV.get('try:' + ip) || 0);
  if (tries >= 10) return json({ error: 'slow down' }, 429);

  const b = await req.json().catch(() => ({}));
  const name = String(b.name || '').trim().slice(0, 24);
  if (!name || !env.INVITE_CODE || b.code !== env.INVITE_CODE) {
    await env.KV.put('try:' + ip, String(tries + 1), { expirationTtl: 3600 });
    return json({ error: 'bad' }, 403);
  }

  // same name = same member (history/admin stay with them); first member ever becomes admin
  let m = await env.DB.prepare('SELECT id FROM members WHERE lower(name)=lower(?)').bind(name).first();
  let id = m?.id;
  if (!id) {
    id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO members (id,name,provider,product,refresh,access,exp,admin,created)
       VALUES (?,?,'invite','ytm',NULL,NULL,0,(SELECT COUNT(*)=0 FROM members),?)`
    ).bind(id, name, Date.now()).run();
  }
  const sid = crypto.randomUUID() + crypto.randomUUID();
  await env.KV.put('sess:' + sid, id, { expirationTtl: 31536000 });
  return json({ ok: true }, 200, {
    'set-cookie': `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
  });
}

export async function logout(req, env) {
  const sid = cookie(req, 'sid');
  if (sid) await env.KV.delete('sess:' + sid);
  return new Response(null, {
    status: 302, headers: { location: new URL('/', req.url).href, 'set-cookie': 'sid=; Path=/; Max-Age=0' }
  });
}

export async function whoami(req, env) {
  const sid = cookie(req, 'sid');
  if (!sid) return null;
  const id = await env.KV.get('sess:' + sid);
  if (!id) return null;
  const m = await env.DB.prepare('SELECT id,name,provider,product,admin FROM members WHERE id=?').bind(id).first();
  if (!m) return null;
  return { id: m.id, name: m.name, product: m.product, provider: m.provider, admin: !!m.admin, room: 'main' };
}
