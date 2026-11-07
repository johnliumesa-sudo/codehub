// Bots at run time, in the browser of the member who triggers them (there is no bot server):
// - commands: the slash command returns a draft with `extra.bot`, so the invoker's message IS the
//   bot's reply;
// - keyword triggers: the `bots.triggers` send hook notices a trigger in the member's own outgoing
//   message and queues the reply; BotsHost sends it once the original message is in the list (so
//   the reply always comes after it);
// - welcome messages: BotsHost posts them from the new member's browser (once, tracked in udata).
import { answeredRecently, findTrigger } from './triggers.js';
import { renderTemplate, usesCount } from './template.js';
import { DEFAULT_GLYPH } from './schema.js';
import { bumpCount, coolingLocally, markCooldown, peekInstalled, serverName } from './store.js';
import { queueReply } from './pending.js';

/** Slowmode seconds per channel scope, kept by the mounted host (trigger replies skip slowmode channels). */
export const slowmodes = new Map();

/** The `bot` body key for a message from `bot`. */
export function botTag(bot, via, trig) {
  const tag = { id: bot.id, name: bot.def.name, glyph: bot.def.glyph || DEFAULT_GLYPH, via };
  if (trig) tag.trig = trig;
  return tag;
}

async function render(template, ctx, bot, { args = '', counter } = {}) {
  const sid = ctx?.conv?.sid;
  return renderTemplate(template, {
    user: ctx?.me?.name || '',
    channel: ctx?.conv?.name || ctx?.conv?.title || '',
    server: template.includes('{server}') ? await serverName(sid) : '',
    args,
    count: counter && usesCount(template) ? bumpCount(sid, bot.id, counter) : 0,
  });
}

/** Draft for running `/name args` of an installed bot. */
export async function commandDraft(bot, cmd, args, ctx) {
  const text = await render(cmd.response, ctx, bot, { args, counter: `/${cmd.name}` });
  if (!text) return { cancel: true, reason: `/${cmd.name} produced an empty reply.` };
  return { text, extra: { bot: botTag(bot, 'cmd'), cmd: cmd.name } };
}

/** Draft for a keyword trigger's reply. */
export async function triggerDraft(bot, trigger, ctx) {
  const text = await render(trigger.response, ctx, bot, { counter: `trigger:${trigger.id}` });
  return text ? { text, extra: { bot: botTag(bot, 'trigger', trigger.id) } } : null;
}

/** Draft for a bot's welcome message. */
export async function welcomeDraft(bot, ctx) {
  const text = await render(bot.def.welcome, ctx, bot);
  return text ? { text, extra: { bot: botTag(bot, 'welcome') } } : null;
}

/**
 * The `bots.triggers` send hook: if my outgoing channel message contains an installed bot's
 * trigger phrase, queue that bot's reply (one per message, never for bot messages, honoring the
 * trigger's cooldown both from the visible history and from this browser's own record).
 */
export async function triggerHook(draft, ctx) {
  const conv = ctx?.conv;
  if (conv?.kind !== 'channel' || !draft || draft.extra?.bot) return draft;
  const text = typeof draft.text === 'string' ? draft.text.trim() : '';
  if (!text) return draft;
  const bots = peekInstalled(conv.sid);
  if (!bots.length) return draft;
  if ((slowmodes.get(conv.scope) || 0) > 0 && !ctx.perms?.manageMessages) return draft; // a second message would be refused
  const now = Date.now();
  const hit = findTrigger(text, bots, (botId, trigger) => coolingLocally(conv.scope, botId, trigger, now)
    || answeredRecently(ctx.messages, botId, trigger, now));
  if (!hit) return draft;
  markCooldown(conv.scope, hit.bot.id, hit.trigger, now);
  const reply = await triggerDraft(hit.bot, hit.trigger, ctx);
  if (reply) {
    queueReply({
      scope: conv.scope,
      uid: ctx.me?.uid,
      text,
      known: new Set((ctx.messages || []).map((m) => m.mid)),
      at: now,
      draft: reply,
    });
  }
  return draft;
}
