// Pixel-art vinyl for the "OLED" screen: a 160x160 canvas shown with crisp pixels.
// Dark navy disc, album cover as the label, cyan pixel lyrics bent around the record.
const N = 160, CX = 79.5, CY = 79.5, RD = 77, RL = 29, TS = 48;
const FONT = '8px "Press Start 2P", monospace';
const PI = Math.PI;
const WIN = 1.35;                                            // lyric arcs span +-77 degrees (readable, upright)

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

// split a lyric line over the two arcs (outer 23 chars, inner 20 chars)
export function wrap(t, ma = 23, mb = 20) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (t.length <= ma) return [t, ''];
  let cut = t.lastIndexOf(' ', ma);
  if (cut < ma * 0.5) cut = ma;
  const a = t.slice(0, cut).trim();
  let b = t.slice(cut).trim();
  if (b.length > mb) b = b.slice(0, mb - 3).trimEnd() + '...';
  return [a, b];
}
const short = (t, n = 22) => (t.length > n ? t.slice(0, n - 3).trimEnd() + '...' : t);

// text -> 1-bit strip, 8 px tall (Press Start 2P is drawn on an 8 px grid, so it stays crisp)
function makeStrip(text) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.font = FONT;
  const w = Math.max(8, Math.ceil(ctx.measureText(text).width));
  c.width = w; c.height = 8;
  ctx.font = FONT; ctx.textBaseline = 'top'; ctx.fillStyle = '#fff';
  ctx.fillText(text, 0, 0);
  const d = ctx.getImageData(0, 0, w, 8).data;
  const bits = new Uint8Array(w * 8);
  for (let i = 0; i < w * 8; i++) bits[i] = d[i * 4 + 3] > 110 ? 1 : 0;
  return { w, bits };
}

// ---------- the pixel renderer (pure: fills `px`, so it can be tested without a browser) ----------
export function renderPixels(px, st) {
  const { rot, spin, tex, sA, sB, sC } = st;
  const cr = Math.cos(rot), sr = Math.sin(rot), c2 = Math.cos(2 * rot), s2 = Math.sin(2 * rot);
  const thA = -PI / 2 + (spin ? rot : 0), thC = PI / 2 + (spin ? rot : 0);
  for (let i = 0, p = 0; i < N * N; i++, p += 4) {
    const r = R[i];
    let rr = 2, gg = 3, bb = 9;                              // OLED black with a hint of blue
    let text = 0;                                            // 1 = current lyric, 2 = next lyric
    if (r <= RD + 1.2) {
      if (r > RD) { rr = 4; gg = 6; bb = 14; }               // soft shadow around the record
      else {
        const gr = r | 0;                                    // grooves
        const base = 12 + (gr % 3 === 0 ? 5 : 0) - (gr % 13 === 0 ? 5 : 0) + (r > RD - 2 ? 14 : 0);
        const s = C2[i] * c2 + S2[i] * s2;                   // cos(2 * angle from the sheen axis)
        const sh = s > 0 ? s * s * s * s : 0;                // two bright reflections that sweep as it spins
        const f = (0.3 + 0.7 * r / RD) * sh;
        rr = base * 0.4 + 26 * f; gg = base * 0.8 + 120 * f; bb = base * 1.8 + 165 * f;
        if (r < RL) {                                        // label = album cover, spinning with the disc
          const x = DX[i] * cr + DY[i] * sr, y = -DX[i] * sr + DY[i] * cr;
          const u = Math.min(TS - 1, Math.max(0, ((x / RL * 0.5 + 0.5) * TS) | 0));
          const v = Math.min(TS - 1, Math.max(0, ((y / RL * 0.5 + 0.5) * TS) | 0));
          if (tex) { const q = (v * TS + u) * 4; rr = tex[q]; gg = tex[q + 1]; bb = tex[q + 2]; }
          else { rr = 8; gg = 60 + 50 * (1 - r / RL); bb = 100 + 70 * (1 - r / RL); }
          if (r < 2.6) { rr = 2; gg = 3; bb = 9; }                          // spindle hole
          else if (r > RL - 1.3) { rr = 6; gg = 12; bb = 30; }              // label edge
        } else {
          rr = (rr | 0) & ~7; gg = (gg | 0) & ~7; bb = (bb | 0) & ~7;       // posterize: chunky pixel-art shading
          if (r >= 56 && r < 73) {                           // current line: two arcs over the top
            let d = A[i] - thA;
            if (d > PI) d -= 2 * PI; else if (d < -PI) d += 2 * PI;
            if (spin || (d > -WIN && d < WIN)) {
              if (r >= 65) {
                if (sA) { const xx = (d * 69 + sA.w / 2) | 0, yy = (72.999 - r) | 0; if (xx >= 0 && xx < sA.w && sA.bits[yy * sA.w + xx]) text = 1; }
              } else if (r < 64 && sB) {
                const xx = (d * 60 + sB.w / 2) | 0, yy = (63.999 - r) | 0;
                if (xx >= 0 && xx < sB.w && sB.bits[yy * sB.w + xx]) text = 1;
              }
            }
          }
          if (!text && r >= 62 && r < 70 && sC) {            // next line: one arc along the bottom, dimmer
            let d = A[i] - thC;
            if (d > PI) d -= 2 * PI; else if (d < -PI) d += 2 * PI;
            if (spin || (d > -WIN && d < WIN)) {
              const xx = (-d * 66 + sC.w / 2) | 0, yy = (r - 62) | 0;
              if (xx >= 0 && xx < sC.w && sC.bits[yy * sC.w + xx]) text = 2;
            }
          }
        }
      }
    }
    if (text === 1) { rr = 125; gg = 250; bb = 255; }
    else if (text === 2) { rr = 38; gg = 128; bb = 150; }
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
  const keys = ['', '', ''], strips = [null, null, null];

  document.fonts?.load(FONT).then(() => { keys[0] = keys[1] = keys[2] = '\0'; }).catch(() => {});   // redraw text once the font is in

  const strip = (i, text) => {
    if (keys[i] !== text) { keys[i] = text; strips[i] = text ? makeStrip(text) : null; }
    return strips[i];
  };

  function lines(t) {                                        // -> [current line, next line]
    if (!track) return ['No song playing', 'Search and add one'];
    const L = lyr?.lines;
    if (!L?.length || t < 0) return [track.title, track.artist];
    if (lyr.synced) {
      let lo = 0, hi = L.length - 1, i = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; }
      return [i < 0 ? track.title : (L[i].text || '...'), L[i + 1] ? (L[i + 1].text || '...') : track.artist];
    }
    const i = Math.min(L.length - 1, Math.floor((t / ((track.dur * 1000) || 1)) * L.length));   // no timing: spread over the song
    return [L[i].text, L[i + 1]?.text || track.artist];
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
    const [cur, nxt] = lines(api.time());
    const [a, b] = wrap(cur);
    renderPixels(img.data, { rot, spin: api.spin(), tex, sA: strip(0, a), sB: strip(1, b), sC: strip(2, short(nxt)) });
    ctx.putImageData(img, 0, 0);
  }

  // whole-pixel scaling where it fits, so the pixels stay crisp
  function fit() {
    const w = canvas.parentElement.clientWidth - 16;
    const px = w >= 320 ? 320 : Math.max(120, Math.floor(w));
    canvas.style.width = canvas.style.height = px + 'px';
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
