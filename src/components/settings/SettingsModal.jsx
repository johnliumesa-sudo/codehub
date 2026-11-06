import { useEffect, useRef, useState } from 'react';
import { sendPasswordResetEmail, signOut, updateProfile } from 'firebase/auth';
import { ref, update } from 'firebase/database';
import { auth, db } from '../../lib/firebase.js';
import { keyFingerprint } from '../../lib/crypto.js';
import { loadGithubToken, myPublicKey, saveGithubToken } from '../../lib/keystore.js';
import { AVATAR_COLORS, initials, useProfile } from '../../lib/profiles.js';
import { stopPresence } from '../../lib/presence.js';
import { deleteAccount, reauthenticate, signInMethod } from '../../lib/account.js';
import { NAME_MAX, PasswordInput, authErrorMessage } from '../auth/AuthScreen.jsx';
import AddonsTab from '../shop/AddonsTab.jsx';
import PromoTab from '../admin/PromoTab.jsx';
import PrivacyTab from '../safety/PrivacyTab.jsx';
import NotificationsTab from '../safety/NotificationsTab.jsx';
import './settings.css';

const STATUS_MAX = 128;

const TABS = [
  ['profile', 'My profile'],
  ['security', 'Encryption & keys'],
  ['privacy', 'Privacy'],
  ['notifications', 'Notifications'],
  ['github', 'GitHub'],
  ['addons', 'Add-ons'],
  ['admin', 'Codes & admin'],
  ['account', 'Account'],
];

function useMounted() {
  const m = useRef(true);
  useEffect(() => () => { m.current = false; }, []);
  return m;
}

// ---------------- Profile ----------------

function ProfileTab({ user }) {
  const profile = useProfile(user.uid);
  const [name, setName] = useState('');
  const [color, setColor] = useState(AVATAR_COLORS[0]);
  const [status, setStatus] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {ok, text}
  const mounted = useMounted();

  useEffect(() => {
    if (profile && !loaded) {
      setName(profile.name === 'Unknown user' ? '' : profile.name || '');
      setColor(profile.color || AVATAR_COLORS[0]);
      setStatus(profile.status || '');
      setLoaded(true);
    }
  }, [profile, loaded]);

  if (!loaded) return <div className="settings-loading"><div className="spinner" /></div>;

  const cleanName = name.trim().replace(/\s+/g, ' ');
  const cleanStatus = status.trim();
  const dirty = cleanName !== (profile?.name || '') || color !== profile?.color || cleanStatus !== (profile?.status || '');

  async function save(e) {
    e.preventDefault();
    if (!cleanName) return setMsg({ ok: false, text: 'Display name cannot be empty.' });
    setBusy(true);
    setMsg(null);
    try {
      await update(ref(db, `users/${user.uid}`), { name: cleanName, color, status: cleanStatus || null });
      updateProfile(user, { displayName: cleanName }).catch(() => {});
      if (mounted.current) setMsg({ ok: true, text: 'Profile saved.' });
    } catch (err) {
      if (mounted.current) setMsg({ ok: false, text: err?.message || 'Could not save profile.' });
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="settings-section">
      <div className="profile-preview">
        <div className="profile-banner" style={{ background: `linear-gradient(135deg, ${color}, ${color}55)` }} />
        <div className="profile-preview-body">
          <span className="avatar profile-avatar" style={{ background: color }}>{initials(cleanName || '?')}</span>
          <div className="profile-preview-text">
            <strong>{cleanName || 'Your name'}</strong>
            <span className="muted">{cleanStatus || 'No status set'}</span>
          </div>
        </div>
      </div>

      <label className="field">
        Display name
        <input className="input" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="field">
        Avatar color
        <div className="swatches" role="radiogroup" aria-label="Avatar color">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={c}
              className={`swatch${c === color ? ' on' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>

      <label className="field">
        <span className="settings-label-row">Status <span className="settings-count">{status.length}/{STATUS_MAX}</span></span>
        <input
          className="input"
          value={status}
          maxLength={STATUS_MAX}
          placeholder="What are you working on?"
          onChange={(e) => setStatus(e.target.value)}
        />
      </label>
      <p className="settings-note">Your name, color and status are public to other Codehub users (not encrypted).</p>

      <div className="settings-actions">
        {msg && <span className={msg.ok ? 'settings-ok' : 'error-text'}>{msg.text}</span>}
        <button className="btn primary" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save changes'}</button>
      </div>
    </form>
  );
}

// ---------------- Security ----------------

function SecurityTab() {
  const [fp, setFp] = useState('');
  const [copied, setCopied] = useState(false);
  const mounted = useMounted();

  useEffect(() => {
    const pub = myPublicKey();
    if (!pub) return;
    keyFingerprint(pub).then((f) => mounted.current && setFp(f)).catch(() => {});
  }, [mounted]);

  async function copyFp() {
    try {
      await navigator.clipboard.writeText(fp);
      setCopied(true);
      setTimeout(() => mounted.current && setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  return (
    <div className="settings-section">
      <div className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Identity key fingerprint</h3>
            <p className="muted">Compare this with a contact out-of-band to confirm it's really you.</p>
          </div>
          <span className="badge-e2e">🔒 E2EE</span>
        </div>
        <div className="fingerprint-row">
          <code className="fingerprint">{fp || '…'}</code>
          <button type="button" className="btn sm" onClick={copyFp} disabled={!fp}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div>
      <div className="settings-card">
        <h3>How your keys are stored</h3>
        <p className="muted">
          Your private key is unlocked automatically when you sign in, so there's no extra passphrase.
          Messages are still encrypted on your device and the server stores only ciphertext. The key
          that unlocks your private key is readable only by your account.
        </p>
      </div>
    </div>
  );
}

// ---------------- GitHub ----------------

async function testToken(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (res.status === 401) throw new Error('GitHub rejected this token (401 Unauthorized).');
  if (!res.ok) throw new Error(`GitHub responded with ${res.status}.`);
  const data = await res.json();
  return { login: data.login, name: data.name, avatar: data.avatar_url, scopes: res.headers.get('x-oauth-scopes') };
}

function maskToken(t) {
  if (!t) return '';
  return t.length <= 10 ? '••••••' : `${t.slice(0, 4)}••••••••${t.slice(-4)}`;
}

function GithubTab() {
  const [saved, setSaved] = useState(undefined); // undefined = loading, null = none
  const [loadErr, setLoadErr] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [account, setAccount] = useState(null);
  const mounted = useMounted();

  useEffect(() => {
    loadGithubToken()
      .then((t) => mounted.current && setSaved(t))
      .catch((e) => {
        if (!mounted.current) return;
        setSaved(null);
        setLoadErr(e?.message || 'Could not decrypt the saved token.');
      });
  }, [mounted]);

  async function run(kind, fn) {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
    } catch (err) {
      if (mounted.current) setMsg({ ok: false, text: err?.message || 'Something went wrong.' });
    } finally {
      if (mounted.current) setBusy('');
    }
  }

  const onTest = () =>
    run('test', async () => {
      const t = input.trim() || saved;
      if (!t) throw new Error('Enter a token first.');
      const info = await testToken(t);
      if (!mounted.current) return;
      setAccount(info);
      setMsg({ ok: true, text: `Token works — authenticated as @${info.login}.` });
    });

  const onSave = () =>
    run('save', async () => {
      const t = input.trim();
      if (!t) throw new Error('Enter a token first.');
      await saveGithubToken(t);
      if (!mounted.current) return;
      setSaved(t);
      setInput('');
      setLoadErr('');
      setMsg({ ok: true, text: 'Token encrypted and saved to your vault.' });
    });

  const onClear = () =>
    run('clear', async () => {
      await saveGithubToken(null);
      if (!mounted.current) return;
      setSaved(null);
      setAccount(null);
      setMsg({ ok: true, text: 'Token removed.' });
    });

  return (
    <div className="settings-section">
      <div className="settings-card">
        <h3>Personal access token</h3>
        <p className="muted">
          Used by the Collab tab to read private repos, commit, create branches and open pull requests. It's encrypted with
          your vault key — the server only stores ciphertext. Public repos work without a token.
        </p>
        <p className="settings-note">
          Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">fine-grained token</a>{' '}
          with <em>Contents</em> and <em>Pull requests</em> read/write on the repos you want, or a classic token with the <code>repo</code> scope.
        </p>

        {saved === undefined ? (
          <div className="settings-loading sm"><div className="spinner" /></div>
        ) : saved ? (
          <div className="gh-saved">
            <span className="gh-dot" />
            <span>Saved token <code>{maskToken(saved)}</code></span>
            <button type="button" className="btn sm danger" onClick={onClear} disabled={!!busy}>{busy === 'clear' ? 'Removing…' : 'Remove'}</button>
          </div>
        ) : (
          <div className="gh-saved none"><span className="gh-dot off" /><span className="muted">No token saved</span></div>
        )}
        {loadErr && <div className="error-text">{loadErr}</div>}

        <label className="field">
          {saved ? 'Replace token' : 'Token'}
          <PasswordInput value={input} onChange={setInput} autoComplete="off" placeholder="github_pat_… or ghp_…" />
        </label>

        {account && (
          <div className="gh-account">
            {account.avatar && <img src={account.avatar} alt="" />}
            <div>
              <strong>{account.name || account.login}</strong>
              <span className="muted">@{account.login}{account.scopes ? ` · scopes: ${account.scopes}` : ''}</span>
            </div>
          </div>
        )}

        <div className="settings-actions">
          {msg && <span className={msg.ok ? 'settings-ok' : 'error-text'}>{msg.text}</span>}
          <button type="button" className="btn" onClick={onTest} disabled={!!busy || (!input.trim() && !saved)}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          <button type="button" className="btn primary" onClick={onSave} disabled={!!busy || !input.trim()}>
            {busy === 'save' ? 'Saving…' : 'Save token'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- Account ----------------

function AccountTab({ user, onClose }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const mounted = useMounted();

  async function resetPw() {
    setBusy('reset');
    setMsg(null);
    try {
      await sendPasswordResetEmail(auth, user.email);
      if (mounted.current) setMsg({ ok: true, text: `Password reset link sent to ${user.email}.` });
    } catch (err) {
      if (mounted.current) setMsg({ ok: false, text: authErrorMessage(err) });
    } finally {
      if (mounted.current) setBusy('');
    }
  }

  async function doSignOut() {
    setBusy('signout');
    try {
      await stopPresence();
      await signOut(auth);
      onClose && onClose();
    } catch (err) {
      if (mounted.current) {
        setMsg({ ok: false, text: err?.message || 'Sign out failed.' });
        setBusy('');
      }
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-card">
        <h3>Account</h3>
        <dl className="settings-dl">
          <dt>Email</dt><dd>{user.email}</dd>
          <dt>User ID</dt><dd><code>{user.uid}</code></dd>
        </dl>
      </div>
      <div className="settings-card row">
        <div>
          <h3>Account password</h3>
          <p className="muted">We'll email you a link to set a new sign-in password. Your encryption keys are unaffected.</p>
        </div>
        <button type="button" className="btn" onClick={resetPw} disabled={!!busy}>{busy === 'reset' ? 'Sending…' : 'Send reset link'}</button>
      </div>
      <div className="settings-card row danger-zone">
        <div>
          <h3>Sign out</h3>
          <p className="muted">Locks your vault and signs you out of this browser.</p>
        </div>
        <button type="button" className="btn danger" onClick={doSignOut} disabled={!!busy}>{busy === 'signout' ? 'Signing out…' : 'Sign out'}</button>
      </div>
      {msg && <div className={msg.ok ? 'settings-ok' : 'error-text'}>{msg.text}</div>}
      <DeleteAccount user={user} disabled={!!busy} />
    </div>
  );
}

function DeleteAccount({ user, disabled }) {
  const method = signInMethod(user);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState('');
  const [error, setError] = useState('');
  const mounted = useMounted();
  const ready = confirm.trim().toUpperCase() === 'DELETE' && (method !== 'password' || password);

  async function run(e) {
    e.preventDefault();
    if (!ready || step) return;
    setError('');
    try {
      setStep('Confirming it’s you…');
      await reauthenticate(password);
      // On success the auth listener signs the app out and unmounts this modal.
      await deleteAccount((t) => mounted.current && setStep(t));
    } catch (err) {
      if (!mounted.current) return;
      setStep('');
      setError(err?.code ? authErrorMessage(err) : err?.message || 'Deleting your account failed. Try again.');
    }
  }

  if (!open) {
    return (
      <div className="settings-card row danger-zone">
        <div>
          <h3>Delete account</h3>
          <p className="muted">Permanently deletes your account, your messages and DMs, and any servers you own.</p>
        </div>
        <button type="button" className="btn danger" onClick={() => setOpen(true)} disabled={disabled}>Delete account…</button>
      </div>
    );
  }
  return (
    <form className="settings-card danger-zone settings-form" onSubmit={run}>
      <div>
        <h3>Delete account</h3>
        <p className="muted">
          This can’t be undone. It removes your profile, keys and friends; every message you sent in servers; your
          direct-message conversations (for both people); and the servers you own, with all their channels and files.
        </p>
      </div>
      <label className="field">
        <span>Type DELETE to confirm</span>
        <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" autoFocus disabled={!!step} />
      </label>
      {method === 'password' && (
        <label className="field">
          <span>Password</span>
          <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
        </label>
      )}
      {method === 'google' && <p className="settings-note">You’ll be asked to sign in with Google again.</p>}
      {error && <div className="error-text">{error}</div>}
      <div className="settings-actions">
        <span className="muted">{step}</span>
        <button type="button" className="btn ghost" onClick={() => { setOpen(false); setConfirm(''); setPassword(''); setError(''); }} disabled={!!step}>Cancel</button>
        <button type="submit" className="btn danger" disabled={!ready || !!step}>{step ? 'Deleting…' : 'Delete my account'}</button>
      </div>
    </form>
  );
}

// ---------------- Modal ----------------

/**
 * Props:
 *  - user: Firebase auth user (required)
 *  - onClose(): close the modal (required)
 *  - initialTab: optional 'profile' | 'security' | 'github' | 'account'
 */
export default function SettingsModal({ user, onClose, initialTab = 'profile', onOpenShop, onOpenAdmin, describeScope }) {
  const [tab, setTab] = useState(TABS.some(([id]) => id === initialTab) ? initialTab : 'profile');
  const profile = useProfile(user?.uid);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!user) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav">
          <div className="settings-me">
            <span className="avatar" style={{ background: profile?.color || '#777', width: 32, height: 32, fontSize: 13 }}>
              {initials(profile?.name || user.email || '?')}
            </span>
            <div>
              <strong>{profile?.name || '…'}</strong>
              <span className="muted">{user.email}</span>
            </div>
          </div>
          <div className="settings-nav-label">User settings</div>
          {TABS.map(([id, label]) => (
            <button key={id} className={`settings-nav-item${tab === id ? ' on' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <section className="settings-body">
          <header className="settings-head">
            <h2>{TABS.find(([id]) => id === tab)[1]}</h2>
            <button className="settings-close" onClick={onClose} aria-label="Close settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>
          <div className="settings-scroll">
            {tab === 'profile' && <ProfileTab user={user} />}
            {tab === 'security' && <SecurityTab />}
            {tab === 'privacy' && <PrivacyTab user={user} />}
            {tab === 'notifications' && <NotificationsTab user={user} describeScope={describeScope} />}
            {tab === 'github' && <GithubTab />}
            {tab === 'addons' && <AddonsTab me={{ ...(profile || {}), uid: user.uid }} onOpenShop={onOpenShop} />}
            {tab === 'admin' && <PromoTab user={user} onOpenAdmin={onOpenAdmin} />}
            {tab === 'account' && <AccountTab user={user} onClose={onClose} />}
          </div>
        </section>
      </div>
    </div>
  );
}
