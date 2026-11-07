// Shared bits of the assistant UI: Markdown through the app's DOMPurify renderer, the per-account
// session hook, the key setup / unlock card and small formatting helpers.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderMarkdown } from '../../../lib/markdown.js';
import { Modal } from '../../../components/layout/ui.jsx';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { ensureUser, keyState, useSession } from '../lib/session.js';
import { unlock } from '../lib/actions.js';

/** Assistant text as Markdown: renderMarkdown() sanitizes with DOMPurify (raw HTML shows as text). */
export function Markdown({ text, className = '' }) {
  const html = useMemo(() => renderMarkdown(String(text || '')), [text]);
  const onClick = (e) => {
    const btn = e.target.closest?.('.md-copy');
    if (!btn) return;
    const code = btn.closest('.md-code')?.querySelector('code')?.textContent ?? '';
    navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('done');
      }, 1400);
    }).catch(() => {});
  };
  // Sanitized by DOMPurify in renderMarkdown().
  return <div className={`md asst-md ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The session for this account (switches accounts in an effect, never during render). */
export function useAssistant(uid) {
  useEffect(() => {
    ensureUser(uid);
  }, [uid]);
  const s = useSession();
  return s.uid === uid ? s : null;
}

export const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString() : '0');

/** Copy text to the clipboard; resolves true when it worked. */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(String(text ?? ''));
    return true;
  } catch {
    return false;
  }
}

/**
 * Shown where the assistant needs a key: a setup hint when none is saved, an unlock form when the key
 * is locked with a passphrase. Renders nothing when the key is ready.
 */
export function KeyGate({ session, compact = false }) {
  const ws = useWorkspaceCtx();
  const state = keyState(session);
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (state === 'ready') return null;
  if (state === 'none') {
    return (
      <div className="asst-gate" role="note">
        <strong>Connect Claude</strong>
        <p>The assistant uses your own Anthropic API key, kept only in this browser. Nothing is sent until you use an assistant action.</p>
        {ws?.openSettings && (
          <button type="button" className="btn primary sm" onClick={() => ws.openSettings('assistant')}>Add API key</button>
        )}
      </div>
    );
  }
  const onSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await unlock(pass);
      setPass('');
    } catch (ex) {
      setErr(ex?.message || 'Could not unlock the key.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`asst-gate${compact ? ' compact' : ''}`} onSubmit={onSubmit}>
      <strong>Unlock your API key</strong>
      <p>Your key{session.record?.hint ? ` (${session.record.hint})` : ''} is locked with a passphrase. It stays unlocked until you reload or lock Codehub.</p>
      <label className="asst-field">
        <span>Passphrase</span>
        <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" aria-label="Assistant key passphrase" />
      </label>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="asst-row end">
        <button type="submit" className="btn primary sm" disabled={busy || !pass}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </div>
    </form>
  );
}

/** The app's Modal, rendered at the document root so no ancestor can clip or offset it. */
export function PortalModal(props) {
  if (typeof document === 'undefined') return null;
  return createPortal(<Modal {...props} />, document.body);
}
