import { useEffect, useState } from 'react';
import { keyFingerprint, safetyNumber } from '../../lib/crypto.js';
import { get, ref } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import { myPublicKey } from '../../lib/keystore.js';
import VerifyToggle from '../safety/VerifyToggle.jsx';

// Shows the DM safety number so both people can compare it out-of-band.
export default function SafetyNumberModal({ peerUid, peerName, onClose }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mine = myPublicKey();
        // Read the peer key live (not the session cache) so what is shown is what gets verified.
        const snap = await get(ref(db, `users/${peerUid}/pubKey`));
        if (!snap.exists()) throw new Error('This person has no encryption key yet');
        const theirs = snap.val();
        const [number, myFp, theirFp] = await Promise.all([safetyNumber(mine, theirs), keyFingerprint(mine), keyFingerprint(theirs)]);
        if (alive) setState({ number, myFp, theirFp });
      } catch (e) {
        if (alive) setState({ error: e?.message || 'Could not compute safety number' });
      }
    })();
    return () => { alive = false; };
  }, [peerUid]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal safety-modal">
        <h2>Verify end-to-end encryption</h2>
        <p className="muted">
          Messages with <b>{peerName || 'this person'}</b> are encrypted with a key only your two devices can derive.
          Compare this number with them in person or over a trusted channel. If it matches, nobody — including the
          server — can read or tamper with your conversation.
        </p>
        {state.loading && <div className="safety-loading"><div className="spinner" /></div>}
        {state.error && <p className="error-text">{state.error}</p>}
        {state.number && (
          <>
            <div className="safety-grid">
              {state.number.split(' ').map((g, i) => <span key={i}>{g}</span>)}
            </div>
            <div className="safety-fps">
              <div><span className="muted small">Your key</span><code>{state.myFp}</code></div>
              <div><span className="muted small">{peerName || 'Their'} key</span><code>{state.theirFp}</code></div>
            </div>
            <VerifyToggle peerUid={peerUid} peerName={peerName} shownFp={state.theirFp} />
            <p className="muted small">The number changes if either of you creates a new identity key.</p>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          {state.number && (
            <button type="button" className="btn ghost" onClick={() => navigator.clipboard?.writeText(state.number).catch(() => {})}>
              Copy number
            </button>
          )}
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
