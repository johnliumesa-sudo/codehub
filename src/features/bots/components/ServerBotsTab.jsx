// Server settings → Bots: the bots installed in this server (pinned copies in sconf/{sid}/bots)
// with their commands; members with "Manage apps" add bots from the directory, update a pinned
// copy when the publisher saved a new version, and uninstall.
import { useState } from 'react';
import { usePub } from '../../../lib/ext/store.js';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { BOT_LIMITS, parseBotEntry } from '../lib/schema.js';
import { installBot, PUB_KIND, uninstallBot, updateInstalledBot, useInstalledBots } from '../lib/store.js';
import BotDirectory, { BotSpec } from './Directory.jsx';
import BotAvatar from './BotAvatar.jsx';

export default function ServerBotsTab({ ctx }) {
  const sid = ctx.sid;
  const canManage = !!ctx.perms?.manageApps;
  const installed = useInstalledBots(sid) || [];
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null); // { text, error? }
  const ids = new Set(installed.map((b) => b.id));
  const full = installed.length >= BOT_LIMITS.perServer;

  async function install(entry) {
    if (full) return setMsg({ text: `A server can have at most ${BOT_LIMITS.perServer} bots.`, error: true });
    setBusyId(entry.id);
    setMsg(null);
    try {
      await installBot(sid, entry);
      setMsg({ text: `${entry.def.name} was added. Its commands are in the / menu of this server's channels.` });
      setAdding(false);
    } catch (e) {
      setMsg({ text: e?.message || 'Could not add the bot.', error: true });
    } finally {
      setBusyId(null);
    }
  }

  if (adding && canManage) {
    return (
      <div className="bt-server">
        <div className="bt-actions left">
          <button type="button" className="btn ghost sm" onClick={() => setAdding(false)}>← Installed bots</button>
          <span className="muted bt-small">{installed.length}/{BOT_LIMITS.perServer} bots installed</span>
        </div>
        {msg && <p className={msg.error ? 'error-text' : 'bt-notice'} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
        <BotDirectory me={ctx.me} mode="install" installedIds={ids} onInstall={install} installBusy={busyId} />
      </div>
    );
  }

  return (
    <div className="bt-server">
      <p className="muted bt-intro">
        Bots run in members&apos; browsers, not on a server: a bot&apos;s reply is sent by the member who used the command (or
        whose message matched a keyword), welcome messages are posted by the new member, and nothing happens while
        nobody is online. Each server keeps its own copy of a bot, so the publisher&apos;s later changes only apply after an update here.
      </p>
      {canManage ? (
        <div className="bt-actions left">
          <button type="button" className="btn primary sm" onClick={() => { setMsg(null); setAdding(true); }} disabled={full}>Add a bot</button>
          <span className="muted bt-small">{installed.length}/{BOT_LIMITS.perServer} bots installed</span>
        </div>
      ) : (
        <p className="muted bt-small">Members with the “Manage apps” permission can add and remove bots.</p>
      )}
      {msg && <p className={msg.error ? 'error-text' : 'bt-notice'} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
      {installed.length === 0 && <p className="muted">No bots are installed in this server.</p>}
      <ul className="bt-installed" aria-label="Installed bots">
        {installed.map((bot) => (
          <InstalledBot key={bot.id} sid={sid} bot={bot} canManage={canManage} onMessage={setMsg} />
        ))}
      </ul>
    </div>
  );
}

function InstalledBot({ sid, bot, canManage, onMessage }) {
  const pub = usePub(PUB_KIND, bot.id);
  const latest = pub.value ? parseBotEntry(bot.id, pub.value) : null;
  const update = latest?.ok && latest.ver > bot.ver ? latest : null;
  const removed = !pub.loading && !pub.error && !pub.value;
  const [busy, setBusy] = useState(false);
  const d = bot.def;
  return (
    <li className="bt-installed-item">
      <div className="bt-installed-head">
        <BotAvatar glyph={d.glyph} image={bot.image} size={40} />
        <div className="bt-list-text">
          <span className="bt-list-name">
            {d.name}
            <span className="muted bt-small"> v{bot.ver}</span>
            {update && <span className="bt-pill warn">Update available (v{update.ver})</span>}
            {removed && <span className="bt-pill">No longer in the directory</span>}
          </span>
          {d.desc && <span className="bt-list-desc">{d.desc}</span>}
          <span className="bt-list-meta">
            {d.commands.length ? d.commands.map((c) => `/${c.name}`).join(' ') : 'No commands'}
            {d.triggers.length ? ` · ${d.triggers.length} keyword trigger${d.triggers.length === 1 ? '' : 's'}` : ''}
            {d.welcome ? ' · welcome message' : ''}
          </span>
        </div>
        {canManage && (
          <span className="bt-row-actions">
            {update && (
              <button
                type="button"
                className="btn sm primary"
                disabled={busy}
                aria-label={`Update ${d.name} to version ${update.ver}`}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await updateInstalledBot(sid, update);
                    onMessage({ text: `${d.name} updated to version ${update.ver}.` });
                  } catch (e) {
                    onMessage({ text: e?.message || 'Could not update the bot.', error: true });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Update
              </button>
            )}
            <ConfirmButton
              confirmLabel="Uninstall?"
              onConfirm={async () => {
                try {
                  await uninstallBot(sid, bot.id);
                  onMessage({ text: `${d.name} was removed from this server.` });
                } catch (e) {
                  onMessage({ text: e?.message || 'Could not uninstall the bot.', error: true });
                }
              }}
            >
              Uninstall
            </ConfirmButton>
          </span>
        )}
      </div>
      <details className="bt-installed-more">
        <summary>Commands, triggers and welcome message</summary>
        <BotSpec def={d} />
      </details>
    </li>
  );
}
