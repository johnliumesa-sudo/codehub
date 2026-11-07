import { useEffect, useMemo, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import { useProfile } from '../../lib/profiles.js';
import { KIND_LABEL, REPORT_KINDS, REPORT_REASONS, dismissReport, dismissReports, parseMessageTarget, useReports } from '../../lib/reports.js';
import { deleteGame } from '../../lib/games.js'; // WS4 export (0.8)
import { ConfirmButton } from '../layout/ui.jsx';
import { useRegistry } from '../../lib/ext/registry.js';
import { ExtRender, passes } from '../ext/ExtRender.jsx';
import './admin.css';

const REASON_LABEL = Object.fromEntries(REPORT_REASONS);

function fmt(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { timeStyle: 'short' }) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Live plaintext field of a public node (games/{id}/title, shop/items/{id}/name). undefined = loading, null = gone.
function usePublicField(path) {
  const [val, setVal] = useState(undefined);
  useEffect(() => {
    if (!path) return undefined;
    setVal(undefined);
    return onValue(ref(db, path), (s) => setVal(s.exists() ? s.val() : null), () => setVal(null));
  }, [path]);
  return val;
}

function UserName({ uid }) {
  const p = useProfile(uid);
  return <span className="adm-user" style={{ color: p?.color }}>{p?.name || '…'}</span>;
}

// Round 3: `reportTargets` entries { id, label, match(r), render(r), actions?(r, { act, dismiss, busy }) }
// describe reports whose target a feature owns: kinds `bot` and `addon` (target = the pub/bots or
// pub/addons id), and older add-on reports filed as `shopItem` with target `addon:{id}`.
function useReportExt(r) {
  const entries = useRegistry('reportTargets');
  return entries.find((e) => typeof e.match === 'function' && typeof e.render === 'function' && passes(e.match, r)) || null;
}

function TargetInfo({ r, ext }) {
  const gameTitle = usePublicField(r.kind === 'game' ? `games/${r.target}/title` : null);
  const itemName = usePublicField(r.kind === 'shopItem' && !ext ? `shop/items/${r.target}/name` : null);
  if (ext) return <ExtRender entry={ext} args={[r]} label={ext.label} />;
  if (r.kind === 'game') {
    return (
      <span>
        {gameTitle === undefined ? '…' : gameTitle === null ? <em className="muted">Game no longer published</em> : <strong>{gameTitle}</strong>}
        <code className="adm-id">{r.target}</code>
      </span>
    );
  }
  if (r.kind === 'shopItem') {
    return (
      <span>
        {itemName === undefined ? '…' : itemName === null ? <em className="muted">Item deleted</em> : <strong>{itemName}</strong>}
        <code className="adm-id">{r.target}</code>
      </span>
    );
  }
  if (r.kind === 'user') {
    return (
      <span>
        <UserName uid={r.target} />
        <code className="adm-id">{r.target}</code>
      </span>
    );
  }
  if (r.kind !== 'message') return <code className="adm-id">{r.target}</code>;
  const mt = parseMessageTarget(r.target);
  return (
    <span>
      {mt.author ? <>Message by <UserName uid={mt.author} /></> : 'Message'}
      {mt.scope && <span className="muted"> · {mt.scope}</span>}
      <code className="adm-id" title="Encrypted location (admins cannot decrypt it)">{mt.where}</code>
    </span>
  );
}

function ReportCard({ r, dupes, onOpenGame, onError }) {
  const [busy, setBusy] = useState(false);
  const ext = useReportExt(r);
  async function act(fn) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e?.message || 'Action failed.');
      setBusy(false);
    }
  }
  return (
    <li className={`adm-report reason-${r.reason}`}>
      <div className="adm-report-head">
        <span className="adm-pill kind">{ext?.label || KIND_LABEL[r.kind] || r.kind}</span>
        <span className={`adm-pill reason ${r.reason}`}>{REASON_LABEL[r.reason] || r.reason}</span>
        {dupes > 1 && <span className="adm-pill dupes" title="Open reports for this same target">{dupes} reports</span>}
        <span className="muted adm-report-time">{fmt(r.ts)}</span>
      </div>
      <div className="adm-report-target"><TargetInfo r={r} ext={ext} /></div>
      <div className="adm-report-by muted">Reported by <UserName uid={r.by} /></div>
      {r.note && <p className="adm-report-note">{r.note}</p>}
      {r.excerpt && (
        <div className="adm-report-excerpt">
          <span className="adm-unverified">Excerpt supplied by reporter — unverified</span>
          <blockquote>{r.excerpt}</blockquote>
        </div>
      )}
      <div className="adm-actions left">
        {r.kind === 'game' && onOpenGame && (
          <button type="button" className="btn sm" disabled={busy} onClick={() => onOpenGame(r.target)}>Open game</button>
        )}
        {r.kind === 'game' && (
          <ConfirmButton
            confirmLabel="Unpublish for everyone?"
            disabled={busy}
            onConfirm={() => act(async () => {
              await deleteGame(r.target);
              await dismissReport(r.rid);
            })}
          >
            Unpublish game
          </ConfirmButton>
        )}
        {ext?.actions && <ExtRender fn={ext.actions} args={[r, { act, dismiss: () => dismissReport(r.rid), busy }]} label={ext.label} />}
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => act(() => dismissReport(r.rid))}>Dismiss</button>
        {dupes > 1 && (
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => act(() => dismissReports(r.sameTarget))}>
            Dismiss all {dupes}
          </button>
        )}
      </div>
    </li>
  );
}

/** Admin-only queue of reports (reports/*), newest first. */
export default function ReportsQueue({ onOpenGame }) {
  const { reports, loading, error } = useReports(200);
  const [filter, setFilter] = useState('all');
  const [actionErr, setActionErr] = useState('');

  const enriched = useMemo(() => {
    const byTarget = new Map();
    for (const r of reports) {
      const k = `${r.kind}|${r.target}`;
      if (!byTarget.has(k)) byTarget.set(k, []);
      byTarget.get(k).push(r.rid);
    }
    return reports.map((r) => ({ ...r, sameTarget: byTarget.get(`${r.kind}|${r.target}`) }));
  }, [reports]);

  const counts = useMemo(() => {
    const c = { all: reports.length };
    for (const r of reports) c[r.kind] = (c[r.kind] || 0) + 1;
    return c;
  }, [reports]);

  const list = filter === 'all' ? enriched : enriched.filter((r) => r.kind === filter);

  return (
    <div className="adm-section">
      <p className="adm-note">
        Reports are plaintext. Message excerpts are typed in by the reporter and cannot be verified, because admins
        cannot decrypt messages. Dismissing deletes the report.
      </p>
      <div className="adm-chips" role="tablist" aria-label="Filter reports">
        {['all', ...REPORT_KINDS].map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={filter === k}
            className={`adm-chip${filter === k ? ' on' : ''}`}
            onClick={() => setFilter(k)}
          >
            {k === 'all' ? 'All' : KIND_LABEL[k]}
            <span className="adm-chip-n">{counts[k] || 0}</span>
          </button>
        ))}
      </div>
      {actionErr && <p className="error-text" role="alert">{actionErr}</p>}
      {loading ? (
        <div className="adm-loading"><div className="spinner" /></div>
      ) : error ? (
        <p className="error-text">{error}</p>
      ) : list.length === 0 ? (
        <div className="adm-empty">
          <strong>All clear</strong>
          <span className="muted">No open {filter === 'all' ? '' : `${KIND_LABEL[filter].toLowerCase()} `}reports.</span>
        </div>
      ) : (
        <ul className="adm-report-list">
          {list.map((r) => (
            <ReportCard
              key={r.rid}
              r={r}
              dupes={r.sameTarget.length}
              onOpenGame={onOpenGame}
              onError={(m) => {
                setActionErr(m);
                setTimeout(() => setActionErr(''), 6000);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
