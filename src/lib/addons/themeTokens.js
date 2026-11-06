// Applies an app-theme add-on's color tokens to the document. CodeMirror-free on purpose so the
// AddonRuntime can theme the app immediately without loading the editor chunk.
//
// Only the fixed TOKEN_VARS map is ever written, and only validated `#rrggbb` values, via
// `document.documentElement.style.setProperty`. No item-provided CSS text reaches the page.
import { HEX_RE, TOKEN_VARS } from './registry.js';

let applied = new Set(); // CSS vars currently overridden by a theme

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Apply `tokens` ({bg0..danger: '#rrggbb'}) or, with null, restore the stylesheet defaults. */
export function applyThemeTokens(tokens) {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  const next = new Set();
  if (tokens && typeof tokens === 'object') {
    for (const [key, cssVar] of Object.entries(TOKEN_VARS)) {
      const v = tokens[key];
      if (typeof v === 'string' && HEX_RE.test(v)) {
        style.setProperty(cssVar, v);
        next.add(cssVar);
      }
    }
    // --accent-soft is derived (not item-provided) so focus rings/selection match a themed accent.
    if (typeof tokens.accent === 'string' && HEX_RE.test(tokens.accent)) {
      const [r, g, b] = hexToRgb(tokens.accent);
      style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);
      next.add('--accent-soft');
    }
  }
  for (const cssVar of applied) if (!next.has(cssVar)) style.removeProperty(cssVar);
  applied = next;
  if (next.size) document.documentElement.setAttribute('data-addon-theme', '');
  else document.documentElement.removeAttribute('data-addon-theme');
}
