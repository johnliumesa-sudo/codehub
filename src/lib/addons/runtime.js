// Add-on runtime: turns what a user has equipped into effects.
//  - applyThemeTokens(tokens|null): app theme via the fixed token -> CSS var map (see themeTokens.js).
//  - editorAddonExtensions(equipped, catalog): CodeMirror extensions for the collab editor.
// Unknown builtinIds, wrong-kind references and missing catalog items are ignored.
import { resolveEditorAddons } from './registry.js';
import { DEFAULT_EDITOR_THEME, editorThemeExtension, editorThemeFromTokens } from './editorThemes.js';
import { editorExtExtension } from './editorExts.js';

export { applyThemeTokens } from './themeTokens.js';

const toById = (catalog) => {
  if (!catalog) return {};
  if (Array.isArray(catalog)) return Object.fromEntries(catalog.map((i) => [i.id, i]));
  return catalog;
};

/**
 * Extensions for a resolved spec `{ theme: builtinId|null, palette: tokens|null, exts: [builtinId] }`.
 * Always starts with an editor theme (a token theme, else the bundled one, else the default for the
 * app theme), so the result can replace the editor's hard-coded `oneDark` one-for-one.
 */
export function extensionsForSpec(spec) {
  const theme = (spec?.palette && editorThemeFromTokens(spec.palette)) || editorThemeExtension(spec?.theme);
  const out = [theme || editorThemeExtension(DEFAULT_EDITOR_THEME)];
  for (const id of spec?.exts || []) {
    const ext = editorExtExtension(id);
    if (ext) out.push(ext);
  }
  return out;
}

/**
 * @param equipped  value of `equipped/{uid}` (or null)
 * @param catalog   normalized catalog: `{ [itemId]: item }` or an array of items
 * @returns CodeMirror extension array: [editorTheme, ...enabled editor add-ons]
 */
export function editorAddonExtensions(equipped, catalog) {
  return extensionsForSpec(resolveEditorAddons(equipped, toById(catalog)));
}
