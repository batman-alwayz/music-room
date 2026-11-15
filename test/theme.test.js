// Tests for the independent theme system: three themes derived from three separate colours,
// readable in light and dark, and genuinely independent of one another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThemes, buildAppTheme, buildLyricsTheme, buildDiscTheme, buildRingTheme,
  hexToRgb, rgbToHex, mix, rgbToHsl, hslToHex, luminance, contrast, readable, deriveAccent,
  DESIGN_DEFAULTS, PRESETS
} from '../public/theme.js';

test('colour maths round-trips', () => {
  assert.deepEqual(hexToRgb('#ff8800'), { r: 255, g: 136, b: 0 });
  assert.deepEqual(hexToRgb('#f80'), { r: 255, g: 136, b: 0 });
  assert.equal(rgbToHex({ r: 255, g: 136, b: 0 }), '#ff8800');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  const { h, s } = rgbToHsl(hexToRgb('#c96e50'));
  assert.ok(h > 10 && h < 25, `hue in range, got ${h}`);
  assert.ok(Math.abs(s - 0.53) < 0.05, `saturation, got ${s}`);
  assert.equal(hslToHex({ h: 0, s: 1, l: 0.5 }), '#ff0000');
});

test('luminance and contrast behave', () => {
  assert.equal(luminance('#000000'), 0);
  assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
  assert.ok(contrast('#000000', '#ffffff') > 20);
  assert.ok(contrast('#ffffff', '#ffffff') === 1);
});

test('readable() reaches the minimum contrast while keeping the hue', () => {
  const out = readable('#c96e50', '#f5f0e8', 4.5);
  assert.ok(contrast(out, '#f5f0e8') >= 4.4, `contrast ${contrast(out, '#f5f0e8')}`);
  // already readable -> unchanged
  assert.equal(readable('#000000', '#ffffff', 4.5), '#000000');
});

test('light and dark app themes both keep text readable', () => {
  for (const bg of ['#f5f0e8', '#0e1016', '#efe6d8', '#141118']) {
    const app = buildAppTheme(bg, undefined);
    assert.ok(contrast(app.ink, app.panel) >= 4.4, `ink on panel for ${bg}: ${contrast(app.ink, app.panel)}`);
    assert.ok(contrast(app.muted, app.panel) >= 4.5, `muted on panel for ${bg}: ${contrast(app.muted, app.panel)}`);
    assert.ok(contrast(app.accentInk, app.accent) >= 4.4, `accent ink for ${bg}: ${contrast(app.accentInk, app.accent)}`);
  }
});

test('lyrics colour is nudged until it reads on the lyrics surface', () => {
  for (const color of ['#c96e50', '#4fd1a5', '#e0b24d', '#a78bfa']) {
    const lyr = buildLyricsTheme(color);
    assert.ok(contrast(lyr.active, lyr.panel) >= 4.4, `active on ${lyr.panel}: ${contrast(lyr.active, lyr.panel)}`);
    assert.ok(contrast(lyr.idle, lyr.panel) >= 2.9, `idle on ${lyr.panel}: ${contrast(lyr.idle, lyr.panel)}`);
    assert.notEqual(lyr.active, lyr.idle);
  }
});

test('disc theme derives a coherent dark palette from one colour', () => {
  const d = buildDiscTheme('#3f6fd8');
  assert.ok(luminance(d.vinyl) < 0.12, 'vinyl is dark');
  assert.ok(luminance(d.bg) < 0.05, 'background is nearly black');
  assert.ok(contrast(d.rim, d.vinyl) > 2, 'rim stands out from the vinyl');
});

test('the three themes are independent', () => {
  const base = buildThemes({ app: '#f5f0e8', appAccent: '#c96e50', lyrics: '#c96e50', disc: '#3f6fd8' });

  // lyrics colour -> app theme untouched
  const newLyrics = buildThemes({ app: '#f5f0e8', appAccent: '#c96e50', lyrics: '#00c853', disc: '#3f6fd8' });
  assert.deepEqual(newLyrics.app, base.app, 'app theme unchanged when lyrics colour changes');
  assert.notDeepEqual(newLyrics.lyrics, base.lyrics, 'lyrics theme did change');

  // disc colour -> app and lyrics untouched
  const newDisc = buildThemes({ app: '#f5f0e8', appAccent: '#c96e50', lyrics: '#c96e50', disc: '#ff00aa' });
  assert.deepEqual(newDisc.app, base.app, 'app theme unchanged when disc colour changes');
  assert.deepEqual(newDisc.lyrics, base.lyrics, 'lyrics theme unchanged when disc colour changes');
  assert.notDeepEqual(newDisc.disc, base.disc, 'disc theme did change');

  // app colour -> disc untouched, lyrics keep the chosen colour
  const newApp = buildThemes({ app: '#efe6d8', appAccent: '#b07d3a', lyrics: '#c96e50', disc: '#3f6fd8' });
  assert.deepEqual(newApp.disc, base.disc, 'disc unchanged when app colour changes');
  assert.equal(newApp.lyrics.chosen, base.lyrics.chosen, 'lyric colour choice is kept');
});

test('the lyrics surface follows the lyric colour, never the app theme', () => {
  const a = buildThemes({ app: '#f5f0e8', appAccent: '#c96e50', lyrics: '#c96e50', disc: '#3f6fd8' });
  const b = buildThemes({ app: '#0e1016', appAccent: '#7cc6ff', lyrics: '#c96e50', disc: '#3f6fd8' });
  // flipping the app from light to dark leaves the lyric colours and their surface untouched
  assert.deepEqual(b.lyrics, a.lyrics, 'app theme flip does not restyle the lyrics');
  assert.ok(contrast(a.lyrics.active, a.lyrics.panel) >= 4.4, 'readable on the lyrics surface');
  // a different lyric colour keeps its hue; only lightness moves for readability
  const c = buildThemes({ app: '#f5f0e8', appAccent: '#c96e50', lyrics: '#00c853', disc: '#3f6fd8' });
  assert.equal(c.lyrics.chosen, '#00c853');
  const hue = hex => rgbToHsl(hexToRgb(hex)).h;
  assert.ok(Math.abs(hue(c.lyrics.active) - hue('#00c853')) < 3, 'hue is preserved');
});

test('ring colours follow the lyrics and disc themes', () => {
  const lyrics = buildLyricsTheme('#e0b24d');
  const disc = buildDiscTheme('#3f6fd8');
  const ring = buildRingTheme(lyrics, disc);
  assert.equal(ring.length, 3);
  // the words sit on the record, so their readability is judged against the vinyl, not the app panel
  assert.ok(contrast(ring[1][1], disc.vinyl) >= 4.4, 'the sung word reads on the record');
  assert.notEqual(ring[2][1], ring[1][1], 'words still to come are dimmer than the sung word');
  assert.ok(contrast(ring[2][1], disc.vinyl) >= 2.9, 'upcoming words are still legible');
});

test('presets are valid hex colours with names', () => {
  for (const key of ['app', 'lyrics', 'disc']) {
    assert.ok(PRESETS[key].length >= 4, `${key} has presets`);
    for (const p of PRESETS[key]) {
      assert.ok(p.name, 'named');
      for (const k of ['bg', 'accent', 'color']) if (p[k]) assert.match(p[k], /^#[0-9a-f]{6}$/i, `${key} ${k}`);
    }
  }
});

test('bad input falls back to defaults instead of throwing', () => {
  const t = buildThemes({ app: 'not-a-colour', appAccent: 'nope', lyrics: null, disc: 42 });
  assert.equal(t.app.base, DESIGN_DEFAULTS.app);
  assert.equal(t.lyrics.active, readable(DESIGN_DEFAULTS.lyrics, t.lyrics.panel));
  assert.ok(t.disc.vinyl.startsWith('#'));
  assert.ok(deriveAccent('#f5f0e8').startsWith('#'));
});

// Every preset we ship must be readable, or a user taps a swatch and gets unreadable text.
test('every shipped preset meets WCAG AA for its text', () => {
  const bad = [];
  for (const p of PRESETS.app) {
    const t = buildThemes({ app: p.bg, appAccent: p.accent, lyrics: DESIGN_DEFAULTS.lyrics, disc: DESIGN_DEFAULTS.disc });
    const checks = [['ink on bg', t.app.ink, t.app.base], ['muted on bg', t.app.muted, t.app.base],
      ['muted on panel', t.app.muted, t.app.panel], ['accent ink on accent', t.app.accentInk, t.app.accent]];
    for (const [name, fg, bg] of checks) if (contrast(fg, bg) < 4.5) bad.push(`${p.name} ${name}: ${contrast(fg, bg).toFixed(2)}`);
  }
  for (const p of PRESETS.lyrics) {
    const t = buildThemes({ app: DESIGN_DEFAULTS.app, appAccent: DESIGN_DEFAULTS.appAccent, lyrics: p.color, disc: DESIGN_DEFAULTS.disc });
    if (contrast(t.lyrics.active, t.lyrics.panel) < 4.5) bad.push(`lyrics ${p.name}: ${contrast(t.lyrics.active, t.lyrics.panel).toFixed(2)}`);
  }
  assert.deepEqual(bad, [], 'presets below AA: ' + bad.join(', '));
});
