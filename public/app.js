import { setOffset, serverNow, startLoop } from './sync.js';
import { ytm, web, manual } from './players.js';
import { createVinyl, parseLrc, lineIndex } from './vinyl.js';
import { spApi, connect as spConnect, findUri } from './spotify.js';

const QUOTA = 10;                                            // songs one person may have queued
const fresh = () => ({
  queue: [], playing: null, present: {}, armed: {}, part: {}, votes: [], pvotes: [], hist: [],
  startAt: 0, goAt: 0, endAt: 0, seq: 0, paused: false, pos: 0
});
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};

let S = fresh();
let me, player, yt, spot = null, spApiObj = null, vinyl, loop, ws, ready = false, room = null;
let spLink = { connected: false, hasId: false }, spTok = null, spExp = 0, warnedSp = false;
let curLyr = null, lastLyrI = -1, seekDrag = false;
let wantArmed = true, beganSeq = -1, beginTimer, playToken = 0, lastDrift = 0, backoff = 1000, lastArm = 0;
let status = '', routeNote = '', tab = 'search', lastItems = [], lastVinylTid = null;
let showVid = store.get('vid') === '1', spinLyr = store.get('spin') === '1', muted = store.get('mute') === '1';
let pls = [], openPl = null, plFrom = 'lobby', renaming = false, delArmed = false, toastT;
const lyrCache = new Map();

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
// turn a failed API answer into something a person can act on
const explain = (r, fallback) =>
  r.error === 'spotify' ? (r.status === 403 || r.status === 401 ? 'Spotify refused: reconnect, and check this account is on your Spotify app’s user list' : 'Spotify did not answer — try again')
  :
  /no such table/i.test(r.detail || '') ? 'The database is missing its newest tables — run schema.sql once (see the update steps)'
  : r.error === 'limit' ? 'Limit reached'
  : r.error === 'network' ? 'Could not reach the server'
  : r.detail ? `${fallback}: ${r.detail}` : fallback;

function show(name) {
  for (const id of ['login', 'lobby', 'room', 'pls']) $('#' + id).hidden = id !== name;
  $('#webwrap').style.visibility = name === 'room' ? 'visible' : 'hidden';
  if (vinyl) { if (name === 'room') vinyl.start(); else vinyl.stop(); }
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3000);
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
const route = () => new URLSearchParams(location.search).has('manual') ? 'manual' : hasShell() ? 'ytm' : 'web';
const applyVid = () => $('#webwrap').classList.toggle('min', !showVid);     // hidden = invisible but still playing
const applyMuteAll = () => [yt, spot].forEach(p => Promise.resolve(p?.setMuted?.(muted)).catch(() => {}));
function pauseAll() { [yt, spot].forEach(p => Promise.resolve(p?.pause?.()).catch(() => {})); }
function toggleMute() { muted = !muted; store.set('mute', muted ? '1' : '0'); applyMuteAll(); render(); }

async function pick() {
  const r = route();
  if (r === 'ytm') player = ytm(sendToShell);
  else if (r === 'web') {
    $('#webwrap').hidden = false; applyVid();
    player = web('webplayer', {
      onLive: v => { send({ t: 'live', v }); if (v) $('#tap').hidden = true; },
      onBlocked: () => { $('#tap').hidden = false; },
      onError: c => setStatus(c === 101 || c === 150
        ? 'This song cannot be played in a browser (blocked by the uploader). Skip it or use the app.'
        : 'Playback error — try skipping')
    });
    routeNote = 'Keep this tab open and the screen on — the song plays here';
    player.setMuted(muted);
  } else { player = manual(() => S, serverNow); routeNote = 'Press play in your own music app when the countdown ends'; }
  yt = player;
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
  if (r.error) { $('#lerr').textContent = explain(r, 'Could not create the room'); return; }
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
    $('#lerr').textContent = r.error === 'none' ? 'No room with that code' : explain(r, 'Could not join');
    return;
  }
  openRoom(r);
}

// ---------- room connection ----------
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }
function closeWS() { const w = ws; ws = null; if (w) { w.onclose = null; w.onmessage = null; w.close(); } }

function openRoom(r) {
  closeWS(); clearTimers();
  room = r; S = fresh(); beganSeq = -1; lastDrift = 0; wantArmed = true; status = ''; lastVinylTid = null;
  vinyl.setTrack(null); $('#lyrstat').textContent = '';
  history.replaceState(null, '', '#r=' + r.id);
  $('#rtitle').textContent = r.name;
  $('#rcodeline').textContent = 'Code ' + r.id;
  setTab('search');
  show('room'); render(); connectWS();
}
function leaveRoom() {
  closeWS(); clearTimers();
  pauseAll();
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
  const was = S.playing, wasPaused = S.paused, prevStart = S.startAt, prevGo = S.goAt, prevSeq = S.seq;
  S = s;
  if ((S.playing?.tid || null) !== lastVinylTid) {           // new song on the record
    lastVinylTid = S.playing?.tid || null;
    vinyl.setTrack(S.playing);
    curLyr = null; lastLyrI = -1; renderLyrics();
    if (S.playing) loadLyrics(S.playing);
  }
  render();
  if (S.playing && S.part?.[me.id]) {
    if (S.paused && !wasPaused) {                            // someone paused the room
      clearTimers();
      pauseAll();
    } else if (!S.paused && (beganSeq !== S.seq || wasPaused)) {   // new song, "join now", or resume
      beganSeq = S.seq; begin();
    } else if (!S.paused && prevStart && S.seq === prevSeq && S.goAt === prevGo && S.startAt !== prevStart) {
      Promise.resolve(player?.seek?.(serverNow() - S.startAt)).catch(() => {});   // someone dragged the sound bar: jump now
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
  // which player? the person's own Spotify (if switched on, the app is open and the song exists there), else YouTube
  const chosen = (async () => {
    if (spOn()) {
      try { setupSpot(); const uri = await findUri(spApiObj, t); if (uri && await spot.ready()) return { p: spot, id: uri }; } catch {}
      if (!warnedSp) { warnedSp = true; toast('Spotify: song or app not found — this one plays from YouTube'); }
    }
    return { p: yt, id: t.yt_id || t.tid };
  })();
  const wait = Math.max(0, S.goAt - serverNow() - 400);      // start a little early so everyone lands on 0:00 together
  beginTimer = setTimeout(async () => {
    if (token !== playToken) return;
    let { p, id } = await chosen;
    if (token !== playToken) return;
    const late = Math.max(0, serverNow() - S.startAt);
    player = p;
    const ok = await p.play(id, late);
    if (p === spot && ok === false) {                        // no Premium / the app went away: use YouTube instead
      store.set('spplay', '0'); renderSp();
      toast('Spotify could not play (it needs Premium and the Spotify app open). Switched back to YouTube.');
      player = p = yt; await yt.play(t.yt_id || t.tid, late);
    }
    Promise.resolve(p.setMuted?.(muted)).catch(() => {});
    if (p === spot) send({ t: 'live', v: true });
    if (token !== playToken) return;
    loop = startLoop(p, () => S, paintDrift);
    p.end(t.dur * 1000).then(() => { if (token === playToken) send({ t: 'ended', seq }); });
  }, wait);
}

function clearTimers() {
  playToken++;
  clearTimeout(beginTimer);
  clearInterval(loop);
  [yt, spot].forEach(p => p?.cancel?.());
}
function finish() {
  clearTimers();
  pauseAll();
}
function paintDrift(d) {
  lastDrift = d;
  const e = $('#drift');
  if (e && !S.paused) e.textContent = `sync ${d >= 0 ? '+' : ''}${Math.round(d)} ms`;
}

// ---------- lyrics ----------
async function loadLyrics(t) {
  const say = (tid, msg) => { if (S.playing?.tid === tid) $('#lyrstat').textContent = msg; };
  const label = l => !l ? '♪ No lyrics found for this song' : l.synced ? '♪ Synced lyrics' : '♪ Lyrics (not timed, spread over the song)';
  const show1 = l => { curLyr = l; vinyl.setLyrics(l); lastLyrI = -1; say(t.tid, label(l)); renderLyrics(); };
  if (lyrCache.has(t.tid)) { if (S.playing?.tid === t.tid) show1(lyrCache.get(t.tid)); return; }
  vinyl.setLyrics(null); say(t.tid, '♪ Loading lyrics…');
  const r = await api('lyrics?' + new URLSearchParams({ tid: t.tid, title: t.title, artist: t.artist || '', dur: String(t.dur) }));
  if (r.error && r.error !== 'none') { say(t.tid, '♪ Lyrics service not reachable right now'); return; }   // not remembered: tried again next time
  const parsed = r.lrc ? parseLrc(r.lrc) : null;
  lyrCache.set(t.tid, parsed);
  if (S.playing?.tid === t.tid) show1(parsed);
}

// ---------- the Lyrics tab: the whole song, the current line lit up ----------
const songMs = () => S.playing ? (S.paused ? S.pos : serverNow() - S.startAt) : 0;
const lyrOff = () => +(store.get('lo:' + (S.playing?.tid || '')) || 0);      // per-song nudge in ms (+ = lyrics earlier)
function renderLyrics() {
  const box = $('#lyrlist'); box.replaceChildren();
  const t = S.playing;
  $('#lyrctl').hidden = !curLyr?.synced;
  $('#lyrpaste').hidden = !t || !!curLyr || $('#lyrstat').textContent.includes('Loading');
  $('#lyrinfo').textContent = `Timing nudge: ${lyrOff() >= 0 ? '+' : ''}${(lyrOff() / 1000).toFixed(1)}s`;
  if (!t) { box.append(h('div', { class: 's' }, 'Play a song to see its lyrics here')); return; }
  if (!curLyr) { box.append(h('div', { class: 's' }, $('#lyrstat').textContent || 'No lyrics yet')); return; }
  curLyr.lines.forEach((l, i) => box.append(h('div', { class: 'lyrline', 'data-i': i }, l.text || '♪')));
  tickLyrics(true);
}
function tickLyrics(force) {
  if (!curLyr?.synced || !S.playing) return;
  const i = lineIndex(curLyr, songMs() + lyrOff());
  if (i === lastLyrI && !force) return;
  lastLyrI = i;
  document.querySelectorAll('#lyrlist .lyrline.on').forEach(e => e.classList.remove('on'));
  const el = document.querySelector(`#lyrlist .lyrline[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('on');
  const box = $('#lyrlist');
  if (tab === 'lyrics' || matchMedia('(min-width:1050px)').matches) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
}
function nudge(d) { if (!S.playing) return; store.set('lo:' + S.playing.tid, String(lyrOff() + d)); lastLyrI = -1; renderLyrics(); }

// ---------- the sound bar ----------
const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function tickSeek() {
  const el = $('#seek'), t = S.playing;
  el.disabled = !t;
  if (!t) { el.value = 0; $('#tcur').textContent = '0:00'; $('#tdur').textContent = '0:00'; return; }
  const ms = Math.max(0, Math.min(songMs(), t.dur * 1000));
  $('#tdur').textContent = fmt(t.dur * 1000);
  if (!seekDrag) { el.value = Math.round(ms / (t.dur * 1000) * 1000); $('#tcur').textContent = fmt(ms); }
}
setInterval(() => { if (!room || !me) return; tickSeek(); tickLyrics(); }, 250);

// ---------- Spotify ----------
const spOn = () => spLink.connected && store.get('spplay') === '1';
async function getSpToken(force) {
  if (!force && spTok && Date.now() < spExp - 60000) return spTok;
  const r = await api('spotify/token' + (force ? '?force=1' : ''));
  if (r.error) return null;
  spTok = r.token; spExp = r.exp; return spTok;
}
function setupSpot() { if (!spot) { spApiObj = spApi(getSpToken); spot = spConnect(spApiObj); } }
async function loadSpStatus() {
  const r = await api('spotify/status');
  spLink = r.error ? { connected: false, hasId: false } : r;
  if (spOn()) setupSpot();
  renderSp();
}
async function renderSp() {
  const list = $('#splist'); if (!list) return;
  list.replaceChildren();
  $('#spconnect').hidden = !spLink.hasId || spLink.connected;
  $('#spdisc').hidden = !spLink.connected;
  $('#spplayrow').hidden = !spLink.connected;
  $('#spplay').checked = store.get('spplay') === '1';
  $('#spstat').textContent = !spLink.hasId ? 'Spotify is not set up on this server yet (the owner adds a Spotify app Client ID).'
    : spLink.connected ? `Connected as ${spLink.name}`
    : 'Not connected. Spotify’s own login page lets you continue with Google, Facebook or Apple.';
  if (!spLink.connected) return;
  const r = await api('spotify/playlists');
  if (r.error) { list.append(h('div', { class: 's err' }, explain(r, 'Could not load your Spotify playlists'))); return; }
  list.append(h('div', { class: 's', style: 'margin-top:10px' }, 'Import into this app (your own playlists and Liked songs):'));
  for (const p of r.items || []) {
    const btn = h('button', { class: 'btn', onclick: () => importSp(p, btn) }, 'Import');
    list.append(h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, p.name), h('div', { class: 's' }, `${p.n} song${p.n === 1 ? '' : 's'}`)), btn));
  }
}
async function importSp(p, btn) {                            // the server does 12 songs per call; keep asking until done
  btn.disabled = true;
  let offset = 0, target = '', added = 0, skipped = 0;
  for (;;) {
    const r = await api('spotify/import', { id: p.id, name: p.name, offset, target });
    if (r.error) { toast(explain(r, 'Import stopped')); break; }
    target = r.target; added += r.added; skipped += r.skipped; offset = r.next;
    btn.textContent = `${Math.min(offset, r.total || offset)}/${r.total || '?'}`;
    if (r.done) { toast(`Imported ${added} song${added === 1 ? '' : 's'}${skipped ? ` — ${skipped} not found on YouTube Music` : ''}`); break; }
  }
  btn.disabled = false; btn.textContent = 'Import again'; loadPls();
}

// ---------- room UI ----------
function setStatus(t) { status = t; render(); }
const nameOf = id => S.present[id]?.name || id;
const trackOf = t => ({ tid: t.tid, title: t.title, artist: t.artist, dur: t.dur, cover: t.cover });
const inRoom = tid => S.playing?.tid === tid || S.queue.some(q => q.tid === tid);

function setTab(t) {
  if (t === 'queue' && matchMedia('(min-width:1050px)').matches) t = 'search';   // wide screens show the queue beside the tabs
  tab = t;
  $('.tabsarea').dataset.tab = t;
  document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  if (t === 'pls') loadMiniPls();
  if (t === 'lyrics') { renderLyrics(); }
}

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
    np.append(h('div', { class: 's' }, S.queue.length ? 'Waiting for everyone to be ready…' : 'Queue is empty — search a song and add it'));
  }

  const votes = [S.votes.length && `skip ${S.votes.length}/${need}`, S.pvotes?.length && `back ${S.pvotes.length}/${need}`].filter(Boolean).join(' · ');
  $('#ctl').replaceChildren(...[
    h('button', { class: 'btn', title: 'Previous (vote)', onclick: () => send({ t: 'prev' }) }, '⏮'),
    h('button', { class: 'btn', disabled: !S.playing, title: S.paused ? 'Resume' : 'Pause', onclick: () => send({ t: S.paused ? 'resume' : 'pause' }) }, S.paused ? '▶' : '⏸'),
    h('button', { class: 'btn', disabled: !S.playing, title: 'Skip (vote)', onclick: () => send({ t: 'skip' }) }, '⏭'),
    h('button', { class: 'btn', title: muted ? 'Unmute' : 'Mute (only for you)', onclick: toggleMute }, muted ? '🔇' : '🔊'),
    h('button', { class: 'btn ghost small', title: 'Lyrics turn with the record', onclick: () => { spinLyr = !spinLyr; store.set('spin', spinLyr ? '1' : '0'); render(); } }, spinLyr ? '↻ Lyrics spin: on' : '↻ Lyrics spin: off'),
    route() === 'web' && h('button', { class: 'btn ghost small', onclick: () => { showVid = !showVid; store.set('vid', showVid ? '1' : '0'); applyVid(); render(); } }, showVid ? '📺 Hide video' : '📺 Show video'),
    votes && h('div', { class: 's' }, votes)
  ].filter(Boolean));

  $('#armbar').replaceChildren(...[
    h('button', { class: 'btn ghost', onclick: () => { wantArmed = !wantArmed; send({ t: wantArmed ? 'arm' : 'unarm' }); } },
      wantArmed ? 'Ready ✓' : 'Not ready'),
    (status || routeNote) && h('div', { class: 's' }, status || routeNote),
    h('div', { class: 'chips' }, ...Object.values(S.present).map(p =>
      h('span', { class: 'chip' }, `${p.name}${p.away ? ' (away)' : S.playing ? (S.part?.[p.id] ? (p.live ? ' 🔊' : ' …') : ' (next song)') : S.armed[p.id] ? ' ✓' : ''}`)))
  ].filter(Boolean));

  $('#qtab').textContent = `Queue${S.queue.length ? ` (${S.queue.length})` : ''}`;
  const qEl = $('#queue'); qEl.replaceChildren();
  if (!S.queue.length) qEl.append(h('div', { class: 's' }, 'Nothing queued yet'));
  S.queue.forEach((q, i) => {
    const mine = q.by === me.id || admin;
    qEl.append(h('div', { class: 'row' },
      q.cover && h('img', { src: q.cover, width: '48', height: '36', style: 'border-radius:6px;object-fit:cover' }),
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, q.title), h('div', { class: 's' }, `${q.artist} · ${nameOf(q.by)}`)),
      mine && i > 0 && h('button', { class: 'btn ghost', title: 'Move up', onclick: () => send({ t: 'move', tid: q.tid, pos: i - 1 }) }, '↑'),
      mine && i < S.queue.length - 1 && h('button', { class: 'btn ghost', title: 'Move down', onclick: () => send({ t: 'move', tid: q.tid, pos: i + 1 }) }, '↓'),
      h('button', { class: 'btn ghost', title: 'Save to playlist', onclick: () => pickPlaylist(trackOf(q)) }, '♪'),
      mine && h('button', { class: 'btn ghost', title: 'Remove', onclick: () => send({ t: 'remove', tid: q.tid }) }, '✕')));
  });

  // search results stay put: just flip their buttons to "Added" as songs land in the queue
  document.querySelectorAll('#results [data-add]').forEach(b => {
    const has = inRoom(b.dataset.add);
    b.disabled = has; b.textContent = has ? '✓ Added' : 'Add';
  });
  const left = lastItems.filter(t => !inRoom(t.tid)).length;
  $('#addall').disabled = !left;
  $('#resinfo').textContent = left ? `${left} not queued yet` : 'All of these are queued';
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
  if (r.error) { box.append(h('div', { class: 's' }, 'Search failed, try again')); return []; }
  if (!r.items?.length) box.append(h('div', { class: 's' }, 'Nothing found'));
  for (const t of r.items || []) {
    box.append(h('div', { class: 'row' },
      t.cover && h('img', { src: t.cover, width: '48', height: '36', style: 'border-radius:6px;object-fit:cover' }),
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, t.title), h('div', { class: 's' }, t.artist)),
      ...actions(t, box)));
  }
  return r.items || [];
}

// ---------- playlists ----------
async function createPl(input, errEl, after) {
  const name = input.value.trim();
  errEl.textContent = '';
  if (!name) { errEl.textContent = 'Type a name first'; return; }
  const r = await api('playlists', { name });
  if (r.error) { errEl.textContent = explain(r, 'Could not create the playlist'); return; }
  input.value = ''; toast('Playlist created'); after?.();
}

async function pickPlaylist(track) {                         // bottom sheet: save a song to one of my playlists
  const r = await api('playlists');
  const ov = $('#overlay'); ov.replaceChildren(); ov.hidden = false;
  const close = () => { ov.hidden = true; };
  const save = async id => {
    const x = await api('playlists/' + id + '/add', { track });
    close(); toast(x.error ? (x.error === 'limit' ? 'Playlist is full (200 songs)' : explain(x, 'Could not save')) : 'Saved to playlist');
  };
  const nameIn = h('input', { placeholder: 'New playlist name', maxlength: '30' });
  const err = h('div', { class: 's err' });
  ov.replaceChildren(h('div', { class: 'sheet' },
    h('div', { class: 't' }, 'Save to playlist'),
    ...(r.items || []).map(p => h('button', { class: 'btn ghost', onclick: () => save(p.id) }, `${p.name} (${p.n})`)),
    nameIn,
    h('button', { class: 'btn', onclick: async () => {
      const name = nameIn.value.trim(); if (!name) { err.textContent = 'Type a name first'; return; }
      const c = await api('playlists', { name });
      if (c.id) save(c.id); else err.textContent = explain(c, 'Could not create the playlist');
    } }, 'Create & save'),
    err,
    h('button', { class: 'btn ghost', onclick: close }, 'Cancel')));
}

// the "Playlists" tab inside a room: queue a whole playlist with one tap
async function loadMiniPls() {
  const r = await api('playlists');
  const box = $('#plmini'); box.replaceChildren();
  if (r.error) { box.append(h('div', { class: 's err' }, explain(r, 'Could not load playlists'))); return; }
  if (!r.items?.length) box.append(h('div', { class: 's' }, 'No playlists yet — create one above, or tap ♪ on any song'));
  for (const p of r.items || []) {
    box.append(h('div', { class: 'row' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, p.name), h('div', { class: 's' }, `${p.n} song${p.n === 1 ? '' : 's'}`)),
      h('button', { class: 'btn', disabled: !p.n, onclick: () => queuePlaylist(p) }, '▶ Queue'),
      h('button', { class: 'btn ghost', onclick: async () => { await showPlaylists('room'); openPlaylist(p); } }, 'Open')));
  }
}
function queuePlaylist(p) {
  const free = Math.max(0, QUOTA - S.queue.filter(q => q.by === me.id).length);
  send({ t: 'addpl', id: p.id });
  toast(free ? `Queueing up to ${Math.min(free, p.n ?? free)} songs from ${p.name}` : `You already have ${QUOTA} songs queued`);
  setTab(matchMedia('(min-width:1050px)').matches ? 'pls' : 'queue');
}

async function showPlaylists(from) {
  plFrom = from; openPl = null; show('pls'); loadSpStatus(); await loadPls();
}
async function loadPls() {
  const r = await api('playlists');
  if (r.error) $('#plerr').textContent = explain(r, 'Could not load playlists');
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
  on('tap', 'click', async () => { await yt?.resume?.(); $('#tap').hidden = true; });
  on('screen', 'click', () => {                                    // laptop: click the record to make it bigger
    if (matchMedia('(max-width:700px)').matches) return;
    document.body.classList.toggle('bigdisc');
    vinyl.fit(); setTimeout(() => vinyl.fit(), 300);
  });
  on('seek', 'input', () => { seekDrag = true; if (S.playing) $('#tcur').textContent = fmt($('#seek').value / 1000 * S.playing.dur * 1000); });
  on('seek', 'change', () => { seekDrag = false; if (S.playing) send({ t: 'seek', ms: $('#seek').value / 1000 * S.playing.dur * 1000 }); });
  on('lyrm', 'click', () => nudge(-500));
  on('lyrp', 'click', () => nudge(500));
  on('lyrsave', 'click', async () => {
    const t = S.playing, text = $('#lyrta').value.trim();
    if (!t || text.length < 10) { toast('Paste the lyrics first'); return; }
    const r = await api('lyrics', { tid: t.tid, lrc: text, source: 'manual' });
    if (r.error) { toast('Could not save the lyrics'); return; }
    const parsed = parseLrc(text);
    lyrCache.set(t.tid, parsed); $('#lyrta').value = '';
    curLyr = parsed; vinyl.setLyrics(parsed); lastLyrI = -1; $('#lyrstat').textContent = '♪ Lyrics added by you';
    renderLyrics(); toast('Saved — everyone gets these lyrics now');
  });
  on('spdisc', 'click', async () => { await api('spotify/disconnect', {}); spot = null; loadSpStatus(); });
  on('spplay', 'change', e => {
    store.set('spplay', e.target.checked ? '1' : '0');
    if (e.target.checked) { setupSpot(); warnedSp = false; toast('Open the Spotify app on this device before the next song'); }
  });
  document.querySelectorAll('.tabbtn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  matchMedia('(min-width:1050px)').addEventListener?.('change', () => setTab(tab));

  // search: results stay on screen so you can add several songs, or all of them
  on('q', 'keydown', async e => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    $('#resbar').hidden = true; lastItems = [];
    lastItems = await search(e.target.value.trim(), $('#results'), t => [
      h('button', { class: 'btn', 'data-add': t.tid, onclick: () => { send({ t: 'add', ...trackOf(t) }); } }, 'Add'),
      h('button', { class: 'btn ghost', title: 'Save to playlist', onclick: () => pickPlaylist(trackOf(t)) }, '♪')
    ]);
    $('#resbar').hidden = !lastItems.length;
    render();
  });
  on('addall', 'click', () => {
    const todo = lastItems.filter(t => !inRoom(t.tid));
    const free = Math.max(0, QUOTA - S.queue.filter(q => q.by === me.id).length);
    if (!todo.length) return;
    send({ t: 'addmany', tracks: todo.map(trackOf) });
    toast(free ? (todo.length > free ? `Adding ${free} of ${todo.length} (limit ${QUOTA} queued per person)` : `Adding ${todo.length} songs`) : `You already have ${QUOTA} songs queued`);
  });

  on('plminicreate', 'click', () => createPl($('#plmininame'), $('#plerr2'), loadMiniPls));
  on('plmininame', 'keydown', e => { if (e.key === 'Enter') $('#plminicreate').click(); });

  on('plback', 'click', () => { if (plFrom === 'room' && room) show('room'); else { show('lobby'); loadLobby(); } });
  on('pldback', 'click', () => { openPl = null; loadPls(); });
  on('plcreate', 'click', () => createPl($('#plname'), $('#plerr'), loadPls));
  on('plname', 'keydown', e => { if (e.key === 'Enter') $('#plcreate').click(); });
  on('plplay', 'click', () => {
    if (!room || !openPl?.tracks.length) return;
    queuePlaylist({ id: openPl.id, name: openPl.name, n: openPl.tracks.length });
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
        toast(x.error ? explain(x, 'Could not add') : 'Added');
        openPlaylist(openPl);
      } }, 'Add')
    ]);
  });
}

async function init() {
  wire();
  vinyl = createVinyl($('#vinyl'), $('#vinylhi'), {
    time: songMs,
    offset: lyrOff,
    playing: () => !!S.playing && !S.paused && serverNow() >= S.goAt,
    spin: () => spinLyr,
    big: () => document.body.classList.contains('bigdisc')
  });
  const r = await fetch('/api/me');
  if (r.status === 401) { show('login'); return; }
  me = await r.json();
  await pick();
  navigator.serviceWorker?.register('/sw.js');
  await loadSpStatus();
  const sp = new URLSearchParams(location.search).get('sp');          // coming back from Spotify's login page
  if (sp) {
    history.replaceState(null, '', location.pathname + location.hash);
    toast({ ok: 'Spotify connected', err: 'Spotify login failed — try again', denied: 'Spotify login was cancelled', notallowed: 'This Spotify account is not on the app’s user list yet (the owner adds you in the Spotify dashboard)', noid: 'Spotify is not set up on the server yet' }[sp] || 'Spotify: ' + sp);
    return showPlaylists('lobby');
  }
  const m = location.hash.match(/r=([A-Za-z0-9]{6})/);       // an invite link opens that room directly
  if (m) return joinCode(m[1]);
  show('lobby'); loadLobby();
}
init();
