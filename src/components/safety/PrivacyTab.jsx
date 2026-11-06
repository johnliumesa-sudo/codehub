import { useEffect, useMemo, useState } from 'react';
import { unblock, useBlocks } from '../../lib/blocks.js';
import { TRUSTED_EVENT, TRUSTED_KEY, listTrusted, untrust } from '../../lib/linkguard.js';
import { useProfiles } from '../../lib/profiles.js';
import { Avatar } from '../layout/ui.jsx';
import './safety.css';

function useTrustedDomains() {
  const [list, setList] = useState(listTrusted);
  useEffect(() => {
    const refresh = () => setList(listTrusted());
    const onStorage = (e) => { if (!e.key || e.key === TRUSTED_KEY) refresh(); };
    window.addEventListener(TRUSTED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TRUSTED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return list;
}

/**
 * Settings → Privacy (F11 + F13): blocked users with Unblock, and this device's trusted link domains.
 * Props: user (Firebase user) or me ({ uid }).
 */
export default function PrivacyTab({ user, me }) {
  const uid = user?.uid || me?.uid || null;
  const blockedSet = useBlocks(uid);
  const blocked = useMemo(() => [...blockedSet], [blockedSet]);
  const profiles = useProfiles(blocked);
  const trusted = useTrustedDomains();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const sorted = useMemo(
    () => [...blocked].sort((a, b) => (profiles[a]?.name || a).localeCompare(profiles[b]?.name || b)),
    [blocked, profiles],
  );

  const doUnblock = async (other) => {
    setBusy(other);
    setError('');
    try {
      await unblock(uid, other);
    } catch (e) {
      setError(e?.message || 'Could not unblock');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-section sf-privacy">
      <div className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3 className="sf-card-title">Blocked users</h3>
            <p className="settings-note">
              Blocked people can&apos;t message you or react in your DMs, re-open your DM, send you friend requests,
              or add you to groups and codespaces — the database rules enforce this. In servers and groups you
              already share, their messages are hidden on your screen behind &ldquo;Show&rdquo;; that part is
              client-side only. They are not told that you blocked them.
            </p>
          </div>
        </div>
        {error && <p className="error-text">{error}</p>}
        {sorted.length === 0 ? (
          <p className="muted sf-empty">You haven&apos;t blocked anyone.</p>
        ) : (
          <ul className="sf-list">
            {sorted.map((other) => {
              const p = profiles[other];
              return (
                <li key={other} className="sf-row">
                  <Avatar profile={p} size={32} />
                  <span className="sf-row-text">
                    <span className="sf-row-name">{p?.name || '…'}</span>
                    <code className="sf-row-sub">{other}</code>
                  </span>
                  <button type="button" className="btn sm" disabled={busy === other} onClick={() => doUnblock(other)}>
                    {busy === other ? <span className="spinner sf-spinner-sm" /> : 'Unblock'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3 className="sf-card-title">Trusted link domains</h3>
            <p className="settings-note">
              Links to other sites ask for confirmation before opening. Domains you chose to always trust open
              directly. This list is stored only in this browser.
            </p>
          </div>
        </div>
        {trusted.length === 0 ? (
          <p className="muted sf-empty">No trusted domains yet.</p>
        ) : (
          <ul className="sf-list">
            {trusted.map((d) => (
              <li key={d} className="sf-row">
                <span className="sf-domain-chip">{d}</span>
                <span className="sf-row-text" />
                <button type="button" className="btn sm ghost" onClick={() => untrust(d)}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
