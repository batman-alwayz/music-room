import { setOffset, serverNow, startLoop } from './sync.js';
import { ytm, web, manual } from './players.js';

let S = { queue: [], playing: null, present: {}, armed: {}, part: {}, votes: [], startAt: 0, endAt: 0, seq: 0 };
let me, player, loop, ws, ready = false;
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

// ---------- routing: everyone plays through YouTube ----------
function route() {
  if (new URLSearchParams(location.search).has('manual')) return 'manual';
  return hasShell() ? 'ytm' : 'web';
}

async function pick() {
  const r = route();
  if (r === 'ytm') player = ytm(sendToShell);
  else if (r === 'web') { $('#webwrap').hidden = false; player = web('webplayer'); setStatus('Keep this tab open — the song plays here'); }
  else { player = manual(() => S, serverNow); setStatus('Press play in your own music app when the countdown ends'); }
  ready = true;
}

// ---------- room connection ----------
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

function connectWS() {
  ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/ws');
  ws.onopen = () => { backoff = 1000; send({ t: 'join' }); };
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

async function begin() {
  // joined mid-song? sit out until the next track (gather gate: nobody seeks into a song)
  if (!ready || !S.part?.[me.id]) return;
  const t = S.playing, seq = S.seq;
  clearTimers();
  const token = ++playToken;
  // start slightly before the countdown ends so everyone lands on 0:00 together
  const wait = Math.max(0, S.startAt - serverNow() - 400);
  beginTimer = setTimeout(async () => {
    if (token !== playToken) return;
    const late = Math.max(0, serverNow() - S.startAt);
    await player.play(t.yt_id || t.tid, late);
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
  else if (route() === 'manual') e.textContent = 'play it now in your music app';
  else paintDrift(lastDrift);
}, 250);

setInterval(() => {                                          // keep-alive + progress for everyone's view
  if (S.playing && ws?.readyState === 1)
    send({ t: 'progress', ms: Math.max(0, serverNow() - S.startAt + lastDrift) });
}, 5000);

// ---------- search & add (type a name, or paste a YouTube / YouTube Music link) ----------
async function search(q) {
  const box = $('#results'); box.replaceChildren(h('div', { class: 's' }, 'Searching…'));
  const r = await fetch('/api/search?q=' + encodeURIComponent(q)).catch(() => null);
  box.replaceChildren();
  if (!r || !r.ok) {
    box.append(h('div', { class: 's' }, r?.status === 503 ? 'Search is not set up on the server yet (YT_API_KEY)' : 'Search failed, try again'));
    return;
  }
  const { items } = await r.json();
  if (!items.length) box.append(h('div', { class: 's' }, 'Nothing found'));
  for (const t of items) {
    box.append(h('div', { class: 'row' },
      t.cover && h('img', { src: t.cover, width: '48', height: '36', style: 'border-radius:6px;object-fit:cover' }),
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, t.title), h('div', { class: 's' }, t.artist)),
      h('button', {
        class: 'btn', onclick: () => {
          send({ t: 'add', tid: t.tid, title: t.title, artist: t.artist, dur: t.dur, cover: t.cover });
          box.replaceChildren(); $('#q').value = '';
        }
      }, 'Add')));
  }
}

// ---------- login & boot ----------
window.voteSkip = () => send({ t: 'skip' });                // called by the native lock-screen "next"

async function doJoin() {
  const err = $('#err'); err.textContent = '';
  const r = await fetch('/auth/join', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: $('#name').value, code: $('#code').value })
  }).catch(() => null);
  if (r?.ok) return location.reload();
  err.textContent = r?.status === 429 ? 'Too many tries, wait a bit' : r?.status === 403 ? 'Wrong code or empty name' : 'Could not reach the server';
}

async function init() {
  $('#join').addEventListener('click', doJoin);
  $('#code').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) search(e.target.value.trim()); });
  const r = await fetch('/api/me');
  if (r.status === 401) { $('#login').hidden = false; return; }
  me = await r.json();
  $('#app').hidden = false;
  await pick();
  connectWS();
  navigator.serviceWorker?.register('/sw.js');
}
init();
