import { useState } from 'react';
import { clearVerified, useVerification } from '../../lib/verify.js';
import './safety.css';

/**
 * DM header verification state (F12).
 * Props:
 *  - me: uid or { uid }; peerUid; peerName
 *  - onReverify(): open the safety-number modal
 *  - variant: 'auto' (default: pill when verified, banner when changed) | 'pill' (only the Verified pill,
 *    for inside the header title) | 'banner' (only the red key-change banner, for below the header)
 */
export default function KeyChangeBanner({ me, peerUid, peerName, onReverify, variant = 'auto' }) {
  const v = useVerification(me, peerUid);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (v.status === 'verified' && variant !== 'banner') {
    return (
      <span className="sf-verified-pill" title={`You verified ${peerName || 'this person'}'s safety number${v.verifiedAt ? ` on ${new Date(v.verifiedAt).toLocaleDateString()}` : ''}. Key ${v.fp}`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
        Verified
      </span>
    );
  }
  if (v.status !== 'changed' || variant === 'pill') return null;

  const dismiss = async () => {
    setBusy(true);
    setError('');
    try {
      await clearVerified(me, peerUid);
    } catch (e) {
      setError(e?.message || 'Could not clear verification');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sf-keychange" role="alert">
      <span className="sf-keychange-icon" aria-hidden="true">!</span>
      <div className="sf-keychange-text">
        <strong>{peerName || 'This person'}&apos;s encryption key changed since you verified it.</strong>{' '}
        Verify the new safety number before sending sensitive info.
        {v.status === 'changed' && !v.fp && <span className="sf-keychange-sub"> Their account currently has no key.</span>}
        {error && <span className="sf-keychange-sub error-text"> {error}</span>}
      </div>
      <div className="sf-keychange-actions">
        {onReverify && <button type="button" className="btn sm primary" onClick={onReverify}>Re-verify</button>}
        <button type="button" className="btn sm ghost" disabled={busy} onClick={dismiss} title="Forget the old verification (marks this contact unverified)">
          Dismiss
        </button>
      </div>
    </div>
  );
}
