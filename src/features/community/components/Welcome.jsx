// Welcome screen & rules gate: the modal members see on their first visit (or when acceptance is
// required), the in-chat bridge (rules button, "accept to post" notice, events panel requests) and
// the server settings tab.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ref, update } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import { renderMarkdown } from '../../../lib/markdown.js';
import { useServerMeta } from '../../../components/layout/hooks.js';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { WELCOME_LIMITS, isGated, parseRules, welcomeState } from '../lib/welcome.js';
import {
  acceptRules, markWelcomeSeen, saveWelcome, useAcceptMarker, useSeenWelcome, useWelcome,
} from '../lib/data.js';
import { useLive } from '../lib/live.js';
import { closeWelcome, consumePanelRequest, openWelcome, useUi } from '../lib/bus.js';
import { PortalModal, errText, useMyServerPerms } from './common.jsx';

function WelcomeBody({ w }) {
  const html = useMemo(() => (w.text ? renderMarkdown(w.text, {}) : ''), [w.text]);
  return (
    <>
      {w.failed && <p className="error-text">This welcome message could not be decrypted.</p>}
      {html && (
        // Sanitized by DOMPurify in renderMarkdown().
        <div className="cm-welcome-text md" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {w.rules.length > 0 && (
        <>
          <h3 className="cm-welcome-h">Server rules</h3>
          <ol className="cm-rules">
            {w.rules.map((r, i) => <li key={i}>{r}</li>)}
          </ol>
        </>
      )}
    </>
  );
}

/**
 * Mounted once (CommunityHost): shows the welcome modal on a member's first visit to a server, when
 * the server requires accepting its rules, or on request (openWelcome).
 */
export function WelcomeHost() {
  const ws = useWorkspaceCtx();
  const ui = useUi();
  const uid = ws?.me?.uid;
  const current = ws && !ws.nav?.view && ws.servers?.some((s) => s.sid === ws.nav?.sid) ? ws.nav.sid : null;
  const sid = ui.welcome?.sid || current;
  const w = useWelcome(sid);
  const { marker, loading: mLoading } = useAcceptMarker(sid, uid);
  const { seenV, loading: sLoading } = useSeenWelcome(sid, uid);
  const { role, loading: rLoading } = useMyServerPerms(sid, uid);
  const meta = useServerMeta(sid, 0);
  const [dismissed, setDismissed] = useState(() => new Set()); // `${sid}:${v}` closed this session
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ready = sid && !w.loading && !mLoading && !sLoading && !rLoading && role;
  const state = ready ? welcomeState({ welcome: w, myUid: uid, myRole: role, marker, seenV }) : null;
  const manual = !!ui.welcome && ui.welcome.sid === sid;
  const auto = !!state && !dismissed.has(`${sid}:${w.v}`);
  const open = ready && (manual || auto) && (w.configured || w.req);

  useEffect(() => setError(''), [sid]);

  if (!open) return null;
  const gated = isGated({ req: w.req, myUid: uid, myRole: role, marker });
  const needsAccept = state === 'gate' || state === 'update';
  const close = () => {
    setDismissed((d) => new Set(d).add(`${sid}:${w.v}`));
    if (manual) closeWelcome();
    if (state === 'show') markWelcomeSeen(sid, w.v).catch(() => {});
  };
  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      await acceptRules(sid, w.v);
      setDismissed((d) => new Set(d).add(`${sid}:${w.v}`));
      if (manual) closeWelcome();
      ws.toast('Thanks! You can post in this server now.', 'success');
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const name = meta.name || 'this server';
  return (
    <PortalModal title={`Welcome to ${name}`} onClose={busy ? undefined : close} className="cm-modal cm-welcome">
      <WelcomeBody w={w} />
      {state === 'update' && <p className="cm-note">The rules changed since you last accepted them.</p>}
      {w.req && (role === 'owner' || role === 'admin') && <p className="muted cm-hint">As an {role}, you can post without accepting.</p>}
      {w.req && !needsAccept && marker?.by === uid && <p className="muted cm-hint">You accepted these rules{marker.ts ? ` on ${new Date(marker.ts).toLocaleDateString()}` : ''}.</p>}
      {gated && <p className="cm-note">You need to accept the rules before you can post in this server.</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="ly-form-actions">
        {needsAccept ? (
          <>
            <button type="button" className="btn ghost" onClick={close} disabled={busy}>Not now</button>
            <button type="button" className="btn primary" onClick={accept} disabled={busy}>
              {busy ? <span className="spinner ly-spinner-sm" /> : 'I accept the rules'}
            </button>
          </>
        ) : (
          <button type="button" className="btn primary" onClick={close}>Got it</button>
        )}
      </div>
    </PortalModal>
  );
}

/** Message shown in the gate notice above the composer. */
function GateNoticeAction({ sid }) {
  return (
    <div className="cm-gate-actions">
      <button type="button" className="btn primary sm" onClick={() => openWelcome(sid)}>Review and accept the rules</button>
    </div>
  );
}

export const GATE_NOTICE_ID = 'community.gate';
const gateNotices = new Map(); // sid -> dismiss() of the newest gate notice (the send hook may re-show it)

/** Show (or re-show) the "accept the rules to post" notice above the composer. */
export function showGateNotice(ctx, sid) {
  const dismiss = ctx.ephemeral?.({
    id: GATE_NOTICE_ID,
    title: 'Accept the rules to post',
    text: 'This server asks members to accept its rules before posting. Until you do, your messages are refused.',
    render: () => <GateNoticeAction sid={sid} />,
  });
  if (typeof dismiss === 'function') gateNotices.set(sid, dismiss);
  return dismiss;
}
function hideGateNotice(sid) {
  gateNotices.get(sid)?.();
  gateNotices.delete(sid);
}

/**
 * composerButtons render entry for server channels: a "Server rules" button when the server has a
 * welcome screen, the gate notice while I can't post, and opening the events panel on request.
 */
export function ChatBridge({ ctx }) {
  const ui = useUi();
  const sid = ctx.conv.kind === 'channel' ? ctx.conv.sid : null;
  const uid = ctx.me.uid;
  const w = useWelcome(sid);
  const { marker, loading } = useAcceptMarker(sid, uid);
  const role = ctx.members?.[uid]?.role;
  const gated = !!sid && !w.loading && !loading && !!role && isGated({ req: w.req, myUid: uid, myRole: role, marker });
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    if (!gated) return undefined;
    showGateNotice(ctxRef.current, sid);
    return () => hideGateNotice(sid);
  }, [gated, sid]);

  useEffect(() => {
    if (sid && ui.panel?.sid === sid) {
      consumePanelRequest();
      ctxRef.current.openPanel('community.events');
    }
  }, [ui.panel, sid]);

  if (!sid || !(w.configured || w.req)) return null;
  return (
    <button type="button" className={`composer-btn cm-rules-btn${gated ? ' gated' : ''}`} title="Server rules" aria-label="Server rules" onClick={() => openWelcome(sid)}>
      📜
    </button>
  );
}

/** serverSettingsTabs 'community.welcome' (manageApps). */
export function WelcomeSettings({ ctx }) {
  const { sid } = ctx;
  const w = useWelcome(sid);
  const accepted = useLive(`sitems/${sid}/accepted`);
  const [form, setForm] = useState(null); // null until loaded
  const [bump, setBump] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (!w.loading && form === null) setForm({ text: w.text, rules: w.rules.join('\n'), require: w.req });
  }, [w.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const canReset = !!(ctx.perms?.staff || ctx.perms?.manageMessages);
  const markers = Object.entries(accepted.value || {}).filter(([k, v]) => v && v.by === k);
  const members = ctx.server?.members || [];
  const needing = members.filter((m) => m.role !== 'owner' && m.role !== 'admin');
  const acceptedCount = needing.filter((m) => markers.some(([k]) => k === m.uid)).length;
  if (!form) return <p className="muted">Loading…</p>;
  const rules = parseRules(form.rules);
  const preview = { text: form.text.trim(), rules, failed: false };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await saveWelcome(sid, { text: form.text, rules, require: form.require }, { prevV: w.v, bump });
      setBump(false);
      setMsg({ ok: true, text: form.text.trim() || rules.length || form.require ? 'Welcome screen saved' : 'Welcome screen removed' });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(false);
    }
  };
  const resetAll = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const patch = {};
      markers.forEach(([k]) => { patch[`sitems/${sid}/accepted/${k}`] = null; });
      if (Object.keys(patch).length) await update(ref(db), patch);
      setMsg({ ok: true, text: 'Everyone has to accept the rules again' });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="cm-settings" onSubmit={save}>
      <p className="muted">New members see this when they first open the server. The text and rules are end-to-end encrypted like messages.</p>
      <label className="field">
        Welcome message <span className="muted">(Markdown)</span>
        <textarea className="input cm-textarea" rows={5} maxLength={WELCOME_LIMITS.text} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Say hello and point people to the right channels." />
      </label>
      <label className="field">
        Rules <span className="muted">(one per line, up to {WELCOME_LIMITS.rules})</span>
        <textarea className="input cm-textarea" rows={5} value={form.rules} onChange={(e) => setForm({ ...form, rules: e.target.value })} placeholder={'Be kind\nNo spam'} />
      </label>
      <label className="cm-check">
        <input type="checkbox" checked={form.require} onChange={(e) => setForm({ ...form, require: e.target.checked })} />
        <span>
          <strong>Require members to accept the rules before posting</strong>
          <span className="muted cm-block">The database refuses channel messages from members who haven't accepted. Owners and admins are exempt.</span>
        </span>
      </label>
      {w.v > 0 && (
        <label className="cm-check">
          <input type="checkbox" checked={bump} onChange={(e) => setBump(e.target.checked)} />
          <span>Show it again to members who already saw it{form.require ? ' (they are asked to accept the new version)' : ''}</span>
        </label>
      )}
      {w.req && (
        <p className="cm-stat">
          {acceptedCount} of {needing.length} member{needing.length === 1 ? '' : 's'} who need to accept {acceptedCount === 1 ? 'has' : 'have'} accepted.
          {canReset && markers.length > 0 && (
            <button type="button" className="cm-link" onClick={resetAll} disabled={busy}>Make everyone accept again</button>
          )}
        </p>
      )}
      {(preview.text || preview.rules.length > 0) && (
        <div className="cm-preview" aria-label="Preview">
          <span className="cm-preview-label">Preview</span>
          <WelcomeBody w={preview} />
        </div>
      )}
      {msg && <p className={msg.ok ? 'cm-ok' : 'error-text'} role="status">{msg.text}</p>}
      <div className="ly-form-actions">
        <button className="btn primary" disabled={busy}>{busy ? <span className="spinner ly-spinner-sm" /> : 'Save welcome screen'}</button>
      </div>
    </form>
  );
}
