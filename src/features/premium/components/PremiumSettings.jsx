// Settings → Premium: membership status, redeem / renew with the monthly code, and the premium look
// (role tag, name effect, profile banner, profile-card effect, avatar frame) with a live preview.
import { useEffect, useId, useRef, useState } from 'react';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { useProfile } from '../../../lib/profiles.js';
import { useUpub } from '../../../lib/ext/store.js';
import { usePremium } from '../lib/status.js';
import { normalizeCode } from '../lib/codes.js';
import { cancelPremium, clearLook, guessCooldownLeft, redeemPremium, saveLook } from '../lib/premium.js';
import {
  BANNERS, BANNER_LABEL, CARD_FX, CARD_FX_LABEL, DEFAULT_A, DEFAULT_B, FRAMES, FRAME_LABEL, NAME_FX, NAME_FX_LABEL,
  TAG_MAX, normalizeLook, tagLength, tagProblem,
} from '../lib/lookCore.js';
import { DiamondIcon, TagPill, nameFxProps } from './PremiumBits.jsx';
import { useAssistant } from '../../assistant/components/common.jsx';
import { keyState } from '../../assistant/lib/session.js';
import '../premium.css';

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

export const PERKS = [
  ['Double daily coins', 'Claim 200 coins a day in the shop instead of 100.'],
  ['Premium-only shop items', 'Buy items creators and admins reserve for members.'],
  ['Premium badge', 'A diamond next to your name in chat, member lists and your profile card.'],
  ['Custom role tag', `Your own tag next to your name: up to ${TAG_MAX} characters, emoji welcome, one colour or a gradient.`],
  ['Profile banners and effects', 'Aurora, gradient or starfield banners, sparkles, snow or confetti on your card, an avatar frame and name effects.'],
  ['Agent mode in codespaces', 'Let the assistant edit files in your codespaces with your own Anthropic API key.'],
];

export default function PremiumSettings({ ctx }) {
  const uid = ctx?.user?.uid || ctx?.me?.uid;
  const prem = usePremium(uid);
  if (!uid) return null;
  return (
    <div className="pm-settings">
      <StatusCard prem={prem} />
      <RedeemCard prem={prem} />
      {prem.active ? <LookEditor uid={uid} /> : <PerksCard />}
      <AgentCard uid={uid} prem={prem} openSettings={ctx?.openSettings} />
    </div>
  );
}

// Agent mode (src/features/premium/agent) lives in the code workspaces; this card says what it needs and
// where to find it: an active membership, the Anthropic API key from Settings → Assistant, a workspace.
function AgentCard({ uid, prem, openSettings }) {
  const session = useAssistant(uid);
  const key = session ? keyState(session) : 'none';
  const keyText = { ready: 'Your Anthropic API key is set up.', locked: 'Your API key is saved but locked: unlock it in Settings → Assistant.', none: 'Add your own Anthropic API key in Settings → Assistant.' }[key];
  return (
    <section className="pm-card" aria-labelledby="pm-agent-h">
      <div className="pm-card-head">
        <h3 id="pm-agent-h">Agent mode in codespaces</h3>
        {openSettings && key !== 'ready' && (
          <button type="button" className="btn ghost sm" onClick={() => openSettings('assistant')}>Open Settings → Assistant</button>
        )}
      </div>
      <p className="muted">
        Describe a task and Claude reads, searches and edits the files of a code channel or codespace, runs the preview,
        and shows every change as a diff you approve. Each run can be undone. It uses your own API key; the files it reads
        are sent to Anthropic under your account.
      </p>
      <ol className="pm-steps">
        <li className={prem.active ? 'done' : ''}>{prem.active ? 'Premium is active.' : 'Redeem this month\'s code above.'}</li>
        <li className={key === 'ready' ? 'done' : ''}>{keyText}</li>
        <li>Open a code channel or codespace and press <strong>Agent</strong> in the workspace toolbar.</li>
      </ol>
    </section>
  );
}

function StatusCard({ prem }) {
  const [err, setErr] = useState('');
  if (prem.loading) return <div className="pm-card"><div className="spinner" /></div>;
  if (!prem.active) {
    return (
      <section className="pm-card pm-hero" aria-labelledby="pm-status-h">
        <span className="pm-hero-icon"><DiamondIcon size={26} /></span>
        <div>
          <h3 id="pm-status-h">Codehub Premium</h3>
          <p className="muted">
            {prem.record ? `Your membership ended on ${fmtDate(prem.until)}. ` : ''}
            Redeem this month&apos;s code to unlock the perks below for 30 days.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="pm-card pm-hero on" aria-labelledby="pm-status-h">
      <span className="pm-hero-icon"><DiamondIcon size={26} /></span>
      <div className="pm-hero-text">
        <h3 id="pm-status-h">You&apos;re a premium member</h3>
        <p className="muted">
          Active until <strong>{fmtDate(prem.until)}</strong>
          {prem.record?.at ? ` · redeemed ${fmtDate(prem.record.at)}` : ''}
        </p>
        <ul className="pm-perk-chips" aria-label="Your perks">
          {PERKS.map(([t]) => <li key={t}>{t}</li>)}
        </ul>
      </div>
      <div className="pm-hero-actions">
        <ConfirmButton
          className="btn ghost sm"
          confirmLabel="Leave premium now?"
          onConfirm={async () => {
            setErr('');
            try {
              await cancelPremium();
            } catch {
              setErr('Could not leave premium. Try again.');
            }
          }}
        >
          Leave premium
        </ConfirmButton>
        {err && <p className="error-text" role="alert">{err}</p>}
      </div>
    </section>
  );
}

function PerksCard() {
  return (
    <section className="pm-card" aria-labelledby="pm-perks-h">
      <h3 id="pm-perks-h">What you get</h3>
      <ul className="pm-perks">
        {PERKS.map(([t, d]) => (
          <li key={t}>
            <strong>{t}</strong>
            <span className="muted">{d}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RedeemCard({ prem }) {
  const id = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
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
    const value = normalizeCode(code);
    setCode(''); // the code lives only in this field; clear it before the request
    if (!value) return;
    setBusy(true);
    setMsg(null);
    const res = await redeemPremium(value, prem.record);
    if (!mounted.current) return;
    setBusy(false);
    setWait(guessCooldownLeft());
    setMsg(res.ok ? { ok: true, text: `Premium is active until ${fmtDate(res.until)}. Enjoy!` } : { ok: false, text: res.message });
  }

  return (
    <form className="pm-card" onSubmit={submit} autoComplete="off" aria-labelledby={`${id}-h`}>
      <div>
        <h3 id={`${id}-h`}>{prem.active ? 'Renew' : 'Redeem a premium code'}</h3>
        <p className="muted">
          {prem.active
            ? "Redeem next month's code to start a new 30 days from today."
            : 'Each code works during its calendar month (UTC) and gives 30 days. One try every 30 seconds.'}
        </p>
      </div>
      <div className="pm-redeem-row">
        <input
          id={`${id}-in`}
          className="input pm-code-input"
          type="text"
          name="codehub-premium-code"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          maxLength={64}
          placeholder="XXXX-XXXX-XXXX"
          aria-label="Premium code"
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="btn primary" disabled={busy || wait > 0 || !code.trim()}>
          {busy ? 'Checking…' : wait > 0 ? `Wait ${Math.ceil(wait / 1000)} s` : prem.active ? 'Renew' : 'Redeem'}
        </button>
      </div>
      {msg && <p className={msg.ok ? 'pm-ok' : 'error-text'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------

function Select({ label, value, options, labels, onChange }) {
  const id = useId();
  return (
    <div className="pm-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{labels[o]}</option>)}
      </select>
    </div>
  );
}

function Color({ label, value, onChange, disabled }) {
  const id = useId();
  return (
    <div className="pm-field pm-color">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="color" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function LookEditor({ uid }) {
  const stored = useUpub(uid, 'premium', 'look');
  const profile = useProfile(uid);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const tagId = useId();

  useEffect(() => {
    if (stored.loading || f) return;
    const l = normalizeLook(stored.value);
    setF({ ...l, gradientTag: !!l.tagB, tagB: l.tagB || DEFAULT_B });
  }, [stored.loading, stored.value, f]);

  if (!f) return <div className="pm-card"><div className="spinner" /></div>;
  const set = (patch) => {
    setMsg(null);
    setF((x) => ({ ...x, ...patch }));
  };
  const look = { ...f, tagB: f.gradientTag ? f.tagB : null };
  const tagErr = tagProblem(f.tag);
  const name = profile?.name || 'You';

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await saveLook(look);
      setMsg({ ok: true, text: 'Saved. Everyone sees your new look while your membership is active.' });
    } catch (err) {
      setMsg({ ok: false, text: /permission/i.test(String(err?.message)) ? 'Could not save your look.' : err?.message || 'Could not save your look.' });
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    setMsg(null);
    try {
      await clearLook();
      setF({ ...normalizeLook(null), gradientTag: false, tagB: DEFAULT_B });
      setMsg({ ok: true, text: 'Back to the standard look.' });
    } catch {
      setMsg({ ok: false, text: 'Could not reset your look.' });
    } finally {
      setBusy(false);
    }
  }

  const fx = nameFxProps(look);
  return (
    <form className="pm-card pm-look" onSubmit={save} aria-label="Premium look">
      <div>
        <h3>Your premium look</h3>
        <p className="muted">Shown next to your name and on your profile card while your membership is active.</p>
      </div>

      <div className="pm-preview" aria-label="Preview">
        <div className={`pm-preview-banner pm-banner ${look.banner !== 'none' ? `pm-banner-${look.banner}` : ''}`} style={{ '--pm-a': look.fxA, '--pm-b': look.fxB, background: look.banner === 'none' || look.banner === 'frame' ? profile?.color || 'var(--accent)' : undefined }}>
          {look.banner === 'starfield' && <span className="pm-stars" aria-hidden="true" />}
          {look.cardFx !== 'none' && (
            <span className={`pm-cardfx pm-cardfx-${look.cardFx}`} style={{ '--pm-a': look.fxA, '--pm-b': look.fxB }} aria-hidden="true">
              {Array.from({ length: 10 }, (_, i) => <span key={i} className="pm-p" style={{ '--i': i, left: `${(i * 37) % 100}%`, animationDelay: `${-((i * 0.73) % 5).toFixed(2)}s` }} />)}
            </span>
          )}
        </div>
        <div className="pm-preview-row">
          <span className={look.frame !== 'none' ? `pm-frame pm-frame-${look.frame}` : ''} style={{ '--pm-a': look.fxA, '--pm-b': look.fxB }}>
            <span className="pm-preview-avatar" style={{ background: profile?.color || 'var(--accent)' }}>{name.trim().charAt(0).toUpperCase()}</span>
          </span>
          <span className="pm-preview-name">
            {fx ? <span {...fx}>{name}</span> : <span>{name}</span>}
            <span className="pm-badge" aria-hidden="true"><DiamondIcon size={13} /></span>
            {look.tag && !tagErr && <TagPill look={look} />}
          </span>
        </div>
      </div>

      <fieldset className="pm-group">
        <legend>Role tag</legend>
        <div className="pm-field pm-grow">
          <label htmlFor={tagId}>Text <span className="muted">({tagLength(f.tag)}/{TAG_MAX})</span></label>
          <input id={tagId} className="input" value={f.tag} maxLength={64} placeholder="e.g. 🚀 Rustacean" aria-invalid={!!tagErr} aria-describedby={tagErr ? `${tagId}-e` : undefined} onChange={(e) => set({ tag: e.target.value })} />
          {tagErr && <span id={`${tagId}-e`} className="error-text" role="alert">{tagErr}</span>}
        </div>
        <Color label="Colour" value={f.tagA} onChange={(v) => set({ tagA: v })} />
        <label className="pm-check">
          <input type="checkbox" checked={f.gradientTag} onChange={(e) => set({ gradientTag: e.target.checked })} /> Gradient
        </label>
        <Color label="Second colour" value={f.tagB} disabled={!f.gradientTag} onChange={(v) => set({ tagB: v })} />
      </fieldset>

      <fieldset className="pm-group">
        <legend>Effects</legend>
        <Select label="Name effect" value={f.nameFx} options={NAME_FX} labels={NAME_FX_LABEL} onChange={(v) => set({ nameFx: v })} />
        <Select label="Profile banner" value={f.banner} options={BANNERS} labels={BANNER_LABEL} onChange={(v) => set({ banner: v })} />
        <Select label="Profile card effect" value={f.cardFx} options={CARD_FX} labels={CARD_FX_LABEL} onChange={(v) => set({ cardFx: v })} />
        <Select label="Avatar frame" value={f.frame} options={FRAMES} labels={FRAME_LABEL} onChange={(v) => set({ frame: v })} />
        <Color label="Effect colour 1" value={f.fxA || DEFAULT_A} onChange={(v) => set({ fxA: v })} />
        <Color label="Effect colour 2" value={f.fxB || DEFAULT_B} onChange={(v) => set({ fxB: v })} />
      </fieldset>
      <p className="muted pm-small">Animations pause when Reduce motion is on (Settings → Appearance) or your device asks for less motion.</p>

      <div className="pm-actions">
        {msg && <span className={msg.ok ? 'pm-ok' : 'error-text'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</span>}
        <button type="button" className="btn ghost" disabled={busy} onClick={reset}>Reset</button>
        <button className="btn primary" disabled={busy || !!tagErr}>{busy ? 'Saving…' : 'Save look'}</button>
      </div>
    </form>
  );
}
