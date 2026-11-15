// Tests for the room-clock drift loop and the Spotify player abstraction (the two-way sync core).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setOffset, serverNow, startLoop } from '../public/sync.js';
import { spApi, connect as spConnect, queueAdds, whyNot, findUri, bestDevice, usableDevice } from '../public/spotify.js';

// startLoop uses setInterval; capture the callback and the period so a test can drive it explicitly.
function fakeInterval() {
  const real = globalThis.setInterval, realClear = globalThis.clearInterval;
  let cb = null, ms = null;
  globalThis.setInterval = (f, t) => { cb = f; ms = t; return 1; };
  globalThis.clearInterval = () => {};
  return {
    tick: () => cb && cb(),
    period: () => ms,
    restore: () => { globalThis.setInterval = real; globalThis.clearInterval = realClear; }
  };
}
const flush = () => new Promise(r => setTimeout(r, 0));

test('server offset starts at the first sample then smooths toward later ones', () => {
  const before = Date.now();
  setOffset(before + 5000);                       // first sample taken as-is
  assert.ok(serverNow() >= before + 4900, 'clock jumped forward with the first sample');
  const after = serverNow();
  setOffset(before + 1000);                       // a wild second sample only nudges it
  assert.ok(serverNow() > after - 4000, 'the second sample is smoothed, not applied fully');
});

test('the drift loop seeks only when the player has drifted too far', async () => {
  const timer = fakeInterval();
  try {
    const calls = { seek: [], pos: 0 };
    const player = { position: async () => calls.pos, seek: ms => { calls.seek.push(ms); } };
    setOffset(Date.now());                        // pin the room clock, whatever offset earlier tests left
    // 5 s into a 300 s song, expressed against the room clock so the target stays inside the track
    const state = { playing: { dur: 300 }, startAt: serverNow() - 5000, paused: false };
    startLoop(player, state, () => {});
    assert.equal(timer.period(), 2000, 'polls every two seconds');

    calls.pos = 5000;                             // player sits exactly where the clock says
    timer.tick(); await flush();
    assert.equal(calls.seek.length, 0, 'in-sync player is left alone');

    calls.pos = 2000;                             // player is 3 s behind the room
    timer.tick(); await flush();
    assert.equal(calls.seek.length, 1, 'a drifting player is pulled back');
    assert.ok(calls.seek[0] > 0);
  } finally { timer.restore(); }
});

test('the drift loop ignores a paused or unknown player', async () => {
  const timer = fakeInterval();
  try {
    const calls = { seek: 0 };
    const player = { position: async () => null, seek: () => { calls.seek++; } };
    startLoop(player, { playing: { dur: 300 }, startAt: 0, paused: false }, () => {});
    setOffset(Date.now());
    timer.tick(); await flush();
    assert.equal(calls.seek, 0, 'null position (paused/unknown) never triggers a seek');
  } finally { timer.restore(); }
});

test('the drift loop does nothing when no song is playing', async () => {
  const timer = fakeInterval();
  try {
    const calls = { seek: 0, pos: 0 };
    const player = { position: async () => { calls.pos++; return 0; }, seek: () => { calls.seek++; } };
    startLoop(player, { playing: null, startAt: 0, paused: false }, () => {});
    timer.tick(); await flush();
    assert.equal(calls.pos, 0, 'position is not even read with no song');
    assert.equal(calls.seek, 0);
  } finally { timer.restore(); }
});

// ---------- Spotify player abstraction ----------
// Mirrors the real spApi shape: get() -> data, put() -> { ok, status, reason, message }.
function fakeApi(routes) {
  const log = [];
  const call = async (method, path, body) => {
    log.push({ method, path, body });
    for (const [re, res] of routes) if (re.test(path)) return typeof res === 'function' ? res(method, path, body) : res;
    return { ok: true, status: 200, data: null };
  };
  return {
    log,
    get: async p => (await call('GET', p))?.data ?? null,
    put: (p, b) => call('PUT', p, b),
    raw: call
  };
}

test('spApi retries once on a 401 with a forced token', async () => {
  let n = 0;
  const getToken = async force => { n++; return force ? 'fresh' : 'stale'; };
  const api = spApi(getToken);
  globalThis.fetch = async (url, opts) => {
    const auth = opts.headers.authorization;
    if (auth === 'Bearer stale') return { status: 401, ok: false, json: async () => ({}) };
    return { status: 200, ok: true, json: async () => ({ hello: 'world' }) };
  };
  const r = await api.get('/me');
  assert.equal(r.hello, 'world', 'retried with a fresh token and returned data');
  assert.ok(n >= 2, 'asked for a forced token after the 401');
});

test('connect.play uses a known device and does not force a device lookup each time', async () => {
  const api = fakeApi([
    [/\/me\/player\/devices/, { ok: true, status: 200, data: { devices: [{ id: 'dev1', is_active: true }] } }],
    [/\/me\/player\/play/, { ok: true, status: 204, data: null }]
  ]);
  const p = spConnect(api);
  assert.equal(await p.ready(), true);
  const first = await p.play('spotify:track:x', 1000);
  assert.equal(first.ok, true);
  const deviceLookups = () => api.log.filter(l => l.path.includes('/devices')).length;
  const before = deviceLookups();
  await p.play('spotify:track:y', 0);
  assert.equal(deviceLookups(), before, 'no extra device lookup once the device is known');
  const play = api.log.find(l => /\/player\/play/.test(l.path));
  assert.match(play.path, /device_id=dev1/);
  assert.deepEqual(play.body, { uris: ['spotify:track:x'], position_ms: 1000 });
});

test('connect.position extrapolates from Spotify’s own timestamp', async () => {
  const now = Date.now();
  const api = fakeApi([
    [/\/me\/player$/, { ok: true, status: 200, data: { is_playing: true, progress_ms: 5000, timestamp: now - 1000, device: { id: 'd' }, item: { duration_ms: 200000 } } }]
  ]);
  const p = spConnect(api);
  const pos = await p.position();
  assert.ok(pos >= 5900 && pos <= 6200, `extrapolated ~6s, got ${pos}`);
});

test('connect.position does not advance while paused', async () => {
  const api = fakeApi([
    [/\/me\/player$/, { ok: true, status: 200, data: { is_playing: false, progress_ms: 5000, timestamp: Date.now() - 5000, item: { duration_ms: 200000 } } }]
  ]);
  const p = spConnect(api);
  assert.equal(await p.position(), 5000, 'paused position is exact');
});

test('connect.state reports the track and pause flag', async () => {
  const api = fakeApi([
    [/\/me\/player$/, { ok: true, status: 200, data: { is_playing: false, progress_ms: 1234, timestamp: 1, item: { id: 'tid', uri: 'spotify:track:tid', duration_ms: 90000 } } }]
  ]);
  const p = spConnect(api);
  const st = await p.state();
  assert.equal(st.trackId, 'tid');
  assert.equal(st.paused, true);
  assert.equal(st.duration, 90000);
  assert.equal(st.source, 'api');
});

test('connect.seek sends the exact millisecond', async () => {
  const api = fakeApi([[/\/me\/player\/seek/, { ok: true, status: 204 }]]);
  const p = spConnect(api);
  await p.seek(12345.6);
  assert.match(api.log.find(l => l.path.includes('/seek')).path, /position_ms=12346/);
});

test('connect.play clears the cached device when Spotify says there is no active device', async () => {
  let first = true;
  const api = fakeApi([
    [/\/me\/player\/play/, () => { if (first) { first = false; return { ok: false, status: 404, reason: 'NO_ACTIVE_DEVICE' }; } return { ok: true, status: 204 }; }],
    [/\/me\/player\/devices/, { ok: true, status: 200, data: { devices: [{ id: 'd2', is_active: false, is_restricted: false }] } }]
  ]);
  const p = spConnect(api);
  await p.ready();
  const r = await p.play('spotify:track:z', 0);
  assert.equal(r.ok, true, 'second attempt succeeds');
  assert.ok(api.log.some(l => l.path.includes('/devices')), 'looked up a fresh device');
});

test('queueAdds finds songs queued in Spotify but not its own top-ups', () => {
  const a = 'spotify:track:a', b = 'spotify:track:b', c = 'spotify:track:c';
  assert.deepEqual(queueAdds(null, [a, b]), [], 'no baseline yet');
  assert.deepEqual(queueAdds([a, b], [a, b]), [], 'nothing new');
  // a new track inserted at the front, and Spotify topping the end up with its own pick
  assert.deepEqual(queueAdds([a, b], [c, a, b, 'spotify:track:auto']), [c]);
});

test('whyNot explains the common Spotify refusals in words', () => {
  assert.match(whyNot({ reason: 'PREMIUM_REQUIRED' }, 'me'), /Premium/);
  assert.match(whyNot({ status: 404 }), /player/i);
  assert.match(whyNot({ status: 401 }), /Reconnect/);
  assert.match(whyNot({ status: 500, message: 'boom' }), /boom/);
});

test('findUri matches a song by title and length, and caches the answer', async () => {
  let searches = 0;
  const api = {
    get: async p => {
      searches++;
      return { tracks: { items: [
        { name: 'Wrong Song', duration_ms: 200000, uri: 'spotify:track:wrong' },
        { name: 'Right Song', duration_ms: 181000, uri: 'spotify:track:right' }
      ] } };
    }
  };
  const t = { tid: 'yt1', title: 'Right Song', artist: 'Someone', dur: 180 };
  assert.equal(await findUri(api, t), 'spotify:track:right');
  assert.equal(await findUri(api, t), 'spotify:track:right', 'cached');
  assert.equal(searches, 1, 'only searched once');
});

// ---------- choosing where Spotify plays ----------
const dev = (id, type, extra = {}) => ({ id, name: id, type, is_restricted: false, ...extra });

test('usableDevice rejects restricted devices and those without an id', () => {
  assert.equal(usableDevice(dev('a', 'Computer')), true);
  assert.equal(usableDevice({ id: 'b', is_restricted: true }), false);
  assert.equal(usableDevice({ name: 'no id' }), false);
  assert.equal(usableDevice(null), false);
});

test('bestDevice follows whatever is already playing', () => {
  const list = [dev('mac', 'Computer'), dev('phone', 'Smartphone', { is_active: true })];
  assert.equal(bestDevice(list).id, 'phone');
});

test('bestDevice prefers a computer, then a phone, over a speaker or a TV', () => {
  const list = [dev('tv', 'TV'), dev('speaker', 'Speaker'), dev('phone', 'Smartphone'), dev('mac', 'Computer')];
  assert.equal(bestDevice(list).id, 'mac');
  assert.equal(bestDevice([dev('tv', 'TV'), dev('speaker', 'Speaker'), dev('phone', 'Smartphone')]).id, 'phone');
  assert.equal(bestDevice([dev('tv', 'TV'), dev('speaker', 'Speaker')]).id, 'speaker');
});

test('bestDevice never returns a restricted device, and copes with an empty list', () => {
  const list = [dev('roku', 'TV', { is_restricted: true }), dev('laptop', 'Computer')];
  assert.equal(bestDevice(list).id, 'laptop');
  assert.equal(bestDevice([dev('roku', 'TV', { is_restricted: true })]), null);
  assert.equal(bestDevice([]), null);
  assert.equal(bestDevice(null), null);
});

test('the Spotify player remembers the chosen device and can be told which one to use', async () => {
  const calls = [];
  const api = {
    get: async p => p === '/me/player/devices'
      ? { devices: [dev('mac', 'Computer'), dev('phone', 'Smartphone')] }
      : null,
    put: async p => { calls.push(p); return { ok: true }; }
  };
  const store = {};
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
  const sp = spConnect(api);

  assert.equal(await sp.ready(), true);
  assert.equal(sp.deviceId(), 'mac');                        // a computer is the best default
  assert.equal(store['sp:device'], 'mac');                   // and it is remembered across reloads

  sp.setDevice('phone');
  assert.equal(sp.deviceId(), 'phone');
  assert.equal(store['sp:device'], 'phone');

  const list = await sp.devices();
  assert.deepEqual(list.map(d => d.id), ['mac', 'phone']);   // computers sort before phones
  delete globalThis.localStorage;
});
