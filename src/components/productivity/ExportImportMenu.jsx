// CollabView extras: export the workspace as an (unencrypted) zip, or import files / a folder /
// a zip into it (writers only). Props: { ctx, title? } — the zip is named after ctx.title || title.
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadWorkspaceFiles } from '../../lib/collab/read.js';
import { normalizePath } from '../../lib/collab/workspace.js';
import { downloadBlob, makeZip, safeFileName } from '../../lib/zip.js';
import { Modal, useToast } from '../layout/ui.jsx';
import { PdIcon, errMsg } from './icons.jsx';
import {
  IMPORT_LIMITS,
  buildPlan,
  createImportedFile,
  filesFromDrop,
  filesFromInput,
  overwriteFile,
  readSources,
} from './importPlan.js';
import './productivity.css';

const fmtBytes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

function ImportModal({ ctx, onClose }) {
  const toast = useToast();
  const [raw, setRaw] = useState(null); // readSources result
  const [reading, setReading] = useState(false);
  const [stripRoot, setStripRoot] = useState(true);
  const [onExisting, setOnExisting] = useState('skip'); // 'skip' | 'overwrite'
  const [run, setRun] = useState(null); // { done, total, current, failed: [{path, error}], finished, cancelled }
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const cancelRef = useRef(false);
  const filesInput = useRef(null);
  const folderInput = useRef(null);
  const zipInput = useRef(null);

  // React doesn't know webkitdirectory; set it on the DOM node.
  useEffect(() => {
    const el = folderInput.current;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, []);

  const plan = useMemo(() => (raw ? buildPlan(raw, ctx.files || [], { stripRoot }) : null), [raw, ctx.files, stripRoot]);
  const running = !!run && !run.finished;
  // The shared Modal binds its Escape handler once at mount, so guard closing through a ref.
  const runningRef = useRef(false);
  runningRef.current = running;
  const safeClose = () => {
    if (!runningRef.current) onClose();
  };

  const load = async (picked) => {
    if (!picked.length) return;
    setError(null);
    setRun(null);
    setReading(true);
    try {
      setRaw(await readSources(picked));
    } catch (e) {
      setRaw(null);
      setError(errMsg(e));
    } finally {
      setReading(false);
    }
  };

  const start = async () => {
    if (!plan || running) return;
    const todo = plan.items.filter((it) => it.status === 'new' || (it.status === 'exists' && onExisting === 'overwrite'));
    if (!todo.length) return;
    cancelRef.current = false;
    const state = { done: 0, total: todo.length, current: '', failed: [], finished: false, cancelled: false };
    setRun({ ...state });
    for (const it of todo) {
      if (cancelRef.current) {
        state.cancelled = true;
        break;
      }
      state.current = it.path;
      setRun({ ...state });
      try {
        if (it.status === 'new') await createImportedFile({ ctx, path: it.path, text: it.text });
        else await overwriteFile({ ctx, fid: it.fid, text: it.text });
      } catch (e) {
        state.failed.push({ path: it.path, error: errMsg(e) });
      }
      state.done += 1;
      setRun({ ...state });
    }
    state.finished = true;
    state.current = '';
    setRun({ ...state });
    const ok = state.done - state.failed.length;
    toast(`Imported ${ok} file${ok === 1 ? '' : 's'}${state.failed.length ? `, ${state.failed.length} failed` : ''}`, state.failed.length ? 'error' : 'success');
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDrag(false);
    if (running) return;
    try {
      await load(await filesFromDrop(e.dataTransfer));
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const willWrite = plan ? plan.counts.new + (onExisting === 'overwrite' ? plan.counts.exists : 0) : 0;

  return (
    <Modal title="Import into workspace" onClose={safeClose} wide className="pd-modal pd-import-modal">
      <div
        className={`pd-drop ${drag ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!running) setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <PdIcon name="upload" size={22} />
        <div>
          <strong>Drop files, a folder or a .zip here</strong>
          <div className="muted pd-small">
            Text files only · up to {IMPORT_LIMITS.maxFiles} files · {fmtBytes(IMPORT_LIMITS.maxFileBytes)} each · {fmtBytes(IMPORT_LIMITS.maxTotalBytes)} total
          </div>
        </div>
        <div className="pd-drop-actions">
          <button type="button" className="btn sm" disabled={running || reading} onClick={() => filesInput.current?.click()}>
            <PdIcon name="file" size={14} /> Files
          </button>
          <button type="button" className="btn sm" disabled={running || reading} onClick={() => folderInput.current?.click()}>
            <PdIcon name="folder" size={14} /> Folder
          </button>
          <button type="button" className="btn sm" disabled={running || reading} onClick={() => zipInput.current?.click()}>
            <PdIcon name="archive" size={14} /> .zip
          </button>
        </div>
        <input ref={filesInput} type="file" multiple hidden onChange={(e) => { load(filesFromInput(e.target.files)); e.target.value = ''; }} />
        <input ref={folderInput} type="file" multiple hidden onChange={(e) => { load(filesFromInput(e.target.files)); e.target.value = ''; }} />
        <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={(e) => { load(filesFromInput(e.target.files)); e.target.value = ''; }} />
      </div>

      {reading && <div className="pd-row muted"><span className="spinner pd-spin" /> Reading files…</div>}
      {error && <p className="error-text">{error}</p>}

      {plan && !reading && (
        <>
          <div className="pd-import-opts">
            {plan.root && (
              <label className="pd-check">
                <input type="checkbox" checked={stripRoot} disabled={running} onChange={(e) => setStripRoot(e.target.checked)} />
                Drop the top folder “{plan.root}/”
              </label>
            )}
            {plan.counts.exists > 0 && (
              <div className="pd-seg" role="radiogroup" aria-label="Existing files">
                <button type="button" className={onExisting === 'skip' ? 'on' : ''} disabled={running} onClick={() => setOnExisting('skip')}>
                  Skip {plan.counts.exists} existing
                </button>
                <button type="button" className={onExisting === 'overwrite' ? 'on' : ''} disabled={running} onClick={() => setOnExisting('overwrite')}>
                  Overwrite existing
                </button>
              </div>
            )}
          </div>
          <div className="pd-import-summary muted">
            {plan.counts.new} new · {plan.counts.exists} already exist · {plan.counts.skip} skipped · {fmtBytes(plan.totalBytes)}
          </div>
          <ul className="pd-import-list">
            {plan.items.map((it) => {
              const overwrite = it.status === 'exists' && onExisting === 'overwrite';
              const tag = it.status === 'new' ? 'new' : it.status === 'exists' ? (overwrite ? 'overwrite' : 'exists · skip') : it.reason || 'skip';
              return (
                <li key={it.key} className={`pd-import-item ${it.status} ${overwrite ? 'overwrite' : ''}`}>
                  <PdIcon name="file" size={13} />
                  <span className="pd-import-path" title={it.srcPath}>{it.path || it.srcPath}</span>
                  <span className="pd-import-size muted">{it.size ? fmtBytes(it.size) : ''}</span>
                  <span className="pd-import-tag">{tag}</span>
                </li>
              );
            })}
          </ul>
          {onExisting === 'overwrite' && plan.counts.exists > 0 && (
            <p className="muted pd-small">Overwriting replaces each existing file’s text in one change, synced live to collaborators. Save a checkpoint first if you may want it back.</p>
          )}
        </>
      )}

      {run && (
        <div className="pd-progress-wrap">
          <div className="pd-progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done}>
            <div className="pd-progress-bar" style={{ width: `${run.total ? (run.done / run.total) * 100 : 0}%` }} />
          </div>
          <div className="pd-small muted">
            {run.finished
              ? `${run.cancelled ? 'Stopped' : 'Done'}: ${run.done - run.failed.length} of ${run.total} written`
              : `${run.done} / ${run.total} · ${run.current}`}
          </div>
          {run.failed.length > 0 && (
            <ul className="pd-import-failed">
              {run.failed.map((f) => <li key={f.path}><span className="error-text">{f.path}</span> — {f.error}</li>)}
            </ul>
          )}
        </div>
      )}

      <div className="pd-actions">
        {running ? (
          <button type="button" className="btn" onClick={() => { cancelRef.current = true; }}>Stop after current file</button>
        ) : (
          <button type="button" className="btn ghost" onClick={safeClose}>{run?.finished ? 'Close' : 'Cancel'}</button>
        )}
        {!run?.finished && (
          <button type="button" className="btn primary" disabled={!willWrite || running || reading} onClick={start}>
            {running ? <span className="spinner pd-spin" /> : <PdIcon name="upload" size={14} />} Import {willWrite || ''} file{willWrite === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </Modal>
  );
}

export default function ExportImportMenu({ ctx, title }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const wrapRef = useRef(null);
  const canWrite = !ctx?.readOnly;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => wrapRef.current && !wrapRef.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const doExport = async () => {
    setOpen(false);
    if (!ctx?.key || exporting) return;
    setExporting(true);
    try {
      const files = await loadWorkspaceFiles(ctx.space, ctx.key, { maxFiles: 1000 });
      // Only well-formed paths (never "⚠ undecryptable-…" placeholders).
      const entries = files
        .filter((f) => f && typeof f.path === 'string' && f.path && normalizePath(f.path) === f.path && typeof f.text === 'string')
        .map((f) => ({ path: f.path, data: f.text }));
      if (!entries.length) throw new Error('This workspace has no files to export');
      const name = safeFileName(ctx.title || title, 'workspace');
      downloadBlob(makeZip(entries), `${name}.zip`);
      toast(`Exported ${entries.length} file${entries.length === 1 ? '' : 's'} as an unencrypted zip`, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="pd-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`btn sm ghost pd-tool-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        disabled={!ctx?.key}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export or import workspace files"
      >
        {exporting ? <span className="spinner pd-spin" /> : <PdIcon name="archive" />}
        <span className="pd-tool-label">Export / Import</span>
        <PdIcon name="chevron" size={12} />
      </button>
      {open && (
        <div className="pd-menu" role="menu">
          <button type="button" role="menuitem" className="pd-menu-item" onClick={doExport} disabled={exporting}>
            <PdIcon name="download" />
            <span>
              Export as .zip
              <small>Downloads an <b>unencrypted</b> copy of every file</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="pd-menu-item"
            disabled={!canWrite}
            onClick={() => {
              setOpen(false);
              setImporting(true);
            }}
            title={canWrite ? '' : 'Viewers cannot import files'}
          >
            <PdIcon name="upload" />
            <span>
              Import files…
              <small>{canWrite ? 'Files, a folder or a .zip (text files only)' : 'View-only access'}</small>
            </span>
          </button>
        </div>
      )}
      {importing && canWrite && <ImportModal ctx={ctx} onClose={() => setImporting(false)} />}
    </div>
  );
}
