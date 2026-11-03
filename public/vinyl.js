// The record. Two layers:
//   1. a chunky pixel disc (80x80 pixels shown big: stair-stepped circle, double rim, grooves, light reflections)
//   2. a smooth, sharp layer on top: the album cover as the round label, and the lyrics curved around the record.
const N = 80, CX = 39.5, CY = 39.5, RD = 38, RL = 13;
const PI = Math.PI, TAU = 2 * PI;

// per-pixel lookup tables for the pixel layer, built once
const R = new Float32Array(N * N), C2 = new Float32Array(N * N), S2 = new Float32Array(N * N);
for (let y = 0, i = 0; y < N; y++) {
  for (let x = 0; x < N; x++, i++) {
    const dx = x - CX, dy = y - CY, r = Math.hypot(dx, dy), rr = r * r || 1;
    R[i] = r; C2[i] = (dx * dx - dy * dy) / rr; S2[i] = (2 * dx * dy) / rr;
  }
}

// ---------- layer 1: the pixel disc (pure: fills `px`) ----------
export function renderPixels(px, rot) {
  const c2 = Math.cos(2 * rot), s2 = Math.sin(2 * rot);
  for (let i = 0, p = 0; i < N * N; i++, p += 4) {
    const r = R[i];
    let rr = 2, gg = 3, bb = 9;                              // OLED black with a hint of blue
    if (r <= RD + 0.5) {
      if (r > RD - 1) { rr = 70; gg = 140; bb = 210; }       // outer rim line
      else if (r > RD - 2.5) { rr = 5; gg = 9; bb = 22; }    // dark gap
      else if (r > RD - 3.5) { rr = 30; gg = 70; bb = 130; } // inner rim line
      else {
        const base = 5 + ((r | 0) % 4 === 0 ? 3 : 0);        // faint grooves
        const s = C2[i] * c2 + S2[i] * s2;
        const sh = s > 0 ? Math.floor(s * s * s * s * 4) / 4 : 0;   // two light reflections, in flat steps
        const f = (0.35 + 0.65 * r / RD) * sh;
        rr = base + 14 * f; gg = base * 1.8 + 60 * f; bb = base * 4 + 95 * f;
        if (r < RL) { rr = 4; gg = 8; bb = 20; }             // the smooth label sits on top of this
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

// ---------- layer 2: sharp lyrics along the record ----------
// Latin lyrics use a 5x7 pixel font: every letter is a rigid block of square pixels with hard edges (matching the pixel disc),
// drawn at full screen resolution so it stays crisp. Other scripts (Hindi, Arabic, ...) fall back to a normal font.
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
  '*': '00010 00011 00010 00010 01110 11110 01100',            // a little music note
  ' ': '00000 00000 00000 00000 00000 00000 00000'
};
const GLYPH = {};
for (const [ch, rows] of Object.entries(FONT5)) GLYPH[ch] = rows.split(' ').join('');

const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[♪♫]/g, '*')
  .toUpperCase().replace(/\s+/g, ' ').trim();
// true when the pixel font can draw (nearly) all of this line
const blockable = t => { const c = [...norm(t)]; return c.length > 0 && c.filter(x => !GLYPH[x]).length / c.length <= 0.2; };

// pixel size + line breaks so the whole line fits on the record (letters are 5 px wide + 1 px gap)
export function layoutBlocks(text, R) {
  let t = norm(text).split('').map(c => (GLYPH[c] ? c : '?')).join('');
  const r1 = R * ROW1, r2 = R * ROW2;
  const cap = (r, p) => Math.floor((MAXA * r / p + 1) / 6);            // letters that fit on one row
  let p = R * 0.19 / 7;
  for (let k = 0; k < 8; k++, p *= 0.9) {
    if (t.length <= cap(r1, p)) return [{ t, r: r1, p }];
    const w = t.split(' ');
    for (let i = w.length - 1; i > 0; i--) {
      const a = w.slice(0, i).join(' '), b = w.slice(i).join(' ');
      if (a.length <= cap(r1, p) && b.length <= cap(r2, p)) return [{ t: a, r: r1, p }, { t: b, r: r2, p }];
    }
  }
  const c1 = cap(r1, p);                                                 // still too long: cut it
  return [{ t: t.slice(0, Math.max(1, c1 - 2)).trimEnd() + '..', r: r1, p }];
}

export function drawBlockRows(ctx, rows, cx, cy) {
  ctx.save(); ctx.translate(cx, cy);
  for (const pass of [0, 1]) {                                           // 0: dark outline, 1: the bright letters
    ctx.fillStyle = pass ? '#8ffcff' : 'rgba(2,10,22,0.96)';
    for (const row of rows) {
      const chars = [...row.t], p = row.p, o = pass ? 0 : p * 0.55, e = pass ? 0.35 : 0.35;   // e: tiny overlap hides seams
      let ang = -(((chars.length * 6 - 1) * p) / row.r) / 2;
      chars.forEach((ch, i) => {
        const g = GLYPH[ch]; if (!g) return;
        const a = ang + ((i * 6 + 2.5) * p) / row.r;                     // letters turn to follow the circle, tops outwards
        ctx.save(); ctx.rotate(a); ctx.translate(0, -row.r);
        for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (g[y * 5 + x] === '1') ctx.fillRect((x - 2.5) * p - o, (y - 3.5) * p - o, p + e + 2 * o, p + e + 2 * o);
        ctx.restore();
      });
    }
  }
  ctx.restore();
}

// text for scripts the pixel font cannot draw (normal font, hard corners)
const FONT = px => `700 ${px}px "Segoe UI", system-ui, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Devanagari", sans-serif`;
const ROW1 = 0.815, ROW2 = 0.585;                            // text row radii as a share of the disc radius
const MAXA = 3.9;                                            // each row may use about 220 degrees around the top

// split into graphemes so scripts that join letters (Hindi, Arabic...) are drawn in one piece
const parts = s => (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment) : [...s];

// decide the font size and where the line breaks so the whole line fits on the record
export function layoutLine(ctx, text, R) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const r1 = R * ROW1, r2 = R * ROW2;
  const width = (s, px) => { ctx.font = FONT(px); return parts(s).reduce((a, ch) => a + ctx.measureText(ch).width + px * 0.05, 0); };
  let px = R * 0.17;
  for (let k = 0; k < 7; k++, px *= 0.9) {
    if (width(text, px) / r1 <= MAXA) return [{ t: text, r: r1, px }];
    const w = text.split(' ');
    for (let i = w.length - 1; i > 0; i--) {                 // longest first row that fits, rest on the inner row
      const a = w.slice(0, i).join(' '), b = w.slice(i).join(' ');
      if (width(a, px) / r1 <= MAXA && width(b, px) / r2 <= MAXA) return [{ t: a, r: r1, px }, { t: b, r: r2, px }];
    }
  }
  let s = parts(text);                                       // really long: cut it with an ellipsis
  while (s.length > 3 && width(s.join('') + '…', px) / r1 > MAXA) s.pop();
  return [{ t: s.join('').trimEnd() + '…', r: r1, px }];
}

export function drawArcRows(ctx, rows, cx, cy) {
  ctx.save(); ctx.translate(cx, cy); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'miter'; ctx.miterLimit = 2;
  for (const row of rows) {
    ctx.font = FONT(row.px);
    const chars = parts(row.t), gap = row.px * 0.05, ws = chars.map(ch => ctx.measureText(ch).width + gap);
    let ang = -(ws.reduce((a, b) => a + b, 0) / row.r) / 2;  // centred on the top, reading clockwise
    chars.forEach((ch, i) => {
      const half = ws[i] / row.r / 2; ang += half;
      ctx.save(); ctx.rotate(ang); ctx.translate(0, -row.r);  // letter tops point outwards
      ctx.lineWidth = row.px * 0.2; ctx.strokeStyle = 'rgba(2,10,22,0.95)'; ctx.strokeText(ch, 0, 0);
      ctx.fillStyle = '#8ffcff'; ctx.fillText(ch, 0, 0);
      ctx.restore(); ang += half;
    });
  }
  ctx.restore();
}

// draw one lyric line with whichever font can show it
export function drawLine(ctx, text, W) {
  const R = (RD / N) * W;
  if (blockable(text)) drawBlockRows(ctx, layoutBlocks(text, R), W / 2, W / 2);
  else drawArcRows(ctx, layoutLine(ctx, text, R), W / 2, W / 2);
}

// everything smooth that sits on top of the pixel disc
export function drawOverlay(ctx, W, st) {
  const c = W / 2, R = (RD / N) * W, rl = R * 0.335;
  ctx.clearRect(0, 0, W, W);
  if (st.textCanvas) {                                       // lyrics (drawn once per line, then just placed)
    ctx.save(); ctx.globalAlpha = st.alpha ?? 1; ctx.translate(c, c);
    if (st.spin) ctx.rotate(st.rot);
    ctx.drawImage(st.textCanvas, -c, -c); ctx.restore();
  }
  ctx.save(); ctx.translate(c, c); ctx.rotate(st.rot);       // album cover = the label, turning with the record
  ctx.beginPath(); ctx.arc(0, 0, rl, 0, TAU); ctx.closePath();
  ctx.save(); ctx.clip();
  if (st.cover) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(st.cover, -rl, -rl, 2 * rl, 2 * rl); }
  else { const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rl); g.addColorStop(0, '#2b9fd0'); g.addColorStop(1, '#0b3b63'); ctx.fillStyle = g; ctx.fill(); }
  ctx.restore();
  ctx.lineWidth = Math.max(1, R * 0.014); ctx.strokeStyle = '#0a1830'; ctx.stroke();
  ctx.restore();
  ctx.beginPath(); ctx.arc(c, c, R * 0.034, 0, TAU); ctx.fillStyle = '#020309'; ctx.fill();   // spindle hole
  ctx.lineWidth = Math.max(1, R * 0.012); ctx.strokeStyle = '#7b89a6'; ctx.stroke();
}

// ---------- the player widget ----------
// api: { time(): ms into the song, offset(): lyric nudge in ms, playing(): bool, spin(): bool, big(): bool }
export function createVinyl(canvas, overlay, api) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(N, N);
  const octx = overlay.getContext('2d');
  const txt = document.createElement('canvas'), tctx = txt.getContext('2d');
  const cov = document.createElement('canvas'); cov.width = cov.height = 384;
  let rot = 0, speed = 0, last = 0, running = false, W = 0;
  let track = null, lyr = null, haveCover = false, coverToken = 0, key = '', fadeAt = 0;

  function line(t) {                                         // the lyric line for this moment
    if (!track) return 'No song playing';
    const fallback = track.title + (track.artist ? ' – ' + track.artist : '');
    const L = lyr?.lines;
    if (!L?.length || t < 0) return fallback;
    if (lyr.synced) { const i = lineIndex(lyr, t); return i < 0 ? fallback : (L[i].text || '♪'); }
    return L[Math.min(L.length - 1, Math.floor((t / ((track.dur * 1000) || 1)) * L.length))].text;   // no timing: spread over the song
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
      haveCover = true;
    } catch {}
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    speed += ((api.playing() ? 0.55 : 0) - speed) * Math.min(1, dt * 2.5);   // eases to a stop when paused
    rot = (rot + speed * dt) % TAU;

    renderPixels(img.data, rot);
    ctx.putImageData(img, 0, 0);

    const text = line(api.time() + (api.offset?.() || 0));
    if (text + '|' + W !== key) {                            // new lyric line: redraw the text layer, fade it in
      key = text + '|' + W; fadeAt = now;
      tctx.clearRect(0, 0, W, W);
      drawLine(tctx, text, W);
    }
    drawOverlay(octx, W, { rot, spin: api.spin(), cover: haveCover ? cov : null, textCanvas: txt, alpha: Math.min(1, (now - fadeAt) / 220) });
  }

  // size: the pixel disc at a whole number of screen pixels per disc pixel; the sharp layer matches it exactly
  function fit() {
    const w = Math.floor(canvas.parentElement.clientWidth - 16);
    const narrow = matchMedia('(max-width:700px)').matches;
    const css = narrow ? Math.max(120, w)                                   // phone: as big as the screen allows
      : N * Math.min(api.big?.() ? 6 : 3, Math.max(2, Math.floor(w / N)));  // laptop: 3x, or 6x after a click
    canvas.style.width = canvas.style.height = overlay.style.width = overlay.style.height = css + 'px';
    const px = Math.round(css * Math.min(2, window.devicePixelRatio || 1));
    if (px !== W) { W = px; overlay.width = overlay.height = txt.width = txt.height = W; key = ''; }
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas.parentElement);
  addEventListener('resize', fit);

  return {
    fit,
    start() { if (!running) { running = true; last = 0; fit(); requestAnimationFrame(frame); } },
    stop() { running = false; },
    setTrack(t) { track = t || null; haveCover = false; lyr = null; coverToken++; key = ''; if (t) loadCover(t.tid); },
    setLyrics(l) { lyr = l || null; key = ''; }
  };
}
