// Named checkpoints for the active workspace file (F9): save, list, preview, diff vs current,
// restore (one minimal Yjs transaction) and delete. Props: { ctx, onClose } (ctx: CollabExtras contract).
import { useEffect, useMemo, useState } from 'react';
import { diffLines } from '../../lib/collab/diff.js';
import {
  MAX_CHECKPOINTS,
  MAX_LABEL,
  cleanLabel,
  deleteCheckpoint,
  replaceYText,
  saveCheckpoint,
  useCheckpointModerator,
  useCheckpoints,
} from '../../lib/checkpoints.js';
import { useProfiles } from '../../lib/profiles.js';
import { ConfirmButton, Modal, useToast } from '../layout/ui.jsx';
import { PdIcon, errMsg, fmtTime, timeAgo } from './icons.jsx';
import './productivity.css';

/** Live text of the active file (re-reads on every local or remote change). */
function useLiveText(provider) {
  const [text, setText] = useState(() => provider?.ytext?.toString() ?? '');
  useEffect(() => {
    const yt = provider?.ytext;
    if (!yt) {
      setText('');
      return undefined;
    }
    let raf = 0;
    const read = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setText(yt.toString()));
    };
    setText(yt.toString());
    yt.observe(read);
    return () => {
      cancelAnimationFrame(raf);
      yt.unobserve(read);
    };
  }, [provider]);
  return text;
}

function useProviderStatus(provider) {
  const [status, setStatus] = useState(provider?.status || 'connecting');
  useEffect(() => {
    if (!provider) return undefined;
    setStatus(provider.status);
    return provider.subscribe((p) => setStatus(p.status));
  }, [provider]);
  return provider ? status : 'none';
}

function DiffView({ oldText, newText }) {
  const d = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  if (d.tooLarge) return <p className="muted pd-pad">These versions differ too much to show a line diff.</p>;
  if (!d.hunks.length) return <p className="muted pd-pad">No differences: the file matches this checkpoint.</p>;
  return (
    <div className="pd-diff">
      <div className="pd-diff-stat">
        <span className="pd-add">+{d.added}</span> <span className="pd-del">−{d.removed}</span>
        <span className="muted"> lines (checkpoint → current file)</span>
      </div>
      {d.hunks.map((h, i) => (
        <div key={i} className="pd-hunk">
          <div className="pd-hunk-head">@@ −{h.oldStart} +{h.newStart} @@</div>
          {h.lines.map((l, j) => (
            <div key={j} className={`pd-dl ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}`}>
              <span className="pd-dl-no">{l.oldNo ?? ''}</span>
              <span className="pd-dl-no">{l.newNo ?? ''}</span>
              <span className="pd-dl-sign">{l.type}</span>
              <span className="pd-dl-text">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function CheckpointsPanel({ ctx, onClose }) {
  const toast = useToast();
  const { space, key, me, readOnly, activeFid, activePath, provider } = ctx;
  const { items, loading, error } = useCheckpoints(space, key, activeFid);
  const canModerate = useCheckpointModerator(space, me?.uid);
  const status = useProviderStatus(provider);
  const current = useLiveText(provider);
  const profiles = useProfiles(useMemo(() => items.map((c) => c.uid).filter(Boolean), [items]));

  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [selId, setSelId] = useState(null);
  const [view, setView] = useState('diff'); // 'diff' | 'preview'

  const sel = items.find((c) => c.cpid === selId) || null;
  useEffect(() => {
    if (!sel && items.length) setSelId(items[0].cpid);
  }, [items, sel]);

  const ready = !!provider && status === 'synced';
  const full = items.length >= MAX_CHECKPOINTS;
  const canDelete = (c) => !!c && (c.uid === me?.uid || canModerate);
  // Oldest checkpoint this user may delete (their own, or any for a moderator): the one a save at the
  // cap replaces, so non-moderators aren't blocked by someone else's oldest checkpoint.
  const oldest = [...items].reverse().find(canDelete) || null;

  const doSave = async (dropOldest) => {
    if (!ready || readOnly) return;
    setBusy(true);
    setErr(null);
    try {
      if (dropOldest && oldest) await deleteCheckpoint({ space, fid: activeFid, cpid: oldest.cpid });
      const cpid = await saveCheckpoint({ space, key, fid: activeFid, uid: me.uid, label, text: provider.ytext.toString() });
      setLabel('');
      setSelId(cpid);
      toast('Checkpoint saved', 'success');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doRestore = async (c) => {
    try {
      if (!ready) throw new Error('The file is still syncing. Try again in a moment.');
      const changed = replaceYText(provider.ytext, c.text);
      toast(changed ? `Restored “${c.label}”` : 'The file already matches this checkpoint', 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const doDelete = async (c) => {
    try {
      await deleteCheckpoint({ space, fid: activeFid, cpid: c.cpid });
      if (selId === c.cpid) setSelId(null);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const fileName = activePath ? activePath.split('/').pop() : 'file';

  return (
    <Modal title={`Checkpoints · ${fileName}`} onClose={onClose} wide className="pd-modal pd-cp-modal">
      {!activeFid ? (
        <p className="muted">Open a file to see its checkpoints.</p>
      ) : (
        <div className="pd-cp">
          <form
            className="pd-cp-save"
            onSubmit={(e) => {
              e.preventDefault();
              if (!full) doSave(false);
            }}
          >
            <input
              className="input"
              placeholder="Label, e.g. “before refactor”"
              value={label}
              maxLength={MAX_LABEL}
              onChange={(e) => setLabel(e.target.value)}
              disabled={readOnly}
              aria-label="Checkpoint label"
            />
            <button className="btn primary" type="submit" disabled={busy || readOnly || !ready || full} title={readOnly ? 'Viewers cannot save checkpoints' : !ready ? 'Waiting for the file to sync' : ''}>
              {busy ? <span className="spinner pd-spin" /> : <PdIcon name="save" />} Save checkpoint
            </button>
          </form>
          <div className="pd-cp-meta muted">
            <span>{items.length} / {MAX_CHECKPOINTS} checkpoints</span>
            <span className="badge-e2e"><PdIcon name="lock" size={11} /> encrypted</span>
            {cleanLabel(label).length >= MAX_LABEL && <span>Label limit reached</span>}
          </div>
          {full && !readOnly && (
            <div className="pd-notice warn">
              <PdIcon name="warn" />
              <span>
                This file has {MAX_CHECKPOINTS} checkpoints, the maximum.{' '}
                {oldest
                  ? <>Delete {oldest.cpid === items[items.length - 1]?.cpid ? 'the oldest' : 'your oldest'} (“{oldest.label}”) to save a new one.</>
                  : 'None of them are yours: ask an owner or one of their authors to delete one.'}
              </span>
              {oldest && (
                <ConfirmButton className="btn sm danger" confirmLabel="Delete oldest & save" onConfirm={() => doSave(true)} disabled={busy || !ready}>
                  Replace oldest
                </ConfirmButton>
              )}
            </div>
          )}
          {err && <p className="error-text">{err}</p>}
          {error && <p className="error-text">{error}</p>}

          <div className="pd-cp-body">
            <ul className="pd-cp-list" aria-label="Checkpoints">
              {loading && <li className="pd-pad"><span className="spinner pd-spin" /></li>}
              {!loading && !items.length && <li className="muted pd-pad">No checkpoints yet. Save one to keep a named version of this file.</li>}
              {items.map((c) => (
                <li key={c.cpid}>
                  <button className={`pd-cp-item ${c.cpid === selId ? 'active' : ''} ${c.broken ? 'broken' : ''}`} onClick={() => setSelId(c.cpid)}>
                    <span className="pd-cp-label">{c.label}</span>
                    <span className="pd-cp-sub muted">
                      {profiles[c.uid]?.name || 'Someone'} · <span title={fmtTime(c.ts)}>{timeAgo(c.ts)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="pd-cp-detail">
              {sel ? (
                <>
                  <div className="pd-cp-detail-head">
                    <div className="pd-seg" role="tablist">
                      <button role="tab" aria-selected={view === 'diff'} className={view === 'diff' ? 'on' : ''} onClick={() => setView('diff')}>
                        <PdIcon name="diff" size={14} /> Diff vs current
                      </button>
                      <button role="tab" aria-selected={view === 'preview'} className={view === 'preview' ? 'on' : ''} onClick={() => setView('preview')}>
                        <PdIcon name="eye" size={14} /> Preview
                      </button>
                    </div>
                    <div className="pd-grow" />
                    {canDelete(sel) && (
                      <ConfirmButton className="btn sm ghost pd-danger-ghost" confirmLabel="Delete?" onConfirm={() => doDelete(sel)}>
                        <PdIcon name="trash" size={14} /> Delete
                      </ConfirmButton>
                    )}
                    <ConfirmButton
                      className="btn sm primary"
                      confirmLabel="Replace file content?"
                      onConfirm={() => doRestore(sel)}
                      disabled={readOnly || !ready || sel.broken}
                    >
                      <PdIcon name="restore" size={14} /> Restore
                    </ConfirmButton>
                  </div>
                  {sel.broken ? (
                    <p className="error-text pd-pad">This checkpoint could not be decrypted.</p>
                  ) : view === 'diff' ? (
                    ready ? <DiffView oldText={sel.text} newText={current} /> : <p className="muted pd-pad">Waiting for the file to sync…</p>
                  ) : (
                    <pre className="pd-code pd-cp-preview">{sel.text || <span className="muted">(empty file)</span>}</pre>
                  )}
                </>
              ) : (
                <p className="muted pd-pad">Select a checkpoint.</p>
              )}
            </div>
          </div>
          {readOnly && <p className="muted pd-small">You have view-only access: you can browse checkpoints but not save or restore them.</p>}
        </div>
      )}
    </Modal>
  );
}
