// How bot and command messages look to readers. Body keys are untrusted (any member can put
// anything in their own message), so they are validated first and rendered as React text.
import { useInstalledBots } from '../lib/store.js';
import { cleanBotTag, cleanCmd, DEFAULT_GLYPH } from '../lib/schema.js';
import BotAvatar from './BotAvatar.jsx';

/**
 * messageBadges: "BotName · BOT · via @member". A bot installed in this server is shown with its
 * installed name and icon (the server's managers chose it) and replaces the author line; a message
 * that names a bot this server doesn't have keeps the real author first and is marked as such.
 */
export function BotBadge({ m, ctx }) {
  const tag = cleanBotTag(m.body?.bot);
  const sid = ctx?.conv?.kind === 'channel' ? ctx.conv.sid : null;
  const installed = useInstalledBots(sid);
  if (!tag) return null;
  const inst = (installed || []).find((b) => b.id === tag.id) || null;
  const via = ctx?.profiles?.[m.uid]?.name || 'a member';
  const name = inst ? inst.def.name : tag.name;
  const glyph = inst ? inst.def.glyph || DEFAULT_GLYPH : tag.glyph || DEFAULT_GLYPH;
  return (
    <span
      className={`bt-badge${inst ? ' lead' : ' unverified'}`}
      title={inst
        ? `${name} is a bot installed in this server. Bots run in members' browsers: this message was sent by ${via}.`
        : `This message names a bot that isn't installed in this server. It was sent by ${via}.`}
    >
      <BotAvatar glyph={glyph} image={inst?.image} size={18} className="bt-badge-avatar" />
      <span className="bt-badge-name">{name}</span>
      <span className="bt-badge-sep" aria-hidden="true">·</span>
      <span className="bt-badge-tag">BOT</span>
      <span className="bt-badge-sep" aria-hidden="true">·</span>
      <span className="bt-badge-via">via @{via}</span>
      {!inst && <span className="bt-badge-warn">(not installed here)</span>}
    </span>
  );
}

/**
 * messageExtras: a small note saying which command (or bot event) produced the message. A welcome
 * message is posted automatically from the newcomer's own account, so it says so plainly.
 */
export function CommandNote({ m, ctx }) {
  const cmd = cleanCmd(m.body?.cmd);
  const tag = cleanBotTag(m.body?.bot);
  let note = null;
  if (cmd) note = <>used <code>/{cmd}</code></>;
  else if (tag?.via === 'trigger') note = 'replied to a keyword';
  else if (tag?.via === 'welcome') {
    const who = ctx?.profiles?.[m.uid]?.name || 'a new member';
    note = `Automatic bot welcome, posted from ${who}'s account when they joined. They didn't write it.`;
  }
  if (!note) return null;
  return <div className={`bt-cmd-note${tag?.via === 'welcome' && !cmd ? ' auto' : ''}`}>{note}</div>;
}

/** groupKey for messageBadges: bot messages and /me actions start their own header. */
export function botGroupKey(m) {
  const tag = cleanBotTag(m?.body?.bot);
  if (tag) return `bot:${tag.id}`;
  return cleanCmd(m?.body?.cmd) === 'me' ? 'me' : '';
}
