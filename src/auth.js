const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const go = (req, path, headers = {}) => new Response(null, {
  status: 302, headers: { location: new URL(path, req.url).href, ...headers }
});
const redirectUri = req => new URL('/auth/callback', req.url).href;
const SCOPES = [
  'streaming', 'user-read-private', 'user-read-playback-state',
  'user-modify-playback-state', 'user-read-currently-playing', 'user-read-recently-played'
].join(' ');
const form = o => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o)
});

export async function login(req, env) {
  const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  const state = b64(crypto.getRandomValues(new Uint8Array(16)));
  await env.KV.put('pkce:' + state, verifier, { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(req),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    scope: SCOPES
  });
  return go(req, 'https://accounts.spotify.com/authorize?' + q);
}

export async function callback(req, env) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  if (u.searchParams.get('error') || !code || !state) return go(req, '/?e=denied');
  const verifier = await env.KV.get('pkce:' + state);
  if (!verifier) return go(req, '/?e=pkce');
  await env.KV.delete('pkce:' + state);

  const t = await fetch('https://accounts.spotify.com/api/token', form({
    grant_type: 'authorization_code', code,
    redirect_uri: redirectUri(req),
    client_id: env.SPOTIFY_CLIENT_ID,
    code_verifier: verifier
  })).then(x => x.json());
  if (!t.access_token) return go(req, '/?e=token');

  const me = await fetch('https://api.spotify.com/v1/me', {
    headers: { authorization: 'Bearer ' + t.access_token }
  }).then(x => x.json());
  if (!me.id) return go(req, '/?e=me');          // e.g. not on the dev-mode allowlist

  // product is 'premium' or 'free' — decides the route. First ever member becomes admin.
  await env.DB.prepare(
    `INSERT INTO members (id,name,provider,product,refresh,access,exp,admin,created)
     VALUES (?,?,'spotify',?,?,?,?,(SELECT COUNT(*)=0 FROM members),?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, product=excluded.product,
       refresh=COALESCE(excluded.refresh, refresh), access=excluded.access, exp=excluded.exp`
  ).bind(me.id, me.display_name || me.id, me.product || 'free', t.refresh_token || null,
         t.access_token, Date.now() + t.expires_in * 1000, Date.now()).run();

  // random session token (the old cookie was the Spotify id: anyone could forge it)
  const sid = crypto.randomUUID() + crypto.randomUUID();
  await env.KV.put('sess:' + sid, me.id, { expirationTtl: 31536000 });
  return go(req, '/', {
    'set-cookie': `sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`
  });
}

export async function logout(req, env) {
  const sid = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  if (sid) await env.KV.delete('sess:' + sid);
  return go(req, '/', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
}

export async function whoami(req, env, force = false) {
  const sid = (req.headers.get('cookie') || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  if (!sid) return null;
  const id = await env.KV.get('sess:' + sid);
  if (!id) return null;
  const m = await env.DB.prepare('SELECT * FROM members WHERE id=?').bind(id).first();
  if (!m) return null;
  if (m.provider === 'spotify' && (force || m.exp < Date.now() + 60000)) {
    const r = await fetch('https://accounts.spotify.com/api/token', form({
      grant_type: 'refresh_token', refresh_token: m.refresh, client_id: env.SPOTIFY_CLIENT_ID
    })).then(x => x.json());
    if (!r.access_token) return null;            // revoked -> log in again
    m.access = r.access_token;
    m.exp = Date.now() + r.expires_in * 1000;
    await env.DB.prepare('UPDATE members SET access=?, exp=?, refresh=COALESCE(?,refresh) WHERE id=?')
      .bind(m.access, m.exp, r.refresh_token || null, m.id).run();
  }
  return {
    id: m.id, name: m.name, product: m.product, provider: m.provider,
    admin: !!m.admin, room: 'main', access: m.access, exp: m.exp
  };
}
