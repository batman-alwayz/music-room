// Independent colour system. Three separate themes — app, lyrics, disc — each derived from one
// user-chosen colour, so changing one never touches the others. Pure functions: no DOM, no globals,
// so they can be unit-tested under Node.

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));

export const DESIGN_DEFAULTS = { app: '#f5f0e8', appAccent: '#c96e50', lyrics: '#c96e50', disc: '#c96e50' };

// Curated presets: attractive out of the box, one tap each.
export const PRESETS = {
  app: [
    { name: 'Linen', bg: '#f5f0e8', accent: '#c96e50' },
    { name: 'Paper', bg: '#f7f7f5', accent: '#3f5efb' },
    { name: 'Sand', bg: '#efe6d8', accent: '#b07d3a' },
    { name: 'Mist', bg: '#eef1f4', accent: '#3d6f8f' },
    { name: 'Midnight', bg: '#0e1016', accent: '#7cc6ff' },
    { name: 'Ink', bg: '#141118', accent: '#c084fc' },
    { name: 'Moss', bg: '#101512', accent: '#6ee7a8' },
    { name: 'Ember', bg: '#16100e', accent: '#ff8a5c' }
  ],
  lyrics: [
    { name: 'Terracotta', color: '#c96e50' },
    { name: 'Mint', color: '#4fd1a5' },
    { name: 'Sky', color: '#5aa9f0' },
    { name: 'Gold', color: '#e0b24d' },
    { name: 'Rose', color: '#ef7d9c' },
    { name: 'Violet', color: '#a78bfa' }
  ],
  disc: [
    { name: 'Classic', color: '#7f8896' },
    { name: 'Terracotta', color: '#c96e50' },
    { name: 'Cobalt', color: '#3f6fd8' },
    { name: 'Amber', color: '#d99a3c' },
    { name: 'Ruby', color: '#c0405a' },
    { name: 'Jade', color: '#3fae86' }
  ]
};

// ---------- colour maths ----------
export function hexToRgb(hex) {
  let s = String(hex || '').trim().replace('#', '');
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) s = '000000';
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgbToHex({ r, g, b }) {
  const h = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
export function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return rgbToHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}
export function rgbToHsl({ r, g, b }) {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn, l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h = ((h * 60) % 360 + 360) % 360;
  }
  return { h, s, l };
}
export function hslToHex({ h, s, l }) {
  h = ((h % 360) + 360) % 360; s = clamp(s); l = clamp(l);
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
  return rgbToHex({ r: (seg[0] + m) * 255, g: (seg[1] + m) * 255, b: (seg[2] + m) * 255 });
}
const chan = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * chan(r / 255) + 0.7152 * chan(g / 255) + 0.0722 * chan(b / 255);
}
export function contrast(a, b) {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
export const isDark = hex => luminance(hex) < 0.42;

// Nudge `fg` toward black or white until it reads clearly on `bg`. Keeps the hue.
export function readable(fg, bg, min = 4.5) {
  if (contrast(fg, bg) >= min) return fg;
  const hsl = rgbToHsl(hexToRgb(fg));
  const toLight = luminance(bg) < 0.5;                    // dark background -> go lighter
  for (let i = 1; i <= 40; i++) {
    const l = clamp(toLight ? hsl.l + i * 0.02 : hsl.l - i * 0.02);
    const c = hslToHex({ ...hsl, l });
    if (contrast(c, bg) >= min) return c;
    if (l === 0 || l === 1) return c;
  }
  return toLight ? '#ffffff' : '#000000';
}

// Accent for a background that has no explicit one: same hue, more life, tuned lightness.
export function deriveAccent(base) {
  const { h, s } = rgbToHsl(hexToRgb(base));
  return hslToHex({ h: h + 12, s: clamp(Math.max(s, 0.46), 0, 0.72), l: isDark(base) ? 0.66 : 0.42 });
}

// The accent block plus the ink that reads on it. We keep the user's hue and move only lightness,
// preferring white ink (the richer, more cinematic look) and falling back to dark ink when the
// accent is already bright. Whichever option ends up closer to the colour the user chose wins.
export function accentPair(accent, min = 4.5) {
  const hsl = rgbToHsl(hexToRgb(accent));
  const fit = (ink, light) => {
    if (contrast(ink, accent) >= min) return accent;
    for (let i = 1; i <= 40; i++) {
      const l = clamp(light ? hsl.l + i * 0.02 : hsl.l - i * 0.02);
      const c = hslToHex({ ...hsl, l });
      if (contrast(ink, c) >= min) return c;
      if (l === 0 || l === 1) break;
    }
    return null;
  };
  const white = fit('#ffffff', false);                       // white ink -> darken the block
  const dark = fit('#0b0b0c', true);                         // dark ink -> lighten the block
  const cands = [];
  if (white) cands.push({ accent: white, ink: '#ffffff' });
  if (dark) cands.push({ accent: dark, ink: '#0b0b0c' });
  if (!cands.length) return { accent, ink: contrast('#ffffff', accent) >= contrast('#0b0b0c', accent) ? '#ffffff' : '#0b0b0c' };
  const dL = c => Math.abs(rgbToHsl(hexToRgb(c.accent)).l - hsl.l);
  cands.sort((a, b) => (a.ink === '#ffffff' ? 0 : 0.001) - (b.ink === '#ffffff' ? 0 : 0.001) || dL(a) - dL(b));
  return cands[0];
}

// ---------- the three themes ----------
export function buildAppTheme(bg, accentIn) {
  const base = /^#[0-9a-f]{6}$/i.test(String(bg)) ? bg : DESIGN_DEFAULTS.app;
  const dark = isDark(base);
  const panel = dark ? mix(base, '#ffffff', 0.07) : mix(base, '#ffffff', 0.72);
  const soft = dark ? mix(base, '#ffffff', 0.13) : mix(base, '#ffffff', 0.45);
  const ink = dark ? mix(base, '#ffffff', 0.92) : mix(base, '#000000', 0.86);
  // muted text sits on both the panel and the raw background, so it must clear AA against the
  // harder of the two surfaces, not just the panel
  const muted = [panel, base].reduce((c, s) => readable(c, s, 4.5), mix(panel, ink, 0.52));
  const line = mix(base, ink, dark ? 0.18 : 0.12);
  const raw = /^#[0-9a-f]{6}$/i.test(String(accentIn)) ? accentIn : deriveAccent(base);
  const { accent, ink: accentInk } = accentPair(raw, 4.5);
  return { base, dark, panel, soft, ink, muted, line, accent, accentInk, shadow: dark ? '#000000' : '#34291b' };
}

// The lyrics theme owns both its text colours and the surface they sit on, so it depends on the
// chosen lyric colour alone: re-colouring the app never restyles the lyrics, and vice versa. A dark
// lyric colour lands on a light card and a light one on a dark card, which keeps the text readable
// without borrowing anything from the app theme.
export function buildLyricsTheme(color) {
  const pick = /^#[0-9a-f]{6}$/i.test(String(color)) ? color : DESIGN_DEFAULTS.lyrics;
  const { h, s } = rgbToHsl(hexToRgb(pick));
  const onLight = isDark(pick);
  const panel = onLight
    ? hslToHex({ h, s: clamp(s, 0, 0.22), l: 0.965 })      // light card for a darker lyric colour
    : hslToHex({ h, s: clamp(s, 0, 0.30), l: 0.085 });     // dark card for a lighter one
  const active = readable(pick, panel, 4.5);
  const idle = readable(mix(panel, onLight ? '#000000' : '#ffffff', 0.42), panel, 3.0);
  return { chosen: pick, active, idle, panel, line: mix(panel, onLight ? '#000000' : '#ffffff', 0.10), glow: active, dark: !onLight };
}

export function buildDiscTheme(color) {
  const pick = /^#[0-9a-f]{6}$/i.test(String(color)) ? color : DESIGN_DEFAULTS.disc;
  const { h, s } = rgbToHsl(hexToRgb(pick));
  const S = clamp(s, 0.12, 0.95);
  return {
    bg: hslToHex({ h, s: S * 0.35, l: 0.02 }),
    vinyl: hslToHex({ h, s: S * 0.5, l: 0.06 }),
    groove: hslToHex({ h, s: S * 0.6, l: 0.64 }),
    sheen: hslToHex({ h: h + 6, s: clamp(S + 0.25, 0, 0.95), l: 0.62 }),
    rim: hslToHex({ h, s: S * 0.85, l: 0.54 }),
    rim2: hslToHex({ h, s: S * 0.7, l: 0.26 }),
    label: hslToHex({ h, s: S * 0.7, l: 0.30 }),
    label2: hslToHex({ h, s: S * 0.7, l: 0.12 }),
    spindle: hslToHex({ h, s: S * 0.4, l: 0.5 })
  };
}

// Colours for the words that ride the record: the sung word, and the ones still to come.
// Returns the [outline, fill] pairs the vinyl renderer expects.
export function buildRingTheme(lyrics, disc) {
  const onDark = isDark(disc?.vinyl || '#0a0a0a');
  const outline = onDark ? 'rgba(2,6,16,0.94)' : 'rgba(255,255,255,0.85)';
  const sung = readable(lyrics?.chosen || lyrics?.active || '#ffffff', disc?.vinyl || '#0a0a0a', 4.5);
  const ahead = readable(mix(lyrics?.chosen || lyrics?.active || '#ffffff', disc?.vinyl || '#0a0a0a', 0.55), disc?.vinyl || '#0a0a0a', 3.0);
  return [[outline, sung], [outline, sung], [outline, ahead]];
}

// A single palette object the app hands to the disc renderer; changes when any colour changes.
export function buildThemes(design) {
  const app = buildAppTheme(design.app, design.appAccent);
  const lyrics = buildLyricsTheme(design.lyrics);
  const disc = buildDiscTheme(design.disc);
  return { app, lyrics, disc, ring: buildRingTheme(lyrics, disc) };
}
