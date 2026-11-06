import { useState } from 'react';
import { auth } from '../../lib/firebase.js';
import { clearVerified, markVerified, useVerification } from '../../lib/verify.js';
import './safety.css';

/**
 * "Mark as verified" switch for SafetyNumberModal (F12).
 * Props:
 *  - peerUid (required), peerName
 *  - me: uid or { uid } (defaults to the signed-in user)
 *  - shownFp: the peer fingerprint the modal displayed. If the live key differs, verifying is refused,
 *    because the user compared a number for a key that is no longer theirs.
 */
export default function VerifyToggle({ peerUid, peerName, me, shownFp }) {
  const myUid = (typeof me === 'string' ? me : me?.uid) || auth.currentUser?.uid || null;
  const v = useVerification(myUid, peerUid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!myUid || !peerUid) return null;
  const on = v.status === 'verified';
  const stale = shownFp && v.fp && shownFp !== v.fp;

  const toggle = async () => {
    setBusy(true);
    setError('');
    try {
      if (on) await clearVerified(myUid, peerUid);
      else await markVerified(myUid, peerUid, { expectFp: shownFp || undefined });
    } catch (e) {
      setError(e?.message || 'Could not update verification');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`sf-verify ${on ? 'on' : ''} ${v.status === 'changed' ? 'changed' : ''}`}>
      <label className="sf-switch-row">
        <span className="sf-switch">
          <input type="checkbox" checked={on} disabled={busy || v.status === 'loading' || v.status === 'nokey' || (!on && stale)} onChange={toggle} />
          <span className="sf-switch-track" aria-hidden="true"><span className="sf-switch-thumb" /></span>
        </span>
        <span className="sf-switch-text">
          <strong>Mark as verified</strong>
          <span className="muted small">
            {on && `You verified ${peerName || 'this person'}. You'll be warned if their key changes.`}
            {v.status === 'unverified' && 'Turn on after the numbers match on both devices.'}
            {v.status === 'changed' && `Their key changed since you last verified. Compare the new number, then turn this on again.`}
            {v.status === 'nokey' && 'This person has no encryption key right now.'}
            {v.status === 'loading' && 'Checking…'}
          </span>
        </span>
      </label>
      {stale && !on && <p className="error-text sf-verify-err">Their key changed while this window was open. Close it and reopen to compare the new number.</p>}
      {error && <p className="error-text sf-verify-err">{error}</p>}
    </div>
  );
}
