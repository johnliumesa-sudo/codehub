// Bot definitions: schema, limits and validation. Definitions come from the public directory
// (pub/bots, written by anyone) and from server installs (sconf/{sid}/bots, written by managers), so
// every read goes through parseBotDef / parseBotEntry / parseInstalled; nothing is trusted.
// Pure (no Firebase/React), unit-tested in tests/unit/bots.test.mjs.
//
// Definition JSON (stored as a string in the `def` field), version 1:
//   { v: 1, name, glyph, desc,
//     commands: [{ name, usage, desc, response }],
//     triggers: [{ id, match, response, cooldown }],      // cooldown in seconds
//     welcome }

export const DEF_VERSION = 1;

export const BOT_LIMITS = Object.freeze({
  name: 32,
  glyph: 16,
  desc: 300,
  commands: 20,
  cmdName: 32,
  usage: 40,
  cmdDesc: 100,
  response: 1500,
  triggers: 20,
  match: 100,
  cooldownMin: 5,
  cooldownMax: 86400,
  welcome: 1500,
  defChars: 20000, // one pub/sconf leaf
  imgChars: 20000, // base64 image, one leaf
  imgDim: 128,
  imgBytes: 14 * 1024,
  perUser: 20, // UI cap: bots one person can publish
  perServer: 25, // UI cap: bots installed in one server
  welcomesPerJoin: 3, // UI cap: welcome messages posted for one new member
});

export const SLASH_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const TRIGGER_ID_RE = /^[a-z0-9]{1,12}$/;
export const BOT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const IMG_TYPES = Object.freeze(['image/webp', 'image/jpeg', 'image/png']);
export const DEFAULT_GLYPH = '🤖';

// Control characters (newline and tab are allowed only where multi-line text is).
// Built with RegExp(): a bundler may turn U+2028/U+2029 escapes in a regex literal into raw line breaks.
const CTRL_LINE = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]');
const CTRL_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/; // eslint-disable-line no-control-regex

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function str(errors, label, v, { max, min = 0, multiline = false, required = false }) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') {
    errors.push(`${label} must be text.`);
    return '';
  }
  const s = multiline ? v.replace(/\r\n?/g, '\n').trim() : v.trim();
  if ((multiline ? CTRL_TEXT : CTRL_LINE).test(s)) errors.push(`${label} contains control characters.`);
  if (required && !s) errors.push(`${label} is required.`);
  else if (s.length < min) errors.push(`${label} is too short.`);
  if (s.length > max) errors.push(`${label} is too long (${s.length}/${max}).`);
  return s;
}

/**
 * Validate and normalize a definition object. Unknown keys are dropped; anything malformed is an
 * error. Returns { ok: true, def, errors: [] } or { ok: false, errors: [message, …] }.
 * opts.reserved: command names that may not be used (the builder passes the built-in commands).
 */
export function validateBotDef(input, opts = {}) {
  const errors = [];
  const L = BOT_LIMITS;
  if (!isObj(input)) return { ok: false, errors: ['The bot definition is not an object.'] };
  if (input.v !== DEF_VERSION) errors.push('Unsupported definition version.');
  const def = { v: DEF_VERSION };
  def.name = str(errors, 'Name', input.name, { max: L.name, required: true });
  def.glyph = str(errors, 'Icon', input.glyph, { max: L.glyph });
  def.desc = str(errors, 'Description', input.desc, { max: L.desc, multiline: true });
  def.welcome = str(errors, 'Welcome message', input.welcome, { max: L.welcome, multiline: true });

  const reserved = new Set(opts.reserved || []);
  const cmds = input.commands === undefined ? [] : input.commands;
  def.commands = [];
  if (!Array.isArray(cmds)) errors.push('Commands must be a list.');
  else {
    if (cmds.length > L.commands) errors.push(`At most ${L.commands} commands.`);
    const seen = new Set();
    cmds.slice(0, L.commands).forEach((c, i) => {
      const at = `Command ${i + 1}`;
      if (!isObj(c)) return errors.push(`${at} is malformed.`);
      const name = typeof c.name === 'string' ? c.name.trim().replace(/^\//, '').toLowerCase() : '';
      if (!SLASH_NAME_RE.test(name)) errors.push(`${at}: the name must be 1–32 lowercase letters, digits, - or _ (starting with a letter or digit).`);
      else if (seen.has(name)) errors.push(`${at}: /${name} is defined twice.`);
      else if (reserved.has(name)) errors.push(`${at}: /${name} is a built-in command.`);
      seen.add(name);
      def.commands.push({
        name,
        usage: str(errors, `${at} usage`, c.usage, { max: L.usage }),
        desc: str(errors, `${at} description`, c.desc, { max: L.cmdDesc }),
        response: str(errors, `${at} response`, c.response, { max: L.response, multiline: true, required: true }),
      });
    });
  }

  const trigs = input.triggers === undefined ? [] : input.triggers;
  def.triggers = [];
  if (!Array.isArray(trigs)) errors.push('Keyword triggers must be a list.');
  else {
    if (trigs.length > L.triggers) errors.push(`At most ${L.triggers} keyword triggers.`);
    const seen = new Set();
    trigs.slice(0, L.triggers).forEach((t, i) => {
      const at = `Trigger ${i + 1}`;
      if (!isObj(t)) return errors.push(`${at} is malformed.`);
      const id = typeof t.id === 'string' ? t.id : '';
      if (!TRIGGER_ID_RE.test(id) || seen.has(id)) errors.push(`${at} has an invalid id.`);
      seen.add(id);
      const cooldown = t.cooldown;
      if (!Number.isInteger(cooldown) || cooldown < L.cooldownMin || cooldown > L.cooldownMax) {
        errors.push(`${at}: the cooldown must be a whole number of seconds from ${L.cooldownMin} to ${L.cooldownMax}.`);
      }
      def.triggers.push({
        id,
        match: str(errors, `${at} word or phrase`, t.match, { max: L.match, required: true }).replace(/\s+/g, ' '),
        response: str(errors, `${at} response`, t.response, { max: L.response, multiline: true, required: true }),
        cooldown,
      });
    });
  }

  if (!def.commands.length && !def.triggers.length && !def.welcome) errors.push('Add at least one command, keyword trigger or welcome message.');
  if (!errors.length && serializeBotDef(def).length > L.defChars) errors.push(`The definition is too large (${serializeBotDef(def).length}/${L.defChars} characters).`);
  return errors.length ? { ok: false, errors } : { ok: true, def, errors: [] };
}

/** Canonical JSON for storage. */
export function serializeBotDef(def) {
  return JSON.stringify(def);
}

/** Parse a stored `def` string (size first, then JSON, then the schema). */
export function parseBotDef(json) {
  if (typeof json !== 'string' || !json) return { ok: false, errors: ['Missing definition.'] };
  if (json.length > BOT_LIMITS.defChars) return { ok: false, errors: ['The definition is too large.'] };
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, errors: ['The definition is not valid JSON.'] };
  }
  return validateBotDef(obj);
}

/** A stored image ({ img: base64, imgType }) if it has an allowed type and fits a leaf, else null. */
export function cleanImg(raw) {
  if (!isObj(raw) || typeof raw.img !== 'string' || !IMG_TYPES.includes(raw.imgType)) return null;
  if (!raw.img || raw.img.length > BOT_LIMITS.imgChars || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw.img)) return null;
  return { img: raw.img, imgType: raw.imgType };
}

const okNum = (v) => typeof v === 'number' && Number.isFinite(v);
const okUid = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[.#$[\]/]/.test(v);

/**
 * A directory entry pub/bots/{id} -> { ok, id, def, ver, by, ts, created, image } or { ok: false, id, by?, error }.
 * `by` is kept on invalid entries so their publisher (and app admins) can still remove them.
 */
export function parseBotEntry(id, raw) {
  if (!BOT_ID_RE.test(String(id || '')) || !isObj(raw)) return { ok: false, id, error: 'Malformed entry.' };
  const by = okUid(raw.by) ? raw.by : null;
  if (!by) return { ok: false, id, error: 'Malformed entry.' };
  const ver = raw.ver;
  if (!Number.isInteger(ver) || ver < 1) return { ok: false, id, by, ts: okNum(raw.ts) ? raw.ts : 0, error: 'Missing version.' };
  const parsed = parseBotDef(raw.def);
  if (!parsed.ok) return { ok: false, id, by, ts: okNum(raw.ts) ? raw.ts : 0, error: parsed.errors[0] };
  return {
    ok: true,
    id,
    by,
    ver,
    def: parsed.def,
    ts: okNum(raw.ts) ? raw.ts : 0,
    created: okNum(raw.created) ? raw.created : okNum(raw.ts) ? raw.ts : 0,
    image: cleanImg(raw),
  };
}

/**
 * Installed bots of a server: sconf/{sid}/bots -> [{ id, def, ver, author, at, by, image }] sorted by
 * install time. Invalid copies are skipped (they never run).
 */
export function parseInstalled(raw) {
  if (!isObj(raw)) return [];
  const out = [];
  for (const [id, v] of Object.entries(raw)) {
    if (!BOT_ID_RE.test(id) || !isObj(v)) continue;
    if (!Number.isInteger(v.ver) || v.ver < 1) continue;
    const parsed = parseBotDef(v.def);
    if (!parsed.ok) continue;
    out.push({
      id,
      def: parsed.def,
      ver: v.ver,
      author: okUid(v.author) ? v.author : null,
      by: okUid(v.by) ? v.by : null,
      at: okNum(v.at) ? v.at : 0,
      image: cleanImg(v),
    });
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export const BOT_VIA = Object.freeze(['cmd', 'trigger', 'welcome']);

/**
 * The `bot` extension key of a message body ({ id, name, glyph?, via?, trig? }), validated, or null.
 * Any member can put anything in their own message, so readers check it before rendering.
 */
export function cleanBotTag(v) {
  if (!isObj(v) || typeof v.id !== 'string' || !BOT_ID_RE.test(v.id)) return null;
  if (typeof v.name !== 'string') return null;
  const name = v.name.trim();
  if (!name || name.length > BOT_LIMITS.name || CTRL_LINE.test(name)) return null;
  const out = { id: v.id, name };
  if (typeof v.glyph === 'string' && v.glyph.length <= BOT_LIMITS.glyph && !CTRL_LINE.test(v.glyph) && v.glyph.trim()) out.glyph = v.glyph.trim();
  if (BOT_VIA.includes(v.via)) out.via = v.via;
  if (typeof v.trig === 'string' && TRIGGER_ID_RE.test(v.trig)) out.trig = v.trig;
  return out;
}

/** The `cmd` extension key (the slash command a message came from), or null. */
export function cleanCmd(v) {
  return typeof v === 'string' && SLASH_NAME_RE.test(v) ? v : null;
}

/** A fresh trigger id. */
export function newTriggerId(u32) {
  const rnd = u32 || (() => {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0];
  });
  return (rnd() >>> 0).toString(36).slice(0, 8) || 't';
}

/** An empty definition for the builder. */
export function emptyDef() {
  return { v: DEF_VERSION, name: '', glyph: DEFAULT_GLYPH, desc: '', commands: [], triggers: [], welcome: '' };
}
