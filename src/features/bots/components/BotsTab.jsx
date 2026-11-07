// Settings → Bots: the public directory, my published bots, and the bot builder.
import { useEffect, useState } from 'react';
import { BOT_LIMITS } from '../lib/schema.js';
import { unpublishBot } from '../lib/store.js';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import BotDirectory, { useBotEntries } from './Directory.jsx';
import BotBuilder from './BotBuilder.jsx';
import BotAvatar from './BotAvatar.jsx';

// A palette action can ask the tab to open straight into the builder.
let intent = null;
export const requestBotsView = (view) => {
  intent = view;
};

export default function BotsTab({ ctx }) {
  const me = ctx?.me || (ctx?.user ? { uid: ctx.user.uid } : null);
  const [view, setView] = useState(() => {
    const v = intent;
    intent = null;
    return v === 'create' ? { name: 'edit', entry: null, from: 'mine' } : { name: 'browse' };
  });
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  if (view.name === 'edit') {
    return (
      <BotBuilder
        entry={view.entry}
        me={me}
        onCancel={() => setView({ name: view.from || 'mine' })}
        onDone={() => {
          setNotice(view.entry ? 'Saved a new version. Servers using this bot will see “Update available”.' : 'Your bot is published in the directory.');
          setView({ name: 'mine' });
        }}
      />
    );
  }

  const tabs = [['browse', 'Directory'], ['mine', 'My bots']];
  return (
    <div className="bt-tab">
      <p className="muted bt-intro">
        Bots post replies to slash commands and keywords, and can welcome new members. They are simple text
        templates (no code), run in members&apos; browsers (there is no bot server), and a bot message is sent by the member
        who used it. Bots can&apos;t act while nobody is online.
      </p>
      <div className="bt-seg" role="tablist" aria-label="Bots">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view.name === id}
            className={`bt-seg-btn${view.name === id ? ' on' : ''}`}
            onClick={() => setView({ name: id })}
          >
            {label}
          </button>
        ))}
      </div>
      {notice && <p className="bt-notice" role="status">{notice}</p>}
      <div role="tabpanel">
        {view.name === 'browse' && <BotDirectory me={me} onEdit={(entry) => setView({ name: 'edit', entry, from: 'browse' })} />}
        {view.name === 'mine' && <MyBots me={me} onEdit={(entry) => setView({ name: 'edit', entry, from: 'mine' })} />}
      </div>
    </div>
  );
}

function MyBots({ me, onEdit }) {
  const { loading, error, entries } = useBotEntries({ by: me?.uid });
  const [err, setErr] = useState('');
  const full = entries.length >= BOT_LIMITS.perUser;
  return (
    <div className="bt-mine">
      <div className="bt-actions left">
        <button type="button" className="btn primary sm" disabled={full || loading} onClick={() => onEdit(null)}>Create a bot</button>
        <span className="muted bt-small">{entries.length}/{BOT_LIMITS.perUser} bots</span>
      </div>
      {error && <p className="error-text" role="alert">{String(error.message || error)}</p>}
      {err && <p className="error-text" role="alert">{err}</p>}
      {loading && <p className="muted">Loading…</p>}
      {!loading && entries.length === 0 && <p className="muted">You haven&apos;t published a bot yet.</p>}
      <ul className="bt-list" aria-label="My bots">
        {entries.map((e) => (
          <li key={e.id} className="bt-list-item static">
            {e.ok ? <BotAvatar glyph={e.def.glyph} image={e.image} size={36} /> : <BotAvatar size={36} />}
            <span className="bt-list-text">
              <span className="bt-list-name">{e.ok ? e.def.name : <>Invalid bot <code>{e.id}</code></>}</span>
              <span className="bt-list-meta">{e.ok ? `version ${e.ver} · ${e.def.commands.length} commands · ${e.def.triggers.length} triggers` : e.error}</span>
            </span>
            <span className="bt-row-actions">
              {e.ok && <button type="button" className="btn sm" onClick={() => onEdit(e)} aria-label={`Edit ${e.def.name}`}>Edit</button>}
              <ConfirmButton
                confirmLabel="Unpublish?"
                onConfirm={async () => {
                  setErr('');
                  try {
                    await unpublishBot(e.id);
                  } catch (ex) {
                    setErr(ex?.message || 'Could not unpublish.');
                  }
                }}
              >
                Unpublish
              </ConfirmButton>
            </span>
          </li>
        ))}
      </ul>
      <p className="muted bt-small">Unpublishing removes a bot from the directory. Servers that installed it keep their pinned copy until they uninstall it.</p>
    </div>
  );
}
