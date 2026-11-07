// Admin panel → Owner: the owner's premium dashboard. Locked until the owner passcode
// (config/ownerPass, set in the Firebase console) is entered; the rules then allow premiumCodes for
// 15 minutes. Shows this and next month's codes, generates / replaces codes, lists members (revoke)
// and shows the minified database rules for pasting into the console.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { useAppAdminState } from '../../../lib/admin.js';
import { useProfiles } from '../../../lib/profiles.js';
import { serverNow } from '../../../lib/messages.js';
import { addMonths, codeRows, monthKey, monthLabel, monthsFrom } from '../lib/codes.js';
import {
  OWNER_UNLOCK_MS, generateMissingCodes, guessCooldownLeft, lockOwner, replaceCode, revokePremium, unlockOwner,
  useOwnerLock, usePremiumCodes, usePremiumMembers,
} from '../lib/premium.js';
import RulesPanel from './RulesPanel.jsx';
import { CopyButton } from './CopyButton.jsx';
import '../premium.css';

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const fmtLeft = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
// What screen readers get instead of the ticking mm:ss: whole minutes, read in place (not announced).
const fmtMinutes = (ms) => {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return `${m} minute${m === 1 ? '' : 's'}`;
};
/** The live announcement: changes only on unlock, one minute before the re-lock, and on lock. */
function lockAnnouncement(unlocked, left, wasUnlocked) {
  if (unlocked) return left <= 60_000 ? 'The owner dashboard locks in 1 minute.' : 'Owner dashboard unlocked.';
  return wasUnlocked ? 'Owner dashboard locked.' : '';
}

export default function OwnerTab() {
  const { isAdmin, loading } = useAppAdminState();
  const { unlocked, left } = useOwnerLock();
  const wasUnlocked = useRef(false);
  if (unlocked) wasUnlocked.current = true;
  if (loading) return <div className="adm-loading"><div className="spinner" /></div>;
  if (!isAdmin) return <div className="adm-empty"><strong>App admins only</strong></div>;
  return (
    <>
      <span className="pm-sr-only" role="status">{lockAnnouncement(unlocked, left, wasUnlocked.current)}</span>
      {unlocked ? <Dashboard left={left} /> : <LockScreen />}
    </>
  );
}

function LockScreen() {
  const id = useId();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [wait, setWait] = useState(() => guessCooldownLeft());
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (wait <= 0) return undefined;
    const t = setInterval(() => setWait(guessCooldownLeft()), 500);
    return () => clearInterval(t);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    if (busy || wait > 0) return;
    const value = pass;
    setPass(''); // never kept beyond this request
    if (!value) return;
    setBusy(true);
    setMsg('');
    const res = await unlockOwner(value);
    if (!mounted.current) return;
    setBusy(false);
    setWait(guessCooldownLeft());
    if (!res.ok) setMsg(res.message);
  }

  return (
    <div className="adm-section">
      <form className="pm-card pm-lock" onSubmit={submit} autoComplete="off" aria-labelledby={`${id}-h`}>
        <span className="pm-lock-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" /></svg>
        </span>
        <div>
          <h3 id={`${id}-h`}>Owner dashboard is locked</h3>
          <p className="muted">
            Enter the owner passcode to manage premium codes and members. It unlocks this dashboard for 15 minutes.
            The passcode is set only in the Firebase console (<code>config/ownerPass</code>).
          </p>
        </div>
        <div className="pm-redeem-row">
          <input
            id={`${id}-in`}
            className="input pm-code-input"
            type="password"
            name="codehub-owner-passcode"
            autoComplete="off"
            data-lpignore="true"
            data-1p-ignore="true"
            maxLength={128}
            aria-label="Owner passcode"
            placeholder="Owner passcode"
            value={pass}
            disabled={busy}
            onChange={(e) => setPass(e.target.value)}
          />
          <button className="btn primary" disabled={busy || wait > 0 || !pass}>
            {busy ? 'Checking…' : wait > 0 ? `Wait ${Math.ceil(wait / 1000)} s` : 'Unlock'}
          </button>
        </div>
        {msg && <p className="error-text" role="alert">{msg}</p>}
      </form>
    </div>
  );
}

function Dashboard({ left }) {
  const { loading, codes, error } = usePremiumCodes(true);
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 30_000);
    return () => clearInterval(t);
  }, []);
  const cur = monthKey(now);
  const next = addMonths(cur, 1);
  const rows = useMemo(() => codeRows(codes, now), [codes, now]);
  const missing = useMemo(() => monthsFrom(cur).filter((k) => typeof codes?.[k]?.c !== 'string').length, [codes, cur]);

  return (
    <div className="adm-section pm-owner">
      <div className="pm-unlocked-bar">
        <span>
          <strong>Unlocked</strong> · locks in <span className="pm-mono" aria-hidden="true">{fmtLeft(left)}</span>
          <span className="pm-sr-only">{fmtMinutes(left)}</span>
        </span>
        <button type="button" className="btn sm" onClick={() => lockOwner()}>Lock</button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {loading ? (
        <div className="adm-loading"><div className="spinner" /></div>
      ) : (
        <>
          <CodesCard codes={codes} cur={cur} next={next} missing={missing} />
          <AllCodes rows={rows} />
        </>
      )}
      <MembersCard now={now} />
      <RulesPanel />
      <p className="adm-note">
        Codes rotate on their own: each one works only inside its calendar month (UTC). Members who redeemed keep their 30 days
        when a code is replaced. The dashboard locks after {OWNER_UNLOCK_MS / 60000} minutes.
      </p>
    </div>
  );
}

function BigCode({ label, k, entry }) {
  return (
    <div className="pm-bigcode">
      <span className="pm-bigcode-label">{label} · {monthLabel(k)}</span>
      {entry ? (
        <>
          <span className="pm-bigcode-value" data-testid={`code-${k}`}>{entry.c}</span>
          <CopyButton text={entry.c} label={`Copy ${monthLabel(k)} code`} />
        </>
      ) : (
        <span className="muted">No code yet. Use Generate codes.</span>
      )}
    </div>
  );
}

function CodesCard({ codes, cur, next, missing }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [confirm, setConfirm] = useState(false);

  async function generate() {
    setBusy('gen');
    setMsg(null);
    try {
      const n = await generateMissingCodes(codes);
      setMsg({ ok: true, text: n ? `Created ${n} code${n === 1 ? '' : 's'}.` : 'Every month already has a code.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  }
  async function replace() {
    setBusy('rep');
    setMsg(null);
    try {
      await replaceCode(cur, codes);
      setConfirm(false);
      setMsg({ ok: true, text: `${monthLabel(cur)} has a new code. The old one no longer works.` });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="pm-card" aria-label="Premium codes">
      <div className="pm-bigcodes">
        <BigCode label="This month" k={cur} entry={codes?.[cur]} />
        <BigCode label="Next month" k={next} entry={codes?.[next]} />
      </div>
      <div className="pm-actions left">
        <button type="button" className="btn primary" disabled={!!busy || missing === 0} onClick={generate}>
          {busy === 'gen' ? 'Generating…' : missing ? `Generate codes (${missing} missing)` : 'Generate codes'}
        </button>
        {codes?.[cur] && !confirm && (
          <button type="button" className="btn danger" disabled={!!busy} onClick={() => setConfirm(true)}>Replace this month&apos;s code</button>
        )}
      </div>
      {confirm && (
        <div className="pm-confirm" role="alertdialog" aria-label="Replace this month's code">
          <p>Replace the {monthLabel(cur)} code? The old code stops working immediately; members who already redeemed it keep their membership.</p>
          <div className="pm-actions left">
            <button type="button" className="btn danger" disabled={!!busy} onClick={replace}>{busy === 'rep' ? 'Replacing…' : 'Replace code'}</button>
            <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p className={msg.ok ? 'pm-ok' : 'error-text'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </section>
  );
}

const STATE_LABEL = { past: 'Expired', current: 'Current', future: 'Upcoming' };

function AllCodes({ rows }) {
  if (!rows.length) return null;
  return (
    <section className="pm-card" aria-labelledby="pm-allcodes-h">
      <h3 id="pm-allcodes-h">All codes</h3>
      <ul className="pm-code-list">
        {rows.map((r) => (
          <li key={r.key} className={`pm-code-row ${r.state}`}>
            <span className="pm-code-month">{monthLabel(r.key)}</span>
            <span className={`pm-pill ${r.state}`}>{STATE_LABEL[r.state]}</span>
            <code className="pm-mono">{r.c}</code>
            <CopyButton text={r.c} label={`Copy ${monthLabel(r.key)} code`} small />
          </li>
        ))}
      </ul>
    </section>
  );
}

function MembersCard({ now }) {
  const { loading, members, error } = usePremiumMembers(true);
  const uids = useMemo(() => members.map((m) => m.uid), [members]);
  const profiles = useProfiles(uids);
  const [showExpired, setShowExpired] = useState(false);
  const [err, setErr] = useState('');
  const active = members.filter((m) => m.until > now);
  const list = showExpired ? members : active;
  return (
    <section className="pm-card" aria-labelledby="pm-members-h">
      <div className="pm-card-head">
        <h3 id="pm-members-h">Premium members <span className="muted">({active.length} active)</span></h3>
        <label className="pm-check">
          <input type="checkbox" checked={showExpired} onChange={(e) => setShowExpired(e.target.checked)} /> Show expired
        </label>
      </div>
      <p className="adm-note">
        Revoking ends a membership at once, and the code it was redeemed with can&apos;t start it again. A later
        month&apos;s code still works for them.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {err && <p className="error-text" role="alert">{err}</p>}
      {loading ? (
        <div className="adm-loading"><div className="spinner" /></div>
      ) : list.length === 0 ? (
        <p className="muted">{members.length ? 'No active members.' : 'Nobody has redeemed a code yet.'}</p>
      ) : (
        <ul className="pm-members" aria-label="Premium members">
          {list.map((m) => {
            const p = profiles[m.uid];
            const on = m.until > now;
            return (
              <li key={m.uid} className="pm-member">
                <div className="pm-member-main">
                  <strong style={{ color: p?.color }}>{p?.name || 'Unknown user'}</strong>
                  <span className="muted pm-small">
                    Redeemed {fmtDate(m.at)} · {on ? 'expires' : 'expired'} {fmtDate(m.until)}{m.m ? ` · code ${monthLabel(m.m)}` : ''}
                  </span>
                  <code className="pm-uid">{m.uid}</code>
                </div>
                <ConfirmButton
                  confirmLabel="Revoke?"
                  onConfirm={async () => {
                    setErr('');
                    try {
                      await revokePremium(m.uid, m.m);
                    } catch (e) {
                      setErr(e.message);
                    }
                  }}
                >
                  Revoke
                </ConfirmButton>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
