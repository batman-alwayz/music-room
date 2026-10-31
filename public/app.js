import { setOffset, serverNow, startLoop } from './sync.js';
import { ytm, web, manual } from './players.js';

const QUOTA = 10;                                            // songs one person may have queued
const fresh = () => ({
  queue: [], playing: null, present: {}, armed: {}, part: {}, votes: [], pvotes: [], hist: [],
  startAt: 0, goAt: 0, endAt: 0, seq: 0, paused: false, pos: 0
});

let S = fresh();
let me, player, loop, ws, ready = false, room = null;
let wantArmed = true, beganSeq = -1, beginTimer, playToken = 0, lastDrift = 0, backoff = 1000, lastArm = 0;
let status = '', routeNote = '';
let pls = [], openPl = null, plFrom = 'lobby', renaming = false, delArmed = false, toastT;

const $ = s => document.querySelector(s);
const on = (id, ev, fn) => $('#' + id).addEventListener(ev, fn);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
};

async function api(path, body) {
  const r = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }).catch(() => null);
  if (!r) return { error: 'network' };
  const j = await r.json().catch(() => ({}));
  return r.ok ? j : { ...j, error: j.error || String(r.status) };
}

function show(name) {
  for (const id of ['login', 'lobby', 'room', 'pls']) $('#' + id).hidden = id !== name;
  $('#webwrap').style.visibility = name === 'room' ? 'visible' : 'hidden';
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2500);
}

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

// ---------- player: everyone plays through YouTube ----------
function route() {
  if (new URLSearchParams(location.search).has('manual')) return 'manual';
  return hasShell() ? 'ytm' : 'web';
}
async function pick() {
  const r = route();
  if (r === 'ytm') player = ytm(sendToShell);
  else if (r === 'web') {
    $('#webwrap').hidden = false;
    player = web('webplayer', {
      onLive: v => { send({ t: 'live', v }); if (v) $('#tap').hidden = true; },
      onBlocked: () => { $('#tap').hidden = false; },
      onError: c => setStatus(c === 101 || c === 150
        ? 'This song cannot be played in a browser (blocked by the uploader). Skip it or use the app.'
        : 'Playback error — try skipping')
    });
    routeNote = 'Keep this tab open and the screen on — the song plays here';
  } else { player = manual(() => S, serverNow); routeNote = 'Press play in your own music app when the countdown ends'; }
  ready = true;
}

// ---------- lobby: create / join rooms ----------
async function loadLobby() {
  const r = await api('rooms');
  const box = $('#myrooms'); box.replaceChildren();
  const items = r.items || [];
  if (!items.length) box.append(h('div', { class: 's' }, 'No rooms yet — create one, or join with a code'));
  for (const x of items) {
    box.append(h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, x.name), h('div', { class: 's' }, `Code ${x.id}${x.owner ? ' · yours' : ''}`)),
      h('button', { class: 'btn', onclick: () => joinCode(x.id) }, 'Open'),
      h('button', { class: 'btn ghost', title: 'Remove from my list', onclick: async () => { await api('rooms/leave', { id: x.id }); loadLobby(); } }, '✕')));
  }
}
async function createRoom() {
  const name = $('#rname').value.trim();
  $('#lerr').textContent = '';
  if (!name) { $('#lerr').textContent = 'Give the room a name'; return; }
  const r = await api('rooms', { name });
  if (r.error) { $('#lerr').textContent = r.error === 'limit' ? 'You can own up to 5 rooms' : 'Could not create the room'; return; }
  $('#rname').value = '';
  openRoom(r);
}
async function joinCode(code) {
  code = String(code).trim().toUpperCase();
  $('#lerr').textContent = '';
  if (code.length !== 6) { $('#lerr').textContent = 'A room code has 6 characters'; return; }
  const r = await api('rooms/join', { code });
  if (r.error) {
    history.replaceState(null, '', location.pathname);
    show('lobby'); loadLobby();
    $('#lerr').textContent = 'No room with that code';
    return;
  }
  openRoom(r);
}

// ---------- room connection ----------
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
function closeWS() { const w = ws; ws = null; if (w) { w.onclose = null; w.onmessage = null; w.close(); } }

function openRoom(r) {
  closeWS(); clearTimers();
  room = r; S = fresh(); beganSeq = -1; lastDrift = 0; wantArmed = true; status = '';
  history.replaceState(null, '', '#r=' + r.id);
  $('#rtitle').textContent = r.name;
  $('#rcodeline').textContent = 'Code ' + r.id;
  show('room'); render(); connectWS();
}
function leaveRoom() {
  closeWS(); clearTimers();
  Promise.resolve(player?.pause?.()).catch(() => {});
  room = null; S = fresh();
  history.replaceState(null, '', location.pathname);
  show('lobby'); loadLobby();
}
function connectWS() {
  const mine = room;
  const w = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/ws?room=' + mine.id);
  ws = w;
  w.onopen = () => { backoff = 1000; send({ t: 'join' }); };
  w.onmessage = e => { if (room === mine) onFrame(JSON.parse(e.data)); };
  w.onclose = () => {
    if (room === mine) setTimeout(() => { if (room === mine) connectWS(); }, (backoff = Math.min(backoff * 2, 15000)));
  };
}

function onFrame({ s, now }) {
  setOffset(now);
  const was = S.playing, wasPaused = S.paused;
  S = s;
  render();
  if (S.playing && S.part?.[me.id]) {
    if (S.paused && !wasPaused) {                            // someone paused the room
      clearTimers();
      Promise.resolve(player.pause?.()).catch(() => {});
    } else if (!S.paused && (beganSeq !== S.seq || wasPaused)) {   // new song, "join now", or resume
      beganSeq = S.seq; begin();
    }
  }
  if (was && !S.playing) finish();
  autoArm();
}

function autoArm() {
  if (ready && room && wantArmed && !S.playing && S.present[me.id] && !S.armed[me.id] && Date.now() - lastArm > 1500) {
    lastArm = Date.now(); send({ t: 'arm' });
  }
}

async function begin() {
  // not part of this song (joined mid-song)? sit out until the next one or "Join this song now"
  if (!ready || S.paused || !S.part?.[me.id]) return;
  const t = S.playing, seq = S.seq;
  clearTimers();
  const token = ++playToken;
  // start slightly before the countdown ends so everyone lands on 0:00 together
  const wait = Math.max(0, S.goAt - serverNow() - 400);
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
  if (e && !S.paused) e.textContent = `sync ${d >= 0 ? '+' : ''}${Math.round(d)} ms`;
}

// ---------- room UI ----------
function setStatus(t) { status = t; render(); }
const nameOf = id => S.present[id]?.name || id;
const trackOf = t => ({ tid: t.tid, title: t.title, artist: t.artist, dur: t.dur, cover: t.cover });

function render() {
  if (!me || !room) return;
  const admin = !!S.present[me.id]?.admin;
  const act = Object.values(S.present).filter(p => !p.away).length;
  const need = Math.max(1, Math.ceil(act * 0.6));

  const np = $('#np'); np.replaceChildren();
  if (S.playing) {
    const t = S.playing;
    np.append(
      h('div', { class: 't' }, t.title),
      h('div', { class: 's' }, `${t.artist} · added by ${nameOf(t.by)}`),
      h('div', { id: 'drift', class: 's' }, S.paused ? '⏸ Paused' : ''),
      !S.part?.[me.id] && h('div', { class: 's', style: 'margin-top:6px' }, 'A song is already playing — you will hear the next one. ',
        h('button', { class: 'btn', onclick: () => send({ t: 'late' }) }, 'Join this song now')),
      h('button', { class: 'btn ghost', style: 'margin-top:6px', onclick: () => pickPlaylist(trackOf(t)) }, '♪ Save to playlist')
    );
  } else {
    np.append(h('div', { class: 's' }, S.queue.length ? 'Waiting for everyone to be ready…' : 'Queue is empty — add a song'));
  }

  const votes = [S.votes.length && `skip ${S.votes.length}/${need}`, S.pvotes?.length && `back ${S.pvotes.length}/${need}`].filter(Boolean).join(' · ');
  $('#ctl').replaceChildren(...[
    h('button', { class: 'btn', title: 'Previous (vote)', onclick: () => send({ t: 'prev' }) }, '⏮'),
    h('button', { class: 'btn', disabled: !S.playing, title: S.paused ? 'Resume' : 'Pause', onclick: () => send({ t: S.paused ? 'resume' : 'pause' }) }, S.paused ? '▶' : '⏸'),
    h('button', { class: 'btn', disabled: !S.playing, title: 'Skip (vote)', onclick: () => send({ t: 'skip' }) }, '⏭'),
    votes && h('div', { class: 's' }, votes)
  ].filter(Boolean));

  $('#armbar').replaceChildren(...[
    h('button', { class: 'btn ghost', onclick: () => { wantArmed = !wantArmed; send({ t: wantArmed ? 'arm' : 'unarm' }); } },
      wantArmed ? 'Ready ✓' : 'Not ready'),
    (status || routeNote) && h('div', { class: 's' }, status || routeNote),
    h('div', { class: 'chips' }, ...Object.values(S.present).map(p =>
      h('span', { class: 'chip' }, `${p.name}${p.away ? ' (away)' : S.playing ? (S.part?.[p.id] ? (p.live ? ' 🔊' : ' …') : ' (next song)') : S.armed[p.id] ? ' ✓' : ''}`)))
  ].filter(Boolean));

  const qEl = $('#queue'); qEl.replaceChildren();
  if (!S.queue.length) qEl.append(h('div', { class: 's' }, 'Nothing queued'));
  S.queue.forEach((q, i) => {
    const mine = q.by === me.id || admin;
    qEl.append(h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, q.title), h('div', { class: 's' }, `${q.artist} · ${nameOf(q.by)}`)),
      mine && i > 0 && h('button', { class: 'btn ghost', title: 'Move up', onclick: () => send({ t: 'move', tid: q.tid, pos: i - 1 }) }, '↑'),
      mine && i < S.queue.length - 1 && h('button', { class: 'btn ghost', title: 'Move down', onclick: () => send({ t: 'move', tid: q.tid, pos: i + 1 }) }, '↓'),
      h('button', { class: 'btn ghost', title: 'Save to playlist', onclick: () => pickPlaylist(trackOf(q)) }, '♪'),
      mine && h('button', { class: 'btn ghost', title: 'Remove', onclick: () => send({ t: 'remove', tid: q.tid }) }, '✕')));
  });
}

setInterval(() => {                                          // countdown / paused hint
  const e = $('#drift');
  if (!e || !S.playing) return;
  if (S.paused) { e.textContent = '⏸ Paused'; return; }
  const left = S.goAt - serverNow();
  if (left > 0) e.textContent = `starting in ${Math.ceil(left / 1000)}…`;
  else if (route() === 'manual') e.textContent = 'play it now in your music app';
  else paintDrift(lastDrift);
}, 250);

setInterval(() => {                                          // keep-alive + progress for everyone's view
  if (room && S.playing && !S.paused && ws?.readyState === 1)
    send({ t: 'progress', ms: Math.max(0, serverNow() - S.startAt + lastDrift) });
}, 5000);

// ---------- search (shared by the room and the playlist screen) ----------
async function search(q, box, actions) {
  box.replaceChildren(h('div', { class: 's' }, 'Searching…'));
  const r = await api('search?q=' + encodeURIComponent(q));
  box.replaceChildren();
  if (r.error) { box.append(h('div', { class: 's' }, 'Search failed, try again')); return; }
  if (!r.items?.length) box.append(h('div', { class: 's' }, 'Nothing found'));
  for (const t of r.items || []) {
    box.append(h('div', { class: 'row' },
      t.cover && h('img', { src: t.cover, width: '48', height: '36', style: 'border-radius:6px;object-fit:cover' }),
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, t.title), h('div', { class: 's' }, t.artist)),
      ...actions(t, box)));
  }
}

// ---------- playlists ----------
async function pickPlaylist(track) {                         // bottom sheet: save a song to one of my playlists
  const r = await api('playlists');
  const ov = $('#overlay'); ov.replaceChildren(); ov.hidden = false;
  const close = () => { ov.hidden = true; };
  const save = async id => {
    const x = await api('playlists/' + id + '/add', { track });
    close(); toast(x.error ? (x.error === 'limit' ? 'Playlist is full (200 songs)' : 'Could not save') : 'Saved to playlist');
  };
  const nameIn = h('input', { placeholder: 'New playlist name', maxlength: '30' });
  ov.replaceChildren(h('div', { class: 'sheet' },
    h('div', { class: 't' }, 'Save to playlist'),
    ...(r.items || []).map(p => h('button', { class: 'btn ghost', onclick: () => save(p.id) }, `${p.name} (${p.n})`)),
    nameIn,
    h('button', { class: 'btn', onclick: async () => {
      const name = nameIn.value.trim(); if (!name) return;
      const c = await api('playlists', { name });
      if (c.id) save(c.id); else toast('Could not create (max 30 playlists)');
    } }, 'Create & save'),
    h('button', { class: 'btn ghost', onclick: close }, 'Cancel')));
}

async function showPlaylists(from) {
  plFrom = from; openPl = null; show('pls'); await loadPls();
}
async function loadPls() {
  const r = await api('playlists');
  pls = r.items || [];
  renderPls();
}
function renderPls() {
  $('#plhome').hidden = !!openPl;
  $('#pldetail').hidden = !openPl;
  if (openPl) return renderPlDetail();
  const box = $('#pllist'); box.replaceChildren();
  if (!pls.length) box.append(h('div', { class: 's' }, 'No playlists yet — create one above'));
  for (const p of pls) {
    box.append(h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, p.name), h('div', { class: 's' }, `${p.n} song${p.n === 1 ? '' : 's'}`)),
      h('button', { class: 'btn', onclick: () => openPlaylist(p) }, 'Open')));
  }
}
async function openPlaylist(p) {
  renaming = false; delArmed = false;
  $('#plrnin').hidden = true; $('#plrename').textContent = 'Rename'; $('#pldel').textContent = 'Delete';
  const r = await api('playlists/' + p.id);
  openPl = { ...p, tracks: r.items || [] };
  renderPls();
}
function renderPlDetail() {
  $('#pltitle').textContent = openPl.name;
  $('#plplay').hidden = !room;                               // only inside a room
  const box = $('#pltracks'); box.replaceChildren();
  if (!openPl.tracks.length) box.append(h('div', { class: 's' }, 'Empty — search above to add songs'));
  for (const t of openPl.tracks) {
    box.append(h('div', { class: 'row' },
      t.cover && h('img', { src: t.cover, width: '48', height: '36', style: 'border-radius:6px;object-fit:cover' }),
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, t.title), h('div', { class: 's' }, t.artist)),
      h('button', { class: 'btn ghost', title: 'Remove', onclick: async () => {
        await api('playlists/' + openPl.id + '/remove', { tid: t.tid });
        openPlaylist(openPl);
      } }, '✕')));
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

function wire() {
  on('join', 'click', doJoin);
  on('code', 'keydown', e => { if (e.key === 'Enter') doJoin(); });

  on('rcreate', 'click', createRoom);
  on('rname', 'keydown', e => { if (e.key === 'Enter') createRoom(); });
  on('rjoin', 'click', () => joinCode($('#rcode').value));
  on('rcode', 'keydown', e => { if (e.key === 'Enter') joinCode(e.target.value); });
  on('toPls', 'click', () => showPlaylists('lobby'));

  on('back', 'click', leaveRoom);
  on('toPls2', 'click', () => showPlaylists('room'));
  on('invite', 'click', async () => {
    const link = location.origin + '/#r=' + room.id;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied'); }
    catch { toast(link); }
  });
  on('tap', 'click', async () => { await player?.resume?.(); $('#tap').hidden = true; });
  on('q', 'keydown', e => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    search(e.target.value.trim(), $('#results'), (t, box) => [
      h('button', { class: 'btn', onclick: () => { send({ t: 'add', ...trackOf(t) }); box.replaceChildren(); $('#q').value = ''; } }, 'Add'),
      h('button', { class: 'btn ghost', title: 'Save to playlist', onclick: () => pickPlaylist(trackOf(t)) }, '♪')
    ]);
  });

  on('plback', 'click', () => { if (plFrom === 'room' && room) show('room'); else { show('lobby'); loadLobby(); } });
  on('pldback', 'click', () => { openPl = null; loadPls(); });
  on('plcreate', 'click', async () => {
    const name = $('#plname').value.trim(); if (!name) return;
    const r = await api('playlists', { name });
    if (r.error) toast('Could not create (max 30 playlists)');
    else { $('#plname').value = ''; loadPls(); }
  });
  on('plname', 'keydown', e => { if (e.key === 'Enter') $('#plcreate').click(); });
  on('plplay', 'click', () => {
    if (!room || !openPl?.tracks.length) return;
    const free = Math.max(0, QUOTA - S.queue.filter(q => q.by === me.id).length);
    send({ t: 'addpl', id: openPl.id });
    toast(free ? `Queueing up to ${Math.min(free, openPl.tracks.length)} songs` : `You already have ${QUOTA} songs queued`);
    show('room');
  });
  on('plrename', 'click', async () => {
    if (!renaming) { renaming = true; $('#plrnin').hidden = false; $('#plrnin').value = openPl.name; $('#plrename').textContent = 'Save'; return; }
    const name = $('#plrnin').value.trim();
    if (name) { await api('playlists/' + openPl.id + '/rename', { name }); openPl.name = name; }
    renaming = false; $('#plrnin').hidden = true; $('#plrename').textContent = 'Rename'; $('#pltitle').textContent = openPl.name;
  });
  on('pldel', 'click', async () => {                         // two taps, because phones can't show confirm()
    if (!delArmed) {
      delArmed = true; $('#pldel').textContent = 'Tap again to delete';
      setTimeout(() => { delArmed = false; if (openPl) $('#pldel').textContent = 'Delete'; }, 3000);
      return;
    }
    await api('playlists/' + openPl.id + '/delete', {});
    openPl = null; delArmed = false; $('#pldel').textContent = 'Delete'; loadPls();
  });
  on('plq', 'keydown', e => {
    if (e.key !== 'Enter' || !e.target.value.trim() || !openPl) return;
    search(e.target.value.trim(), $('#plres'), t => [
      h('button', { class: 'btn', onclick: async () => {
        const x = await api('playlists/' + openPl.id + '/add', { track: trackOf(t) });
        toast(x.error ? 'Could not add' : 'Added');
        openPlaylist(openPl);
      } }, 'Add')
    ]);
  });
}

async function init() {
  wire();
  const r = await fetch('/api/me');
  if (r.status === 401) { show('login'); return; }
  me = await r.json();
  await pick();
  navigator.serviceWorker?.register('/sw.js');
  const m = location.hash.match(/r=([A-Za-z0-9]{6})/);       // an invite link opens that room directly
  if (m) return joinCode(m[1]);
  show('lobby'); loadLobby();
}
init();
