// One server event: time, place, description, RSVP buttons with counts and attendees, and the
// organizer/moderator actions. Used by the events panel, the detail modal and event messages.
import { useEffect, useMemo, useState } from 'react';
import { useProfiles } from '../../../lib/profiles.js';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { useChannels } from '../../../components/layout/hooks.js';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import {
  RSVP_LABELS, RSVP_STATES, canJoinVoice, fmtRange, isLive, isPast, relTime, tallyRsvps, toIcs,
} from '../lib/events.js';
import { deleteEvent, saveEvent, setRsvp } from '../lib/data.js';
import { openEventEditor } from '../lib/bus.js';
import { downloadText, errText, joinVoiceChannel } from './common.jsx';

/** Re-render every `ms` (for "in 5 min" labels and the Join voice window). */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Location label: "🔊 voice-name", "📍 text", or ''. */
export function useWhere(sid, ev) {
  const { channels } = useChannels(ev?.loc?.kind === 'voice' ? sid : null, 0);
  if (!ev?.loc) return '';
  if (ev.loc.kind === 'text') return ev.loc.text;
  const ch = channels.find((c) => c.cid === ev.loc.cid && c.type === 'voice');
  return ch?.name ? `#${ch.name}` : 'Voice channel';
}

export default function EventCard({ sid, ev, rsvps, me, perms, compact = false, send, toast }) {
  const ws = useWorkspaceCtx();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const tally = useMemo(() => tallyRsvps(rsvps), [rsvps]);
  const mine = rsvps?.get(me.uid)?.s || null;
  const people = useProfiles(useMemo(() => [ev.by, ev.orig, ...tally.going, ...tally.maybe].filter(Boolean), [ev.by, ev.orig, tally]));
  const where = useWhere(sid, ev);
  const canModerate = !!perms?.manageMessages;
  const canEdit = ev.by === me.uid || canModerate;
  const live = isLive(ev, now);
  const past = isPast(ev, now);
  const say = (text, kind) => (toast ? toast(text, kind) : ws?.toast(text, kind === 'ok' ? 'success' : kind));

  const run = async (fn, okText) => {
    setBusy(true);
    try {
      await fn();
      if (okText) say(okText, 'ok');
    } catch (e) {
      say(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const answer = (s) => run(() => setRsvp(sid, ev.rid, mine === s ? null : s));
  const toggleCancel = () => run(() => saveEvent(sid, ev, { ...ev, cancelled: !ev.cancelled }, { canModerate }), ev.cancelled ? 'Event restored' : 'Event cancelled');
  const remove = () => run(() => deleteEvent(sid, ev, [...(rsvps?.keys() || [])], { canModerate }), 'Event deleted');
  const ics = () => downloadText(`${ev.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 40) || 'event'}.ics`, toIcs(ev, { where }), 'text/calendar');
  const share = () => run(async () => {
    const ok = await send({ text: `📅 **${ev.title}** · ${fmtRange(ev)}`, extra: { srvEvent: { id: ev.id } } });
    if (!ok) throw new Error('The event was not shared');
  });
  const join = () => run(() => joinVoiceChannel(ws, sid, ev.loc.cid));

  const organizer = people[ev.orig || ev.by]?.name || 'a member';
  const editor = ev.orig ? people[ev.by]?.name || 'a moderator' : null;

  return (
    <article className={`cm-event${compact ? ' compact' : ''}${ev.cancelled ? ' cancelled' : ''}${past ? ' past' : ''}`} style={{ '--ev-color': ev.color }} aria-label={`Event: ${ev.title}`}>
      <div className="cm-event-bar" aria-hidden="true" />
      <div className="cm-event-main">
        <div className="cm-event-head">
          <h4 className="cm-event-title">{ev.title}</h4>
          {ev.cancelled && <span className="cm-chip danger">Cancelled</span>}
          {!ev.cancelled && live && <span className="cm-chip live">Happening now</span>}
          {!ev.cancelled && !live && !past && <span className="cm-chip">{relTime(ev.start, now)}</span>}
        </div>
        <p className="cm-event-when">🗓️ {fmtRange(ev)}</p>
        {where && <p className="cm-event-where">{ev.loc.kind === 'voice' ? '🔊' : '📍'} {where}</p>}
        {!compact && ev.desc && <p className="cm-event-desc">{ev.desc}</p>}
        <p className="cm-event-by muted">
          Organized by {organizer}{editor ? ` · edited by ${editor}` : ''}
        </p>

        {!ev.cancelled && !past && (
          <div className="cm-rsvp" role="group" aria-label="Your answer">
            {RSVP_STATES.map((s) => (
              <button key={s} type="button" className={`cm-rsvp-btn ${s}${mine === s ? ' on' : ''}`} aria-pressed={mine === s} disabled={busy} onClick={() => answer(s)}>
                {RSVP_LABELS[s]}
                {s !== 'not' && <span className="cm-rsvp-n">{tally[s].length}</span>}
              </button>
            ))}
          </div>
        )}
        {(ev.cancelled || past) && (tally.going.length > 0 || tally.maybe.length > 0) && (
          <p className="cm-event-count muted">{tally.going.length} went{tally.maybe.length ? ` · ${tally.maybe.length} maybe` : ''}</p>
        )}

        {(tally.going.length > 0 || tally.maybe.length > 0) && (
          <button type="button" className="cm-link" aria-expanded={showPeople} onClick={() => setShowPeople((v) => !v)}>
            {showPeople ? 'Hide who is coming' : `Who is coming (${tally.going.length + tally.maybe.length})`}
          </button>
        )}
        {showPeople && (
          <ul className="cm-people">
            {tally.going.map((u) => <li key={u}><span className="cm-dot going" aria-hidden="true" />{people[u]?.name || 'Member'}<span className="cm-sr"> (going)</span></li>)}
            {tally.maybe.map((u) => <li key={u}><span className="cm-dot maybe" aria-hidden="true" />{people[u]?.name || 'Member'} <span className="muted">(maybe)</span></li>)}
          </ul>
        )}

        <div className="cm-event-actions">
          {canJoinVoice(ev, now) && (
            <button type="button" className="btn primary sm" onClick={join} disabled={busy}>🔊 Join voice</button>
          )}
          {send && !ev.cancelled && !past && <button type="button" className="btn ghost sm" onClick={share} disabled={busy}>Share in chat</button>}
          <button type="button" className="btn ghost sm" onClick={ics}>Add to calendar</button>
          {canEdit && !past && (
            <button type="button" className="btn ghost sm" onClick={() => openEventEditor({ sid, event: ev, canModerate })} disabled={busy}>Edit</button>
          )}
          {canEdit && !past && (
            <button type="button" className="btn ghost sm" onClick={toggleCancel} disabled={busy}>{ev.cancelled ? 'Restore' : 'Cancel event'}</button>
          )}
          {canEdit && (
            <ConfirmButton className="btn ghost sm cm-danger" confirmLabel="Really delete?" onConfirm={remove} disabled={busy}>Delete</ConfirmButton>
          )}
        </div>
      </div>
    </article>
  );
}
