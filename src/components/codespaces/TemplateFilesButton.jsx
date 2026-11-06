// "Add files from template" for an EMPTY workspace (channel workspace or codespace), rendered by
// the integrator-owned CollabExtras. Hidden when the workspace has files or the viewer is read-only.
// Props: { ctx } — the CollabExtras ctx contract from spec 0.7 ({ space, key, me, readOnly, files, ... }).
import { useState } from 'react';
import { seedTemplate } from '../../lib/codespaces.js';
import { TEMPLATES } from '../../lib/codespaceTemplates.js';
import { Icon as LyIcon, Modal, useToast } from '../layout/ui.jsx';
import './codespaces.css';

const CHOICES = TEMPLATES.filter((t) => Object.keys(t.files).length > 0);

export default function TemplateFilesButton({ ctx, onOpenFile }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState(CHOICES[0]?.id || null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');

  if (!ctx || ctx.readOnly || !ctx.key || !ctx.space || (ctx.files && ctx.files.length > 0)) return null;

  const add = async () => {
    if (!templateId || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await seedTemplate({
        space: ctx.space,
        key: ctx.key,
        uid: ctx.me.uid,
        templateId,
        skipPaths: (ctx.files || []).map((f) => f.path),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (res.created.length === 0 && res.failed.length) throw new Error(res.failed[0].error);
      if (res.failed.length) toast(`${res.failed.length} file${res.failed.length === 1 ? '' : 's'} couldn’t be added`, 'error');
      else toast(`Added ${res.created.length} file${res.created.length === 1 ? '' : 's'}`, 'success');
      if (res.openFid) onOpenFile?.(res.openFid);
      setOpen(false);
    } catch (e) {
      setError(String(e?.message || e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <>
      <button className="btn sm ghost" onClick={() => setOpen(true)} title="Add starter files from a template">
        <LyIcon name="plus" size={14} /> Template
      </button>
      {open && (
        <Modal title="Add files from a template" onClose={busy ? undefined : () => setOpen(false)} wide className="cs-modal">
          <div className="cs-templates" role="radiogroup" aria-label="Template">
            {CHOICES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={templateId === t.id}
                className={`cs-template ${templateId === t.id ? 'active' : ''}`}
                onClick={() => setTemplateId(t.id)}
                disabled={busy}
              >
                <span className="cs-template-icon" aria-hidden="true">{t.icon}</span>
                <span className="cs-template-text">
                  <span className="cs-template-name">{t.name}</span>
                  <span className="cs-template-desc">{t.description}</span>
                  <span className="cs-template-files">{Object.keys(t.files).join(' · ')}</span>
                </span>
              </button>
            ))}
          </div>
          {progress && progress.total > 0 && (
            <div className="cs-progress" aria-live="polite">
              <div className="cs-progress-bar">
                <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
              </div>
              <span className="muted">Encrypting files… {progress.done}/{progress.total}</span>
            </div>
          )}
          {error && <div className="error-text">{error}</div>}
          <div className="ly-form-actions">
            <button className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
            <button className="btn primary" onClick={add} disabled={busy || !templateId}>
              {busy ? <span className="spinner cs-spinner-sm" /> : <LyIcon name="plus" size={15} />}
              {busy ? 'Adding…' : 'Add files'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
