// Live preview + run console for a collab workspace (channel workspace or codespace).
//
// Props: { ctx, onClose, initialWidth? }
//   ctx: the CollabView extras contract (space, key, me, files, activeFid, activePath, provider, …).
// The active file re-renders 400 ms after the last edit (observing ctx.provider.ytext). Other
// workspace files are decrypted once via loadWorkspaceFiles and reloaded with the refresh button.
// Everything runs in SandboxFrame profile="play" (opaque origin; the only network is the public code
// CDNs of the play CSP). The workspace itself never leaves the client. The first render waits until
// the other workspace files are decrypted, so a page never runs without its scripts.
// Game code (HTML, JS, TS/TSX/JSX, Python, Lua) is built by lib/gameLangs, the same layer the
// publish modal uses, so the preview is exactly what would be published. TypeScript loads on demand.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../../lib/markdown.js';
import { loadWorkspaceFiles } from '../../lib/collab/read.js';
import { MAX_CONSOLE_LINES, autoEntry, buildPreviewHtml, cleanPath, formatSize, extOf } from '../../lib/sandbox.js';
import {
  UNSUPPORTED,
  UNSUPPORTED_MESSAGE,
  autoGameEntry,
  buildGamePreview,
  entryKind,
  findEntries,
  loadTypeScript,
  needsTranspiler,
} from '../../lib/gameLangs/index.js';
import SandboxFrame from './SandboxFrame.jsx';
import { Icon } from './icons.jsx';
import './sandbox.css';

const DEBOUNCE_MS = 400;
const WIDTH_KEY = 'codehub.sbx.width';
const CONSOLE_KEY = 'codehub.sbx.consoleHeight';
const OTHER_PREVIEWABLE = new Set(['md', 'markdown', 'svg', 'cjs']);

function lsNum(key, fallback) {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}
function lsPut(key, value) {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* storage disabled */
  }
}

/** Debounced text of the active editor's Y.Text; null until the provider has synced. */
function useLiveText(provider) {
  const [text, setText] = useState(null);
  useEffect(() => {
    setText(null);
    if (!provider || provider.destroyed) return undefined;
    let timer = null;
    const read = () => {
      if (!provider.destroyed && provider.status === 'synced') setText(provider.ytext.toString());
    };
    read();
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(read, DEBOUNCE_MS);
    };
    provider.ytext.observe(onChange);
    // Status changes (connecting -> synced) come through the provider's own subscription.
    const unsub = typeof provider.subscribe === 'function' ? provider.subscribe(() => read()) : null;
    return () => {
      clearTimeout(timer);
      try {
        provider.ytext.unobserve(onChange);
      } catch {
        /* provider already destroyed */
      }
      unsub?.();
    };
  }, [provider]);
  return text;
}

/** Drag-to-resize helper. axis 'x' grows to the left (width), 'y' grows upward (height). */
function useDrag(axis, value, setValue, { min, max, storeKey }) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startValue = value;
    let last = value;
    setDragging(true);
    const move = (ev) => {
      const delta = start - (axis === 'x' ? ev.clientX : ev.clientY);
      last = Math.min(max(), Math.max(min, startValue + delta));
      setValue(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDragging(false);
      lsPut(storeKey, last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 60 : 20;
    const grow = axis === 'x' ? e.key === 'ArrowLeft' : e.key === 'ArrowUp';
    const shrink = axis === 'x' ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
    if (!grow && !shrink) return;
    e.preventDefault();
    const next = Math.min(max(), Math.max(min, value + (grow ? step : -step)));
    setValue(next);
    lsPut(storeKey, next);
  };
  return { dragging, onPointerDown, onKeyDown };
}

let lineSeq = 0;

export default function LivePreviewPane({ ctx, onClose, initialWidth }) {
  const { space, key, files: liveFiles = [], activePath, provider } = ctx || {};
  const rootRef = useRef(null);

  // ---- sibling files (decrypted once, refreshed on demand) ----
  const [siblings, setSiblings] = useState({ status: 'idle', files: [], error: null, loadedAt: 0 });
  const loadSeq = useRef(0);
  const reload = useCallback(async () => {
    if (!space || !key) return;
    const seq = ++loadSeq.current;
    setSiblings((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const list = await loadWorkspaceFiles(space, key, { maxFiles: 200 });
      if (seq !== loadSeq.current) return;
      setSiblings({ status: 'ready', files: list || [], error: null, loadedAt: Date.now() });
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setSiblings((s) => ({ ...s, status: 'error', error: err?.message || String(err) }));
    }
  }, [space, key]);
  useEffect(() => {
    const seqRef = loadSeq; // cleanup bumps the counter itself, so in-flight loads are dropped
    reload();
    return () => {
      seqRef.current++;
    };
  }, [reload]);

  const liveText = useLiveText(provider);

  // Workspace files as the preview sees them: decrypted siblings, with the active file's live text.
  const merged = useMemo(() => {
    const list = siblings.files.map((f) => ({ path: cleanPath(f.path), text: f.text }));
    if (activePath && typeof liveText === 'string') {
      const p = cleanPath(activePath);
      const i = list.findIndex((f) => f.path === p);
      if (i >= 0) list[i] = { path: p, text: liveText };
      else list.push({ path: p, text: liveText });
    }
    return list;
  }, [siblings.files, activePath, liveText]);

  // Files created/renamed since the last load (refresh to include them).
  const stale = useMemo(() => {
    if (siblings.status !== 'ready') return 0;
    const have = new Set(siblings.files.map((f) => cleanPath(f.path)));
    return liveFiles.filter((f) => f.path && !have.has(cleanPath(f.path)) && cleanPath(f.path) !== cleanPath(activePath || '')).length;
  }, [siblings, liveFiles, activePath]);

  // ---- entry selection ----
  const [entrySel, setEntrySel] = useState('auto');
  // Game entries (with their language) first, then other files that render (Markdown, SVG).
  const entryOptions = useMemo(() => {
    const games = findEntries(merged).map((e) => ({ path: e.path, label: `${e.path} · ${e.label}` }));
    const have = new Set(games.map((g) => g.path));
    const others = merged
      .filter((f) => !have.has(f.path) && (OTHER_PREVIEWABLE.has(extOf(f.path)) || (entryKind(f.path) && f.path === cleanPath(activePath || ''))))
      .map((f) => ({ path: f.path, label: f.path }))
      .sort((a, b) => a.path.localeCompare(b.path));
    return [...games, ...others];
  }, [merged, activePath]);
  useEffect(() => {
    if (entrySel !== 'auto' && siblings.status === 'ready' && !merged.some((f) => f.path === entrySel)) setEntrySel('auto');
  }, [entrySel, merged, siblings.status]);
  const entry = entrySel === 'auto' ? (activePath ? autoGameEntry(activePath, merged) || autoEntry(activePath, merged) : null) : entrySel;
  const gameEntry = !!entry && !!entryKind(entry);

  // The TypeScript compiler (a lazy chunk) when the entry needs it.
  const wantTs = gameEntry && needsTranspiler(entry, merged);
  const [tsMod, setTsMod] = useState({ ts: null, error: null });
  useEffect(() => {
    if (!wantTs || tsMod.ts) return undefined;
    let alive = true;
    loadTypeScript().then(
      (ts) => alive && setTsMod({ ts, error: null }),
      (err) => alive && setTsMod({ ts: null, error: err?.message || String(err) }),
    );
    return () => {
      alive = false;
    };
  }, [wantTs, tsMod.ts]);

  const waitingForText = !!activePath && !!provider && liveText === null && !merged.some((f) => f.path === cleanPath(activePath));
  // Until the first load of the other files finishes, only Markdown/SVG/plain files can render.
  const firstLoad = !!space && !!key && (siblings.status === 'idle' || (siblings.status === 'loading' && !siblings.loadedAt));
  const result = useMemo(() => {
    if (!entry) return { html: '', missing: [], error: null };
    if (UNSUPPORTED[extOf(entry)]) return { html: '', missing: [], error: UNSUPPORTED_MESSAGE };
    if (firstLoad && (gameEntry || /^cjs$/.test(extOf(entry)))) return { html: '', missing: [], error: null };
    if (!merged.some((f) => f.path === entry)) {
      return { html: '', missing: [], error: siblings.status === 'loading' || waitingForText ? null : `Can't read ${entry}` };
    }
    if (gameEntry) {
      if (wantTs && !tsMod.ts) return { html: '', missing: [], error: tsMod.error, compiling: !tsMod.error };
      return buildGamePreview(entry, merged, { ts: tsMod.ts });
    }
    return buildPreviewHtml(entry, merged, { renderMarkdown });
  }, [entry, merged, siblings.status, waitingForText, firstLoad, gameEntry, wantTs, tsMod]);
  const buildErrors = result.errors || [];
  const blockedUrls = useMemo(() => (result.external || []).filter((x) => !x.allowed).map((x) => x.url), [result.external]);

  // ---- run / stop ----
  const [running, setRunning] = useState(true);
  const [runNonce, setRunNonce] = useState(0);

  // ---- console ----
  const [lines, setLines] = useState([]);
  const buffer = useRef([]);
  const raf = useRef(0);
  const flush = useCallback(() => {
    raf.current = 0;
    const batch = buffer.current;
    buffer.current = [];
    if (!batch.length) return;
    setLines((prev) => {
      let next = prev;
      for (const item of batch) {
        if (item.level === 'clear') {
          next = [{ id: ++lineSeq, level: 'meta', text: 'Console was cleared', count: 1 }];
          continue;
        }
        const last = next[next.length - 1];
        if (last && last.level === item.level && last.text === item.text) {
          next = [...next.slice(0, -1), { ...last, count: last.count + 1 }];
        } else {
          next = [...next, { id: ++lineSeq, level: item.level, text: item.text, count: 1 }];
        }
      }
      return next.length > MAX_CONSOLE_LINES ? next.slice(next.length - MAX_CONSOLE_LINES) : next;
    });
  }, []);
  const onConsole = useCallback(
    ({ level, args }) => {
      buffer.current.push({ level, text: args.join(' ') });
      if (buffer.current.length > MAX_CONSOLE_LINES * 2) buffer.current = buffer.current.slice(-MAX_CONSOLE_LINES);
      if (!raf.current) raf.current = requestAnimationFrame(flush);
    },
    [flush],
  );
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const clearConsole = () => {
    buffer.current = [];
    setLines([]);
  };
  // A new document (or an explicit re-run) starts with a clean console.
  useEffect(() => {
    buffer.current = [];
    setLines([]);
  }, [result.html, runNonce, running]);

  const logRef = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const l of lines) {
      if (l.level === 'error') errors += l.count;
      else if (l.level === 'warn') warnings += l.count;
    }
    return { errors, warnings };
  }, [lines]);

  // ---- layout: width + console height ----
  const [width, setWidth] = useState(() => lsNum(WIDTH_KEY, initialWidth || 460));
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [consoleHeight, setConsoleHeight] = useState(() => lsNum(CONSOLE_KEY, 170));
  const maxWidth = () => {
    const host = rootRef.current?.parentElement;
    // Floating (PreviewButton portal): the host shrink-wraps the pane, so its max-width is the limit.
    const room = host?.classList.contains('sbx-float') ? parseFloat(host.style.maxWidth) || window.innerWidth : host?.clientWidth || window.innerWidth;
    return Math.max(320, Math.round(room * 0.85));
  };
  const maxConsole = () => Math.max(80, (rootRef.current?.clientHeight || 600) - 140);
  const dragX = useDrag('x', width, setWidth, { min: 280, max: maxWidth, storeKey: WIDTH_KEY });
  const dragY = useDrag('y', consoleHeight, setConsoleHeight, { min: 60, max: maxConsole, storeKey: CONSOLE_KEY });
  const dragging = dragX.dragging || dragY.dragging;

  const entryName = entry ? entry.split('/').pop() : null;
  const showFrame = running && !result.error && !!result.html;

  return (
    <aside
      ref={rootRef}
      className={`sbx-pane ${dragging ? 'dragging' : ''}`}
      style={{ width }}
      aria-label="Live preview"
    >
      <div
        className="sbx-resize-x"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview"
        tabIndex={0}
        onPointerDown={dragX.onPointerDown}
        onKeyDown={dragX.onKeyDown}
      />
      <header className="sbx-bar">
        <span className="sbx-title">
          <Icon name="eye" size={14} /> Preview
        </span>
        <select
          className="sbx-entry"
          value={entrySel}
          onChange={(e) => setEntrySel(e.target.value)}
          title="Which file to render"
          aria-label="File to preview"
        >
          <option value="auto">{entryName ? `Auto: ${entryName}` : 'Auto (active file)'}</option>
          {entryOptions.map((o) => (
            <option key={o.path} value={o.path}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="sbx-bar-spacer" />
        <button
          className="btn ghost sm sbx-icon-btn"
          onClick={() => {
            reload();
            setRunNonce((n) => n + 1);
          }}
          disabled={siblings.status === 'loading'}
          title={stale ? `Reload workspace files (${stale} new)` : 'Reload other workspace files and re-run'}
          aria-label="Reload workspace files"
        >
          {siblings.status === 'loading' ? <span className="spinner sbx-spin" /> : <Icon name="refresh" size={14} />}
          {stale > 0 && <span className="sbx-badge">{stale}</span>}
        </button>
        {running ? (
          <button className="btn sm sbx-stop" onClick={() => setRunning(false)} title="Stop: removes the frame (kills runaway loops)">
            <Icon name="stop" size={12} fill="currentColor" /> Stop
          </button>
        ) : (
          <button className="btn sm primary" onClick={() => setRunning(true)} title="Run the preview">
            <Icon name="play" size={12} fill="currentColor" /> Run
          </button>
        )}
        {onClose && (
          <button className="btn ghost sm sbx-icon-btn" onClick={onClose} aria-label="Close preview" title="Close preview">
            <Icon name="close" size={14} />
          </button>
        )}
      </header>

      {siblings.status === 'error' && (
        <div className="sbx-banner warn">
          Couldn’t load the other workspace files: {siblings.error}. Previewing the active file only.
        </div>
      )}
      {blockedUrls.length > 0 && !result.error && (
        <div className="sbx-banner warn" title={blockedUrls.join('\n')}>
          The sandbox blocks {blockedUrls.slice(0, 2).join(', ')}
          {blockedUrls.length > 2 ? ` +${blockedUrls.length - 2} more` : ''}. Load libraries from cdn.jsdelivr.net/npm, cdnjs or unpkg.
        </div>
      )}
      {buildErrors.length > 0 && !result.error && (
        <div className="sbx-banner warn" role="alert" title={buildErrors.join('\n')}>
          {buildErrors.slice(0, 2).join(' · ')}
          {buildErrors.length > 2 ? ` +${buildErrors.length - 2} more` : ''}
        </div>
      )}
      {result.missing?.length > 0 && !result.error && (
        <div className="sbx-banner" title={result.missing.join('\n')}>
          Not found in the workspace: {result.missing.slice(0, 3).join(', ')}
          {result.missing.length > 3 ? ` +${result.missing.length - 3} more` : ''}
        </div>
      )}

      <div className="sbx-stage">
        {!activePath && entrySel === 'auto' ? (
          <div className="sbx-empty">
            <Icon name="file" size={26} />
            <p>Open a file to preview it.</p>
            <p className="muted">HTML, JavaScript, TypeScript, Python and Lua games run here; Markdown and SVG render.</p>
          </div>
        ) : result.error ? (
          <div className="sbx-empty">
            <Icon name="alert" size={26} />
            <p>{result.error}</p>
          </div>
        ) : !running ? (
          <div className="sbx-empty">
            <Icon name="stop" size={24} />
            <p>Stopped.</p>
            <button className="btn sm primary" onClick={() => setRunning(true)}>
              <Icon name="play" size={12} fill="currentColor" /> Run
            </button>
          </div>
        ) : !showFrame ? (
          <div className="sbx-empty">
            <span className="spinner" />
            {result.compiling && <p className="muted">Loading the TypeScript compiler…</p>}
          </div>
        ) : (
          <SandboxFrame key={runNonce} html={result.html} profile="play" mode="preview" onConsole={onConsole} title={`Preview of ${entryName || 'file'}`} />
        )}
      </div>

      <section className={`sbx-console ${consoleOpen ? 'open' : ''}`} style={consoleOpen ? { height: consoleHeight } : undefined}>
        {consoleOpen && (
          <div
            className="sbx-resize-y"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize console"
            tabIndex={0}
            onPointerDown={dragY.onPointerDown}
            onKeyDown={dragY.onKeyDown}
          />
        )}
        <header className="sbx-console-bar">
          <button className="sbx-console-toggle" onClick={() => setConsoleOpen((o) => !o)} aria-expanded={consoleOpen}>
            <Icon name="terminal" size={13} /> Console
            {counts.errors > 0 && <span className="sbx-count error">{counts.errors}</span>}
            {counts.warnings > 0 && <span className="sbx-count warn">{counts.warnings}</span>}
          </button>
          <div className="sbx-bar-spacer" />
          {showFrame && result.html && <span className="sbx-size muted">{formatSize(result.html.length)}</span>}
          <button className="btn ghost sm sbx-icon-btn" onClick={clearConsole} title="Clear console" aria-label="Clear console">
            <Icon name="trash" size={13} />
          </button>
        </header>
        {consoleOpen && (
          <div
            className="sbx-log"
            ref={logRef}
            role="log"
            aria-live="polite"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {lines.length === 0 ? (
              <div className="sbx-log-empty muted">{running ? 'console.log output and errors show up here.' : 'Not running.'}</div>
            ) : (
              lines.map((l) => (
                <div key={l.id} className={`sbx-line ${l.level}`}>
                  {l.count > 1 && <span className="sbx-repeat">{l.count}</span>}
                  {/* Text only: never dangerouslySetInnerHTML for frame output. */}
                  <span className="sbx-text">{l.text}</span>
                </div>
              ))
            )}
          </div>
        )}
      </section>
      <footer className="sbx-foot muted">
        <Icon name="lock" size={11} /> Sandboxed: no access to your account or keys; no network except public code CDNs. Your files never leave this device.
      </footer>
    </aside>
  );
}
