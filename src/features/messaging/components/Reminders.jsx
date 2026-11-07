// Reminders UI: the chat panel (due / upcoming / done, with open, snooze, done and delete), the
// scheduler (appMounts) that fires due reminders once into the notification center, a desktop
// notification when the tab isn't focused, and an in-app card with the same actions.
import { useEffect, useRef, useState } from 'react';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { ExtMenu } from '../../../components/ext/ExtRender.jsx';
import { notificationPermission, showNotification, useNotifPrefs } from '../../../lib/notify.js';
import { deleteReminder, fireReminder, markDone, markUndone, snoozeReminder, useReminders } from '../lib/reminders.js';
import { dueToFire, nextDue, reminderSummary, sections } from '../lib/reminderModel.js';
import { formatDue, snoozeChoices } from '../lib/when.js';
import { openTarget } from '../lib/jump.js';
import { AlarmIcon } from './icons.jsx';

const MAX_TIMER = 60_000;

function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

const fail = (toast) => (e) => toast?.(e?.message || 'That didn’t work', 'error');

function SnoozeButton({ r, toast, className = 'btn ghost sm' }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Snooze
      </button>
      {open && (
        <ExtMenu
          anchor={btn.current}
          label="Snooze for"
          items={snoozeChoices(new Date()).map((c) => ({
            id: c.id,
            label: c.label,
            run: () => snoozeReminder(r, c.due).then(() => toast?.(`Snoozed until ${formatDue(c.due)}`, 'ok'), fail(toast)),
          }))}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) requestAnimationFrame(() => btn.current?.focus());
          }}
        />
      )}
    </>
  );
}

function ReminderItem({ r, now, toast }) {
  const state = r.done ? 'done' : r.fired || r.due <= now ? 'due' : 'upcoming';
  const open = () => openTarget({ ...r.conv, mid: r.mid }, { toast: (t) => toast?.(t, 'error') });
  return (
    <li className={`mx-rem-item ${state}`}>
      <div className="mx-rem-main">
        <span className="mx-rem-summary">{reminderSummary(r)}</span>
        <span className="mx-rem-meta">
          {state === 'done' ? 'Done' : state === 'due' ? `Due ${formatDue(r.due, new Date(now))}` : formatDue(r.due, new Date(now))}
          {r.title ? ` · ${r.title}` : ''}
        </span>
        {r.note && r.excerpt && <span className="mx-rem-excerpt">{r.author ? `${r.author}: ` : ''}{r.excerpt}</span>}
      </div>
      <div className="mx-rem-actions">
        <button type="button" className="btn ghost sm" onClick={open}>{r.mid ? 'Open message' : 'Open'}</button>
        {state !== 'done' && <SnoozeButton r={r} toast={toast} />}
        {state === 'done' ? (
          <button type="button" className="btn ghost sm" onClick={() => markUndone(r).catch(fail(toast))}>Undo</button>
        ) : (
          <button type="button" className="btn ghost sm" onClick={() => markDone(r).catch(fail(toast))}>Done</button>
        )}
        <button type="button" className="btn ghost sm danger" aria-label={`Delete reminder: ${reminderSummary(r)}`} onClick={() => deleteReminder(r).catch(fail(toast))}>
          Delete
        </button>
      </div>
    </li>
  );
}

/** chatPanels render: every reminder, grouped. */
export function RemindersPanel({ ctx }) {
  const { loading, list, error } = useReminders();
  const now = useNow();
  const { due, upcoming, done } = sections(list, now);
  const toast = ctx?.toast;
  if (loading) return <p className="muted">Loading reminders…</p>;
  if (error) return <p className="error-text">Couldn’t load reminders.</p>;
  return (
    <div className="mx-rem-panel">
      {!list.length && (
        <p className="muted">
          No reminders yet. Use <strong>Remind me…</strong> in a message’s “More actions” menu, or type
          {' '}<code>/remind 20m stretch</code>.
        </p>
      )}
      {due.length > 0 && (
        <section aria-label="Due reminders">
          <h4 className="mx-rem-h">Due</h4>
          <ul className="mx-rem-list">{due.map((r) => <ReminderItem key={r.id} r={r} now={now} toast={toast} />)}</ul>
        </section>
      )}
      {upcoming.length > 0 && (
        <section aria-label="Upcoming reminders">
          <h4 className="mx-rem-h">Upcoming</h4>
          <ul className="mx-rem-list">{upcoming.map((r) => <ReminderItem key={r.id} r={r} now={now} toast={toast} />)}</ul>
        </section>
      )}
      {done.length > 0 && (
        <section aria-label="Finished reminders">
          <h4 className="mx-rem-h">Done</h4>
          <ul className="mx-rem-list">{done.slice(0, 30).map((r) => <ReminderItem key={r.id} r={r} now={now} toast={toast} />)}</ul>
        </section>
      )}
    </div>
  );
}

/**
 * appMounts: fires due reminders (including ones that came due while no tab was open) and shows them.
 * A transaction on each record makes sure only one tab or device fires a reminder.
 */
export function ReminderScheduler({ ctx }) {
  const ws = useWorkspaceCtx() || ctx;
  const { loading, list } = useReminders();
  const prefs = useNotifPrefs(ws?.me?.uid);
  const [cards, setCards] = useState([]); // reminder ids fired by this tab and not dismissed
  const [tick, setTick] = useState(0);
  const firing = useRef(new Set());
  const latest = useRef({});
  latest.current = { prefs, ws };

  // Fire what's due now; wake up again for the next one (at most a minute later, so sleep and clock
  // changes are caught too).
  useEffect(() => {
    if (loading) return undefined;
    const now = Date.now();
    for (const r of dueToFire(list, now)) {
      const fk = `${r.id}|${r.due}`; // a snoozed reminder fires again at its new time
      if (firing.current.has(fk)) continue;
      firing.current.add(fk);
      fireReminder(r)
        .then((res) => {
          if (!res) return;
          setCards((c) => (c.includes(r.id) ? c : [...c, r.id]));
          alertDesktop(r, typeof res === 'string' ? res : r.id, latest.current);
        })
        .catch(() => firing.current.delete(fk));
    }
    const next = nextDue(list, now);
    const wait = next === null ? MAX_TIMER : Math.max(250, Math.min(MAX_TIMER, next - now + 50));
    const t = setTimeout(() => setTick((x) => x + 1), wait);
    return () => clearTimeout(t);
  }, [loading, list, tick]);

  useEffect(() => {
    const wake = () => setTick((x) => x + 1);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, []);

  // Cards follow the live list: a reminder snoozed, done or deleted anywhere disappears here too.
  const shown = cards.map((id) => list.find((r) => r.id === id)).filter((r) => r && !r.done && r.fired);
  if (!shown.length) return null;
  const toast = (text, kind) => ws?.toast?.(text, kind === 'ok' ? 'success' : kind || 'info');
  const dismiss = (id) => setCards((c) => c.filter((x) => x !== id));
  return (
    <section className="mx-due-stack" aria-label="Reminders due" aria-live="polite">
      {shown.slice(-3).map((r) => (
        <div key={r.id} className="mx-due-card" role="group" aria-label="Reminder">
          <div className="mx-due-head">
            <span className="mx-due-icon"><AlarmIcon size={16} /></span>
            <strong>Reminder</strong>
            <span className="mx-due-when">{formatDue(r.due)}</span>
            <button type="button" className="mx-due-x" aria-label="Hide this reminder (it stays in Reminders)" onClick={() => dismiss(r.id)}>✕</button>
          </div>
          <p className="mx-due-text">{reminderSummary(r)}</p>
          {r.title && <p className="mx-due-ctx">{r.title}</p>}
          <div className="mx-due-actions">
            <button
              type="button"
              className="btn primary sm"
              onClick={() => {
                dismiss(r.id);
                openTarget({ ...r.conv, mid: r.mid }, { toast: (t) => toast(t, 'error') });
              }}
            >
              {r.mid ? 'Open message' : 'Open'}
            </button>
            <SnoozeButton r={r} toast={toast} className="btn sm" />
            <button type="button" className="btn ghost sm" onClick={() => markDone(r).catch(fail(toast))}>Done</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function alertDesktop(r, tagId, { prefs, ws }) {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return;
  const s = prefs?.settings;
  if (!s?.desktop || notificationPermission() !== 'granted') return;
  // Like message alerts, the text only shows when previews are on in notification settings.
  const body = s.preview ? `${reminderSummary(r)}${r.title ? ` (${r.title})` : ''}` : 'It’s time for your reminder.';
  // Same tag as the notification center's own alert for this entry, so the two never stack.
  showNotification('Reminder', {
    body,
    tag: `notif_${tagId}`,
    onClick: () => openTarget({ ...r.conv, mid: r.mid }, { ws }),
  });
}
