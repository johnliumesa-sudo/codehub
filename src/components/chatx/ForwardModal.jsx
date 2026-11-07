// Forward a message. Props: body (decrypted), fromName, me, targets (conversation descriptors the
// user can post in: [{kind, sid,cid | dmId,peerUid | gid,epoch, title, scope}]), onClose,
// onDone?(conv, { mid }) after the server accepted the forwarded copy.
import { useMemo, useState } from 'react';
import { Modal } from '../layout/ui.jsx';
import { forwardMessage } from '../../lib/chatx/forward.js';
import './chatx.css';

export default function ForwardModal({ body, fromName, me, targets = [], onClose, onDone }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return targets.filter((t) => !n || (t.title || '').toLowerCase().includes(n));
  }, [targets, q]);

  async function send(t, idx) {
    setBusy(String(idx));
    setErr('');
    try {
      const res = await forwardMessage(t, me, body, fromName);
      onDone?.(t, res);
      onClose();
    } catch (e) {
      setErr(e?.message || 'Could not forward.');
      setBusy('');
    }
  }

  return (
    <Modal title="Forward message" onClose={onClose}>
      <div className="cx-fwd-preview">
        <span className="cx-fwd-from">{fromName}</span>
        <div className="cx-fwd-text">{(body?.text || body?.code?.filename || 'Code snippet').slice(0, 200)}</div>
      </div>
      <input className="cx-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" />
      <ul className="cx-list" role="list">
        {list.map((t, i) => (
          <li key={`${t.scope || t.title}-${i}`} className="cx-list-row">
            <span className="cx-list-title">{t.kind === 'channel' ? '# ' : ''}{t.title}</span>
            <button type="button" className="btn primary sm" disabled={!!busy} onClick={() => send(t, i)}>
              {busy === String(i) ? 'Sending' : 'Send'}
            </button>
          </li>
        ))}
        {!list.length && <li className="cx-empty">No conversations found.</li>}
      </ul>
      {err && <div className="cx-err" role="alert">{err}</div>}
    </Modal>
  );
}
