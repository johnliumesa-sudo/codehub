// Add-on builder: manifest fields, permissions, a CodeMirror editor for the single HTML/JS document
// (<= 64 KB) and a live sandbox preview with a mock bridge. Publishing writes the manifest and the
// code in one update (pub/addons/{id} + pub/addonCode/{id}).
import { Suspense, cloneElement, lazy, useEffect, useMemo, useState } from 'react';
import { EXAMPLES } from '../examples/index.js';
import { LIMITS, formatBytes, normalizePerms, utf8Length, validateDraft } from '../lib/manifest.js';
import { loadAddon, publishAddon, unpublishAddon, usePublishedBy } from '../lib/store.js';
import PreviewPane from './PreviewPane.jsx';
import { PermRequestPicker, errText } from './bits.jsx';
import { ConfirmButton } from '../../../components/layout/ui.jsx';

const CodeEditor = lazy(() => import('./CodeEditor.jsx'));

export const BLANK_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 16px; font: 14px/1.5 system-ui, sans-serif;
         background: var(--ch-bg-1); color: var(--ch-text); }
  button { padding: 6px 12px; border-radius: 6px; border: 1px solid var(--ch-border);
           background: var(--ch-accent); color: #fff; font: inherit; cursor: pointer; }
</style>
</head>
<body>
  <h1 style="font-size:16px;margin:0 0 8px">Hello!</h1>
  <p id="where">Connecting…</p>
  <button id="hi" type="button">Say hi in the composer</button>
<script>
  // window.codehub is the bridge to Codehub. Ask only for the permissions you use.
  codehub.ready().then(({ context }) => {
    document.getElementById('where').textContent =
      'Hi ' + context.me.name + ', you are in ' + (context.name || 'a conversation') + '.';
  });
  document.getElementById('hi').addEventListener('click', () => {
    codehub.insertText('Hi everyone 👋').catch((e) => {
      document.getElementById('where').textContent = e.message;
    });
  });
</script>
</body>
</html>
`;

const EMPTY = { name: '', icon: '🧩', version: '1.0.0', desc: '', perms: ['composer'], code: BLANK_TEMPLATE };

/** Props: me, editId?, onDone(id), onCancel() */
export default function Builder({ me, editId, onDone, onCancel }) {
  const [draft, setDraft] = useState(editId ? null : EMPTY);
  const [orig, setOrig] = useState(null); // the published manifest + code when editing
  const [loadErr, setLoadErr] = useState('');
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [previewCode, setPreviewCode] = useState(editId ? '' : EMPTY.code);
  const [autoRun, setAutoRun] = useState(true);
  const [runKey, setRunKey] = useState(0);
  const mine = usePublishedBy(me?.uid);

  useEffect(() => {
    if (!editId) return undefined;
    let off = false;
    loadAddon(editId).then(
      ({ manifest, code }) => {
        if (off) return;
        if (manifest.by !== me?.uid) {
          setLoadErr('Only the publisher can edit this add-on.');
          return;
        }
        setOrig({ manifest, code });
        setDraft({ name: manifest.name, icon: manifest.icon, version: manifest.version, desc: manifest.desc, perms: manifest.perms, code });
        setPreviewCode(code);
      },
      (e) => !off && setLoadErr(errText(e)),
    );
    return () => {
      off = true;
    };
  }, [editId, me?.uid]);

  // Debounced live preview.
  useEffect(() => {
    if (!draft || !autoRun) return undefined;
    const t = setTimeout(() => setPreviewCode(draft.code), 700);
    return () => clearTimeout(t);
  }, [draft?.code, autoRun]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const bytes = useMemo(() => utf8Length(draft?.code || ''), [draft?.code]);

  if (loadErr) {
    return (
      <div className="ad-builder">
        <p className="error-text" role="alert">{loadErr}</p>
        <button type="button" className="btn" onClick={onCancel}>Back</button>
      </div>
    );
  }
  if (!draft) return <div className="ad-center"><div className="spinner" aria-label="Loading the add-on" /></div>;

  const codeOrPermsChanged = orig && (orig.code !== draft.code || orig.manifest.perms.join(',') !== normalizePerms(draft.perms).join(','));

  const publish = async (e) => {
    e.preventDefault();
    setErr('');
    const v = validateDraft(draft, { previousVersion: codeOrPermsChanged ? orig.manifest.version : undefined });
    setErrors(v.errors);
    if (!v.ok) {
      setErr('Fix the highlighted fields first.');
      return;
    }
    if (!editId && mine.list.length >= LIMITS.perPublisher) {
      setErr(`You can publish up to ${LIMITS.perPublisher} add-ons. Unpublish one first.`);
      return;
    }
    setBusy(true);
    try {
      const { id } = await publishAddon(editId || null, v.value, orig?.manifest.seed ? { seed: orig.manifest.seed } : {});
      onDone(id);
    } catch (e2) {
      setErr(errText(e2));
      setBusy(false);
    }
  };

  // Label, input and message: the message is linked with aria-describedby (not part of the name).
  const field = (k, label, input) => (
    <div className="ad-field">
      <label htmlFor={`ad-b-${k}`}>{label}</label>
      {cloneElement(input, { id: `ad-b-${k}`, 'aria-describedby': errors[k] ? `ad-b-${k}-err` : undefined })}
      {errors[k] && <span id={`ad-b-${k}-err`} className="error-text" role="alert">{errors[k]}</span>}
    </div>
  );

  return (
    <form className="ad-builder" onSubmit={publish} noValidate>
      <div className="ad-b-form">
        <div className="ad-b-row">
          {field('icon', 'Icon', <input className="input ad-icon-input" value={draft.icon} maxLength={LIMITS.icon} onChange={(e) => set('icon')(e.target.value)} aria-invalid={!!errors.icon} />)}
          {field('name', 'Name', <input className="input" data-autofocus value={draft.name} maxLength={LIMITS.name} onChange={(e) => set('name')(e.target.value)} aria-invalid={!!errors.name} placeholder="My add-on" />)}
          {field('version', 'Version', <input className="input ad-version-input" value={draft.version} maxLength={LIMITS.version} onChange={(e) => set('version')(e.target.value)} aria-invalid={!!errors.version} />)}
        </div>
        {field(
          'desc',
          `Description (${draft.desc.length}/${LIMITS.desc})`,
          <textarea className="input" rows={2} value={draft.desc} maxLength={LIMITS.desc} onChange={(e) => set('desc')(e.target.value)} aria-invalid={!!errors.desc} placeholder="What it does, in a sentence or two" />,
        )}
        <PermRequestPicker value={draft.perms} onChange={set('perms')} />
        <div className="ad-b-codehead">
          <span className="ad-field-label">Code (one HTML document with inline JS and CSS)</span>
          {!editId && (
            <label className="ad-start">
              <span className="ad-visually-hidden">Start from</span>
              <select
                className="input"
                aria-label="Start from an example"
                value=""
                onChange={(e) => {
                  const ex = EXAMPLES.find((x) => x.seed === e.target.value);
                  if (e.target.value === 'blank') setDraft((d) => ({ ...d, code: BLANK_TEMPLATE }));
                  else if (ex) setDraft((d) => ({ ...d, code: ex.code, perms: ex.perms, icon: d.icon === EMPTY.icon ? ex.icon : d.icon }));
                }}
              >
                <option value="">Start from…</option>
                <option value="blank">Hello template</option>
                {EXAMPLES.map((x) => <option key={x.seed} value={x.seed}>{x.name} example</option>)}
              </select>
            </label>
          )}
          <span className={`ad-size${bytes > LIMITS.codeBytes ? ' over' : ''}`}>{formatBytes(bytes)} / 64 KB</span>
        </div>
        <div className="ad-editor-wrap">
          <Suspense fallback={<div className="ad-center"><div className="spinner" aria-label="Loading the editor" /></div>}>
            <CodeEditor value={draft.code} onChange={set('code')} label="Add-on code" />
          </Suspense>
        </div>
        {errors.code && <p className="error-text" role="alert">{errors.code}</p>}
        <p className="ad-hint muted">
          Your code runs in a sandboxed frame without network access (no fetch, no external scripts or images; inline
          everything). Use <code className="ad-code-inline">window.codehub</code> to talk to Codehub and the
          <code className="ad-code-inline">--ch-*</code> CSS variables (e.g. <code className="ad-code-inline">var(--ch-bg-2)</code>) to match the
          user’s theme. Everything you publish is public.
        </p>
      </div>
      <div className="ad-b-preview">
        <div className="ad-preview-opts">
          <label className="ad-check inline">
            <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
            <span>Update preview as I type</span>
          </label>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setPreviewCode(draft.code);
              setRunKey((k) => k + 1);
            }}
          >
            Run
          </button>
        </div>
        <PreviewPane code={previewCode} perms={draft.perms} meName={me?.name} runKey={runKey} />
      </div>
      <div className="ad-b-foot">
        {err && <p className="error-text" role="alert">{err}</p>}
        <div className="ad-actions">
          {editId && (
            <ConfirmButton confirmLabel="Unpublish for everyone?" onConfirm={() => unpublishAddon(editId).then(() => onDone(null), (e) => setErr(errText(e)))}>
              Unpublish
            </ConfirmButton>
          )}
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Publishing…' : editId ? 'Publish update' : 'Publish'}
          </button>
        </div>
      </div>
    </form>
  );
}
