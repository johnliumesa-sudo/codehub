// appMounts 'community.host': the community modals (event editor, event details, welcome screen,
// Discover) and the event reminder scheduler. Reminders fire 15 minutes before events I'm going to,
// while a Codehub tab is open (no push on the Spark plan); one missed while offline fires on the
// next load if the event hasn't started yet.
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { useServerMeta } from '../../../components/layout/hooks.js';
import { showNotification, useNotifPrefs } from '../../../lib/notify.js';
import { canJoinVoice, dueReminders, fmtRange, nextReminderIn, reminderId, relTime } from '../lib/events.js';
import { useMyRsvpIndex, useServerEvents } from '../lib/data.js';
import { closeDiscover, closeEventDetail, closeEventEditor, openEventDetail, useUi } from '../lib/bus.js';
import EventEditor from './EventEditor.jsx';
import { EventDetailModal } from './EventsViews.jsx';
import { WelcomeHost } from './Welcome.jsx';
import { DiscoverModal } from './Discovery.jsx';
import { errText, joinVoiceChannel } from './common.jsx';

const FIRED_KEY = 'codehub.eventReminders';
const KEEP_MS = 3 * 24 * 3600 * 1000;

function loadFired() {
  try {
    const v = JSON.parse(localStorage.getItem(FIRED_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function saveFired(map) {
  const now = Date.now();
  const kept = Object.fromEntries(Object.entries(map).filter(([, at]) => typeof at === 'number' && now - at < KEEP_MS));
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(kept));
  } catch { /* storage full or disabled: reminders may repeat */ }
}

/** Reports one server's decrypted events up to the scheduler. */
const ServerEventsFeed = memo(function ServerEventsFeed({ sid, onEvents }) {
  const { events } = useServerEvents(sid);
  useEffect(() => onEvents(sid, events), [sid, events, onEvents]);
  useEffect(() => () => onEvents(sid, null), [sid, onEvents]);
  return null;
});

function ReminderCard({ r, onDismiss }) {
  const ws = useWorkspaceCtx();
  const meta = useServerMeta(r.sid, 0);
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const join = async () => {
    setBusy(true);
    try {
      await joinVoiceChannel(ws, r.sid, r.ev.loc.cid);
      onDismiss();
    } catch (e) {
      ws.toast(errText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="cm-reminder" style={{ '--ev-color': r.ev.color }} aria-label={`Reminder: ${r.ev.title}`}>
      <div className="cm-reminder-head">
        <span>⏰ {r.ev.start > now ? `Starts ${relTime(r.ev.start, now)}` : 'Starting now'}{meta.name ? ` · ${meta.name}` : ''}</span>
        <button type="button" className="cm-icon-btn" onClick={onDismiss} aria-label="Dismiss reminder">✕</button>
      </div>
      <strong className="cm-reminder-title">{r.ev.title}</strong>
      <span className="muted">{fmtRange(r.ev)}</span>
      <div className="cm-reminder-actions">
        {canJoinVoice(r.ev, now) && <button type="button" className="btn primary sm" onClick={join} disabled={busy}>🔊 Join voice</button>}
        <button type="button" className="btn ghost sm" onClick={() => { openEventDetail({ sid: r.sid, id: r.ev.id }); onDismiss(); }}>View event</button>
      </div>
    </section>
  );
}

function EventReminders() {
  const ws = useWorkspaceCtx();
  const uid = ws?.me?.uid;
  const index = useMyRsvpIndex(uid);
  const prefs = useNotifPrefs(uid);
  const servers = useMemo(() => new Set((ws?.servers || []).map((s) => s.sid)), [ws?.servers]);
  // `${sid}/${rid}` I'm going to, and the servers they belong to.
  const going = useMemo(() => {
    const out = new Set();
    Object.entries(index).forEach(([k, v]) => {
      const i = k.indexOf('~');
      if (v === 'going' && i > 0 && servers.has(k.slice(0, i))) out.add(`${k.slice(0, i)}/${k.slice(i + 1)}`);
    });
    return out;
  }, [index, servers]);
  const sids = useMemo(() => [...new Set([...going].map((k) => k.split('/')[0]))].sort(), [going]);
  const [bySid, setBySid] = useState({});
  const onEvents = useCallback((sid, events) => setBySid((m) => {
    if (m[sid] === events) return m;
    const next = { ...m };
    if (events) next[sid] = events;
    else delete next[sid];
    return next;
  }), []);
  const list = useMemo(() => Object.entries(bySid).flatMap(([sid, evs]) => evs.map((ev) => ({ sid, ev, rid: ev.rid }))), [bySid]);
  const [active, setActive] = useState([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const fired = loadFired();
    const firedSet = new Set(Object.keys(fired));
    const now = Date.now();
    const due = dueReminders(list, going, firedSet, now);
    if (due.length) {
      due.forEach((r) => { fired[reminderId(r.sid, r.ev)] = now; });
      saveFired(fired);
      setActive((a) => [...a.filter((x) => !due.some((d) => d.ev.id === x.ev.id)), ...due].slice(-4));
      if (prefs.settings?.desktop) {
        // Like message alerts, the (encrypted) title only shows when previews are on.
        due.forEach((r) => showNotification(prefs.settings?.preview ? `Starting soon: ${r.ev.title}` : 'An event you’re going to starts soon', {
          body: fmtRange(r.ev),
          tag: `event-${r.ev.id}`,
          onClick: () => openEventDetail({ sid: r.sid, id: r.ev.id }),
        }));
      }
    }
    const wait = nextReminderIn(list, going, new Set(Object.keys(loadFired())), now);
    // Re-check at the next due time, and every minute anyway (sleeping laptops skip timers).
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(wait ?? 60_000, 60_000) + 50);
    return () => clearTimeout(t);
  }, [list, going, tick, prefs.settings?.desktop, prefs.settings?.preview]);

  // Drop cards once their event is over or gone.
  const visible = active.filter((r) => list.some((x) => x.sid === r.sid && x.ev.id === r.ev.id && !x.ev.cancelled) && Date.now() < (r.ev.end || r.ev.start + 2 * 3600_000));
  return (
    <>
      {sids.map((sid) => <ServerEventsFeed key={sid} sid={sid} onEvents={onEvents} />)}
      {visible.length > 0 && (
        <div className="cm-reminders" aria-live="polite">
          {visible.map((r) => {
            const fresh = list.find((x) => x.sid === r.sid && x.ev.id === r.ev.id)?.ev || r.ev;
            return <ReminderCard key={`${r.sid}/${r.ev.id}`} r={{ ...r, ev: fresh }} onDismiss={() => setActive((a) => a.filter((x) => x !== r))} />;
          })}
        </div>
      )}
    </>
  );
}

export default function CommunityHost() {
  const ui = useUi();
  return (
    <>
      <EventReminders />
      <WelcomeHost />
      {ui.editor && <EventEditor key={ui.editor.at} req={ui.editor} onClose={closeEventEditor} />}
      {ui.detail && <EventDetailModal req={ui.detail} onClose={closeEventDetail} />}
      {ui.discover && <DiscoverModal onClose={closeDiscover} />}
    </>
  );
}
