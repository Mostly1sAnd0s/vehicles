// Pure color helpers for vehicle body colors. No DOM here: everything is
// testable with plain `node --test`.

/** 4x4 manual color palette for the body-color picker. Deliberately no pure
 *  black (#000000) or pure white (#ffffff) — those read as "off" on the canvas. */
export const COLOR_PALETTE = [
  '#fa5252', '#fd7e14', '#fcc419', '#94d82d',
  '#40c057', '#12b886', '#15aabf', '#339af0',
  '#4c6ef5', '#7950f2', '#be4bdb', '#e64980',
  '#f783ac', '#ff8787', '#63e6be', '#91a7ff',
];

/** Default body color, used when a vehicle never picked one (also the trail
 *  fallback so a trail is always visible). */
export const DEFAULT_BODY_COLOR = '#4da3ff';

const normHex = hex => {
  let h = String(hex ?? '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(h) ? h : null;
};

const toHex2 = n => n.toString(16).padStart(2, '0');

/** '#rrggbb' -> 'rgba(r,g,b,alpha)'. Tolerates 3-digit hex; bad input falls
 *  back to the default blue. */
export function hexToRgba(hex, alpha) {
  const h = normHex(hex);
  if (!h) return `rgba(77,163,255,${alpha})`; // #4da3ff
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Lighten a hex color toward white by `amount` (0..1 fraction of the gap).
 *  0 leaves it unchanged, 1 yields pure white. Bad input returns the color back
 *  normalized; unknown values fall through to the default blue. */
export function lightenHex(hex, amount = 0.3) {
  const h = normHex(hex) ?? '4da3ff';
  const n = parseInt(h, 16);
  const t = Math.min(1, Math.max(0, amount));
  const ch = c => Math.round(c + (255 - c) * t);
  return `#${toHex2(ch((n >> 16) & 255))}${toHex2(ch((n >> 8) & 255))}${toHex2(ch(n & 255))}`;
}

/** HTML for the 4x4 body-color picker. The active color gets the `active`
 *  class so the current pick is obvious. Returns a plain string (no DOM). */
export function colorPaletteHtml(activeColor) {
  return COLOR_PALETTE.map(c => {
    const on = c === activeColor ? ' active' : '';
    return `<button type="button" class="swatch${on}" data-color="${c}" style="background:${c}" title="${c}"></button>`;
  }).join('');
}
