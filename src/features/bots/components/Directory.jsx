// The public bot directory (pub/bots): search, sort, details, report, owner edit/unpublish and
// app-admin removal. In install mode (server settings) the details offer "Add to server".
// Every entry is validated on read (parseBotEntry); invalid ones are hidden, except from their
// publisher and app admins, who can remove them.
import { useMemo, useState } from 'react';
import { usePub } from '../../../lib/ext/store.js';
import { useProfiles } from '../../../lib/profiles.js';
import { useIsAppAdmin } from '../../../lib/admin.js';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { parseBotEntry } from '../lib/schema.js';
import { PUB_KIND, unpublishBot } from '../lib/store.js';
import BotAvatar from './BotAvatar.jsx';
import BotReportButton from './BotReport.jsx';

const PAGE = 60;

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/** Live, validated directory entries (newest `last` by update time, or one publisher's). */
export function useBotEntries({ last = PAGE, by } = {}) {
  const st = usePub(PUB_KIND, null, by ? { by } : { last });
  const entries = useMemo(() => st.items.map((it) => {
    const { id, ...raw } = it;
    return parseBotEntry(id, raw);
  }), [st.items]);
  return { loading: st.loading, error: st.error, entries, full: !by && st.items.length >= last };
}

function matches(entry, q) {
  if (!q) return true;
  const d = entry.def;
  const hay = [d.name, d.desc, ...d.commands.map((c) => `/${c.name} ${c.desc}`)].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/**
 * props: me ({ uid }), mode 'browse' | 'install', installedIds (Set, install mode),
 * onInstall(entry) (install mode), onEdit(entry) (owner), installBusy (id being installed).
 */
export default function BotDirectory({ me, mode = 'browse', installedIds, onInstall, onEdit, installBusy }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('new');
  const [last, setLast] = useState(PAGE);
  const [openId, setOpenId] = useState(null);
  const { loading, error, entries, full } = useBotEntries({ last });
  const isAdmin = useIsAppAdmin();
  const profiles = useProfiles(useMemo(() => [...new Set(entries.map((e) => e.by).filter(Boolean))], [entries]));

  const shown = useMemo(() => {
    const list = entries.filter((e) => (e.ok ? matches(e, q.trim()) : (e.by === me?.uid || isAdmin) && !q.trim()));
    const by = {
      new: (a, b) => (b.created || 0) - (a.created || 0),
      updated: (a, b) => (b.ts || 0) - (a.ts || 0),
      name: (a, b) => (a.def?.name || '').localeCompare(b.def?.name || ''),
    }[sort];
    return list.sort(by);
  }, [entries, q, sort, me?.uid, isAdmin]);

  const open = openId ? entries.find((e) => e.id === openId) : null;
  if (open) {
    return (
      <BotDetails
        entry={open}
        me={me}
        isAdmin={isAdmin}
        publisher={profiles[open.by]?.name}
        mode={mode}
        installed={!!installedIds?.has(open.id)}
        installBusy={installBusy === open.id}
        onInstall={onInstall}
        onEdit={onEdit}
        onBack={() => setOpenId(null)}
      />
    );
  }

  return (
    <div className="bt-dir">
      <div className="bt-dir-tools">
        <input
          className="input"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search bots and commands"
          aria-label="Search bots"
        />
        <select className="input bt-sort" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort bots">
          <option value="new">Newest</option>
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
        </select>
      </div>
      {error && <p className="error-text" role="alert">Couldn&apos;t load the directory: {String(error.message || error)}</p>}
      {loading && <p className="muted">Loading bots…</p>}
      {!loading && !error && shown.length === 0 && (
        <p className="muted">{q.trim() ? 'No bots match your search.' : 'No bots have been published yet. Create the first one!'}</p>
      )}
      <ul className="bt-list" aria-label="Bots">
        {shown.map((e) => (
          <li key={e.id}>
            {e.ok ? (
              <button type="button" className="bt-list-item" onClick={() => setOpenId(e.id)} aria-label={`${e.def.name}: details`}>
                <BotAvatar glyph={e.def.glyph} image={e.image} size={40} />
                <span className="bt-list-text">
                  <span className="bt-list-name">
                    {e.def.name}
                    {installedIds?.has(e.id) && <span className="bt-pill ok">Installed</span>}
                  </span>
                  {e.def.desc && <span className="bt-list-desc">{e.def.desc}</span>}
                  <span className="bt-list-meta">
                    {e.def.commands.length} command{e.def.commands.length === 1 ? '' : 's'} · {e.def.triggers.length} trigger{e.def.triggers.length === 1 ? '' : 's'}
                    {e.def.welcome ? ' · welcome' : ''} · by {profiles[e.by]?.name || 'someone'}
                  </span>
                </span>
              </button>
            ) : (
              <div className="bt-list-item invalid">
                <span className="bt-list-text">
                  <span className="bt-list-name">Invalid bot <code>{e.id}</code></span>
                  <span className="bt-list-desc">{e.error} It is hidden from the directory.</span>
                </span>
                {(e.by === me?.uid || isAdmin) && (
                  <ConfirmButton onConfirm={() => unpublishBot(e.id).catch(() => {})} confirmLabel="Remove?">Remove</ConfirmButton>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {full && !q.trim() && (
        <button type="button" className="btn sm bt-more" onClick={() => setLast((n) => n + PAGE)}>Load more</button>
      )}
      {mode === 'browse' && (
        <p className="muted bt-small">To add a bot to a server, open that server&apos;s settings → Bots (needs the “Manage apps” permission).</p>
      )}
    </div>
  );
}

/** One bot's full definition (as text, never rendered as HTML) and its actions. */
export function BotDetails({ entry, me, isAdmin, publisher, mode, installed, installBusy, onInstall, onEdit, onBack }) {
  const [err, setErr] = useState('');
  const mine = entry.by === me?.uid;
  const d = entry.def;
  return (
    <article className="bt-details" aria-label={`${d.name} details`}>
      <button type="button" className="btn ghost sm bt-back" onClick={onBack}>← All bots</button>
      <header className="bt-details-head">
        <BotAvatar glyph={d.glyph} image={entry.image} size={64} />
        <div>
          <h3>{d.name} <span className="bt-badge-tag">BOT</span></h3>
          <p className="muted bt-small">by {publisher || 'someone'} · version {entry.ver} · updated {fmtDate(entry.ts)}</p>
        </div>
      </header>
      {d.desc && <p className="bt-desc">{d.desc}</p>}

      <div className="bt-actions left">
        {mode === 'install' && (
          installed
            ? <span className="bt-pill ok">Installed in this server</span>
            : <button type="button" className="btn primary sm" disabled={installBusy} onClick={() => onInstall?.(entry)}>{installBusy ? 'Adding…' : 'Add to server'}</button>
        )}
        {mine && onEdit && <button type="button" className="btn sm" onClick={() => onEdit(entry)}>Edit</button>}
        {(mine || isAdmin) && (
          <ConfirmButton
            confirmLabel={mine ? 'Unpublish?' : 'Remove from directory?'}
            onConfirm={async () => {
              try {
                await unpublishBot(entry.id);
                onBack();
              } catch (e) {
                setErr(e?.message || 'Could not remove the bot.');
              }
            }}
          >
            {mine ? 'Unpublish' : 'Remove (app admin)'}
          </ConfirmButton>
        )}
        {!mine && <BotReportButton entry={entry} />}
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}

      <BotSpec def={d} />
      <p className="muted bt-small">
        Bots run in members&apos; browsers, not on a server: a bot message is sent by the member who used the command
        (or whose message matched a trigger), and bots can&apos;t act when nobody is online.
      </p>
    </article>
  );
}

/** Commands, triggers and welcome message of a definition (plain text). */
export function BotSpec({ def }) {
  return (
    <div className="bt-spec">
      <h4>Commands</h4>
      {def.commands.length === 0 ? <p className="muted bt-small">No commands.</p> : (
        <ul className="bt-spec-list">
          {def.commands.map((c) => (
            <li key={c.name}>
              <code>/{c.name}{c.usage ? ` ${c.usage}` : ''}</code>
              {c.desc && <span className="muted"> — {c.desc}</span>}
              <pre className="bt-template">{c.response}</pre>
            </li>
          ))}
        </ul>
      )}
      <h4>Keyword triggers</h4>
      {def.triggers.length === 0 ? <p className="muted bt-small">No keyword triggers.</p> : (
        <ul className="bt-spec-list">
          {def.triggers.map((t) => (
            <li key={t.id}>
              <span>“{t.match}”</span> <span className="muted">· cooldown {t.cooldown} s</span>
              <pre className="bt-template">{t.response}</pre>
            </li>
          ))}
        </ul>
      )}
      <h4>Welcome message</h4>
      {def.welcome ? <pre className="bt-template">{def.welcome}</pre> : <p className="muted bt-small">None.</p>}
    </div>
  );
}
