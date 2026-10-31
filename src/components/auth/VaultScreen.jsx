import { useCallback, useEffect, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import { get, ref, serverTimestamp, update } from 'firebase/database';
import { auth, db } from '../../lib/firebase.js';
import { createVault, hasVault, unlockVault } from '../../lib/keystore.js';
import { AVATAR_COLORS } from '../../lib/profiles.js';
import { stopPresence } from '../../lib/presence.js';
import { Logo, NAME_MAX, PasswordInput } from './AuthScreen.jsx';
import { MIN_PASSPHRASE, passphraseStrength } from './strength.js';
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

export function StrengthMeter({ value }) {
  const s = passphraseStrength(value);
  return (
    <div className="strength" aria-live="polite">
      <div className="strength-bars">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={i <= s.score ? `on s${s.score}` : ''} />
        ))}
      </div>
      <div className="strength-text">
        {s.label && <strong className={`s${s.score}`}>{s.label}</strong>}
        <span>{s.hint}</span>
      </div>
    </div>
  );
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

function Deriving({ label }) {
  return (
    <div className="vault-deriving" role="status">
      <div className="spinner" />
      <div>
        <strong>{label}</strong>
        <span className="muted">Running 600,000 rounds of PBKDF2 on your device…</span>
      </div>
    </div>
  );
}

export default function VaultScreen({ user, onUnlocked }) {
  const [phase, setPhase] = useState('checking'); // checking | error | create | unlock | reset-confirm
  const [resetting, setResetting] = useState(false); // create form is replacing an existing vault
  const [loadError, setLoadError] = useState('');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ack, setAck] = useState(false);
  const [resetWord, setResetWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const check = useCallback(async () => {
    setPhase('checking');
    setLoadError('');
    try {
      const exists = await hasVault(user.uid);
      if (mounted.current) setPhase(exists ? 'unlock' : 'create');
    } catch (e) {
      if (mounted.current) {
        setLoadError(e?.message || 'Could not reach the database.');
        setPhase('error');
      }
    }
  }, [user.uid]);

  useEffect(() => { check(); }, [check]);

  const go = (p) => {
    setPhase(p);
    setPass('');
    setConfirm('');
    setAck(false);
    setResetWord('');
    setError('');
  };

  async function doSignOut() {
    try {
      await stopPresence();
      await signOut(auth);
    } catch (e) {
      setError(e?.message || 'Sign out failed.');
    }
  }

  async function onUnlock(e) {
    e.preventDefault();
    if (busy || !pass) return;
    setBusy(true);
    setError('');
    // Let React paint the spinner before the CPU-heavy derivation starts.
    await new Promise((r) => setTimeout(r, 30));
    try {
      await unlockVault(user.uid, pass);
      ensureProfile(user);
      if (mounted.current) setPass('');
      onUnlocked();
    } catch (err) {
      if (mounted.current) {
        setError(err?.message === 'Wrong passphrase' ? 'That passphrase is incorrect.' : err?.message || 'Unlock failed.');
        setBusy(false);
      }
      return;
    }
  }

  const strength = passphraseStrength(pass);
  const canCreate = pass.length >= MIN_PASSPHRASE && strength.score >= 2 && pass === confirm && ack && !busy;

  async function onCreate(e) {
    e.preventDefault();
    if (!canCreate) {
      if (pass.length < MIN_PASSPHRASE) setError(`Use at least ${MIN_PASSPHRASE} characters.`);
      else if (strength.score < 2) setError('That passphrase is too easy to guess.');
      else if (pass !== confirm) setError('Passphrases do not match.');
      else if (!ack) setError('Please confirm you understand the passphrase cannot be recovered.');
      return;
    }
    setBusy(true);
    setError('');
    await new Promise((r) => setTimeout(r, 30));
    try {
      await ensureProfile(user); // createVault patches users/{uid}.pubKey; profile must exist first
      await createVault(user.uid, pass);
      if (mounted.current) { setPass(''); setConfirm(''); }
      onUnlocked();
    } catch (err) {
      if (mounted.current) {
        setError(err?.code === 'PERMISSION_DENIED' || /permission/i.test(err?.message || '')
          ? 'The database refused to save your vault (permission denied).'
          : err?.message || 'Could not create your vault.');
        setBusy(false);
      }
    }
  }

  const who = user.displayName || user.email;

  let body;
  if (phase === 'checking') {
    body = (
      <div className="vault-center"><div className="spinner" /><span className="muted">Checking your vault…</span></div>
    );
  } else if (phase === 'error') {
    body = (
      <>
        <h2>Can't load your vault</h2>
        <div className="auth-alert error">{loadError}</div>
        <button className="btn primary auth-submit" onClick={check}>Try again</button>
      </>
    );
  } else if (phase === 'unlock') {
    body = (
      <>
        <div className="vault-icon"><LockIcon /></div>
        <h2>Unlock your vault</h2>
        <p className="muted auth-sub">Enter your encryption passphrase to decrypt your keys on this device.</p>
        {busy ? (
          <Deriving label="Unlocking…" />
        ) : (
          <form onSubmit={onUnlock} className="auth-form">
            <label className="field">
              Encryption passphrase
              <PasswordInput value={pass} onChange={setPass} autoComplete="current-password" autoFocus id="vault-pass" />
            </label>
            {error && <div className="auth-alert error" role="alert">{error}</div>}
            <button className="btn primary auth-submit" disabled={!pass}>Unlock</button>
          </form>
        )}
        {!busy && (
          <div className="auth-switch">
            <button className="auth-link subtle" onClick={() => go('reset-confirm')}>Forgot your passphrase?</button>
          </div>
        )}
      </>
    );
  } else if (phase === 'reset-confirm') {
    body = (
      <>
        <div className="vault-icon danger"><LockIcon /></div>
        <h2>Reset encryption keys?</h2>
        <p className="muted auth-sub">
          Your passphrase is never sent to us, so it can't be recovered. You can start over with new keys, but:
        </p>
        <ul className="vault-consequences">
          <li>Existing encrypted messages, DMs and code you could read will become unreadable to you.</li>
          <li>You'll need fresh invite links to regain access to your servers.</li>
          <li>Your saved GitHub token will be erased.</li>
          <li>People you DM will see a new safety number.</li>
        </ul>
        <label className="field">
          Type RESET to continue
          <input className="input" value={resetWord} onChange={(e) => setResetWord(e.target.value)} autoFocus spellCheck={false} />
        </label>
        <div className="vault-row">
          <button className="btn ghost" onClick={() => go('unlock')}>Cancel</button>
          <button
            className="btn danger"
            disabled={resetWord.trim().toUpperCase() !== 'RESET'}
            onClick={() => { setResetting(true); go('create'); }}
          >
            Reset and create new keys
          </button>
        </div>
      </>
    );
  } else {
    // create
    body = (
      <>
        <div className="vault-icon"><LockIcon /></div>
        <h2>{resetting ? 'Choose a new passphrase' : 'Create your encryption passphrase'}</h2>
        <p className="muted auth-sub">
          This passphrase encrypts your private key. It's separate from your account password and never leaves this device.
        </p>
        {busy ? (
          <Deriving label="Generating your keys…" />
        ) : (
          <form onSubmit={onCreate} className="auth-form">
            <label className="field">
              Passphrase
              <PasswordInput value={pass} onChange={setPass} autoComplete="new-password" autoFocus placeholder="e.g. correct horse battery staple" />
            </label>
            <StrengthMeter value={pass} />
            <label className="field">
              Confirm passphrase
              <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
            </label>
            {confirm && pass !== confirm && <div className="error-text">Passphrases don't match.</div>}

            <div className="vault-warning">
              <strong>⚠ This cannot be recovered.</strong>
              <span>If you forget it, nobody — including us — can decrypt your messages. Store it in a password manager.</span>
            </div>
            <label className="vault-ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand that losing this passphrase means losing access to my encrypted data.</span>
            </label>

            {error && <div className="auth-alert error" role="alert">{error}</div>}
            <button className="btn primary auth-submit" disabled={!canCreate}>
              {resetting ? 'Reset keys' : 'Create vault'}
            </button>
            {resetting && (
              <button type="button" className="btn ghost" onClick={() => { setResetting(false); go('unlock'); }}>
                Never mind, I remember it
              </button>
            )}
          </form>
        )}
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
