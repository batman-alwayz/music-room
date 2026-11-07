// The record. Two layers:
//   1. a chunky pixel disc (80x80 pixels shown big) in one of six shapes, or a smooth circle
//   2. a sharp layer on top: the album cover as the round label, and the lyrics, which move:
//      words hop as they are sung, and lines blow in and out like wind.
const N = 80, CX = 39.5, CY = 39.5, RD = 38, RL = 13;
const PI = Math.PI, TAU = 2 * PI;

// the six discs. ts = how much of the disc is usable for a round lyric ring (corners waste space)
export const SHAPES = [
  { id: 'circle', name: 'Circle', smooth: true, ts: 1 },
  { id: 'pixel', name: 'Pixel disc', ts: 1 },
  { id: 'diamond', name: 'Diamond', ts: 0.73 },
  { id: 'hexagon', name: 'Hexagon', ts: 0.89 },
  { id: 'octagon', name: 'Octagon', ts: 1 },
  { id: 'square', name: 'Square', ts: 1 }
];
// distance from the centre measured the way each shape is built, scaled so the edge is at RD
const METRIC = {
  circle: (x, y) => Math.hypot(x, y),
  pixel: (x, y) => Math.hypot(x, y),
  diamond: (x, y) => (Math.abs(x) + Math.abs(y)) * (RD / 39),
  hexagon: (x, y) => Math.max(Math.abs(x), Math.abs(x) * 0.5 + Math.abs(y) * 0.866) * (RD / 34),
  octagon: (x, y) => Math.max(Math.abs(x), Math.abs(y), (Math.abs(x) + Math.abs(y)) * 0.7071),
  square: (x, y) => Math.pow(Math.pow(Math.abs(x), 6) + Math.pow(Math.abs(y), 6), 1 / 6)   // a square with softened corners
};

// per-pixel lookup tables, built once
const R = new Float32Array(N * N), C2 = new Float32Array(N * N), S2 = new Float32Array(N * N);
const DXY = [];
for (let y = 0, i = 0; y < N; y++) {
  for (let x = 0; x < N; x++, i++) {
    const dx = x - CX, dy = y - CY, r = Math.hypot(dx, dy), rr = r * r || 1;
    R[i] = r; C2[i] = (dx * dx - dy * dy) / rr; S2[i] = (2 * dx * dy) / rr; DXY.push(dx, dy);
  }
}
const metrics = {};
function metricOf(id) {
  if (!metrics[id]) { const m = new Float32Array(N * N), f = METRIC[id] || METRIC.pixel; for (let i = 0; i < N * N; i++) m[i] = f(DXY[2 * i], DXY[2 * i + 1]); metrics[id] = m; }
  return metrics[id];
}

// ---------- layer 1: the pixel disc (pure: fills `px`) ----------
export function renderPixels(px, rot, shape = 'pixel') {
  const M = metricOf(shape), c2 = Math.cos(2 * rot), s2 = Math.sin(2 * rot);
  for (let i = 0, p = 0; i < N * N; i++, p += 4) {
    const m = M[i];
    let rr = 2, gg = 3, bb = 9;                              // OLED black with a hint of blue
    if (m <= RD + 0.5) {
      if (m > RD - 1) { rr = 70; gg = 140; bb = 210; }       // outer rim line
      else if (m > RD - 2.5) { rr = 5; gg = 9; bb = 22; }    // dark gap
      else if (m > RD - 3.5) { rr = 30; gg = 70; bb = 130; } // inner rim line
      else {
        const base = 5 + ((m | 0) % 4 === 0 ? 3 : 0);        // faint grooves (they follow the shape)
        const s = C2[i] * c2 + S2[i] * s2;
        const sh = s > 0 ? Math.floor(s * s * s * s * 4) / 4 : 0;   // two light reflections, in flat steps
        const f = (0.35 + 0.65 * Math.min(1, m / RD)) * sh;
        rr = base + 14 * f; gg = base * 1.8 + 60 * f; bb = base * 4 + 95 * f;
        if (R[i] < RL) { rr = 4; gg = 8; bb = 20; }          // the smooth label sits on top of this
      }
    }
    px[p] = rr; px[p + 1] = gg; px[p + 2] = bb; px[p + 3] = 255;
  }
}

// ---------- lyrics ----------
export function parseLrc(text) {
  const lines = []; let synced = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const body = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (stamps.length) { synced = true; for (const m of stamps) lines.push({ t: (+m[1] * 60 + +m[2]) * 1000, text: body }); }
    else if (body) lines.push({ t: 0, text: body });
  }
  if (synced) lines.sort((a, b) => a.t - b.t);
  return lines.length ? { lines, synced } : null;
}

// index of the line that is being sung at `ms` (-1 = before the first line)
export function lineIndex(lyr, ms) {
  const L = lyr?.lines; if (!L?.length) return -1;
  let lo = 0, hi = L.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= ms) { i = m; lo = m + 1; } else hi = m - 1; }
  return i;
}

// ---------- canvases (swappable so the drawing code can also run outside a browser) ----------
let mkc = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h ?? w; return c; };
export const setCanvasFactory = f => { mkc = f; };

// ---------- pixel font: every Latin letter is a rigid block of square pixels with hard edges ----------
const FONT = px => `700 ${px}px "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Devanagari", sans-serif`;
const ROW1 = 0.815, ROW2 = 0.585;                            // text row radii as a share of the usable radius
const MAXA = 3.9;                                            // each row may use about 220 degrees around the top
const FONT5 = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110', J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111', 3: '11110 00001 00001 01110 00001 00001 11110',
  4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
  "'": '00100 00100 01000 00000 00000 00000 00000', ',': '00000 00000 00000 00000 00110 00100 01000',
  '.': '00000 00000 00000 00000 00000 01100 01100', '!': '00100 00100 00100 00100 00100 00000 00100',
  '?': '01110 10001 00001 00010 00100 00000 00100', '-': '00000 00000 00000 11111 00000 00000 00000',
  ':': '00000 01100 01100 00000 01100 01100 00000', '(': '00010 00100 01000 01000 01000 00100 00010',
  ')': '01000 00100 00010 00010 00010 00100 01000', '&': '01100 10010 10100 01000 10101 10010 01101',
  '"': '01010 01010 00000 00000 00000 00000 00000', '/': '00001 00001 00010 00100 01000 10000 10000',
  '*': '00010 00011 00010 00010 01110 11110 01100',          // a little music note
  ' ': '00000 00000 00000 00000 00000 00000 00000'
};
const GLYPH = {};
for (const [ch, rows] of Object.entries(FONT5)) GLYPH[ch] = rows.split(' ').join('');

const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[♪♫]/g, '*')
  .toUpperCase().replace(/\s+/g, ' ').trim();
export const blockable = t => { const c = [...norm(t)]; return c.length > 0 && c.filter(x => !GLYPH[x]).length / c.length <= 0.2; };
const parts = s => (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment) : [...s];

// pixel size + line breaks so the whole line fits on the ring (letters are 5 px wide + 1 px gap)
export function layoutBlocks(text, Rr) {
  const t = norm(text).split('').map(c => (GLYPH[c] ? c : '?')).join('');
  const r1 = Rr * ROW1, r2 = Rr * ROW2;
  const cap = (r, p) => Math.floor((MAXA * r / p + 1) / 6);
  let p = Rr * 0.19 / 7;
  for (let k = 0; k < 8; k++, p *= 0.9) {
    if (t.length <= cap(r1, p)) return [{ t, r: r1, p }];
    const w = t.split(' ');
    for (let i = w.length - 1; i > 0; i--) {
      const a = w.slice(0, i).join(' '), b = w.slice(i).join(' ');
      if (a.length <= cap(r1, p) && b.length <= cap(r2, p)) return [{ t: a, r: r1, p }, { t: b, r: r2, p }];
    }
  }
  return [{ t: t.slice(0, Math.max(1, cap(r1, p) - 2)).trimEnd() + '..', r: r1, p }];
}
// the same for scripts the pixel font cannot draw (a normal font)
export function layoutSmooth(ctx, text, Rr) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const r1 = Rr * ROW1, r2 = Rr * ROW2;
  const width = (s, px) => { ctx.font = FONT(px); return parts(s).reduce((a, ch) => a + ctx.measureText(ch).width + px * 0.05, 0); };
  let px = Rr * 0.17;
  for (let k = 0; k < 7; k++, px *= 0.9) {
    if (width(text, px) / r1 <= MAXA) return [{ t: text, r: r1, px }];
    const w = text.split(' ');
    for (let i = w.length - 1; i > 0; i--) {
      const a = w.slice(0, i).join(' '), b = w.slice(i).join(' ');
      if (width(a, px) / r1 <= MAXA && width(b, px) / r2 <= MAXA) return [{ t: a, r: r1, px }, { t: b, r: r2, px }];
    }
  }
  const s = parts(text);
  while (s.length > 3 && width(s.join('') + '…', px) / r1 > MAXA) s.pop();
  return [{ t: s.join('').trimEnd() + '…', r: r1, px }];
}

// ---------- one lyric line, ready to animate ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeOutBack = u => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); };

// t0/t1: when the line starts/ends in the song (null = no timing: show it still)
export function buildLine(ctx, text, Rr, t0, t1, now) {
  const block = blockable(text);
  const rows = block ? layoutBlocks(text, Rr) : layoutSmooth(ctx, text, Rr);
  const letters = [];
  let word = 0;
  rows.forEach((row, ri) => {
    if (ri > 0) word++;                                        // the second row starts a new word
    const chars = block ? [...row.t] : parts(row.t);
    let ws, total;
    if (block) { ws = chars.map(() => 6 * row.p); total = (chars.length * 6 - 1) * row.p; }
    else { ctx.font = FONT(row.px); ws = chars.map(ch => ctx.measureText(ch).width + row.px * 0.05); total = ws.reduce((a, b) => a + b, 0); }
    let acc = 0;
    chars.forEach((ch, i) => {
      const centre = block ? i * 6 * row.p + 2.5 * row.p : acc + ws[i] / 2;
      acc += ws[i];
      if (ch === ' ') { word++; return; }
      letters.push({ ch, ang: -(total / row.r) / 2 + centre / row.r, r: row.r, p: row.p, px: row.px, word, block });
    });
  });
  const ids = [...new Set(letters.map(l => l.word))];           // 0..n-1 without gaps
  letters.forEach(l => { l.word = ids.indexOf(l.word); });
  const words = ids.map((_, k) => {
    const ls = letters.filter(l => l.word === k);
    return { n: ls.length, ang: ls.reduce((a, l) => a + l.ang, 0) / ls.length, r: ls[0].r };
  });
  const tot = words.reduce((a, w) => a + w.n + 1, 0);           // longer words take longer to sing
  let c = 0; words.forEach(w => { w.a = c / tot; c += w.n + 1; w.b = c / tot; });
  return { letters, words, R: Rr, t0, t1, born: now, died: 0 };
}

// glyph sprites: the outline + the letter, drawn once per size and colour
const sprites = new Map();
const COLORS = [['rgba(2,10,22,0.96)', '#8ffcff'], ['rgba(2,10,22,0.96)', '#ffffff'], ['rgba(2,10,22,0.8)', '#4c9db0']];   // normal, sung/active, still to come
function sprite(ch, p, variant) {
  const key = ch + '|' + Math.round(p * 20) + '|' + variant;
  let s = sprites.get(key); if (s) return s;
  const o = Math.ceil(p * 0.55) + 1, w = Math.ceil(5 * p + 2 * o), h = Math.ceil(7 * p + 2 * o);
  const c = mkc(w, h), x = c.getContext('2d'), g = GLYPH[ch] || GLYPH['?'];
  for (const pass of [0, 1]) {
    x.fillStyle = COLORS[variant][pass]; const e = pass ? 0 : p * 0.55;
    for (let yy = 0; yy < 7; yy++) for (let xx = 0; xx < 5; xx++) if (g[yy * 5 + xx] === '1') x.fillRect(o + xx * p - e, o + yy * p - e, p + 0.35 + 2 * e, p + 0.35 + 2 * e);
  }
  s = { c, w, h }; sprites.set(key, s); return s;
}

function sparkle(ctx, x, y, s, a) {                            // a small four-point star
  ctx.save(); ctx.translate(x, y); ctx.globalAlpha = a; ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * 0.12, -s * 0.12, s, 0); ctx.quadraticCurveTo(s * 0.12, s * 0.12, 0, s);
  ctx.quadraticCurveTo(-s * 0.12, s * 0.12, -s, 0); ctx.quadraticCurveTo(-s * 0.12, -s * 0.12, 0, -s); ctx.fill(); ctx.restore();
}

// draws the line that is entering/being sung (out = false) or the one blowing away (out = true).
// the context is already at the centre of the record
function drawAnim(ctx, ln, st, out) {
  const Rr = ln.R, timed = ln.t0 != null;
  const age = st.now - (out ? ln.died : ln.born);
  const p = out || !timed ? (out ? 1 : -1) : clamp((st.songMs - ln.t0) / Math.max(500, ln.t1 - ln.t0));
  let sparkleAt = null;
  ln.letters.forEach((L, i) => {
    const w = ln.words[L.word];
    let dAng = 0, dr = 0, a = 1, sc = 1, variant = 0;
    if (out) {                                                // blown away: drifts clockwise and up, letter by letter
      const u = clamp((age - i * 12) / 420); if (u >= 1) return;
      dAng = u * 0.75; dr = u * 0.07 * Rr; a = 1 - u; sc = 1 - 0.2 * u; variant = timed ? 1 : 0;
    } else {                                                  // blown in: arrives from behind with a little overshoot
      const u = clamp((age - i * 14) / 480), e = easeOutBack(u);
      dAng = (1 - e) * -0.5; dr = (1 - e) * -0.05 * Rr; a = clamp(u * 1.8);
      if (timed) {                                            // karaoke: the word being sung hops
        if (p >= w.b) variant = 1;
        else if (p >= w.a) { const h = Math.sin(PI * (p - w.a) / (w.b - w.a)); dr += 0.075 * Rr * h; sc = 1 + 0.22 * h; variant = 1; sparkleAt = w; }
        else variant = 2;
      }
    }
    dr += 0.011 * Rr * Math.sin(st.now * 0.0028 + i * 0.6);   // the wind: a slow ripple that always runs along the line
    dAng += 0.004 * Math.sin(st.now * 0.0021 + i * 0.9);
    ctx.save(); ctx.rotate(L.ang + dAng); ctx.translate(0, -(L.r + dr)); if (sc !== 1) ctx.scale(sc, sc); ctx.globalAlpha = a;
    if (L.block) { const s = sprite(L.ch, L.p, variant); ctx.drawImage(s.c, -s.w / 2, -s.h / 2); }
    else {
      ctx.font = FONT(L.px); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'miter'; ctx.miterLimit = 2;
      ctx.lineWidth = L.px * 0.2; ctx.strokeStyle = COLORS[variant][0]; ctx.strokeText(L.ch, 0, 0);
      ctx.fillStyle = COLORS[variant][1]; ctx.fillText(L.ch, 0, 0);
    }
    ctx.restore();
  });
  if (sparkleAt && !out) {                                     // a twinkle above the word being sung
    ctx.save(); ctx.rotate(sparkleAt.ang);
    sparkle(ctx, 0, -(sparkleAt.r + 0.2 * Rr), Rr * 0.05, 0.55 + 0.45 * Math.sin(st.now * 0.014));
    ctx.restore();
  }
}

// a few thin arcs sweep clockwise right after the line changes
function drawGust(ctx, Rr, st) {
  const age = st.now - st.gustAt; if (!(age >= 0 && age < 720)) return;
  const k = age / 720;
  ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1, Rr * 0.011);
  for (let j = 0; j < 5; j++) {
    const r = Rr * (0.52 + 0.075 * j + 0.02 * Math.sin(j * 7.3)), a0 = -PI / 2 - 1.1 + k * 2.3 + j * 0.16, len = 0.55 + 0.1 * j;
    ctx.strokeStyle = `rgba(143,252,255,${(1 - k) * 0.32})`; ctx.beginPath(); ctx.arc(0, 0, r, a0, a0 + len); ctx.stroke();
  }
  ctx.restore();
}

// ---------- layer 2: smooth disc (the "Circle" shape), cover label, lyrics ----------
const bodies = new Map();
function discBody(W) {                                         // rim + grooves, drawn once per size
  if (bodies.has(W)) return bodies.get(W);
  const c = mkc(W), x = c.getContext('2d'), C = W / 2, Rr = (RD / N) * W;
  const g = x.createRadialGradient(C, C, Rr * 0.1, C, C, Rr); g.addColorStop(0, '#05091a'); g.addColorStop(1, '#080f22');
  x.fillStyle = g; x.beginPath(); x.arc(C, C, Rr * 0.985, 0, TAU); x.fill();
  x.lineWidth = Math.max(1, Rr * 0.006);
  for (let r = Rr * 0.2, k = 0; r < Rr * 0.9; r += Rr * 0.032, k++) { x.strokeStyle = k % 4 === 0 ? 'rgba(120,170,255,0.08)' : 'rgba(120,170,255,0.03)'; x.beginPath(); x.arc(C, C, r, 0, TAU); x.stroke(); }
  x.lineWidth = Rr * 0.026; x.strokeStyle = 'rgb(70,140,210)'; x.beginPath(); x.arc(C, C, Rr * 0.987, 0, TAU); x.stroke();
  x.strokeStyle = 'rgb(30,70,130)'; x.beginPath(); x.arc(C, C, Rr * 0.92, 0, TAU); x.stroke();
  bodies.clear(); bodies.set(W, c); return c;
}
function sheen(ctx, W, rot) {                                  // two light reflections that sweep round as it spins
  const Rr = (RD / N) * W;
  ctx.save(); ctx.translate(W / 2, W / 2); ctx.rotate(rot);
  for (const a of [0, PI]) {
    const g = ctx.createRadialGradient(0, 0, Rr * 0.2, 0, 0, Rr * 0.92);
    g.addColorStop(0, 'rgba(70,160,230,0)'); g.addColorStop(0.7, 'rgba(70,160,230,0.22)'); g.addColorStop(1, 'rgba(70,160,230,0.08)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, Rr * 0.92, a - 0.3, a + 0.3); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// st: { rot, spin, shape, cover, cur, out, now, songMs, gustAt }
export function drawOverlay(ctx, W, st) {
  const c = W / 2, ts = st.shape?.ts ?? 1, Rr = (RD / N) * W * ts, rl = Rr * 0.335;
  ctx.clearRect(0, 0, W, W);
  if (st.shape?.smooth) { ctx.drawImage(discBody(W), 0, 0); sheen(ctx, W, st.rot); }
  ctx.save(); ctx.translate(c, c); ctx.rotate(st.rot);         // album cover = the label, turning with the record
  ctx.beginPath(); ctx.arc(0, 0, rl, 0, TAU); ctx.closePath();
  ctx.save(); ctx.clip();
  if (st.cover) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(st.cover, -rl, -rl, 2 * rl, 2 * rl); }
  else { const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rl); g.addColorStop(0, '#2b9fd0'); g.addColorStop(1, '#0b3b63'); ctx.fillStyle = g; ctx.fill(); }
  ctx.restore();
  ctx.lineWidth = Math.max(1, Rr * 0.014); ctx.strokeStyle = '#0a1830'; ctx.stroke();
  ctx.restore();
  ctx.beginPath(); ctx.arc(c, c, Rr * 0.034, 0, TAU); ctx.fillStyle = '#020309'; ctx.fill();   // spindle hole
  ctx.lineWidth = Math.max(1, Rr * 0.012); ctx.strokeStyle = '#7b89a6'; ctx.stroke();
  ctx.save(); ctx.translate(c, c); if (st.spin) ctx.rotate(st.rot);
  if (st.out) drawAnim(ctx, st.out, st, true);
  if (st.cur) drawAnim(ctx, st.cur, st, false);
  drawGust(ctx, Rr, st);
  ctx.restore();
}

// ---------- the player widget ----------
// api: { time(): ms into the song, offset(): lyric nudge in ms, playing(): bool, spin(): bool, big(): bool, shape(): id }
export function createVinyl(canvas, overlay, api) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(N, N);
  const octx = overlay.getContext('2d');
  const cov = document.createElement('canvas'); cov.width = cov.height = 384;
  let rot = 0, speed = 0, last = 0, running = false, W = 0;
  let track = null, lyr = null, haveCover = false, coverToken = 0, key = '', cur = null, out = null, gustAt = -1e9;

  function line(t) {                                         // what to show now: { text, t0, t1 } (t0 null = no timing)
    if (!track) return { text: 'No song playing', t0: null };
    const fallback = { text: track.title + (track.artist ? ' – ' + track.artist : ''), t0: null };
    const L = lyr?.lines;
    if (!L?.length || t < 0) return fallback;
    if (lyr.synced) {
      const i = lineIndex(lyr, t); if (i < 0) return fallback;
      return { text: L[i].text || '♪', t0: L[i].t, t1: L[i + 1] ? L[i + 1].t : L[i].t + 4000 };
    }
    const d = (track.dur * 1000) || 1, i = Math.min(L.length - 1, Math.floor((t / d) * L.length));   // no timing: spread over the song
    return { text: L[i].text, t0: (i / L.length) * d, t1: ((i + 1) / L.length) * d };
  }

  async function loadCover(id) {
    const token = ++coverToken;
    try {
      const r = await fetch('/api/cover?id=' + encodeURIComponent(id));
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      const im = new Image(); im.src = url; await im.decode();
      URL.revokeObjectURL(url);
      if (token !== coverToken) return;
      const wide = im.width / im.height > 1.5;               // 16:9 (sharp art) or a 4:3 thumbnail with black bars
      const side = wide ? im.height : im.height * 0.75;
      const x = cov.getContext('2d');
      x.clearRect(0, 0, 384, 384); x.imageSmoothingQuality = 'high';
      x.drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, 384, 384);
      haveCover = true; api.onCover?.(cov);
    } catch {}
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    speed += ((api.playing() ? 0.55 : 0) - speed) * Math.min(1, dt * 2.5);   // eases to a stop when paused
    rot = (rot + speed * dt) % TAU;

    const shape = SHAPES.find(s => s.id === api.shape?.()) || SHAPES[1];
    if (shape.smooth) { ctx.fillStyle = '#020309'; ctx.fillRect(0, 0, N, N); }
    else { renderPixels(img.data, rot, shape.id); ctx.putImageData(img, 0, 0); }

    const t = api.time() + (api.offset?.() || 0), L = line(t);
    const k = L.text + '|' + L.t0 + '|' + W + '|' + shape.id;
    if (k !== lineKey()) {                                   // a new line: the old one blows away, the new one blows in
      const resized = !key.endsWith('|' + W + '|' + shape.id);
      if (cur && !resized) { cur.died = now; out = cur; } else out = null;
      key = k; gustAt = now;
      cur = buildLine(octx, L.text, (RD / N) * W * shape.ts, L.t0, L.t1, now);
    }
    if (out && now - out.died > 420 + out.letters.length * 12 + 60) out = null;
    drawOverlay(octx, W, { rot, spin: api.spin(), shape, cover: haveCover ? cov : null, cur, out, now, songMs: t, gustAt });
  }
  const lineKey = () => key;

  // size: the pixel disc at a whole number of screen pixels per disc pixel; the sharp layer matches it exactly
  function fit() {
    const w = Math.floor(canvas.parentElement.clientWidth - 16);
    const narrow = matchMedia('(max-width:700px)').matches;
    const css = narrow ? Math.max(120, w)                                   // phone: as big as the screen allows
      : N * Math.min(api.big?.() ? 6 : 3, Math.max(2, Math.floor(w / N)));  // laptop: 3x, or 6x after a click
    canvas.style.width = canvas.style.height = overlay.style.width = overlay.style.height = css + 'px';
    const px = Math.round(css * Math.min(2, window.devicePixelRatio || 1));
    if (px !== W) { W = px; overlay.width = overlay.height = W; key = ''; }
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas.parentElement);
  addEventListener('resize', fit);

  return {
    fit,
    start() { if (!running) { running = true; last = 0; fit(); requestAnimationFrame(frame); } },
    stop() { running = false; },
    setTrack(t) { track = t || null; haveCover = false; lyr = null; coverToken++; key = ''; cur = out = null; if (t) loadCover(t.tid); },
    setLyrics(l) { lyr = l || null; key = ''; cur = out = null; }
  };
}
