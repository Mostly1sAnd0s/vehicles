// Pure-logic tests for vehicle body-color helpers (public/app/color.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_PALETTE,
  hexToRgba,
  lightenHex,
  colorPaletteHtml,
} from '../public/app/color.js';

// ---------------- hexToRgba ----------------

test('hexToRgba converts a 6-digit hex to rgba with the given alpha', () => {
  assert.equal(hexToRgba('#ff0000', 0.5), 'rgba(255,0,0,0.5)');
  assert.equal(hexToRgba('#4da3ff', 0.5), 'rgba(77,163,255,0.5)');
});

test('hexToRgba expands 3-digit shorthand hex', () => {
  assert.equal(hexToRgba('#f00', 1), 'rgba(255,0,0,1)');
});

test('hexToRgba falls back to the default blue on bad input', () => {
  assert.equal(hexToRgba(null, 0.5), 'rgba(77,163,255,0.5)');
  assert.equal(hexToRgba('#zzzzzz', 0.5), 'rgba(77,163,255,0.5)');
});

// ---------------- lightenHex ----------------

test('lightenHex lightens toward white by the given fraction', () => {
  assert.equal(lightenHex('#000000', 0.5), '#808080'); // mid grey
  assert.equal(lightenHex('#0000ff', 1), '#ffffff'); // full -> white
  assert.equal(lightenHex('#ffffff', 0.5), '#ffffff'); // already white stays white
});

test('lightenHex leaves the color unchanged at amount 0 and always returns a 6-digit hex', () => {
  assert.equal(lightenHex('#ff0000', 0), '#ff0000');
  const out = lightenHex('#4da3ff', 0.35);
  assert.match(out, /^#[0-9a-f]{6}$/);
});

test('lightenHex raises the value of each channel (never darkens)', () => {
  const src = '#4da3ff';
  const dst = lightenHex(src, 0.35);
  const ch = h => {
    let s = h.replace('#', '');
    if (s.length === 3) s = s.split('').map(c => c + c).join('');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  };
  const [sr, sg, sb] = ch(src);
  const [dr, dg, db] = ch(dst);
  assert.ok(dr >= sr && dg >= sg && db >= sb);
});

// ---------------- COLOR_PALETTE ----------------

test('COLOR_PALETTE is a 4x4 grid (16 distinct colors)', () => {
  assert.equal(COLOR_PALETTE.length, 16);
  assert.equal(new Set(COLOR_PALETTE).size, 16, 'all swatches must be unique');
  for (const c of COLOR_PALETTE) assert.match(c, /^#[0-9a-f]{6}$/i);
});

test('COLOR_PALETTE contains no black and no white', () => {
  for (const c of COLOR_PALETTE) {
    assert.notEqual(c.toLowerCase(), '#000000', 'no pure black');
    assert.notEqual(c.toLowerCase(), '#ffffff', 'no pure white');
  }
});

// ---------------- colorPaletteHtml ----------------

test('colorPaletteHtml renders one swatch per palette color (no native color input)', () => {
  const html = colorPaletteHtml('#fa5252');
  assert.equal((html.match(/class="swatch/g) || []).length, 16);
  assert.ok(!html.includes('type="color"'), 'must not use the native <input type="color">');
});

test('colorPaletteHtml marks the active color and carries each hex on data-color', () => {
  const html = colorPaletteHtml('#fa5252');
  assert.ok(html.includes('class="swatch active"'));
  assert.ok(html.includes('data-color="#fa5252"'));
});
