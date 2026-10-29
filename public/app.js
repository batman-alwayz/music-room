import { setOffset, serverNow, startLoop } from './sync.js';
import { connect, ytm, manual, routeFor } from './players.js';

let S = { queue: [], playing: null, present: {}, armed: {}, part: {}, votes: [], startAt: 0, endAt: 0, seq: 0 };
let me, player, loop, ws, device = null, ready = false;
let wantArmed = true, lastSeq = -1, beginTimer, playToken = 0, lastDrift = 0, backoff = 1000, lastArm = 0, status = '';

const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
};

// ---------- Spotify Web API (token comes from our Worker, which refreshes it) ----------
let tok = null, tokExp = 0;
async function getToken(force) {
  if (!force && tok && Date.now() < tokExp - 60000) return tok;
  const r = await fetch('/api/token' + (force ? '?force=1' : ''));
  if (!r.ok) return null;
  const j = await r.json(); tok = j.token; tokExp = j.exp; return tok;
}
async function sp(method, path, body, retry = true) {
  const t = await getToken();
  if (!t) return null;
  const r = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: { authorization: 'Bearer ' + t, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 401 && retry) { await getToken(true); return sp(method, path, body, false); }
  if (!r.ok || r.status === 204) return null;
  return r.json().catch(() => null);
}
const api = { get: p => sp('GET', p), put: (p, b) => sp('PUT', p, b) };

// ---------- native shell bridge (Android WebView / iOS WKWebView) ----------
const hasShell = () => !!(window.NativeBridge || window.webkit?.messageHandlers?.native);
function sendToShell(name, arg) {
  const nb = window.NativeBridge;
  if (nb) {                                                  // Android: methods are matched by arg count
    if (name === 'load') return nb.load(arg.id, arg.ms);
    return arg === undefined ? nb[name]() : nb[name](arg);
  }
  window.webkit?.messageHandlers?.native?.postMessage({ name, arg });   // iOS: async; position is pushed to window.__pos
  return name === 'position' ? (window.__pos ?? 0) : undefined;
}

// ---------- routing ----------
function route(m) {
  if (m.provider === 'spotify') return m.product === 'premium' ? 'connect' : 'manual';
  return hasShell() ? 'ytm' : 'manual';
}

async function getDevice() {
  const r = await api.get('/me/player/devices');
  const list = r?.devices || [];
  return (list.find(d => d.is_active) || list.find(d => !d.is_restricted))?.id || null;
}

async function pick() {
  const r = route(me);
  if (r === 'connect') {
    device = await getDevice();                              // cached from /me/player/devices
    if (device) { player = connect(api, device); ready = true; setStatus(''); }
    else { ready = false; setStatus('Spotify app not running — open it on this device'); }
  } else if (r === 'ytm') {
    player = ytm(sendToShell); ready = true;
  } else {
    player = manual(() => S, serverNow); ready = true;
    setStatus(routeFor(me).ads ? 'Free tier: press play in your music app when the countdown ends' : 'Press play in your music app when the countdown ends');
  }
}

// Spotify app closed/opened while we run: go "away" so the room doesn't wait for us
function watchDevice() {
  if (route(me) !== 'connect') return;
  setInterval(async () => {
    const d = await getDevice();
    if (!d && ready) { ready = false; send({ t: 'away', v: true }); setStatus('Spotify app not running — open it on this device'); }
    else if (d && (!ready || d !== device)) {
      device = d; player = connect(api, d);
      if (!ready) { ready = true; send({ t: 'away', v: false }); setStatus(''); }
    }
    render();
  }, 5000);
}

// ---------- room connection ----------
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

function connectWS() {
  ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/ws');
  ws.onopen = () => {
    backoff = 1000;
    send({ t: 'join' });
    if (!ready) send({ t: 'away', v: true });
  };
  ws.onmessage = e => onFrame(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connectWS, (backoff = Math.min(backoff * 2, 15000)));
}

function onFrame({ s, now }) {
  setOffset(now);
  const was = S.playing;
  S = s;
  render();
  if (S.playing && (!was || S.seq !== lastSeq)) { lastSeq = S.seq; begin(); }
  if (was && !S.playing) finish();
  autoArm();
}

function autoArm() {
  if (ready && wantArmed && !S.playing && S.present[me.id] && !S.armed[me.id] && Date.now() - lastArm > 1500) {
    lastArm = Date.now(); send({ t: 'arm' });
  }
}

async function ytId(t) {
  if (t.yt_id) return t.yt_id;
  try {
    const r = await fetch('/api/match', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ track: t })
    });
    return r.ok ? (await r.json()).yt_id : null;
  } catch { return null; }
}

async function begin() {
  // joined mid-song? sit out until the next track (gather gate: nobody seeks into a song)
  if (!ready || !S.part?.[me.id]) return;
  const t = S.playing, seq = S.seq;
  clearTimers();
  const token = ++playToken;
  const isYtm = route(me) === 'ytm';
  const idP = isYtm ? ytId(t) : Promise.resolve(t.uri || 'spotify:track:' + t.sp_id);
  // start slightly before the countdown ends so everyone lands on 0:00 together
  const wait = Math.max(0, S.startAt - serverNow() - 400);
  beginTimer = setTimeout(async () => {
    if (token !== playToken) return;
    const id = await idP;
    if (token !== playToken) return;
    const late = Math.max(0, serverNow() - S.startAt);
    if (id) await player.play(id, late);
    if (token !== playToken) return;
    loop = startLoop(player, () => S, paintDrift);
    player.end(t.dur * 1000).then(() => { if (token === playToken) send({ t: 'ended', seq }); });
  }, wait);
}

function clearTimers() {
  playToken++;
  clearTimeout(beginTimer);
  clearInterval(loop);
  player?.cancel?.();
}

function finish() {
  clearTimers();
  Promise.resolve(player?.pause?.()).catch(() => {});
}

function paintDrift(d) {
  lastDrift = d;
  const e = $('#drift');
  if (e) e.textContent = `sync ${d >= 0 ? '+' : ''}${Math.round(d)} ms`;
}

// ---------- UI ----------
function setStatus(t) { status = t; render(); }
const nameOf = id => S.present[id]?.name || id;

function render() {
  if (!me) return;
  const np = $('#np'); np.replaceChildren();
  if (S.playing) {
    const t = S.playing;
    np.append(
      h('div', { class: 't' }, t.title),
      h('div', { class: 's' }, `${t.artist} · added by ${nameOf(t.by)}`),
      h('div', { id: 'drift', class: 's' }, '')
    );
  } else {
    np.append(h('div', { class: 's' }, S.queue.length ? 'Waiting for everyone to be ready…' : 'Queue is empty — add a song'));
  }

  const bar = $('#armbar'); bar.replaceChildren();
  bar.append(
    h('button', { class: 'btn', onclick: () => { wantArmed = !wantArmed; send({ t: wantArmed ? 'arm' : 'unarm' }); } },
      wantArmed ? 'Ready ✓' : 'Not ready'),
    h('button', { class: 'btn', onclick: () => send({ t: 'skip' }) },
      `Skip (${S.votes.length}/${Math.ceil(Object.values(S.present).filter(p => !p.away).length * 0.6)})`),
    status && h('div', { class: 's' }, status),
    h('div', { class: 'chips' }, ...Object.values(S.present).map(p =>
      h('span', { class: 'chip' }, `${p.name}${p.away ? ' (away)' : S.armed[p.id] ? ' ✓' : ''}`)))
  );

  const qEl = $('#queue'); qEl.replaceChildren();
  S.queue.forEach((q, i) => {
    const mine = q.by === me.id || me.admin;
    qEl.append(h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, q.title), h('div', { class: 's' }, `${q.artist} · ${nameOf(q.by)}`)),
      mine && i > 0 && h('button', { class: 'btn', onclick: () => send({ t: 'move', tid: q.tid, pos: i - 1 }) }, '↑'),
      mine && h('button', { class: 'btn', onclick: () => send({ t: 'remove', tid: q.tid }) }, '✕')));
  });
}

setInterval(() => {                                          // countdown / manual-play hint
  const e = $('#drift');
  if (!e || !S.playing) return;
  const left = S.startAt - serverNow();
  if (left > 0) e.textContent = `starting in ${Math.ceil(left / 1000)}…`;
  else if (route(me) === 'manual') e.textContent = 'play it now in your music app';
  else paintDrift(lastDrift);
}, 250);

setInterval(() => {                                          // keep-alive + progress for everyone's view
  if (S.playing && ws?.readyState === 1)
    send({ t: 'progress', ms: Math.max(0, serverNow() - S.startAt + lastDrift) });
}, 5000);

// ---------- search & add ----------
async function search(q) {
  const r = await api.get('/search?type=track&limit=8&q=' + encodeURIComponent(q));
  const box = $('#results'); box.replaceChildren();
  for (const t of r?.tracks?.items || []) {
    box.append(h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, t.name), h('div', { class: 's' }, t.artists.map(a => a.name).join(', '))),
      h('button', {
        class: 'btn', onclick: () => {
          send({
            t: 'add', tid: t.id, title: t.name, artist: t.artists[0]?.name, album: t.album?.name,
            dur: t.duration_ms / 1000, uri: t.uri, sp_id: t.id,
            cover: t.album?.images?.[2]?.url, isrc: t.external_ids?.isrc
          });
          box.replaceChildren(); $('#q').value = '';
        }
      }, 'Add')));
  }
}

// ---------- boot ----------
window.voteSkip = () => send({ t: 'skip' });                // called by the Android lock-screen "next"

async function init() {
  $('#q')?.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) search(e.target.value.trim()); });
  const r = await fetch('/api/me');
  if (r.status === 401) { $('#login').hidden = false; return; }
  me = await r.json();
  $('#app').hidden = false;
  await pick();
  watchDevice();
  connectWS();
  navigator.serviceWorker?.register('/sw.js');
}
init();
