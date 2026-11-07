// The Lyrics tab: a small lyric video. A painted night sky in the song's own colours, big type that changes style
// from line to line (huge caps, script, small-big-small, plain), words that hop when they are sung,
// and wind that carries each line in and out.
const PI = Math.PI;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const easeOutBack = u => { const c1 = 1.7, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); };
const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

let mkc = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
export const setCanvasFactory = f => { mkc = f; };

// ---------- colours from the album cover ----------
export function paletteFrom(data, seed) {
  let sx = 0, sy = 0, sw = 0, ss = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
    if (d < 0.12 || mx < 0.2) continue;                         // skip greys and near-black
    let h = (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60; if (h < 0) h += 360;
    const w = d * mx; sx += Math.cos(h * PI / 180) * w; sy += Math.sin(h * PI / 180) * w; sw += w; ss += (d / mx) * w;
  }
  return sw < 3 ? makePalette(hash(seed) % 360, 0.72) : makePalette((Math.atan2(sy, sx) * 180 / PI + 360) % 360, clamp(ss / sw, 0.5, 0.9));
}
export function makePalette(h, s) {
  const S = Math.round(s * 100), H = d => (Math.round(h + d) % 360 + 360) % 360;
  return { h, top: `hsl(${h},${S}%,36%)`, mid: `hsl(${H(16)},${Math.min(95, S + 8)}%,50%)`, low: `hsl(${H(-20)},${Math.max(40, S - 12)}%,13%)`,
    ridge: `hsl(${H(-30)},45%,7%)`, ridge2: `hsl(${H(-25)},40%,14%)`, glow: `hsl(${H(12)},95%,72%)`, accent: `hsl(${H(170)},90%,72%)` };
}

// ---------- the painted background (drawn once per size and song) ----------
function flow(x, y) { return (Math.sin(x * 0.012 + 1.3) * Math.cos(y * 0.015) + Math.sin((x + y) * 0.006)) * 1.6; }
function buildBg(W, H, pal, seed) {
  const c = mkc(W, H), x = c.getContext('2d'), rnd = prng(seed);
  const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, pal.top); g.addColorStop(0.55, pal.mid); g.addColorStop(1, pal.low);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.lineCap = 'round';
  const n = Math.round(W * H / 45);                              // brush strokes that follow a swirling flow
  for (let k = 0; k < n; k++) {
    const px = rnd() * W, py = rnd() * H, a = flow(px, py), len = 12 + rnd() * 34, light = rnd() < 0.5;
    x.strokeStyle = light ? `hsla(${(pal.h + rnd() * 40 - 10 + 360) % 360},85%,${55 + rnd() * 20}%,${0.05 + rnd() * 0.07})`
      : `hsla(${(pal.h + 320 + rnd() * 30) % 360},70%,${12 + rnd() * 14}%,${0.06 + rnd() * 0.08})`;
    x.lineWidth = 2 + rnd() * 7;
    x.beginPath(); x.moveTo(px, py);
    x.quadraticCurveTo(px + Math.cos(a) * len * 0.6 + Math.cos(a + 1.2) * len * 0.2, py + Math.sin(a) * len * 0.6 + Math.sin(a + 1.2) * len * 0.2, px + Math.cos(a) * len, py + Math.sin(a) * len);
    x.stroke();
  }
  const ridge = (base, amp, s1, s2, fill) => {                   // hills
    x.fillStyle = fill; x.beginPath(); x.moveTo(0, H);
    for (let px = 0; px <= W + 6; px += 6) x.lineTo(px, base + Math.sin(px * 0.011 + s1) * amp + Math.sin(px * 0.027 + s2) * amp * 0.5);
    x.lineTo(W, H); x.closePath(); x.fill();
  };
  ridge(H * 0.84, H * 0.04, 1.1, 2.4, pal.ridge2);
  ridge(H * 0.91, H * 0.035, 3.3, 0.7, pal.ridge);
  x.strokeStyle = pal.ridge; x.lineWidth = 2;                    // blades of grass along the front hill
  for (let px = 0; px < W; px += 5) { const y = H * 0.91 + Math.sin(px * 0.011 + 3.3) * H * 0.035 + Math.sin(px * 0.027 + 0.7) * H * 0.0175; x.beginPath(); x.moveTo(px, y + 2); x.lineTo(px + (rnd() - 0.3) * 5, y - 4 - rnd() * 9); x.stroke(); }
  return c;
}

function makeParticles(W, H, seed) {
  const r = prng(seed ^ 0x9e3779b9);
  return {
    orbs: Array.from({ length: 4 }, () => ({ x: r(), y: r() * 0.7, s: 0.08 + r() * 0.12, ph: r() * 6.28 })),
    stars: Array.from({ length: 36 }, () => ({ x: r(), y: r() * 0.75, s: 0.6 + r() * 1.4, ph: r() * 6.28 })),
    petals: Array.from({ length: 22 }, () => ({ x: r(), y: r(), s: 0.5 + r(), rot: r() * 6.28, vr: (r() - 0.5) * 2, ph: r() * 6.28 }))
  };
}

function drawBackground(ctx, W, H, now, dt, st) {
  const pal = st.pal;
  ctx.save();
  const sc = 1.07, pan = Math.sin(now * 0.00018) * W * 0.02;      // the painting drifts a little
  ctx.translate(W / 2 + pan, H / 2); ctx.scale(sc, sc); ctx.translate(-W / 2, -H / 2); ctx.drawImage(st.bg, 0, 0, W, H); ctx.restore();
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const o of st.parts.orbs) {                                // soft glowing orbs
    const x = (o.x + Math.sin(now * 0.00012 + o.ph) * 0.05) * W, y = (o.y + Math.cos(now * 0.0001 + o.ph) * 0.04) * H, r = o.s * H * 1.6;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(255,230,200,0.22)'); g.addColorStop(0.35, 'rgba(255,200,170,0.07)'); g.addColorStop(1, 'rgba(255,200,170,0)');
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  ctx.lineCap = 'round';                                          // a brush-drawn moon ring
  const mx = W * 0.86, my = H * 0.2, mr = H * 0.085, pulse = 0.5 + 0.2 * Math.sin(now * 0.0011);
  for (let k = 0; k < 3; k++) { ctx.strokeStyle = `rgba(255,236,190,${pulse * (0.5 - k * 0.12)})`; ctx.lineWidth = H * (0.02 - k * 0.005); ctx.beginPath(); ctx.arc(mx, my, mr + k * 2, 0.4 + k * 0.5, 5.6 + k * 0.2); ctx.stroke(); }
  for (const s of st.parts.stars) {                               // twinkling stars
    const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(now * 0.002 * s.s + s.ph)); ctx.fillStyle = `rgba(255,255,255,${a})`;
    const x = s.x * W, y = s.y * H, z = s.s * (W / 700) + 0.4; ctx.fillRect(x - z, y - z * 0.3, z * 2, z * 0.6); ctx.fillRect(x - z * 0.3, y - z, z * 0.6, z * 2);
  }
  ctx.restore();
  const gustK = clamp(1 - (now - st.gustAt) / 1200);              // petals ride the wind; a new line gives them a push
  for (const p of st.parts.petals) {
    p.x -= dt * (0.02 + 0.07 * gustK) * p.s; p.y += dt * (0.012 + 0.01 * Math.sin(now * 0.0011 + p.ph)) * p.s * 0.6; p.rot += dt * p.vr * (1 + gustK * 3);
    if (p.x < -0.05) { p.x = 1.05; p.y = Math.random() * 0.9; } if (p.y > 1.05) p.y = -0.05;
    ctx.save(); ctx.translate(p.x * W, p.y * H); ctx.rotate(p.rot); ctx.fillStyle = `hsla(${(pal.h + 345) % 360},90%,62%,0.65)`;
    ctx.beginPath(); ctx.ellipse(0, 0, H * 0.012 * p.s, H * 0.006 * p.s, 0, 0, 2 * PI); ctx.fill(); ctx.restore();
  }
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.95); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
}

// ---------- type ----------
const FAM = {
  hero: 'Anton, Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif',
  script: 'Pacifico, "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive',
  sans: 'Poppins, "Segoe UI", system-ui, Arial, sans-serif'
};
export function styleOf(i, text) {
  const words = text.trim().split(/\s+/).length, chars = text.trim().length;
  if (words <= 3 && chars <= 20) return 'hero';
  if (words <= 7 && chars <= 40) return words >= 4 && hash(i) % 2 ? 'stack' : 'script';
  return 'classic';
}

function layClassic(ctx, text, W, H, y0, scale = 1) {
  const S = clamp(H * 0.085, 18, 58) * scale; ctx.font = `800 ${S}px ${FAM.sans}`;
  const words = text.trim().split(/\s+/), sp = ctx.measureText(' ').width, maxW = W * 0.84, x0 = W * 0.07;
  const out = []; let x = x0, y = y0;
  for (const w of words) {
    const ww = ctx.measureText(w).width;
    if (x > x0 && x + ww > x0 + maxW) { x = x0; y += S * 1.28; }
    out.push({ t: w, cx: x + ww / 2, cy: y, size: S, font: ctx.font }); x += ww + sp;
  }
  return { words: out, tilt: -0.04, ox: x0, oy: y0, bottom: y + S };
}
function rowsFit(ctx, words, fontOf, maxW, maxS) {              // biggest size at which the words fit in rows of maxW
  const wid = (ws, S) => { ctx.font = fontOf(S); return ctx.measureText(ws.join(' ')).width; };
  let S = maxS; const w0 = wid(words, S); S = Math.min(maxS, S * maxW / Math.max(1, w0));
  if (S >= maxS * 0.5 || words.length < 2) return { rows: [words], S };
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i), b = words.slice(i), m = Math.max(wid(a, maxS), wid(b, maxS));
    if (!best || m < best.m) best = { a, b, m };
  }
  return { rows: [best.a, best.b], S: Math.min(maxS * 0.85, maxS * maxW / best.m) };
}
function layCentered(ctx, text, W, H, kind) {
  const hero = kind === 'hero', t = hero ? text.toUpperCase() : text, words = t.trim().split(/\s+/);
  const fontOf = S => hero ? `${S}px ${FAM.hero}` : `italic ${S}px ${FAM.script}`;
  const { rows, S } = rowsFit(ctx, words, fontOf, W * (hero ? 0.9 : 0.84), H * (hero ? 0.4 : 0.2));
  ctx.font = fontOf(S); const sp = ctx.measureText(' ').width, lh = S * (hero ? 1.02 : 1.3), out = [];
  const top = H * 0.5 - ((rows.length - 1) * lh) / 2;
  rows.forEach((row, ri) => {
    const ws = row.map(w => ctx.measureText(w).width), total = ws.reduce((a, b) => a + b, 0) + sp * (row.length - 1);
    let x = W / 2 - total / 2;
    row.forEach((w, i) => { out.push({ t: w, cx: x + ws[i] / 2, cy: top + ri * lh, size: S, font: ctx.font }); x += ws[i] + sp; });
  });
  return { words: out, tilt: hero ? 0 : -0.06, ox: W / 2, oy: H / 2, bottom: top + rows.length * lh };
}
function layStack(ctx, text, W, H) {                             // small word / BIG PHRASE / small words
  const ws = text.trim().split(/\s+/), nLead = ws.length >= 6 ? 2 : 1, nTail = ws.length >= 6 ? 2 : 1;
  const lead = ws.slice(0, nLead), mid = ws.slice(nLead, ws.length - nTail), tail = ws.slice(ws.length - nTail);
  const small = clamp(H * 0.07, 14, 40), out = [];
  const place = (words, font, cy, size, upper) => {
    ctx.font = font; const sp = ctx.measureText(' ').width, ww = words.map(w => ctx.measureText(upper ? w.toUpperCase() : w).width), total = ww.reduce((a, b) => a + b, 0) + sp * (words.length - 1);
    let x = W / 2 - total / 2; words.forEach((w, i) => { out.push({ t: upper ? w.toUpperCase() : w, cx: x + ww[i] / 2, cy, size, font }); x += ww[i] + sp; });
  };
  const fit = rowsFit(ctx, mid.map(w => w.toUpperCase()), S => `${S}px ${FAM.hero}`, W * 0.84, H * 0.3);
  place(lead, `700 ${small}px ${FAM.sans}`, H * 0.3, small, false);
  const bigS = fit.S; fit.rows.forEach((row, ri) => place(row, `${bigS}px ${FAM.hero}`, H * 0.5 + (ri - (fit.rows.length - 1) / 2) * bigS * 1.02, bigS, false));
  place(tail, `700 ${small}px ${FAM.sans}`, H * 0.72, small, false);
  return { words: out, tilt: 0, ox: W / 2, oy: H / 2, bottom: H * 0.75 };
}
const layout = (ctx, text, W, H, style) => style === 'hero' || style === 'script' ? layCentered(ctx, text, W, H, style) : style === 'stack' ? layStack(ctx, text, W, H) : layClassic(ctx, text, W, H, H * 0.3);

// one line, ready to animate
function makeLine(ctx, i, text, t0, t1, W, H, now) {
  const style = styleOf(i, text), lay = layout(ctx, text, W, H, style);
  const tot = lay.words.reduce((a, w) => a + w.t.length + 1, 0); let c = 0;
  lay.words.forEach(w => { w.a = c / tot; c += w.t.length + 1; w.b = c / tot; });
  return { i, text, style, lay, t0, t1, born: now, died: 0 };
}

function star(ctx, x, y, s, a) {
  ctx.save(); ctx.translate(x, y); ctx.globalAlpha = a; ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.moveTo(0, -s); ctx.quadraticCurveTo(s * 0.12, -s * 0.12, s, 0); ctx.quadraticCurveTo(s * 0.12, s * 0.12, 0, s);
  ctx.quadraticCurveTo(-s * 0.12, s * 0.12, -s, 0); ctx.quadraticCurveTo(-s * 0.12, -s * 0.12, 0, -s); ctx.fill(); ctx.restore();
}

// draws a line. out = it is leaving on the wind. returns the active word (for sparkles)
function drawLine(ctx, ln, st, out) {
  const { lay } = ln, timed = ln.t0 != null, age = st.now - (out ? ln.died : ln.born);
  const p = out ? 1 : timed ? clamp((st.songMs - ln.t0) / Math.max(600, ln.t1 - ln.t0)) : -1;
  let active = null;
  ctx.save(); ctx.translate(lay.ox, lay.oy); ctx.rotate(lay.tilt); ctx.translate(-lay.ox, -lay.oy);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  lay.words.forEach((w, i) => {
    let x = w.cx, y = w.cy, rot = 0, sc = 1, a = 1, glow = 0.22, fill = '#ffffff', ghosts = 0;
    const S = w.size;
    if (out) {                                                      // carried off on the wind
      const u = clamp((age - i * 45) / 480); if (u >= 1) return;
      x -= u * S * 1.6; y -= u * S * 0.5; rot = -u * 0.25; a = 1 - u; sc = 1 - 0.15 * u; ghosts = 3;
    } else {
      const u = clamp((age - i * 75) / 560), e = easeOutBack(u);     // blown in from the right, lands with a little bounce
      x += (1 - e) * S * 1.1; y += (1 - e) * S * 0.6; rot = (1 - e) * 0.2; sc = 0.85 + 0.15 * e; a = clamp(u * 1.8);
      if (timed) {
        if (p >= w.b) { /* sung: stays bright */ }
        else if (p >= w.a) { const h = Math.sin(PI * (p - w.a) / (w.b - w.a)); y -= 0.22 * S * h; sc *= 1 + 0.16 * h; rot += 0.05 * Math.sin(st.now * 0.02) * h; glow = 0.55 + 0.45 * h; active = { x, y, S, i, word: w }; }
        else { fill = 'rgba(255,255,255,0.46)'; glow = 0; }
      }
    }
    y += S * 0.03 * Math.sin(st.now * 0.003 + i * 0.8); rot += 0.012 * Math.sin(st.now * 0.0023 + i);   // wind: a slow ripple along the words
    for (let g = ghosts; g >= 0; g--) {
      ctx.save(); ctx.translate(x + g * S * 0.14, y + g * S * 0.04); ctx.rotate(rot); ctx.scale(sc, sc); ctx.globalAlpha = a * (g ? 0.2 / g : 1);
      ctx.font = w.font;
      if (g === 0 && glow > 0) { ctx.shadowColor = st.pal.glow; ctx.shadowBlur = S * 0.5 * glow; }
      ctx.fillStyle = fill; ctx.fillText(w.t, 0, 0); ctx.restore();
    }
  });
  ctx.restore();
  return active && { ...active, tilt: lay.tilt, ox: lay.ox, oy: lay.oy };
}

// the upcoming line, small and softly blurred underneath (one line, trimmed to fit)
function drawNext(ctx, text, W, H) {
  const S = clamp(H * 0.05, 12, 30); ctx.font = `800 ${S}px ${FAM.sans}`;
  let t = text.trim(); const maxW = W * 0.84;
  while (t.length > 4 && ctx.measureText(t).width > maxW) t = t.slice(0, -2);
  if (t.length < text.trim().length) t = t.trimEnd() + '…';
  const x = W * 0.07, y = H * 0.9, w = ctx.measureText(t).width;
  ctx.save(); ctx.translate(x, y); ctx.rotate(-0.025); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [0, 0]]) { ctx.fillStyle = 'rgba(255,255,255,0.13)'; ctx.fillText(t, dx, dy); }
  ctx.restore(); return w;
}

function drawGust(ctx, W, H, st) {                                // long thin streaks swoop across when a line changes
  const age = st.now - st.gustAt; if (!(age >= 0 && age < 900)) return;
  const k = age / 900; ctx.save(); ctx.lineCap = 'round';
  for (let j = 0; j < 6; j++) {
    const y = H * (0.28 + j * 0.09 + 0.02 * Math.sin(j * 5.1)), x0 = W * (1.05 - k * 1.5 - j * 0.04), len = W * (0.18 + 0.05 * j);
    ctx.strokeStyle = `rgba(255,255,255,${(1 - k) * 0.28})`; ctx.lineWidth = 1 + (j % 3);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.bezierCurveTo(x0 + len * 0.3, y - H * 0.02, x0 + len * 0.6, y + H * 0.02, x0 + len, y); ctx.stroke();
  }
  ctx.restore();
}

export function createStage(canvas, api) {
  const ctx = canvas.getContext('2d');
  let track = null, lyr = null, cover = null, pal = makePalette(330, 0.7), bg = null, bgKey = '', parts = null;
  let cur = null, out = null, lineKeyS = '', gustAt = -1e9, last = 0, running = false, fonts = 0;
  const sparkles = [];

  function resetLines() { cur = out = null; lineKeyS = ''; }
  function line(t) {                                              // { i, text, t0, t1 } for this moment
    const L = lyr?.lines;
    if (!track) return { i: -1, text: 'NO SONG', t0: null };
    const fb = { i: -2, text: track.title, t0: null };
    if (!L?.length || t < 0) return fb;
    if (lyr.synced) { let lo = 0, hi = L.length - 1, i = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (L[m].t <= t) { i = m; lo = m + 1; } else hi = m - 1; } if (i < 0) return fb; return { i, text: L[i].text || '♪', t0: L[i].t, t1: L[i + 1] ? L[i + 1].t : L[i].t + 4000 }; }
    const d = (track.dur * 1000) || 1, i = Math.min(L.length - 1, Math.floor((t / d) * L.length));
    return { i, text: L[i].text, t0: (i / L.length) * d, t1: ((i + 1) / L.length) * d };
  }
  const nextText = i => (lyr?.lines?.[i + 1]?.text) || '';

  function drawFrame(now) {
    const W = canvas.width, H = canvas.height; if (!W || !H) return;
    const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
    const key = W + 'x' + H + '|' + pal.h + '|' + (track?.tid || '');
    if (key !== bgKey) { bgKey = key; bg = buildBg(W, H, pal, hash(track?.tid || 'x')); parts = makeParticles(W, H, hash(track?.tid || 'x')); }
    const st = { now, dt, pal, bg, parts, gustAt, songMs: api.time() };
    drawBackground(ctx, W, H, now, dt, st);

    const L = line(st.songMs), k = L.i + '|' + L.text + '|' + W + 'x' + H + '|' + fonts;
    if (k !== lineKeyS) {
      const same = lineKeyS.split('|').slice(2).join('|') === k.split('|').slice(2).join('|');
      if (cur && same) { cur.died = now; out = cur; } else out = null;
      lineKeyS = k; gustAt = now; st.gustAt = now;
      cur = makeLine(ctx, L.i, L.text, L.t0, L.t1, W, H, now);
    }
    if (out && now - out.died > 480 + out.lay.words.length * 45 + 60) out = null;
    if (L.i >= 0 && nextText(L.i)) drawNext(ctx, nextText(L.i), W, H);
    drawGust(ctx, W, H, st);
    if (out) drawLine(ctx, out, st, true);
    const act = cur && drawLine(ctx, cur, st, false);
    if (act && (!sparkles.length || sparkles[sparkles.length - 1].i !== act.i || sparkles[sparkles.length - 1].line !== cur)) sparkles.push({ i: act.i, line: cur, born: now });
    while (sparkles.length > 6) sparkles.shift();
    for (const s of sparkles) {                                   // twinkles over the word being sung
      const a = clamp(1 - (now - s.born) / 900); if (a <= 0 || !act || act.i !== s.i || s.line !== cur) continue;
      ctx.save(); ctx.translate(act.ox, act.oy); ctx.rotate(act.tilt); ctx.translate(-act.ox, -act.oy);
      star(ctx, act.x + act.S * 0.35, act.y - act.S * 0.62, act.S * 0.16, 0.5 + 0.5 * Math.sin(now * 0.02) * a); star(ctx, act.x - act.S * 0.3, act.y - act.S * 0.74, act.S * 0.09, a * 0.8);
      ctx.restore();
    }
    if (track) {                                                  // who is singing, top left
      const m = H * 0.045; ctx.save();
      if (cover) { ctx.save(); ctx.beginPath(); ctx.arc(m + H * 0.035, m + H * 0.035, H * 0.035, 0, 2 * PI); ctx.clip(); ctx.drawImage(cover, m, m, H * 0.07, H * 0.07); ctx.restore(); }
      const tx = m + (cover ? H * 0.09 : 0); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.font = `700 ${Math.max(11, H * 0.038)}px ${FAM.sans}`; ctx.fillText(track.title.slice(0, 34), tx, m + H * 0.032);
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = `600 ${Math.max(10, H * 0.03)}px ${FAM.sans}`; ctx.fillText((track.artist || '').slice(0, 40), tx, m + H * 0.068);
      ctx.restore();
    }
  }
  function frame(now) { if (!running) return; requestAnimationFrame(frame); drawFrame(now); }

  function fit() {
    const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
    const d = Math.min(1.5, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) { canvas.width = Math.round(w * d); canvas.height = Math.round(h * d); resetLines(); }
  }
  if (typeof window !== 'undefined') { if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas); addEventListener('resize', fit); }
  const loadFonts = () => Promise.all(['64px Anton', 'italic 64px Pacifico', '800 40px Poppins'].map(f => document.fonts?.load(f).catch(() => {}))).then(() => { fonts++; });

  return {
    fit, drawFrame,
    start() { if (!running) { running = true; last = 0; fit(); loadFonts(); requestAnimationFrame(frame); } },
    stop() { running = false; },
    setTrack(t) { track = t || null; cover = null; lyr = null; pal = makePalette(hash(t?.tid || 'x') % 360, 0.72); bgKey = ''; resetLines(); },
    setLyrics(l) { lyr = l || null; resetLines(); },
    setCover(c) {                                                 // the album cover: its colours become the background
      cover = c || null; if (!c) return;
      try { const s = mkc(32, 32), x = s.getContext('2d'); x.drawImage(c, 0, 0, 32, 32); pal = paletteFrom(x.getImageData(0, 0, 32, 32).data, track?.tid); bgKey = ''; } catch {}
    }
  };
}
