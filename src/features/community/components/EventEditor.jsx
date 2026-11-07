// Create / edit a server event (modal). Opened by /event, the events panel, the sidebar and the
// palette through the community bus; rendered by CommunityHost.
import { useId, useMemo, useState } from 'react';
import { useChannels } from '../../../components/layout/hooks.js';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import {
  DEFAULT_DURATION_MS, EVENT_COLORS, EVENT_LIMITS, cleanEvent, fmtRange, fromLocalInput, toLocalInput,
} from '../lib/events.js';
import { createEvent, saveEvent, useServerEvents } from '../lib/data.js';
import { PortalModal, errText } from './common.jsx';

/** Next full hour at least 30 minutes from now. */
function defaultStart(now = Date.now()) {
  const d = new Date(now + 30 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.getTime();
}

export default function EventEditor({ req, onClose }) {
  const ws = useWorkspaceCtx();
  const { sid, event: ev } = req;
  const editing = !!ev;
  const uid = useId();
  const { channels } = useChannels(sid, 0);
  const voice = channels.filter((c) => c.type === 'voice' && c.name);
  const { count } = useServerEvents(sid);
  const start0 = ev?.start || defaultStart();
  const [title, setTitle] = useState(ev?.title || req.title || '');
  const [desc, setDesc] = useState(ev?.desc || '');
  const [start, setStart] = useState(toLocalInput(start0));
  const [end, setEnd] = useState(ev ? toLocalInput(ev.end) : toLocalInput(start0 + DEFAULT_DURATION_MS));
  // null = not chosen yet: a voice channel when the server has one (channels load after the first render).
  const [locPick, setLocKind] = useState(ev ? ev.loc?.kind || 'none' : null);
  const locKind = locPick ?? (voice.length ? 'voice' : 'none');
  const [cid, setCid] = useState(ev?.loc?.kind === 'voice' ? ev.loc.cid : '');
  const [place, setPlace] = useState(ev?.loc?.kind === 'text' ? ev.loc.text : '');
  const [color, setColor] = useState(ev?.color || EVENT_COLORS[0]);
  const [announce, setAnnounce] = useState(!editing && typeof req.send === 'function');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const voiceCid = cid || voice[0]?.cid || '';
  const loc = locKind === 'voice' && voiceCid ? { kind: 'voice', cid: voiceCid } : locKind === 'text' && place.trim() ? { kind: 'text', text: place } : null;
  const draft = useMemo(() => ({
    ...(ev || {}), title, desc, start: fromLocalInput(start), end: fromLocalInput(end), loc, color,
  }), [ev, title, desc, start, end, loc?.kind, loc?.cid, loc?.text, color]); // eslint-disable-line react-hooks/exhaustive-deps

  // Moving the start keeps the duration when the end would otherwise come first.
  const changeStart = (v) => {
    const prev = fromLocalInput(start);
    const next = fromLocalInput(v);
    const endMs = fromLocalInput(end);
    if (next && endMs && endMs <= next) setEnd(toLocalInput(next + (prev && endMs > prev ? endMs - prev : DEFAULT_DURATION_MS)));
    setStart(v);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    let clean;
    try {
      clean = cleanEvent(draft, { isNew: !editing });
    } catch (err) {
      setError(errText(err));
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await saveEvent(sid, ev, { ...clean, cancelled: ev.cancelled }, { canModerate: !!req.canModerate });
        ws?.toast('Event updated', 'success');
      } else {
        const id = await createEvent(sid, clean, count);
        ws?.toast('Event created', 'success');
        if (announce && req.send) {
          const ok = await req.send({ text: `📅 **${clean.title}** · ${fmtRange(clean)}`, extra: { srvEvent: { id } } });
          if (!ok) ws?.toast('The event was created, but the announcement was not posted', 'error');
        }
      }
      onClose();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <PortalModal title={editing ? 'Edit event' : 'New event'} onClose={busy ? undefined : onClose} className="cm-modal">
      <form className="ly-form cm-form" onSubmit={submit} noValidate>
        <label className="field">
          Title
          <input className="input" value={title} maxLength={EVENT_LIMITS.title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        </label>
        <div className="cm-row2">
          <label className="field">
            Starts
            <input className="input" type="datetime-local" value={start} onChange={(e) => changeStart(e.target.value)} required />
          </label>
          <label className="field">
            <span className="cm-label">Ends <span className="muted">(optional)</span></span>
            <input className="input" type="datetime-local" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <fieldset className="cm-fieldset">
          <legend>Where</legend>
          <div className="cm-radios">
            <label><input type="radio" name={`${uid}-loc`} checked={locKind === 'voice'} onChange={() => setLocKind('voice')} disabled={!voice.length} /> Voice channel</label>
            <label><input type="radio" name={`${uid}-loc`} checked={locKind === 'text'} onChange={() => setLocKind('text')} /> Somewhere else</label>
            <label><input type="radio" name={`${uid}-loc`} checked={locKind === 'none'} onChange={() => setLocKind('none')} /> Not set</label>
          </div>
          {locKind === 'voice' && voice.length > 0 && (
            <label className="field">
              <span className="cm-sr">Voice channel</span>
              <select className="input" value={voiceCid} onChange={(e) => setCid(e.target.value)} aria-label="Voice channel">
                {voice.map((c) => <option key={c.cid} value={c.cid}>🔊 {c.name}</option>)}
              </select>
            </label>
          )}
          {locKind === 'voice' && !voice.length && <p className="muted cm-hint">This server has no voice channels yet.</p>}
          {locKind === 'text' && (
            <label className="field">
              <span className="cm-sr">Place</span>
              <input className="input" value={place} maxLength={EVENT_LIMITS.locText} onChange={(e) => setPlace(e.target.value)} placeholder="A room, an address or a link" aria-label="Place" />
            </label>
          )}
        </fieldset>
        <label className="field">
          <span className="cm-label">Description <span className="muted">(optional)</span></span>
          <textarea className="input cm-textarea" rows={4} value={desc} maxLength={EVENT_LIMITS.desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        <div className="ly-field">
          Cover color
          <div className="cm-swatches" role="radiogroup" aria-label="Cover color">
            {EVENT_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={`cm-swatch${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
        {!editing && typeof req.send === 'function' && (
          <label className="cm-check">
            <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
            Announce it in #{req.channelName || 'this channel'}
          </label>
        )}
        <p className="muted cm-hint">🔒 The title, description, time and place are end-to-end encrypted for this server's members. Who answers going / maybe / can't go is visible to the database, like poll votes.</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        <div className="ly-form-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !title.trim() || !start}>
            {busy ? <span className="spinner ly-spinner-sm" /> : editing ? 'Save changes' : 'Create event'}
          </button>
        </div>
      </form>
    </PortalModal>
  );
}
