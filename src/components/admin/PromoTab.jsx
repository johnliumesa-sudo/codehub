import { useEffect, useRef, useState } from 'react';
import { PROMO_MAX, promoCooldownLeft, redeemPromo, setAdminBadgeVisible, useAdminBadge, useAppAdminState } from '../../lib/admin.js';
import AdminPanel from './AdminPanel.jsx';
import './admin.css';

/**
 * Settings tab "Codes & admin". Props: user (Firebase user), onOpenAdmin? (opens the Admin panel
 * at Workspace level; if omitted the panel opens from here).
 * The typed code lives only in this component's state, is cleared before the request is awaited,
 * and is never logged or persisted.
 */
export default function PromoTab({ user, onOpenAdmin }) {
  const { isAdmin, loading } = useAppAdminState();
  const badge = useAdminBadge(user?.uid);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {ok, text}
  const [wait, setWait] = useState(() => promoCooldownLeft());
  const [panel, setPanel] = useState(false);
  const [badgeBusy, setBadgeBusy] = useState(false);
  const [badgeErr, setBadgeErr] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setInterval(() => setWait(promoCooldownLeft()), 500);
    return () => clearInterval(t);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPanel = () => (onOpenAdmin ? onOpenAdmin() : setPanel(true));

  async function submit(e) {
    e.preventDefault();
    if (busy || wait > 0) return;
    const value = code;
    setCode(''); // clear the field immediately; the value is never stored anywhere else
    if (!value.trim()) return;
    setBusy(true);
    setMsg(null);
    const res = await redeemPromo(value);
    if (!mounted.current) return;
    setBusy(false);
    setWait(promoCooldownLeft());
    setMsg(res.ok ? { ok: true, text: "You're now an app admin." } : { ok: false, text: res.message });
  }

  async function toggleBadge() {
    setBadgeBusy(true);
    setBadgeErr('');
    try {
      await setAdminBadgeVisible(!badge);
    } catch (err) {
      if (mounted.current) setBadgeErr(err?.message || 'Could not update your badge.');
    } finally {
      if (mounted.current) setBadgeBusy(false);
    }
  }

  return (
    <div className="adm-section">
      {loading ? (
        <div className="adm-loading"><div className="spinner" /></div>
      ) : isAdmin ? (
        <div className="adm-card adm-admin-status">
          <div className="adm-status-row">
            <span className="adm-status-shield" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
            </span>
            <div>
              <h3>{msg?.ok ? "You're now an app admin" : 'You are an app admin'}</h3>
              <p className="muted">
                You can manage the shop catalog, unpublish games, review reports and post announcements. You cannot read or
                decrypt anyone's private messages, servers, groups, codespaces or vaults.
              </p>
            </div>
          </div>
          <div className="adm-actions left">
            <button type="button" className="btn primary" onClick={openPanel}>Open admin panel</button>
          </div>
          <label className="adm-check">
            <input type="checkbox" checked={badge} disabled={badgeBusy} onChange={toggleBadge} />
            <span>Show the admin shield next to my name (public to everyone signed in)</span>
          </label>
          {badgeErr && <p className="error-text">{badgeErr}</p>}
        </div>
      ) : (
        <form className="adm-card" onSubmit={submit} autoComplete="off">
          <div>
            <h3>Redeem a code</h3>
            <p className="muted">Enter a code you were given. Each account can try one code every 30 seconds.</p>
          </div>
          <div className="adm-redeem-row">
            <input
              className="input adm-code-input"
              type="password"
              name="codehub-redeem"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              maxLength={PROMO_MAX}
              value={code}
              placeholder="Code"
              aria-label="Code"
              disabled={busy}
              onChange={(e) => setCode(e.target.value)}
            />
            <button className="btn primary" disabled={busy || wait > 0 || !code.trim()}>
              {busy ? 'Checking…' : wait > 0 && !busy ? `Wait ${Math.ceil(wait / 1000)} s` : 'Redeem'}
            </button>
          </div>
          {msg && <p className={msg.ok ? 'adm-ok' : 'error-text'} role="status">{msg.text}</p>}
        </form>
      )}

      <div className="adm-card">
        <h3>About app admins</h3>
        <ul className="adm-list">
          <li>Admin status is granted and enforced by the database rules, not by this app.</li>
          <li>Admins manage only public, plaintext surfaces: the shop catalog, published games, reports and the global announcement.</li>
          <li>Admins never receive encryption keys, so they cannot read your messages, servers, groups, codespaces or vault.</li>
        </ul>
      </div>

      {panel && <AdminPanel me={user} onClose={() => setPanel(false)} />}
    </div>
  );
}
