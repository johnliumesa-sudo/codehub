import { useCallback, useEffect, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import { get, ref, serverTimestamp, update } from 'firebase/database';
import { auth, db } from '../../lib/firebase.js';
import { createVault, migrateLegacyVault, openVault } from '../../lib/keystore.js';
import { AVATAR_COLORS } from '../../lib/profiles.js';
import { stopPresence } from '../../lib/presence.js';
import { Logo, NAME_MAX, PasswordInput } from './AuthScreen.jsx';
import './auth.css';

// Make sure users/{uid} has a name/color (e.g. if the sign-up profile write failed).
// Runs only on user action, so it can't race the sign-up write.
async function ensureProfile(user) {
  try {
    const snap = await get(ref(db, `users/${user.uid}`));
    const v = snap.val() || {};
    if (v.name && v.color) return;
    const patch = {};
    if (!v.name) patch.name = (user.displayName || user.email?.split('@')[0] || 'New user').slice(0, NAME_MAX);
    if (!v.color) patch.color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    if (!v.createdAt) patch.createdAt = serverTimestamp();
    await update(ref(db, `users/${user.uid}`), patch);
  } catch (e) {
    console.warn('[vault] could not repair profile', e);
  }
}

function LockIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 018 0v3" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

const denied = (e) => e?.code === 'PERMISSION_DENIED' || /permission/i.test(e?.message || '');

/**
 * Unlocks the user's keys right after sign-in. New users get keys generated automatically.
 * Only accounts created before auto-unlock (passphrase vaults) see a one-time prompt, after which
 * their vault is converted and never asks again.
 */
export default function VaultScreen({ user, onUnlocked }) {
  const [phase, setPhase] = useState('checking'); // checking | error | legacy | reset-confirm
  const [loadError, setLoadError] = useState('');
  const [pass, setPass] = useState('');
  const [resetWord, setResetWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const unlockedRef = useRef(onUnlocked);
  unlockedRef.current = onUnlocked;

  const start = useCallback(async () => {
    setPhase('checking');
    setLoadError('');
    try {
      await ensureProfile(user); // createVault patches users/{uid}.pubKey; the profile must exist first
      const ok = await openVault(user.uid);
      if (!mounted.current) return;
      if (ok) unlockedRef.current();
      else setPhase('legacy');
    } catch (e) {
      if (mounted.current) {
        setLoadError(denied(e) ? 'The database refused access to your keys (permission denied). Make sure the latest database rules are published.' : e?.message || 'Could not reach the database.');
        setPhase('error');
      }
    }
  }, [user]);

  useEffect(() => { start(); }, [start]);

  async function doSignOut() {
    try {
      await stopPresence();
      await signOut(auth);
    } catch (e) {
      setError(e?.message || 'Sign out failed.');
    }
  }

  async function onMigrate(e) {
    e.preventDefault();
    if (busy || !pass) return;
    setBusy(true);
    setError('');
    await new Promise((r) => setTimeout(r, 30)); // paint the spinner before PBKDF2 runs
    try {
      await migrateLegacyVault(user.uid, pass);
      onUnlocked();
    } catch (err) {
      if (mounted.current) {
        setError(err?.message === 'Wrong passphrase' ? 'That passphrase is incorrect.' : err?.message || 'Unlock failed.');
        setBusy(false);
      }
    }
  }

  async function onReset() {
    setBusy(true);
    setError('');
    try {
      await createVault(user.uid);
      onUnlocked();
    } catch (err) {
      if (mounted.current) {
        setError(err?.message || 'Could not create new keys.');
        setBusy(false);
      }
    }
  }

  const who = user.displayName || user.email;

  let body;
  if (phase === 'checking') {
    body = (
      <div className="vault-center"><div className="spinner" /><span className="muted">Unlocking your encrypted workspace…</span></div>
    );
  } else if (phase === 'error') {
    body = (
      <>
        <h2>Can't load your keys</h2>
        <div className="auth-alert error">{loadError}</div>
        <button className="btn primary auth-submit" onClick={start}>Try again</button>
      </>
    );
  } else if (phase === 'legacy') {
    body = (
      <>
        <div className="vault-icon"><LockIcon /></div>
        <h2>One-time upgrade</h2>
        <p className="muted auth-sub">
          Codehub no longer needs a separate passphrase. Enter your old encryption passphrase once and
          you'll be signed straight in from now on.
        </p>
        {busy ? (
          <div className="vault-deriving" role="status"><div className="spinner" /><strong>Upgrading…</strong></div>
        ) : (
          <form onSubmit={onMigrate} className="auth-form">
            <label className="field">
              Old encryption passphrase
              <PasswordInput value={pass} onChange={setPass} autoComplete="current-password" autoFocus id="vault-pass" />
            </label>
            {error && <div className="auth-alert error" role="alert">{error}</div>}
            <button className="btn primary auth-submit" disabled={!pass}>Continue</button>
          </form>
        )}
        {!busy && (
          <div className="auth-switch">
            <button className="auth-link subtle" onClick={() => { setError(''); setPhase('reset-confirm'); }}>I don't remember it</button>
          </div>
        )}
      </>
    );
  } else {
    body = (
      <>
        <div className="vault-icon danger"><LockIcon /></div>
        <h2>Start over with new keys?</h2>
        <ul className="vault-consequences">
          <li>Messages, DMs and code encrypted for your old keys become unreadable to you.</li>
          <li>You'll need fresh invites to regain access to your servers.</li>
          <li>Your saved GitHub token will be erased.</li>
          <li>People you DM will see a new safety number.</li>
        </ul>
        <label className="field">
          Type RESET to continue
          <input className="input" value={resetWord} onChange={(e) => setResetWord(e.target.value)} autoFocus spellCheck={false} />
        </label>
        {error && <div className="auth-alert error" role="alert">{error}</div>}
        <div className="vault-row">
          <button className="btn ghost" onClick={() => setPhase('legacy')} disabled={busy}>Cancel</button>
          <button className="btn danger" disabled={busy || resetWord.trim().toUpperCase() !== 'RESET'} onClick={onReset}>
            Create new keys
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="auth-root">
      <div className="auth-glow" aria-hidden="true" />
      <main className="auth-card vault-card">
        <div className="vault-top">
          <div className="vault-brand"><Logo size={28} /><span className="auth-wordmark sm">Codehub</span></div>
          <span className="badge-e2e">🔒 End-to-end encrypted</span>
        </div>
        {body}
        <div className="vault-footer">
          <span className="muted">Signed in as <strong>{who}</strong></span>
          <button className="auth-link" onClick={doSignOut} disabled={busy}>Sign out</button>
        </div>
      </main>
    </div>
  );
}
