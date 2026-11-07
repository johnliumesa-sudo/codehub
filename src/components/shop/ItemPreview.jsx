// Static, data-driven preview of a shop item. Only validated `#rrggbb` values and plain text are
// rendered; nothing from an item is ever interpreted as HTML/CSS.
import { BASE_TOKENS, EDITOR_EXT_INFO, EDITOR_THEME_INFO } from '../../lib/addons/registry.js';
import { cleanEditorTokens, editorPreview } from '../../lib/addons/editorPalette.js';

function ThemePreview({ tokens }) {
  const c = { ...BASE_TOKENS, ...(tokens || {}) };
  return (
    <div className="shop-pv-theme" style={{ background: c.bg0, borderColor: c.border }} aria-hidden="true">
      <div className="shop-pv-rail">
        <span style={{ background: `linear-gradient(135deg, ${c.accent}, ${c.accent2})` }} />
        <span style={{ background: c.bg2 }} />
        <span style={{ background: c.bg2 }} />
      </div>
      <div className="shop-pv-side" style={{ background: c.bg1 }}>
        <i style={{ background: c.textDim }} />
        <i style={{ background: c.text, width: '70%' }} />
        <i style={{ background: c.textFaint, width: '55%' }} />
        <i style={{ background: c.bgHover, width: '80%' }} />
      </div>
      <div className="shop-pv-main" style={{ background: c.bg2 }}>
        <i style={{ background: c.text, width: '62%' }} />
        <i style={{ background: c.textDim, width: '84%' }} />
        <i style={{ background: c.textDim, width: '48%' }} />
        <div className="shop-pv-dots">
          <b style={{ background: c.ok }} />
          <b style={{ background: c.warn }} />
          <b style={{ background: c.danger }} />
        </div>
        <span className="shop-pv-input" style={{ background: c.bg3, borderColor: c.border }}>
          <span style={{ background: c.accent }} />
        </span>
      </div>
    </div>
  );
}

function EditorThemePreview({ builtinId, tokens }) {
  const clean = tokens ? cleanEditorTokens(tokens) : null;
  const p = clean ? editorPreview(clean) : EDITOR_THEME_INFO[builtinId]?.preview;
  if (!p) return <div className="shop-pv-unknown">{tokens ? 'Pick a color for every token' : 'Not available in this version'}</div>;
  const op = p.op || p.fg;
  return (
    <pre className="shop-pv-code" style={{ background: p.bg, color: p.fg }} aria-hidden="true">
      <span style={{ color: p.gutter }}>1 </span><span style={{ color: p.comment }}>{'// say hi'}</span>{'\n'}
      <span style={{ color: p.gutter }}>2 </span><span style={{ color: p.keyword }}>function</span> <span style={{ color: p.fn }}>hello</span>(name) {'{'}{'\n'}
      <span style={{ color: p.gutter }}>3 </span>  <span style={{ color: p.keyword }}>const</span> n<span style={{ color: op }}>: </span><span style={{ color: p.type }}>Int</span> <span style={{ color: op }}>=</span> <span style={{ color: p.number }}>42</span>;{'\n'}
      <span style={{ color: p.gutter }}>4 </span>  <span style={{ color: p.keyword }}>return</span> <span style={{ color: p.string }}>{"'hi '"}</span> <span style={{ color: op }}>+</span>{' '}
      {p.sel ? <span style={{ background: p.sel }}>name</span> : 'name'}{p.caret && <span className="shop-pv-caret" style={{ background: p.caret }} />};{'\n'}
      <span style={{ color: p.gutter }}>5 </span>{'}'}
    </pre>
  );
}

function ExtPreview({ builtinId }) {
  const info = EDITOR_EXT_INFO[builtinId];
  if (!info) return <div className="shop-pv-unknown">Not available in this version</div>;
  return (
    <div className="shop-pv-ext" aria-hidden="true">
      <span className="shop-pv-ext-glyph">{info.glyph}</span>
      <span className="shop-pv-ext-label">{info.label}</span>
    </div>
  );
}

/** Props: { item, me? ({name}) } */
export default function ItemPreview({ item, me }) {
  if (!item) return null;
  switch (item.kind) {
    case 'theme':
      return <ThemePreview tokens={item.data?.tokens} />;
    case 'editorTheme':
      return <EditorThemePreview builtinId={item.data?.builtinId} tokens={item.data?.tokens} />;
    case 'editorExt':
      return <ExtPreview builtinId={item.data?.builtinId} />;
    case 'badge':
      return (
        <div className="shop-pv-badge" aria-hidden="true">
          <span className="shop-pv-badge-glyph">{item.data?.glyph}</span>
        </div>
      );
    case 'nameColor':
      return (
        <div className="shop-pv-name" aria-hidden="true">
          <span className="shop-pv-name-text" style={{ color: item.data?.color }}>{me?.name || 'Your name'}</span>
          <span className="shop-pv-name-msg">shipped the fix 🎉</span>
        </div>
      );
    default:
      return <div className="shop-pv-unknown">Unknown item</div>;
  }
}
