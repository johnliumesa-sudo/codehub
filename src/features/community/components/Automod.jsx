// AutoMod: the server settings tab and the readers' render check (messageExtras). The sender's
// check is the 'community.automod' send hook (index.js). Everything runs in members' browsers.
import { useEffect, useMemo, useState } from 'react';
import { permsFor } from '../../../lib/roles.js';
import { AUTOMOD_LIMITS, DEFAULT_AUTOMOD, automodActive, checkMessage, cleanAutomod, isExempt, parseWordList } from '../lib/automod.js';
import { saveAutomod, useAutomod } from '../lib/data.js';
import { useLive } from '../lib/live.js';
import { errText } from './common.jsx';

const revealed = new Set(); // message ids the reader chose to show (this tab only)

/** Under each server message: hides it for readers when it breaks the server's AutoMod rules. */
export function AutomodGate({ m, ctx }) {
  const sid = ctx.conv.sid;
  const { cfg } = useAutomod(sid);
  const active = automodActive(cfg);
  const roles = useLive(active ? `servers/${sid}/roles` : null);
  const [, bump] = useState(0);
  const verdict = useMemo(() => {
    if (!active || !m.body) return null;
    const rec = ctx.members?.[m.uid];
    const author = rec ? { uid: m.uid, role: rec.role === 'owner' || rec.role === 'admin' ? rec.role : 'member', roleId: rec.roleId } : null;
    if (author && isExempt(permsFor(author, roles.value || {}), cfg)) return null;
    return checkMessage(m.body, cfg);
  }, [active, cfg, m.body, m.uid, ctx.members, roles.value]);
  if (!verdict) return null;
  if (m.uid === ctx.me.uid) {
    return (
      <div className="cm-am own" role="note">
        🛡️ AutoMod {cfg.action === 'hide' ? 'hides this message from other members' : 'flags this message'}: {verdict.reason}.
      </div>
    );
  }
  const shown = revealed.has(m.mid);
  const toggle = () => {
    if (shown) revealed.delete(m.mid);
    else revealed.add(m.mid);
    bump((n) => n + 1);
  };
  return (
    <div className={`cm-am${shown ? '' : ' cm-am-hidden'}`} role="note">
      <span>🛡️ {shown ? 'Flagged' : 'Hidden'} by AutoMod: {verdict.reason}.</span>
      <button type="button" className="cm-link" onClick={toggle} aria-expanded={shown}>{shown ? 'Hide again' : 'Show message'}</button>
    </div>
  );
}

/** serverSettingsTabs 'community.automod' (manageApps). */
export function AutomodSettings({ ctx }) {
  const { sid } = ctx;
  const { cfg, loading, failed } = useAutomod(sid);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [sample, setSample] = useState('');
  useEffect(() => {
    if (!loading && form === null) {
      const c = cfg || DEFAULT_AUTOMOD;
      setForm({ ...c, words: c.words.join('\n') });
    }
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const draftCfg = useMemo(() => (form ? cleanAutomod({ ...form, words: parseWordList(form.words) }) : null), [form]);
  if (!form) return <p className="muted">Loading…</p>;
  const verdict = sample.trim() ? checkMessage({ text: sample }, draftCfg) : null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await saveAutomod(sid, draftCfg);
      setMsg({ ok: true, text: automodActive(draftCfg) ? 'AutoMod saved' : 'AutoMod is off' });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="cm-settings" onSubmit={save}>
      <div className="cm-warn" role="note">
        <strong>AutoMod runs in members' browsers.</strong> Messages are end-to-end encrypted, so the server can't read
        them to check them. Each member's app checks messages before sending and hides messages that break the rules when
        showing them. A modified client can bypass it, so treat it as a helper, not a guarantee. Owners and admins are never checked.
      </div>
      {failed && <p className="error-text">The current settings could not be decrypted. Saving replaces them.</p>}
      <label className="field">
        <span className="cm-label">Blocked words and phrases <span className="muted">(one per line; * matches any letters, e.g. spam* or *coin)</span></span>
        <textarea className="input cm-textarea" rows={5} value={form.words} onChange={(e) => set({ words: e.target.value })} />
      </label>
      <p className="muted cm-hint">{parseWordList(form.words).length} of {AUTOMOD_LIMITS.words} patterns. Matching ignores case and accents and only matches whole words.</p>
      <label className="cm-check"><input type="checkbox" checked={form.invites} onChange={(e) => set({ invites: e.target.checked })} /> Block invite links (Codehub and other chat apps)</label>
      <label className="cm-check"><input type="checkbox" checked={form.links} onChange={(e) => set({ links: e.target.checked })} /> Block all links</label>
      <div className="cm-row2">
        <label className="field">
          <span className="cm-label">Max mentions per message <span className="muted">(0 = off)</span></span>
          <input className="input" type="number" min={0} max={AUTOMOD_LIMITS.maxMentions} value={form.maxMentions} onChange={(e) => set({ maxMentions: Math.max(0, Math.min(AUTOMOD_LIMITS.maxMentions, parseInt(e.target.value, 10) || 0)) })} />
        </label>
        <label className="field">
          <span className="cm-label">Max capital letters, % <span className="muted">(0 = off, 50–100)</span></span>
          <input className="input" type="number" min={0} max={100} value={form.caps} onChange={(e) => { const n = parseInt(e.target.value, 10) || 0; set({ caps: n <= 0 ? 0 : Math.min(100, n) }); }} />
        </label>
      </div>
      {form.caps > 0 && form.caps < 50 && <p className="error-text">Use 0 (off) or a value from 50 to 100.</p>}
      <fieldset className="cm-fieldset">
        <legend>When a message breaks a rule</legend>
        <label className="cm-check"><input type="radio" name="cm-am-action" checked={form.action === 'block'} onChange={() => set({ action: 'block' })} /> Block sending and explain why</label>
        <label className="cm-check"><input type="radio" name="cm-am-action" checked={form.action === 'hide'} onChange={() => set({ action: 'hide' })} /> Allow it, but hide it for readers (they can reveal it)</label>
      </fieldset>
      <label className="cm-check"><input type="checkbox" checked={form.exemptMods} onChange={(e) => set({ exemptMods: e.target.checked })} /> Don't check moderators (Manage messages or Manage apps)</label>
      <label className="field">
        Try a message
        <input className="input" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Type something to test these settings" />
      </label>
      {sample.trim() && (
        <p className={verdict ? 'error-text' : 'cm-ok'} role="status">{verdict ? `${form.action === 'block' ? 'Blocked' : 'Hidden'}: ${verdict.reason}.` : 'This message passes.'}</p>
      )}
      {msg && <p className={msg.ok ? 'cm-ok' : 'error-text'} role="status">{msg.text}</p>}
      <div className="ly-form-actions">
        <button className="btn primary" disabled={busy || (form.caps > 0 && form.caps < 50)}>{busy ? <span className="spinner ly-spinner-sm" /> : 'Save AutoMod'}</button>
      </div>
    </form>
  );
}
