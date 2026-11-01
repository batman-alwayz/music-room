// Chunky pixel vinyl for the "OLED" screen (80x80 pixels, shown at 3-4x so every pixel is visible):
// stair-stepped disc with a double rim, album cover as the small centre label, and big blocky
// lyrics curving around the record from the left, over the top, down the right side.
const N = 80, CX = 39.5, CY = 39.5, RD = 38, RL = 12, TS = 24;
const PI = Math.PI;
const HW = 2.0;                                              // lyric arc: +-115 degrees around the top
const RA = 31, RB = 22;                                      // middle radius of the outer / inner text row (7 px thick each)
const ADV = 6;                                               // 5 px letter + 1 px gap

// per-pixel lookup tables, built once
const DX = new Float32Array(N * N), DY = new Float32Array(N * N), R = new Float32Array(N * N),
      A = new Float32Array(N * N), C2 = new Float32Array(N * N), S2 = new Float32Array(N * N);
for (let y = 0, i = 0; y < N; y++) {
  for (let x = 0; x < N; x++, i++) {
    const dx = x - CX, dy = y - CY, r = Math.hypot(dx, dy), rr = r * r || 1;
    DX[i] = dx; DY[i] = dy; R[i] = r; A[i] = Math.atan2(dy, dx);
    C2[i] = (dx * dx - dy * dy) / rr; S2[i] = (2 * dx * dy) / rr;
  }
}

// ---------- 5x7 pixel font (capitals, digits, a little punctuation) ----------
const FONT = {
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
for (const [ch, rows] of Object.entries(FONT)) GLYPH[ch] = rows.split(' ').join('');

const norm = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[♪♫]/g, '*')
  .toUpperCase().replace(/\s+/g, ' ').trim();

// text -> 1-bit strip, 7 px tall. Lines in scripts the font cannot draw become music notes.
export function bitmapStrip(text) {
  let chars = [...norm(text)];
  if (!chars.length) return null;
  const bad = chars.filter(c => !GLYPH[c]).length;
  chars = bad / chars.length > 0.6 ? ['*', ' ', '*', ' ', '*'] : chars.map(c => (GLYPH[c] ? c : '?'));
  const w = chars.length * ADV - 1;
  const bits = new Uint8Array(w * 7);
  chars.forEach((c, k) => {
    const g = GLYPH[c];
    for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (g[y * 5 + x] === '1') bits[y * w + k * ADV + x] = 1;
  });
  return { w, h: 7, bits };
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

// split a line over the two rows (outer holds 20 letters, inner 15)
export function wrap(t, ma = 20, mb = 15) {
  t = norm(t);
  if (t.length <= ma) return [t, ''];
  let cut = t.lastIndexOf(' ', ma);
  if (cut < ma * 0.5) cut = ma;
  const a = t.slice(0, cut).trim();
  let b = t.slice(cut).trim();
  if (b.length > mb) b = b.slice(0, mb - 2).trimEnd() + '..';
  return [a, b];
}

// ---------- the pixel renderer (pure: fills `px`, so it can be tested without a browser) ----------
export function renderPixels(px, st) {
  const { rot, spin, tex, sA, sB } = st;
  const cr = Math.cos(rot), sr = Math.sin(rot), c2 = Math.cos(2 * rot), s2 = Math.sin(2 * rot);
  const thA = -PI / 2 + (spin ? rot : 0);
  for (let i = 0, p = 0; i < N * N; i++, p += 4) {
    const r = R[i];
    let rr = 2, gg = 3, bb = 9, text = false;                // OLED black with a hint of blue
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
        if (r < RL) {                                        // small round label = album cover, turning with the disc
          const x = DX[i] * cr + DY[i] * sr, y = -DX[i] * sr + DY[i] * cr;
          const u = Math.min(TS - 1, Math.max(0, ((x / RL * 0.5 + 0.5) * TS) | 0));
          const v = Math.min(TS - 1, Math.max(0, ((y / RL * 0.5 + 0.5) * TS) | 0));
          if (tex) { const q = (v * TS + u) * 4; rr = tex[q]; gg = tex[q + 1]; bb = tex[q + 2]; }
          else { rr = 10; gg = 70 + 50 * (1 - r / RL); bb = 110 + 70 * (1 - r / RL); }
          if (r < 1.6) { rr = 2; gg = 3; bb = 9; }                         // spindle hole
          else if (r < 2.6) { rr = 70; gg = 85; bb = 110; }                // ring round the hole
          else if (r > RL - 1.1) { rr = 4; gg = 8; bb = 20; }              // label edge
        } else if (r >= 18.5 && r < 34.5) {                  // lyrics: big blocky letters, tops pointing outwards
          for (let k = 0; k < 4 && !text; k++) {             // 4 sub-samples per pixel -> bold, unbroken strokes
            const x = DX[i] + (k & 1 ? 0.3 : -0.3), y = DY[i] + (k & 2 ? 0.3 : -0.3);
            const rs = Math.hypot(x, y);
            if (rs < 18.5 || rs >= 34.5) continue;
            let d = Math.atan2(y, x) - thA;
            if (d > PI) d -= 2 * PI; else if (d < -PI) d += 2 * PI;
            if (!spin && (d <= -HW || d >= HW)) continue;
            if (rs >= 27.5) {
              if (sA) { const xx = (d * RA + sA.w / 2) | 0, yy = ((34.5 - rs) / 7 * sA.h) | 0; if (xx >= 0 && xx < sA.w && sA.bits[yy * sA.w + xx]) text = true; }
            } else if (rs < 25.5 && sB) {
              const xx = (d * RB + sB.w / 2) | 0, yy = ((25.5 - rs) / 7 * sB.h) | 0;
              if (xx >= 0 && xx < sB.w && sB.bits[yy * sB.w + xx]) text = true;
            }
          }
        }
      }
    }
    if (text) { rr = 125; gg = 250; bb = 255; }
    px[p] = rr; px[p + 1] = gg; px[p + 2] = bb; px[p + 3] = 255;
  }
}

// ---------- the player widget ----------
// api: { time(): ms into the song, playing(): bool, spin(): bool }
export function createVinyl(canvas, api) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(N, N);
  let rot = 0, speed = 0, last = 0, running = false;
  let track = null, lyr = null, tex = null, coverToken = 0;
  const keys = ['', ''], strips = [null, null];

  const strip = (i, text) => {
    if (keys[i] !== text) { keys[i] = text; strips[i] = text ? bitmapStrip(text) : null; }
    return strips[i];
  };

  function line(t) {                                         // the lyric line for this moment
    if (!track) return 'No song';
    const L = lyr?.lines;
    if (!L?.length || t < 0) return track.title + ' - ' + (track.artist || '');
    if (lyr.synced) {
      let lo = 0, hi = L.length - 1, i = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
      return i < 0 ? track.title + ' - ' + (track.artist || '') : (L[i].text || '*');
    }
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
      const c = document.createElement('canvas'); c.width = c.height = TS;
      const x = c.getContext('2d', { willReadFrequently: true });
      const side = Math.min(im.width, im.height * 0.75);     // tight crop of the art inside a 4:3 thumbnail
      x.drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, TS, TS);
      const d = x.getImageData(0, 0, TS, TS).data;
      for (let i = 0; i < d.length; i++) if (i % 4 !== 3) d[i] = Math.min(255, Math.round(d[i] / 36.4) * 36.4);   // 8 levels per colour
      tex = d;
    } catch {}
  }

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    speed += ((api.playing() ? 0.55 : 0) - speed) * Math.min(1, dt * 2.5);   // eases to a stop when paused
    rot = (rot + speed * dt) % (2 * PI);
    const [a, b] = wrap(line(api.time()));
    renderPixels(img.data, { rot, spin: api.spin(), tex, sA: strip(0, a), sB: strip(1, b) });
    ctx.putImageData(img, 0, 0);
  }

  // whole-number scaling (3x or 4x) so every pixel is the same size
  function fit() {
    const w = canvas.parentElement.clientWidth - 16;
    const k = Math.min(4, Math.max(2, Math.floor(w / N)));
    canvas.style.width = canvas.style.height = (k * N) + 'px';
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas.parentElement);
  addEventListener('resize', fit);

  return {
    fit,
    start() { if (!running) { running = true; last = 0; fit(); requestAnimationFrame(frame); } },
    stop() { running = false; },
    setTrack(t) { track = t || null; tex = null; lyr = null; coverToken++; if (t) loadCover(t.tid); },
    setLyrics(l) { lyr = l || null; }
  };
}
