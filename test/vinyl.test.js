// Tests for the record renderer and the lyric ring: colours follow the disc theme, the pixel disc
// still draws, and the karaoke word timing is stable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPixels, parseLrc, lineIndex, buildLine, blockable, layoutBlocks,
  hexToRgb, shade, mixRgb, setRingColors, windPhase, DEFAULT_DISC, SHAPES
} from '../public/vinyl.js';
import { buildThemes } from '../public/theme.js';

const fakeCtx = { font: '', measureText: s => ({ width: [...s].length * 9 }) };

test('the pixel disc fills every pixel, in the theme colours', () => {
  const px = new Uint8ClampedArray(80 * 80 * 4);
  renderPixels(px, 0.7, 'pixel', DEFAULT_DISC);
  let opaque = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] === 255) opaque++;
  assert.equal(opaque, 6400, 'all pixels written');

  // the rim pixel must take the rim colour family, not black
  const rim = new Uint8ClampedArray(80 * 80 * 4);
  const theme = { ...DEFAULT_DISC, rim: '#ff0000', bg: '#000000' };
  renderPixels(rim, 0, 'pixel', theme);
  let foundRed = false;
  for (let i = 0; i < rim.length; i += 4) if (rim[i] > 200 && rim[i + 1] < 40 && rim[i + 2] < 40) foundRed = true;
  assert.ok(foundRed, 'the outer rim uses the theme rim colour');
});

test('renderPixels is deterministic for the same rotation', () => {
  const a = new Uint8ClampedArray(80 * 80 * 4), b = new Uint8ClampedArray(80 * 80 * 4);
  renderPixels(a, 1.234, 'hexagon', DEFAULT_DISC);
  renderPixels(b, 1.234, 'hexagon', DEFAULT_DISC);
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('a different disc theme gives a different disc', () => {
  const a = new Uint8ClampedArray(80 * 80 * 4), b = new Uint8ClampedArray(80 * 80 * 4);
  const t1 = buildThemes({ app: '#f5f0e8', lyrics: '#c96e50', disc: '#3f6fd8' }).disc;
  const t2 = buildThemes({ app: '#f5f0e8', lyrics: '#c96e50', disc: '#c0405a' }).disc;
  renderPixels(a, 0, 'pixel', t1);
  renderPixels(b, 0, 'pixel', t2);
  assert.notDeepEqual(Array.from(a), Array.from(b), 'changing the disc colour changes the record');
});

test('every shape renders without error', () => {
  for (const s of SHAPES) {
    const px = new Uint8ClampedArray(80 * 80 * 4);
    assert.doesNotThrow(() => renderPixels(px, 0.3, s.id, DEFAULT_DISC), `shape ${s.id}`);
  }
});

test('colour helpers behave', () => {
  assert.deepEqual(hexToRgb('#ff8800'), [255, 136, 0]);
  assert.deepEqual(hexToRgb('#f80'), [255, 136, 0], '3-digit shorthand expands');
  assert.deepEqual(hexToRgb('zzzzzz'), [0, 0, 0], 'invalid hex falls back to black');
  assert.deepEqual(shade('#808080', 0.5), [64, 64, 64]);
  assert.deepEqual(mixRgb([0, 0, 0], [100, 100, 100], 0.5), [50, 50, 50]);
});

test('LRC parsing keeps order and handles multiple stamps', () => {
  const l = parseLrc('[00:20.00][00:22.00]Repeat\n[00:10.00]First');
  assert.equal(l.synced, true);
  assert.equal(l.lines.length, 3);
  assert.deepEqual(l.lines.map(x => x.t), [10000, 20000, 22000], 'synced lines are sorted by time');

  const plain = parseLrc('just words\nmore words');
  assert.equal(plain.synced, false);
  assert.equal(plain.lines.length, 2);
  assert.equal(parseLrc(''), null);
});

test('lineIndex finds the line being sung, including before the first', () => {
  const l = parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c');
  assert.equal(lineIndex(l, 5000), -1, 'before the first line');
  assert.equal(lineIndex(l, 10000), 0, 'exactly on the first');
  assert.equal(lineIndex(l, 15000), 0, 'between first and second');
  assert.equal(lineIndex(l, 25000), 1);
  assert.equal(lineIndex(l, 99999), 2, 'after the last');
  assert.equal(lineIndex(null, 1000), -1);
});

test('buildLine assigns increasing word windows that cover 0..1', () => {
  const ln = buildLine(fakeCtx, 'Hello bright world', 30, 1000, 2000, 0);
  assert.ok(ln.letters.length > 0);
  assert.equal(ln.words[0].a, 0);
  assert.ok(Math.abs(ln.words[ln.words.length - 1].b - 1) < 1e-9);
  for (let i = 1; i < ln.words.length; i++) assert.ok(ln.words[i].a >= ln.words[i - 1].b - 1e-9, 'windows are ordered');
});

test('a seek straight into the middle of a song picks the right word window', () => {
  const ln = buildLine(fakeCtx, 'one two three four', 30, 1000, 5000, 0);
  const at = ms => {
    const p = Math.min(1, Math.max(0, (ms - ln.t0) / (ln.t1 - ln.t0)));
    return ln.words.findIndex(w => p >= w.a && p < w.b);
  };
  assert.ok(at(1100) <= at(3000), 'later time never picks an earlier word');
  assert.ok(at(3000) <= at(4900));
});

test('blockable() decides pixel font vs smooth font', () => {
  assert.equal(blockable('Hello World'), true);
  assert.equal(blockable('हिन्दी'), false, 'Devanagari cannot be drawn with the pixel font');
  assert.equal(blockable(''), false);
});

test('layoutBlocks never returns an empty layout', () => {
  for (const t of ['A', 'Hello', 'a very long lyric line that must wrap or shrink', '1234567890']) {
    const rows = layoutBlocks(t, 30);
    assert.ok(rows.length >= 1 && rows[0].t.length > 0, t);
    assert.ok(rows[0].p > 0);
  }
});

test('setRingColors swaps the palette used for the words on the record', () => {
  setRingColors([['rgba(0,0,0,0.9)', '#111111'], ['rgba(0,0,0,0.9)', '#222222'], ['rgba(0,0,0,0.9)', '#333333']]);
  // no throw, and a line can still be built and drawn later
  const ln = buildLine(fakeCtx, 'test', 30, 0, 1000, 0);
  assert.ok(ln.letters.length > 0);
  setRingColors([['rgba(2,10,22,0.96)', '#8ffcff'], ['rgba(2,10,22,0.96)', '#ffffff'], ['rgba(2,10,22,0.8)', '#4c9db0']]);
});

// The idle wind ripple must freeze on pause, or the record keeps twitching under a paused song.
test('the wind phase is frozen while paused, so the disc really stops', () => {
  assert.equal(windPhase(false, 5000, null), 5000, 'playing: the wind follows the clock');
  assert.equal(windPhase(false, 5000, 1234), 5000, 'playing: a stale pause stamp is ignored');
  assert.equal(windPhase(true, 9999, 4000), 4000, 'paused: the wind holds the moment it stopped');
  assert.equal(windPhase(true, 9999, null), 9999, 'paused with no stamp yet: hold the current time');
  assert.equal(windPhase(true, 9999, 4000), windPhase(true, 12000, 4000), 'paused: the value no longer changes');
});
