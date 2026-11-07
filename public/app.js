import { setOffset, serverNow, startLoop } from './sync.js';
import { ytm, web, manual } from './players.js';
import { createVinyl, parseLrc, lineIndex, SHAPES } from './vinyl.js';
import { spApi, connect as spConnect, sdkConnect, whyNot, queueAdds, findUri } from './spotify.js';
import { createStage } from './stage.js';

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
let spotifyPos = null, spotifyPosAt = 0, spotifyIsPlaying = false;
let spotifyObserved = null, spotifyStateBusy = false, spotifyEchoUntil = 0;
let ggLink = { connected: false, hasId: false, idOk: false }, syncing = false, fails = 0, peopleTimer = null, lastShared = null, spQueuePrev = null;
let stage = null, spotKind = '', shapeId = 'pixel';
const roomSpUris = new Set();
let wantArmed = true, beganSeq = -1, beginTimer, playToken = 0, lastDrift = 0, backoff = 1000, lastArm = 0;
let status = '', routeNote = '', tab = 'search', lastItems = [], lastVinylTid = null;
let showVid = store.get('vid') === '1', spinLyr = store.get('spin') === '1', muted = store.get('mute') === '1';
let pls = [], openPl = null, plFrom = 'lobby', renaming = false, delArmed = false, toastT;
const lyrCache = new Map();

const DESIGN_DEFAULTS = { app: '#f5f0e8', lyrics: '#c96e50', disc: '#c96e50' };
const colorHue = hex => {
  const n = parseInt(String(hex).replace('#',''),16), r=((n>>16)&255)/255, g=((n>>8)&255)/255, b=(n&255)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  if (!d) return 0;
  let h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;
  return (h*60+360)%360;
};
function applyDesign() {
  const colors = {
    app: store.get('design:app') || DESIGN_DEFAULTS.app,
    lyrics: store.get('design:lyrics') || DESIGN_DEFAULTS.lyrics,
    disc: store.get('design:disc') || DESIGN_DEFAULTS.disc
  };
  const root = document.documentElement;
  root.style.setProperty('--ui-bg', colors.app);
  root.style.setProperty('--ui-panel', mixColor(colors.app, '#ffffff', .72));
  root.style.setProperty('--ui-ink', '#252729');
  root.style.setProperty('--ui-muted', mixColor(colors.app, '#252729', .56));
  root.style.setProperty('--ui-line', mixColor(colors.app, '#252729', .12));
  root.style.setProperty('--ui-accent', colors.lyrics);
  root.style.setProperty('--ui-lyric', colors.lyrics);
  root.style.setProperty('--ui-disc-hue', colorHue(colors.disc) + 'deg');
  for (const [id,key] of [['appColor','app'],['lyricsColor','lyrics'],['discColor','disc']]) {
    const el = $('#' + id); if (el) el.value = colors[key];
  }
}
function mixColor(a,b,t) {
  const x=parseInt(a.slice(1),16), y=parseInt(b.slice(1),16);
  const c=[16,8,0].map(s=>Math.round(((x>>s)&255)*(1-t)+((y>>s)&255)*t).toString(16).padStart(2,'0')).join('');
  return '#'+c;
}
function setDesign(key,value) { store.set('design:'+key,value); applyDesign(); }


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
  r.error === 'google' ? (r.status === 403 || r.status === 401 ? 'Google refused: reconnect YT Music (while the Google app is in test mode, the sign-in lasts 7 days)' : 'Google did not answer — try again')
  : r.error === 'blocked' ? 'You are blocked from this room by its admin'
  : r.error === 'spotify' ? (r.status === 403 || r.status === 401 ? 'Spotify refused: reconnect, and check this account is on your Spotify app’s user list' : 'Spotify did not answer — try again')
  :
  /no such table/i.test(r.detail || '') ? 'The database is missing its newest tables — run schema.sql once (see the update steps)'
  : r.error === 'limit' ? 'Limit reached'
  : r.error === 'network' ? 'Could not reach the server'
  : r.detail ? `${fallback}: ${r.detail}` : fallback;

function show(name) {
  for (const id of ['login', 'connect', 'lobby', 'room', 'pls']) $('#' + id).hidden = id !== name;
  $('#mobileNav').hidden = name !== 'room';
  if (name !== 'room') $('#designPanel').hidden = true;
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
    $('#lerr').textContent = r.error === 'none' ? 'No room with that code' : explain(r, 'Could not join');   // explain() knows "blocked"
    return;
  }
  openRoom(r);
}

// ---------- room connection ----------
function send(m) {
  if (['pause', 'resume', 'seek'].includes(m.t)) spotifyEchoUntil = Date.now() + 2600;
  if (ws?.readyState === 1) ws.send(JSON.stringify(m));
}
function closeWS() { const w = ws; ws = null; if (w) { w.onclose = null; w.onmessage = null; w.close(); } }

function openRoom(r) {
  closeWS(); clearTimers();
  room = r; S = fresh(); beganSeq = -1; lastDrift = 0; wantArmed = true; status = ''; lastVinylTid = null;
  spotifyObserved = null; spotifyPos = null; spotifyPosAt = 0; spotifyIsPlaying = false; spotifyEchoUntil = 0;
  lastShared = null; spQueuePrev = null;
  vinyl.setTrack(null); stage.setTrack(null);
  if (spOn()) { setupSpot(); spot.ready?.(); }                 // warm the Spotify player up so the first song is on time $('#lyrstat').textContent = '';
  history.replaceState(null, '', '#r=' + r.id);
  $('#rtitle').textContent = r.name;
  $('#rcodeline').textContent = 'Code ' + r.id;
  setTab('search');
  show('room'); render(); connectWS();
}
function leaveRoom() {
  clearInterval(peopleTimer);
  closeWS(); clearTimers();
  pauseAll();
  room = null; S = fresh();
  spotifyObserved = null; spotifyPos = null; spotifyPosAt = 0; spotifyIsPlaying = false;
  history.replaceState(null, '', location.pathname);
  show('lobby'); loadLobby();
}
function removed() { toast('You were removed from that room'); leaveRoom(); }

function connectWS() {
  const mine = room; let opened = false;
  const w = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/ws?room=' + mine.id);
  ws = w;
  w.onopen = () => { opened = true; fails = 0; backoff = 1000; send({ t: 'join' }); };
  w.onmessage = e => { if (room === mine) onFrame(JSON.parse(e.data)); };
  w.onclose = async e => {
    if (room !== mine) return;
    if (e.code === 4003) return removed();                    // the admin kicked or blocked me
    if (!opened && ++fails >= 2) {                            // can't get in: am I still a member?
      const r = await api('rooms');
      if (room !== mine) return;
      if (!(r.items || []).some(x => x.id === mine.id)) return removed();
    }
    setTimeout(() => { if (room === mine) connectWS(); }, (backoff = Math.min(backoff * 2, 15000)));
  };
}

function onFrame({ s, now }) {
  setOffset(now);
  const was = S.playing, wasPaused = S.paused, prevStart = S.startAt, prevGo = S.goAt, prevSeq = S.seq, prevPos = S.pos;
  S = s;
  if (S.paused !== wasPaused || S.startAt !== prevStart || S.pos !== prevPos) spotifyEchoUntil = Date.now() + 2600;
  if ((S.playing?.tid || null) !== lastVinylTid) {           // new song on the record
    lastVinylTid = S.playing?.tid || null;
    spotifyPos = null; spotifyPosAt = 0; spotifyIsPlaying = false; spotifyObserved = null;
    vinyl.setTrack(S.playing); stage.setTrack(S.playing); stage.setLyrics(null);
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
    } else if (S.paused && S.pos !== prevPos) {
      Promise.resolve(player?.seek?.(S.pos)).catch(() => {});                    // paused seek from Spotify or the room
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
      let why = '';
      try {
        setupSpot();
        const uri = await findUri(spApiObj, t);
        if (!uri) why = 'This song was not found on Spotify, so it plays from YouTube.';
        else if (await spot.ready()) return { p: spot, id: uri };
        else why = spot.error?.()?.kind === 'account_error' ? whyNot({ reason: 'PREMIUM_REQUIRED' }, spLink.name)
          : spotKind === 'browser' ? 'Spotify’s in-browser player could not start (try “in my Spotify app”, or reconnect Spotify). Playing from YouTube.'
          : 'Spotify could not find a player. Open the Spotify app on this device. Playing from YouTube.';
      } catch { why = 'Spotify did not answer. Playing from YouTube.'; }
      if (!warnedSp) { warnedSp = true; toast(why); }
    }
    return { p: yt, id: t.yt_id || t.tid };
  })();
  const wait = Math.max(0, S.goAt - serverNow() - 400);      // start a little early so everyone lands on 0:00 together
  beginTimer = setTimeout(async () => {
    if (token !== playToken) return;
    let { p, id } = await Promise.race([chosen, new Promise(r => setTimeout(() => r({ p: yt, id: t.yt_id || t.tid }), 6000))]);   // Spotify slow? YouTube instead
    if (token !== playToken) return;
    const late = Math.max(0, serverNow() - S.startAt);
    player = p;
    spotifyPos = null; spotifyPosAt = 0;
    if (p === spot) {
      vinyl.setLyrics(null);
      stage.setLyrics(null);
      $('#lyrstat').textContent = '♪ Lyrics shown without timing during Spotify playback';
      renderLyrics();
    }
    const res = await p.play(id, late);
    if (p === spot && !(res && res.ok)) {                    // Spotify said no: tell the person exactly why, then use YouTube
      if (res?.reason === 'PREMIUM_REQUIRED') store.set('spplay', '0');
      renderSp(); toast(whyNot(res, spLink.name));
      player = p = yt; await yt.play(t.yt_id || t.tid, late);
    }
    Promise.resolve(p.setMuted?.(muted)).catch(() => {});
    if (p === spot) {
      send({ t: 'live', v: true }); roomSpUris.add(id);
      try { await observeSpotifyState(await spot.state()); } catch {}
    }
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
  if (spotifyPlayback()) {
    curLyr = null; vinyl.setLyrics(null); stage.setLyrics(null);
    say(t.tid, '♪ Lyrics are unavailable while Spotify playback is active');
    renderLyrics();
    return;
  }
  const label = l => !l ? '♪ No lyrics found for this song' : l.synced ? '♪ Synced lyrics' : '♪ Lyrics (not timed, spread over the song)';
  const show1 = l => {
    curLyr = l;
    const spotify = spotifyPlayback();
    vinyl.setLyrics(spotify ? null : l);
    stage.setLyrics(spotify ? null : l);
    lastLyrI = -1;
    say(t.tid, spotify ? '♪ Lyrics shown without timing during Spotify playback' : label(l));
    renderLyrics();
  };
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
  if (spotifyPlayback()) {
    $('#lyrctl').hidden = true;
    $('#lyrpaste').hidden = true;
    box.append(h('div', { class: 's' }, 'Lyrics are unavailable while Spotify playback is active'));
    return;
  }
  $('#lyrctl').hidden = spotifyPlayback() || !curLyr?.synced;
  $('#lyrpaste').hidden = !t || !!curLyr || $('#lyrstat').textContent.includes('Loading');
  $('#lyrinfo').textContent = `Timing nudge: ${lyrOff() >= 0 ? '+' : ''}${(lyrOff() / 1000).toFixed(1)}s`;
  if (!t) { box.append(h('div', { class: 's' }, 'Play a song to see its lyrics here')); return; }
  if (!curLyr) { box.append(h('div', { class: 's' }, $('#lyrstat').textContent || 'No lyrics yet')); return; }
  curLyr.lines.forEach((l, i) => box.append(h('div', { class: 'lyrline', 'data-i': i }, l.text || '♪')));
  tickLyrics(true);
}
function tickLyrics(force) {
  if (spotifyPlayback() || !curLyr?.synced || !S.playing) return;
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
async function tickSeek() {
  const el = $('#seek'), t = S.playing;
  el.disabled = !t;
  if (!t) { el.value = 0; $('#tcur').textContent = '0:00'; $('#tdur').textContent = '0:00'; return; }

  let position = songMs();
  if (spotifyPlayback() && spotifyPos != null) {
    position = spotifyPos + (spotifyIsPlaying ? Math.max(0, Date.now() - spotifyPosAt) : 0);
  }

  const ms = Math.max(0, Math.min(position, t.dur * 1000));
  $('#tdur').textContent = fmt(t.dur * 1000);
  if (!seekDrag) { el.value = Math.round(ms / (t.dur * 1000) * 1000); $('#tcur').textContent = fmt(ms); }
}
setInterval(() => { if (!room || !me) return; tickSeek(); tickLyrics(); }, 250);

// ---------- Accounts: Spotify + YouTube Music (Google) ----------
const spOn = () => spLink.connected && store.get('spplay') !== '0';       // on by default once connected
const spotifyPlayback = () => spOn() && player === spot;

async function observeSpotifyState(st, fromSdk = false) {
  if (!st) { spotifyObserved = null; spotifyPos = null; spotifyIsPlaying = false; return; }
  spotifyPos = Number.isFinite(st.position) ? st.position : null;
  spotifyPosAt = Date.now();
  spotifyIsPlaying = !st.paused;

  if (!room || !S.playing || !spotifyPlayback() || !st.trackId || st.source === 'ad') {
    spotifyObserved = st;
    return;
  }
  const previous = spotifyObserved;
  spotifyObserved = st;
  if (!previous || previous.trackId !== st.trackId) return;     // establish a baseline; don't hijack a newly joined room
  if (Date.now() < spotifyEchoUntil) return;

  const uri = await findUri(spApiObj, S.playing).catch(() => null);
  if (!uri || (st.uri && st.uri !== uri)) return;               // only mirror controls for the room's current song

  const changed = fromSdk || (st.timestamp && previous.timestamp && st.timestamp !== previous.timestamp);
  if (!changed) return;
  if (st.paused !== S.paused) {
    send({ t: st.paused ? 'pause' : 'resume' });
    return;
  }
  const expected = S.paused ? S.pos : Math.max(0, serverNow() - S.startAt);
  if (Math.abs(st.position - expected) > 2600) send({ t: 'seek', ms: st.position });
}

async function pollSpotifyState() {
  if (!room || !spOn() || !spotifyPlayback() || !spot?.state || spotifyStateBusy) return;
  spotifyStateBusy = true;
  try { await observeSpotifyState(await spot.state()); }
  catch {} finally { spotifyStateBusy = false; }
}
setInterval(() => { pollSpotifyState().catch(() => {}); }, 2500);

async function getSpToken(force) {
  if (!force && spTok && Date.now() < spExp - 60000) return spTok;
  const r = await api('spotify/token' + (force ? '?force=1' : ''));
  if (r.error) return null;
  spTok = r.token; spExp = r.exp; return spTok;
}
const spWhere = () => store.get('spwhere') || (hasShell() ? 'app' : 'browser');   // laptops play inside the page, the phone apps use the Spotify app
function setupSpot() {
  if (!spApiObj) spApiObj = spApi(getSpToken);
  const want = spWhere();
  if (spot && spotKind === want) return;
  spot?.cancel?.(); spot?.disconnect?.();
  spotKind = want;
  spotifyObserved = null; spotifyPos = null; spotifyPosAt = 0; spotifyIsPlaying = false;
  spot = want === 'browser'
    ? sdkConnect(spApiObj, getSpToken, () => { $('#tap').hidden = false; }, st => observeSpotifyState(st, true))
    : spConnect(spApiObj);
}
const bad = { connected: false, hasId: false, idOk: false };
async function loadSpStatus() { const r = await api('spotify/status'); spLink = r.error ? bad : r; if (spLink.connected) setupSpot(); }
async function loadGgStatus() { const r = await api('google/status'); ggLink = r.error ? bad : r; }
async function loadLinks() {
  await Promise.all([loadSpStatus(), loadGgStatus()]);
  renderAccts(); renderConnect(); renderSp(); renderGg();
}
const setupNote = (name, L) => !L.hasId ? `${name} is not set up on the server yet (the owner adds its keys).`
  : !L.idOk ? `The ${name} ID saved on the server does not look right — the owner should save it again.` : '';

function connectClick(e, prov) {                              // buttons are links; stop them when the provider is not ready
  const L = prov === 'spotify' ? spLink : ggLink, name = prov === 'spotify' ? 'Spotify' : 'YT Music';
  const note = setupNote(name, L);
  if (note) { e.preventDefault(); toast(note); return; }
  if (L.connected && ['cSpotify', 'cGoogle'].includes(e.currentTarget.id)) { e.preventDefault(); goLobby(); }
}

function renderConnect() {
  $('#cSpotify').textContent = spLink.connected ? `✓ Spotify connected${spLink.name ? ' — ' + spLink.name : ''}` : 'Connect Spotify';
  $('#cGoogle').textContent = ggLink.connected ? `✓ YT Music connected${ggLink.name ? ' — ' + ggLink.name : ''}` : 'Connect YT Music';
  $('#cSpotifyNote').textContent = setupNote('Spotify', spLink);
  $('#cGoogleNote').textContent = setupNote('YT Music', ggLink);
  $('#cContinue').hidden = !(spLink.connected || ggLink.connected);
}
function renderAccts() {
  const box = $('#accts'); if (!box) return; box.replaceChildren();
  const chip = (name, L, href) => L.connected ? h('span', { class: 'chip ok' }, `${name} ✓ ${L.name || ''}`)
    : h('a', { class: 'chip', href, onclick: e => { const n = setupNote(name, L); if (n) { e.preventDefault(); toast(n); } } }, `Connect ${name}`);
  box.append(chip('Spotify', spLink, '/auth/spotify/login'), chip('YT Music', ggLink, '/auth/google/login'));
  if (spLink.connected || ggLink.connected) box.append(h('button', { class: 'chip', onclick: () => syncAll() }, '⟳ Sync my playlists'));
}
function goLobby() { show('lobby'); loadLobby(); renderAccts(); }
function startScreen() {                                      // the first page: connect, or straight to the rooms
  if (spLink.connected || ggLink.connected || store.get('guest') === '1') goLobby();
  else { show('connect'); renderConnect(); }
}

async function renderSp() {                                   // the Spotify card on the Playlists screen
  const list = $('#splist'); if (!list) return;
  list.replaceChildren();
  $('#spconnect').hidden = spLink.connected || !spLink.hasId || !spLink.idOk;
  $('#spdisc').hidden = !spLink.connected;
  $('#spplayrow').hidden = !spLink.connected;
  $('#spsharerow').hidden = !spLink.connected;
  $('#spwhererow').hidden = !spLink.connected;
  $('#spswitch').hidden = !spLink.connected;
  $('#spwhere').value = spWhere();
  $('#spplay').checked = store.get('spplay') !== '0';
  $('#spshare').checked = store.get('spshare') === '1';
  $('#spstat').textContent = setupNote('Spotify', spLink)
    || (spLink.connected ? `Connected as ${spLink.name}${spLink.spid ? ' (' + spLink.spid + ')' : ''} — if that is not your Premium account, use “Use a different Spotify account”.` : 'Not connected. Spotify’s own login page lets you continue with Google, Facebook or Apple.');
  if (!spLink.connected || $('#pls').hidden) return;
  const r = await api('spotify/playlists');
  if (r.error) { list.append(h('div', { class: 's err' }, explain(r, 'Could not load your Spotify playlists'))); return; }
  list.append(h('div', { class: 's', style: 'margin-top:10px' }, 'Import (your own playlists and Liked songs):'));
  for (const p of r.items || []) {
    const btn = h('button', { class: 'btn', onclick: () => importOne2('spotify', p, btn) }, 'Import');
    list.append(h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:0' }, h('div', {}, p.name), h('div', { class: 's' }, `${p.n} song${p.n === 1 ? '' : 's'}`)), btn));
  }
}
async function renderGg() {                                   // the YouTube Music card
  const list = $('#gglist'); if (!list) return;
  list.replaceChildren();
  $('#ggconnect').hidden = ggLink.connected || !ggLink.hasId || !ggLink.idOk;
  $('#ggdisc').hidden = !ggLink.connected;
  $('#ggstat').textContent = setupNote('YT Music', ggLink)
    || (ggLink.connected ? `Connected as ${ggLink.name}` : 'Not connected. Sign in with your Google account to bring over the playlists you made in YouTube Music or YouTube. If Google says “Access blocked”, the owner has to add your Google email as a test user first.');
  if (!ggLink.connected || $('#pls').hidden) return;
  const r = await api('google/playlists');
  if (r.error) { list.append(h('div', { class: 's err' }, explain(r, 'Could not load your playlists'))); return; }
  list.append(h('div', { class: 's', style: 'margin-top:10px' }, 'Import:'));
  for (const p of r.items || []) {
    const btn = h('button', { class: 'btn', onclick: () => importOne2('google', p, btn) }, 'Import');
    list.append(h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:0' }, h('div', {}, p.name), h('div', { class: 's' }, `${p.n} song${p.n === 1 ? '' : 's'}`)), btn));
  }
}

// one playlist, in small batches (Spotify: by offset, Google: by page token) until the server says done
async function importOne(prov, p, progress) {
  let added = 0, skipped = 0, target = '', cursor = prov === 'spotify' ? 0 : '';
  for (;;) {
    const body = prov === 'spotify' ? { id: p.id, name: p.name, offset: cursor, target } : { id: p.id, name: p.name, page: cursor, target };
    const r = await api(`${prov}/import`, body);
    if (r.error) { toast(explain(r, 'Import stopped')); return { added, skipped, error: true }; }
    target = r.target; added += r.added; skipped += r.skipped; cursor = r.next;
    progress?.(added + skipped);
    if (r.done) return { added, skipped };
  }
}
async function importOne2(prov, p, btn) {                     // the Import button next to one playlist
  btn.disabled = true;
  const r = await importOne(prov, p, n => { btn.textContent = `${n}…`; });
  if (!r.error) toast(`Imported ${r.added} song${r.added === 1 ? '' : 's'}${r.skipped ? ` — ${r.skipped} not found` : ''}`);
  btn.disabled = false; btn.textContent = 'Import again'; loadPls();
}

// everything at once: right after connecting, and from "Sync my playlists"
async function syncAll(which) {
  if (syncing) { toast('Already syncing…'); return; }
  syncing = true;
  const bar = $('#syncbar'); bar.hidden = false;
  const say = t => { bar.textContent = t; };
  let added = 0, skipped = 0;
  try {
    for (const prov of which ? [which] : [spLink.connected && 'spotify', ggLink.connected && 'google'].filter(Boolean)) {
      const label = prov === 'spotify' ? 'Spotify' : 'YT Music';
      say(`Reading your ${label} playlists…`);
      const lr = await api(`${prov}/playlists`);
      if (lr.error) { say(explain(lr, `Could not read your ${label} playlists`)); continue; }
      const lists = (lr.items || []).filter(p => p.n > 0).slice(0, 25);
      let i = 0;
      for (const p of lists) {
        i++;
        const r = await importOne(prov, p, n => say(`Syncing ${label}: playlist ${i}/${lists.length} “${p.name}” — ${n} songs`));
        added += r.added; skipped += r.skipped;
        if (r.error) break;
      }
    }
    say(`Synced ${added} song${added === 1 ? '' : 's'} into your playlists${skipped ? ` (${skipped} not found)` : ''}. Open “My playlists” to see them.`);
  } finally {
    syncing = false;
    setTimeout(() => { if (!syncing) bar.hidden = true; }, 9000);
  }
}

// the other direction: what you play on Spotify lands in the room's queue (only if you switch it on)
async function shareTrack(t) {
  const m = await api('spotify/match', { id: t.id, name: t.name, artist: t.artists?.[0]?.name || '', duration_ms: t.duration_ms });
  if (m.track) { send({ t: 'add', ...trackOf(m.track) }); toast(`Added “${t.name}” from your Spotify to the room`); }
}
async function pollSpotifyNow() {
  if (!room || !spLink.connected || store.get('spshare') !== '1' || !spApiObj) return;
  const r = await spApiObj.get('/me/player/queue');           // the song playing now + what is queued after it
  if (!r) return;
  const now = r.currently_playing, q = (r.queue || []).filter(x => x && x.type !== 'episode');
  const uris = q.map(x => x.uri), adds = queueAdds(spQueuePrev, uris); spQueuePrev = uris;   // first look = baseline only
  const todo = [];
  if (now && now.type !== 'episode') {
    if (lastShared === null) lastShared = now.id;
    else if (now.id !== lastShared) { lastShared = now.id; if (!roomSpUris.has(now.uri)) todo.push(now); }   // not a song the room itself started
  }
  for (const u of adds) { const t = q.find(x => x.uri === u); if (t) todo.push(t); }                       // songs queued in Spotify
  for (const t of todo) await shareTrack(t);
}
setInterval(() => { pollSpotifyNow().catch(() => {}); }, 7000);

// ---------- people in the room: the admin can kick, block and unblock ----------
function confirmBtn(label, fn, cls = 'btn ghost small') {
  const b = h('button', { class: cls }, label); let armed = false, t;
  b.addEventListener('click', async () => {
    if (!armed) { armed = true; b.textContent = 'Sure?'; clearTimeout(t); t = setTimeout(() => { armed = false; b.textContent = label; }, 3000); return; }
    armed = false; clearTimeout(t); await fn();
  });
  return b;
}
async function modAct(kind, p) {
  const r = await api('rooms/' + kind, { room: room.id, member: p.id });
  toast(r.error ? 'That did not work' : ({ kick: 'Removed ', block: 'Blocked ', unblock: 'Unblocked ' }[kind]) + p.name);
  loadPeople();
}
async function loadPeople() {
  if (!room) return;
  const r = await api('rooms/people?room=' + room.id);
  const box = $('#people'); box.replaceChildren();
  if (r.error) { box.append(h('div', { class: 's err' }, 'Could not load the people list')); return; }
  for (const p of r.people) {
    box.append(h('div', { class: 'row' },
      h('span', { class: 'dot' + (p.online ? ' on' : '') }),
      h('div', { style: 'flex:1;min-width:0' }, h('div', {}, p.name + (p.me ? ' (you)' : '') + (p.admin ? ' · admin' : '')), h('div', { class: 's' }, p.online ? 'in the room now' : 'not here right now')),
      r.owner && !p.me && confirmBtn('Kick', () => modAct('kick', p)),
      r.owner && !p.me && confirmBtn('Block', () => modAct('block', p))));
  }
  $('#blockedbox').hidden = !r.owner;
  const bl = $('#blocked'); bl.replaceChildren();
  if (r.owner) {
    if (!r.blocked.length) bl.append(h('div', { class: 's' }, 'Nobody is blocked'));
    for (const p of r.blocked) bl.append(h('div', { class: 'row' }, h('div', { style: 'flex:1' }, p.name), h('button', { class: 'btn small', onclick: () => modAct('unblock', p) }, 'Unblock')));
  }
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
  document.querySelectorAll('[data-mobile-tab]').forEach(b => b.classList.toggle('on', b.dataset.mobileTab === t));
  if (t === 'pls') loadMiniPls();
  if (t === 'lyrics') { renderLyrics(); stage.start(); } else if (!$('#lstage').classList.contains('full')) stage.stop();
  clearInterval(peopleTimer);
  if (t === 'people') { loadPeople(); peopleTimer = setInterval(loadPeople, 8000); }
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
  plFrom = from; openPl = null; show('pls'); loadLinks(); await loadPls();
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
  on('tap', 'click', async () => { await yt?.resume?.(); spot?.activate?.(); $('#tap').hidden = true; });
  on('designOpen', 'click', () => { $('#designPanel').hidden = false; });
  on('designClose', 'click', () => { $('#designPanel').hidden = true; });
  on('designPanel', 'click', e => { if (e.target.id === 'designPanel') $('#designPanel').hidden = true; });
  on('designReset', 'click', () => { for (const k of ['app','lyrics','disc']) store.set('design:'+k, DESIGN_DEFAULTS[k]); applyDesign(); toast('Colors reset'); });
  for (const [id,key] of [['appColor','app'],['lyricsColor','lyrics'],['discColor','disc']]) {
    on(id, 'input', e => setDesign(key, e.target.value));
  }
  document.querySelectorAll('[data-mobile-tab]').forEach(b => b.addEventListener('click', () => {
    setTab(b.dataset.mobileTab);
    document.querySelectorAll('[data-mobile-tab]').forEach(x => x.classList.toggle('on', x === b));
  }));
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
    curLyr = parsed; vinyl.setLyrics(parsed); stage.setLyrics(parsed); lastLyrI = -1; $('#lyrstat').textContent = '♪ Lyrics added by you';
    renderLyrics(); toast('Saved — everyone gets these lyrics now');
  });
  on('spdisc', 'click', async () => { await api('spotify/disconnect', {}); spot = null; spApiObj = null; loadLinks(); });
  on('ggdisc', 'click', async () => { await api('google/disconnect', {}); loadLinks(); });
  on('spshare', 'change', e => {
    store.set('spshare', e.target.checked ? '1' : '0'); lastShared = null; spQueuePrev = null;
    toast(e.target.checked ? 'Songs you play on Spotify will be added to the room queue' : 'Sharing off');
  });
  for (const [id, prov] of [['cSpotify', 'spotify'], ['cGoogle', 'google'], ['spconnect', 'spotify'], ['ggconnect', 'google']]) on(id, 'click', e => connectClick(e, prov));
  on('cGuest', 'click', () => { store.set('guest', '1'); goLobby(); });
  on('cContinue', 'click', goLobby);
  on('leave', 'click', async () => {                                // leave for good (two taps)
    const b = $('#leave');
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to leave'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Leave'; }, 3000); return; }
    b.dataset.armed = ''; b.textContent = 'Leave';
    const id = room.id;
    await api('rooms/leave', { id });
    leaveRoom(); toast('You left the room');
  });
  on('spplay', 'change', e => {
    store.set('spplay', e.target.checked ? '1' : '0');
    if (e.target.checked) { setupSpot(); warnedSp = false; toast(spWhere() === 'browser' ? 'Spotify songs will play in this browser' : 'Open the Spotify app on this device before the next song'); }
  });
  on('spwhere', 'change', e => { store.set('spwhere', e.target.value); setupSpot(); });
  on('lyrfull', 'click', () => {                                   // the lyric video, full screen
    const el = $('#lstage'), full = el.classList.toggle('full');
    $('#lyrfull').textContent = full ? '✕ Close' : '⛶ Full screen';
    stage.fit(); setTimeout(() => stage.fit(), 50);
    if (full) stage.start(); else if (tab !== 'lyrics') stage.stop();
  });
  addEventListener('keydown', e => { if (e.key === 'Escape' && $('#lstage').classList.contains('full')) $('#lyrfull').click(); });
  document.querySelectorAll('.tabbtn').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  document.querySelectorAll('[data-mobile-tab]').forEach(b => b.classList.toggle('on', b.dataset.mobileTab === tab));
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
  applyDesign();
  wire();
  stage = createStage($('#lyrcanvas'), { time: () => songMs() + lyrOff(), playing: () => !!S.playing && !S.paused });
  shapeId = store.get('shape') || 'circle';
  const sbox = $('#shapes');
  for (const sh of SHAPES) {
    sbox.append(h('button', { class: 'shp' + (sh.id === shapeId ? ' on' : ''), title: sh.name, 'data-shape': sh.id, onclick: () => {
      shapeId = sh.id; store.set('shape', sh.id);
      sbox.querySelectorAll('.shp').forEach(b => b.classList.toggle('on', b.dataset.shape === sh.id));
    } }, h('i', { class: sh.id })));
  }
  vinyl = createVinyl($('#vinyl'), $('#vinylhi'), {
    time: songMs,
    offset: lyrOff,
    playing: () => !!S.playing && !S.paused && serverNow() >= S.goAt,
    spin: () => spinLyr,
    big: () => document.body.classList.contains('bigdisc'),
    shape: () => shapeId,
    onCover: c => stage.setCover(c)
  });
  const r = await fetch('/api/me');
  if (r.status === 401) { show('login'); return; }
  me = await r.json();
  await pick();
  navigator.serviceWorker?.register('/sw.js');
  await loadLinks();

  const qs = new URLSearchParams(location.search), sp = qs.get('sp'), gg = qs.get('gg');   // back from Spotify / Google
  if (sp || gg) {
    history.replaceState(null, '', location.pathname + location.hash);
    const why = {
      ok: 'connected', err: 'login failed — try again', denied: 'login was cancelled', noid: 'is not set up on the server yet',
      notallowed: 'did not let this account in (the owner must add you as a test user)'
    }, name = sp ? 'Spotify' : 'YT Music', code = sp || gg;
    toast(`${name} ${why[code] || code}`);
    goLobby();
    if (code === 'ok') syncAll(sp ? 'spotify' : 'google');       // bring their playlists over right away
    return;
  }
  const m = location.hash.match(/r=([A-Za-z0-9]{6})/);       // an invite link opens that room directly
  if (m) return joinCode(m[1]);
  startScreen();
}
init();
