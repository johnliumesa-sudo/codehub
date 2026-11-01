import { useEffect, useRef, useState } from 'react';
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  updateProfile,
} from 'firebase/auth';
import { ref, serverTimestamp, set } from 'firebase/database';
import { auth, db } from '../../lib/firebase.js';
import { AVATAR_COLORS } from '../../lib/profiles.js';
import './auth.css';

export const NAME_MAX = 32;

export function authErrorMessage(e) {
  switch (e?.code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.';
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return 'That email address looks invalid.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Try signing in.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'Password is too weak. Use at least 8 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in is not enabled for this project.';
    case 'auth/unauthorized-domain':
      return 'Google sign-in is not allowed on this domain yet. Add it under Firebase Authentication → Settings → Authorized domains.';
    case 'auth/account-exists-with-different-credential':
      return 'An account with this email already exists. Sign in with email and password.';
    case 'auth/requires-recent-login':
      return 'Please sign in again to do that.';
    default:
      return e?.message?.replace(/^Firebase:\s*/, '') || 'Something went wrong.';
  }
}

export function Logo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="chLogoG" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b8cff" />
          <stop offset="1" stopColor="#a66bff" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#chLogoG)" />
      <path d="M16 13l-7 7 7 7M24 13l7 7-7 7" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EyeToggle({ shown, onClick }) {
  return (
    <button type="button" className="auth-eye" onClick={onClick} aria-label={shown ? 'Hide password' : 'Show password'} tabIndex={-1}>
      {shown ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A10 10 0 0112 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.5M6.6 6.6C4.4 8 2.8 10.2 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5-1.5" /></svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
      )}
    </button>
  );
}

export function PasswordInput({ value, onChange, autoComplete, placeholder, autoFocus, id }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="auth-pw">
      <input
        id={id}
        className="input"
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        required
      />
      <EyeToggle shown={shown} onClick={() => setShown((s) => !s)} />
    </div>
  );
}

const FEATURES = [
  ['🔐', 'End-to-end encrypted', 'Messages, channel names and code are encrypted on your device. The server only sees ciphertext.'],
  ['💬', 'Servers, channels & DMs', 'Markdown, code blocks, reactions, replies and emoji — everything you expect.'],
  ['🧑‍💻', 'Live code collaboration', 'Edit together in real time with cursors, then commit straight to GitHub.'],
];

export default function AuthScreen() {
  const [mode, setMode] = useState('signin'); // signin | signup | reset
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const switchMode = (m) => {
    setMode(m);
    setError('');
    setNotice('');
    setPassword('');
    setConfirm('');
  };

  async function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setNotice('');
    const mail = email.trim();

    if (mode === 'signup') {
      const displayName = name.trim().replace(/\s+/g, ' ');
      if (!displayName) return setError('Pick a display name.');
      if (displayName.length > NAME_MAX) return setError(`Display name must be ${NAME_MAX} characters or less.`);
      if (password.length < 8) return setError('Password must be at least 8 characters.');
      if (password !== confirm) return setError('Passwords do not match.');
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        await signInWithEmailAndPassword(auth, mail, password);
        // App's onAuthStateChanged takes over from here.
      } else if (mode === 'signup') {
        const displayName = name.trim().replace(/\s+/g, ' ');
        const cred = await createUserWithEmailAndPassword(auth, mail, password);
        const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
        await Promise.allSettled([
          updateProfile(cred.user, { displayName }),
          set(ref(db, `users/${cred.user.uid}`), { name: displayName, color, createdAt: serverTimestamp() }),
        ]);
        // VaultScreen repairs users/{uid} if this write failed.
      } else {
        try {
          await sendPasswordResetEmail(auth, mail);
        } catch (err) {
          // Don't reveal whether an account exists.
          if (err?.code !== 'auth/user-not-found') throw err;
        }
        if (mounted.current) setNotice(`If an account exists for ${mail}, a reset link is on its way. Check your inbox (and spam).`);
      }
    } catch (err) {
      if (mounted.current) setError(authErrorMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function onGoogle() {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
      // VaultScreen creates users/{uid} from the Google display name.
    } catch (err) {
      if (err?.code === 'auth/popup-blocked') {
        await signInWithRedirect(auth, provider).catch((e) => mounted.current && setError(authErrorMessage(e)));
        return;
      }
      if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request' && mounted.current) {
        setError(authErrorMessage(err));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const titles = {
    signin: ['Welcome back', 'Sign in to pick up where you left off.'],
    signup: ['Create your account', 'It takes less than a minute.'],
    reset: ['Reset your password', "We'll email you a link to choose a new one."],
  };

  return (
    <div className="auth-root">
      <div className="auth-glow" aria-hidden="true" />
      <div className="auth-shell">
        <aside className="auth-brand">
          <div className="auth-brand-head">
            <Logo size={44} />
            <span className="auth-wordmark">Codehub</span>
          </div>
          <h1 className="auth-tagline">Chat and code together.<br /><span>Privately.</span></h1>
          <ul className="auth-features">
            {FEATURES.map(([icon, title, body]) => (
              <li key={title}>
                <span className="auth-feature-icon">{icon}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <main className="auth-card">
          <div className="auth-mobile-logo"><Logo size={36} /><span className="auth-wordmark">Codehub</span></div>
          <h2>{titles[mode][0]}</h2>
          <p className="muted auth-sub">{titles[mode][1]}</p>

          {mode !== 'reset' && (
            <>
              <button type="button" className="btn auth-google" onClick={onGoogle} disabled={busy}>
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                  <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                  <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
                </svg>
                Continue with Google
              </button>
              <div className="auth-or"><span>or use email</span></div>
            </>
          )}

          <form onSubmit={onSubmit} className="auth-form" noValidate>
            {mode === 'signup' && (
              <label className="field">
                Display name
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={NAME_MAX}
                  autoComplete="nickname"
                  placeholder="How others will see you"
                  autoFocus
                  required
                />
              </label>
            )}
            <label className="field">
              Email
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                autoFocus={mode !== 'signup'}
                required
              />
            </label>
            {mode !== 'reset' && (
              <label className="field">
                <span className="auth-label-row">
                  Password
                  {mode === 'signin' && (
                    <button type="button" className="auth-link" onClick={() => switchMode('reset')}>Forgot password?</button>
                  )}
                </span>
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  placeholder={mode === 'signup' ? 'At least 8 characters' : ''}
                />
              </label>
            )}
            {mode === 'signup' && (
              <label className="field">
                Confirm password
                <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
              </label>
            )}

            {error && <div className="auth-alert error" role="alert">{error}</div>}
            {notice && <div className="auth-alert ok" role="status">{notice}</div>}

            <button className="btn primary auth-submit" disabled={busy || !email.trim() || (mode !== 'reset' && !password)}>
              {busy ? <span className="spinner sm" /> : null}
              {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
            </button>
          </form>

          {mode === 'signup' && (
            <p className="auth-fine">
              Your account password signs you in. After this you'll set a separate <strong>encryption passphrase</strong> that never leaves your device.
            </p>
          )}

          <div className="auth-switch">
            {mode === 'signin' && (<>New to Codehub? <button className="auth-link" onClick={() => switchMode('signup')}>Create an account</button></>)}
            {mode === 'signup' && (<>Already have an account? <button className="auth-link" onClick={() => switchMode('signin')}>Sign in</button></>)}
            {mode === 'reset' && (<button className="auth-link" onClick={() => switchMode('signin')}>← Back to sign in</button>)}
          </div>
        </main>
      </div>
    </div>
  );
}
