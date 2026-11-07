// Small, pure color helpers for data-only shop items. Inputs are validated `#rrggbb` strings; outputs are
// `#rrggbb` or `rgba(r, g, b, a)` strings built from numbers, never from item-provided text.
const HEX = /^#[0-9a-fA-F]{6}$/; // same as registry.HEX_RE (kept local: registry.js imports this module)

export const isHex = (v) => typeof v === 'string' && HEX.test(v);

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

export function rgbToHex([r, g, b]) {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Linear blend of two hex colors: t = 0 -> a, t = 1 -> b. */
export function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
}

/** `rgba(...)` of a hex color with alpha 0..1. */
export function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 100) / 100;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(hex) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const isDark = (hex) => luminance(hex) < 0.2;
