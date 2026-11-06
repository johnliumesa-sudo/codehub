// Create a codespace: name, starter template (F8), personal or shared.
// Props: { me, onClose, onCreated({ csid, openFid, share, failed }) }
import { useState } from 'react';
import { MAX_CODESPACE_NAME, cleanCodespaceName, createCodespace } from '../../lib/codespaces.js';
import { DEFAULT_TEMPLATE_ID, TEMPLATES } from '../../lib/codespaceTemplates.js';
import { Icon, Modal } from '../layout/ui.jsx';
import './codespaces.css';

export default function CreateCodespaceModal({ me, onClose, onCreated, initialTemplate = DEFAULT_TEMPLATE_ID }) {
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(TEMPLATES.some((t) => t.id === initialTemplate) ? initialTemplate : DEFAULT_TEMPLATE_ID);
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null); // { done, total, path }
  const [error, setError] = useState('');

  const clean = cleanCodespaceName(name);

  const submit = async (e) => {
    e.preventDefault();
    if (!clean || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await createCodespace(me, {
        name: clean,
        templateId,
        onProgress: (done, total, path) => setProgress({ done, total, path }),
      });
      onCreated?.({ csid: res.csid, openFid: res.openFid, share, failed: res.failed || [] });
    } catch (err) {
      setError(String(err?.message || err).replace(/^Error:\s*/, ''));
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal title="New codespace" onClose={busy ? undefined : onClose} wide className="cs-modal">
      <form className="cs-create" onSubmit={submit}>
        <label className="field">
          Name
          <input
            className="input"
            value={name}
            maxLength={MAX_CODESPACE_NAME}
            placeholder="e.g. Weekend hack"
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>

        <div className="cs-section-label">Start from</div>
        <div className="cs-templates" role="radiogroup" aria-label="Template">
          {TEMPLATES.map((t) => (
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
                {Object.keys(t.files).length > 0 && (
                  <span className="cs-template-files">{Object.keys(t.files).join(' · ')}</span>
                )}
              </span>
            </button>
          ))}
        </div>

        <div className="cs-section-label">Who can use it</div>
        <div className="cs-seg" role="radiogroup" aria-label="Visibility">
          <button type="button" role="radio" aria-checked={!share} className={!share ? 'active' : ''} onClick={() => setShare(false)} disabled={busy}>
            <Icon name="lock" size={15} />
            <span>
              <b>Personal</b>
              <small>Only you, until you invite someone</small>
            </span>
          </button>
          <button type="button" role="radio" aria-checked={share} className={share ? 'active' : ''} onClick={() => setShare(true)} disabled={busy}>
            <Icon name="users" size={15} />
            <span>
              <b>Shared</b>
              <small>Invite editors and viewers next</small>
            </span>
          </button>
        </div>

        <p className="cs-note muted">
          <Icon name="shield" size={13} /> The name, file names, contents and cursors are end-to-end encrypted. Membership, roles and the
          template you pick are stored in plaintext.
        </p>

        {progress && progress.total > 0 && (
          <div className="cs-progress" aria-live="polite">
            <div className="cs-progress-bar">
              <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </div>
            <span className="muted">
              Encrypting starter files… {progress.done}/{progress.total}
            </span>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}

        <div className="ly-form-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={!clean || busy}>
            {busy ? <span className="spinner cs-spinner-sm" /> : <Icon name="plus" size={15} />}
            {busy ? 'Creating…' : 'Create codespace'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
