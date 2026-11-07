// Events in the UI: the chat panel (upcoming / past), the sidebar "next event" section, the detail
// modal and the card under event announcement messages.
import { useMemo, useState } from 'react';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { canJoinVoice, fmtRange, isLive, isEventId, nextEvent, relTime, splitEvents, tallyRsvps } from '../lib/events.js';
import { useServerEvents, useServerRsvps, useWelcome } from '../lib/data.js';
import { openEventDetail, openEventEditor, openWelcome, requestEventsPanel } from '../lib/bus.js';
import EventCard, { useNow, useWhere } from './EventCard.jsx';
import { PortalModal, errText, joinVoiceChannel, useMyServerPerms } from './common.jsx';

/** chatPanels 'community.events': upcoming and past events of the current server. */
export function EventsPanel({ ctx }) {
  const sid = ctx.conv.sid;
  const { events, loading, failed } = useServerEvents(sid);
  const rsvps = useServerRsvps(sid);
  const now = useNow(60_000);
  const [tab, setTab] = useState('upcoming');
  const { upcoming, past } = useMemo(() => splitEvents(events, now), [events, now]);
  const list = tab === 'upcoming' ? upcoming : past;
  const send = ctx.canSend ? ctx.send : undefined;
  return (
    <div className="cm-panel">
      <div className="cm-panel-top">
        <div className="cm-tabs" role="tablist" aria-label="Events">
          <button type="button" role="tab" aria-selected={tab === 'upcoming'} className={tab === 'upcoming' ? 'on' : ''} onClick={() => setTab('upcoming')}>Upcoming ({upcoming.length})</button>
          <button type="button" role="tab" aria-selected={tab === 'past'} className={tab === 'past' ? 'on' : ''} onClick={() => setTab('past')}>Past ({past.length})</button>
        </div>
        <button
          type="button"
          className="btn primary sm"
          onClick={() => openEventEditor({ sid, send, channelName: ctx.conv.name })}
        >
          New event
        </button>
      </div>
      {loading && !events.length && <p className="muted cm-empty">Loading events…</p>}
      {!loading && !list.length && (
        <p className="muted cm-empty">{tab === 'upcoming' ? 'No upcoming events. Plan one with “New event” or type /event in the chat.' : 'No past events yet.'}</p>
      )}
      <div className="cm-event-list" role="tabpanel">
        {list.map((ev) => (
          <EventCard key={ev.id} sid={sid} ev={ev} rsvps={rsvps.get(ev.rid)} me={ctx.me} perms={ctx.perms} send={send} toast={ctx.toast} />
        ))}
      </div>
      {failed > 0 && <p className="muted cm-hint">{failed} event{failed === 1 ? '' : 's'} could not be decrypted.</p>}
    </div>
  );
}

/** sidebarSections: the next event of the server and quick links (all events, rules). */
export function EventsSidebar({ ctx }) {
  const sid = ctx.sid;
  const ws = useWorkspaceCtx();
  const { events } = useServerEvents(sid);
  const rsvps = useServerRsvps(sid);
  const welcome = useWelcome(sid);
  const now = useNow();
  const next = useMemo(() => nextEvent(events, now), [events, now]);
  const where = useWhere(sid, next);
  const tally = tallyRsvps(next ? rsvps.get(next.rid) : null);
  const [busy, setBusy] = useState(false);

  // The panel lives in the chat view: open a text channel first when another view is showing.
  const showAll = () => {
    const ch = ctx.server?.channels || [];
    const active = ch.find((c) => c.cid === ctx.server?.activeCid);
    requestEventsPanel(sid);
    if (!(ctx.server?.tab === 'chat' && active?.type === 'text')) {
      const text = active?.type === 'text' ? active : ch.find((c) => c.type === 'text');
      if (text) ws?.openConv({ kind: 'channel', sid, cid: text.cid });
    }
  };
  const join = async () => {
    setBusy(true);
    try {
      await joinVoiceChannel(ws, sid, next.loc.cid);
    } catch (e) {
      ws?.toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cm-side" aria-label="Server events">
      <div className="cm-side-head">
        <span className="cm-side-title">Events</span>
        <button type="button" className="cm-icon-btn" onClick={() => openEventEditor({ sid })} aria-label="New event" title="New event">＋</button>
        <button type="button" className="cm-icon-btn" onClick={showAll} aria-label="All events" title="All events">☰</button>
      </div>
      {next ? (
        <div className="cm-next" style={{ '--ev-color': next.color }}>
          <button type="button" className="cm-next-main" onClick={() => openEventDetail({ sid, id: next.id })} aria-label={`Next event: ${next.title}, ${fmtRange(next)}`}>
            <span className="cm-next-title">{next.title}</span>
            <span className="cm-next-when">{isLive(next, now) ? 'Happening now' : relTime(next.start, now)} · {fmtRange(next)}</span>
            {where && <span className="cm-next-where">{next.loc.kind === 'voice' ? '🔊' : '📍'} {where}</span>}
            {(tally.going.length > 0 || tally.maybe.length > 0) && <span className="cm-next-count">{tally.going.length} going{tally.maybe.length ? ` · ${tally.maybe.length} maybe` : ''}</span>}
          </button>
          {canJoinVoice(next, now) && (
            <button type="button" className="btn primary sm cm-next-join" onClick={join} disabled={busy}>🔊 Join voice</button>
          )}
        </div>
      ) : (
        <p className="cm-side-empty">No upcoming events</p>
      )}
      {(welcome.configured || welcome.req) && (
        <button type="button" className="cm-side-link" onClick={() => openWelcome(sid)}>📜 Welcome &amp; rules</button>
      )}
    </section>
  );
}

/** Modal with one event (from the sidebar, reminders and the palette). */
export function EventDetailModal({ req, onClose }) {
  const ws = useWorkspaceCtx();
  const { sid, id } = req;
  const { events, loading } = useServerEvents(sid);
  const rsvps = useServerRsvps(sid);
  const { perms } = useMyServerPerms(sid, ws?.me?.uid);
  const ev = events.find((e) => e.id === id || e.rid === id);
  return (
    <PortalModal title={ev ? ev.title : 'Event'} onClose={onClose} className="cm-modal">
      {ev ? (
        <EventCard sid={sid} ev={ev} rsvps={rsvps.get(ev.rid)} me={ws.me} perms={perms} />
      ) : (
        <p className="muted">{loading ? 'Loading…' : 'This event was deleted.'}</p>
      )}
    </PortalModal>
  );
}

/** messageExtras: an event announced in chat (body.srvEvent = { id }) as a live card. */
export function EventMessageCard({ m, ctx }) {
  const sid = ctx.conv.sid;
  const id = m.body.srvEvent.id;
  const { events, loading } = useServerEvents(sid);
  const rsvps = useServerRsvps(sid);
  const ev = events.find((e) => e.id === id || e.rid === id);
  if (!ev) return loading ? null : <p className="cm-event-gone muted">📅 This event is no longer available.</p>;
  return <EventCard sid={sid} ev={ev} rsvps={rsvps.get(ev.rid)} me={ctx.me} perms={ctx.perms} toast={ctx.toast} compact />;
}

/** Validates the untrusted body extra before rendering. */
export const isEventRef = (v) => !!v && typeof v === 'object' && isEventId(v.id);
