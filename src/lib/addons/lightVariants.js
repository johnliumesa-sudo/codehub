// Derives a light variant of a dark app-theme add-on's tokens (registry TOKEN_VARS keys), so every
// shop theme keeps its hue/accent identity in light mode. Pure and deterministic; input is the
// already-validated `#rrggbb` token map, output the same shape (all values `#rrggbb`).
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round(clamp(v + m, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

// [token, target lightness] for surfaces/text; accents are only darkened to stay legible on white.
const SURFACES = { bg0: 0.9, bg1: 0.945, bg2: 0.99, bg3: 0.925, bgHover: 0.875, border: 0.82 };
const TEXTS = { text: 0.12, textDim: 0.33, textFaint: 0.48 };
const ACCENT_MAX_L = { accent: 0.4, accent2: 0.44, ok: 0.34, warn: 0.38, danger: 0.46 };

export function lightVariant(tokens) {
  if (!tokens || typeof tokens !== 'object') return tokens;
  const out = { ...tokens };
  const base = tokens.bg2 || tokens.bg1 || tokens.bg0;
  const [bh, bs] = base ? hexToHsl(base) : [220, 0.2];
  const sat = clamp(bs * 0.7, 0.1, 0.4);
  for (const [k, l] of Object.entries(SURFACES)) if (tokens[k]) out[k] = hslToHex(bh, sat, l);
  for (const [k, l] of Object.entries(TEXTS)) if (tokens[k]) out[k] = hslToHex(bh, clamp(bs * 0.5, 0.08, 0.3), l);
  for (const [k, max] of Object.entries(ACCENT_MAX_L)) {
    if (!tokens[k]) continue;
    const [h, s, l] = hexToHsl(tokens[k]);
    out[k] = l > max ? hslToHex(h, clamp(s, 0.3, 0.85), max) : tokens[k];
  }
  return out;
}
