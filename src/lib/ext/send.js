// Round 3 send pipeline and slash commands (pure logic; the UI lives in ChatView/Composer).
//
// Every send from the composer (and ctx.send from extensions) runs the `sendHooks` registry in order
// before anything is encrypted:
//   hook.run(draft, ctx) -> draft | { handled: true } | { cancel: true, reason? }   (may be async)
//   draft = { text, code?, attachments?, gif?, poll?, extra? }
// `extra` is merged into the encrypted message body JSON (e.g. { bot: { id, name } }) under keys that
// match EXTRA_KEY and are not core body keys; receivers get it as m.body.<key>.
//
// The first hook ('core.slash', order -1e9) runs a registered slash command when the text starts with
// "/name": command.run(argsText, ctx) returns the same three shapes. Unknown "/word" text is sent as is.
import { list, register } from './registry.js';

/** Body keys the core owns; `extra` can never set them. */
export const CORE_BODY_KEYS = Object.freeze(['text', 'code', 'invite', 'attachments', 'gif', 'poll', 'fwd']);
/** Allowed extension body keys (same shape as a `$feat` name). */
export const EXTRA_KEY = /^[a-z][a-zA-Z0-9]{0,23}$/;
export const SLASH_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const SCOPES = Object.freeze(['channel', 'dm', 'group']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Extension keys of a body/extra object that may ride in the encrypted body. */
export function pickExtras(obj) {
  const out = {};
  if (!isObj(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!EXTRA_KEY.test(k) || CORE_BODY_KEYS.includes(k)) continue;
    if (v === undefined || v === null || typeof v === 'function' || typeof v === 'symbol') continue;
    out[k] = v;
  }
  return out;
}

/** Final draft -> message body: core fields as they are, plus `extra` merged under extension keys. */
export function draftToBody(draft) {
  const { extra, ...rest } = draft || {};
  return { ...rest, ...pickExtras(extra) };
}

/**
 * Run `hooks` (default: the sendHooks registry) over a draft.
 * Resolves to { draft } to send, { handled: true } (nothing to send) or { cancel: true, reason }.
 * A hook that throws or returns something unusable cancels the send (never sends half-processed text).
 */
export async function runSendHooks(draft, ctx, hooks = list('sendHooks')) {
  let cur = { ...draft };
  for (const h of hooks) {
    if (!h || typeof h.run !== 'function') continue;
    let res;
    try {
      res = await h.run(cur, ctx);
    } catch (e) {
      console.error(`[ext] send hook ${h.id} failed`, e);
      return { cancel: true, reason: e?.message || `“${h.id}” failed` };
    }
    if (res === undefined || res === null) continue; // unchanged
    if (!isObj(res)) return { cancel: true, reason: `“${h.id}” returned an invalid draft` };
    if (res.handled === true) return { handled: true };
    if (res.cancel === true) return { cancel: true, reason: typeof res.reason === 'string' ? res.reason : '' };
    if (typeof res.text !== 'string') return { cancel: true, reason: `“${h.id}” returned an invalid draft` };
    cur = res;
  }
  return { draft: cur };
}

/** "/name args" at the very start of the text -> { name, args } (name lower-cased), else null. */
export function parseSlash(text) {
  if (typeof text !== 'string') return null;
  const m = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

/** Whether a command is offered in this conversation kind. */
export function commandInScope(cmd, kind) {
  if (!Array.isArray(cmd?.scopes) || !cmd.scopes.length) return true;
  return cmd.scopes.includes(kind);
}

/** Registered commands usable in `kind` ('channel' | 'dm' | 'group'), valid names only. */
export function commandsFor(kind, commands = list('slashCommands')) {
  const seen = new Set();
  return commands.filter((c) => {
    if (!c || !SLASH_NAME.test(c.name || '') || typeof c.run !== 'function' || !commandInScope(c, kind) || seen.has(c.name)) return false;
    seen.add(c.name); // the first (lowest order) entry wins a name
    return true;
  });
}

/** Autocomplete matches for the partial name typed after "/" (prefix first, then substring). */
export function matchCommands(query, kind, commands = list('slashCommands')) {
  const q = String(query || '').toLowerCase();
  const all = commandsFor(kind, commands);
  const pre = all.filter((c) => c.name.startsWith(q));
  const mid = q ? all.filter((c) => !c.name.startsWith(q) && c.name.includes(q)) : [];
  return [...pre, ...mid].sort((a, b) => (a.name === q ? -1 : b.name === q ? 1 : 0));
}

/** The sendHooks entry that runs slash commands. */
export const slashHook = {
  id: 'core.slash',
  order: -1e9,
  async run(draft, ctx) {
    const p = parseSlash(draft.text);
    if (!p) return draft;
    const cmd = commandsFor(ctx?.conv?.kind || 'channel').find((c) => c.name === p.name);
    if (!cmd) return draft; // unknown "/word": plain text
    const res = await cmd.run(p.args, ctx);
    if (res === undefined || res === null) return { handled: true };
    // A command returning a draft keeps the original attachments/extra unless it sets its own.
    if (isObj(res) && typeof res.text === 'string' && !res.handled && !res.cancel) {
      return { ...draft, ...res, extra: { ...(draft.extra || {}), ...(res.extra || {}) } };
    }
    return res;
  },
};

/** The one built-in command: lists the commands available here as a local-only notice. */
export const helpCommand = {
  name: 'help',
  description: 'List the slash commands you can use here',
  run(_args, ctx) {
    const cmds = commandsFor(ctx?.conv?.kind || 'channel');
    const items = cmds.map((c) => ({
      label: `/${c.name}${typeof c.args === 'string' && c.args ? ` ${c.args}` : ''}`,
      detail: typeof c.description === 'string' ? c.description : '',
    }));
    if (typeof ctx?.ephemeral === 'function') ctx.ephemeral({ id: 'core.help', title: 'Slash commands', items });
    return { handled: true };
  },
};

let installed = false;
/** Registers the slash hook and /help once (called from src/features/index.js). */
export function installCoreExtensions() {
  if (installed) return;
  installed = true;
  register('sendHooks', slashHook);
  register('slashCommands', { id: 'core.help', ...helpCommand });
}
