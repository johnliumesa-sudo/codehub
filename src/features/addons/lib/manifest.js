// Add-on manifests, permissions and install records (pure: no Firebase, no DOM).
//
// Published add-ons live in two public catalog entries (pub/{kind}/{id}, see ARCHITECTURE.md
// "Generic rules blocks"):
//   pub/addons/{id}     { name, desc, icon, version, perms, sha, size, rt, by, ts, seed? }
//   pub/addonCode/{id}  { code, sha, by, ts }
// Everything read from the database is untrusted: parse it with these functions before use and
// render the strings as React text only.

/** The add-on runtime this build runs (lib/runtime.js); bumped when older add-on code can't run any more. */
export const RUNTIME_VERSION = 2;

/** The fixed permission list an add-on may request. */
export const ADDON_PERMS = Object.freeze(['context', 'readMessages', 'composer', 'send', 'storage']);

/** What each permission lets an add-on do, in the words shown before install and on consent. */
export const PERM_INFO = Object.freeze({
  context: {
    label: 'See where it’s open',
    detail: 'Know the name of the conversation it is open in (channel, DM or group) and your display name.',
    risk: false,
  },
  readMessages: {
    label: 'Read messages',
    detail:
      'See the last 100 messages (author names, text, times) of the conversation where you open it, decrypted. ' +
      'Add-on code has no network access, so it can only show them to you, or post them if you also allow “Send messages as you”.',
    risk: true,
  },
  composer: {
    label: 'Write in your message box',
    detail: 'Insert text into your composer. Nothing is sent until you press Enter.',
    risk: false,
  },
  send: {
    label: 'Send messages as you',
    detail:
      'Post messages in the conversation where it is open. Codehub shows you the full text and asks before every message ' +
      'unless you allow it to send without asking.',
    risk: true,
  },
  storage: {
    label: 'Store its own data',
    detail: 'Keep up to 32 KB of its own data, encrypted in your private storage.',
    risk: false,
  },
});

export const LIMITS = Object.freeze({
  name: 48,
  desc: 500,
  icon: 8,
  version: 14,
  codeBytes: 65536, // "single HTML/JS document <= 64 KB" (UTF-8); the rules cap `code` at 65536 chars
  storageBytes: 32768, // add-on storage per user per add-on (plaintext JSON, UTF-8)
  perPublisher: 20, // client cap: the rules can't count children
  messages: 100, // getMessages(n) upper bound
  text: 4000, // insertText / sendMessage (same as a chat message)
});

const SHA_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
// Control characters (except tab/newline in descriptions) and bidi overrides are not allowed in names.
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
const CTRL_RE_G = new RegExp(CTRL_RE.source, 'g');
const PUSH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);
export const isVersion = (s) => typeof s === 'string' && VERSION_RE.test(s);
/** Add-on ids are RTDB push ids (or other short safe keys). */
export const isAddonId = (s) => typeof s === 'string' && PUSH_ID_RE.test(s);

/** Permission list from an array or a comma-separated string: known names only, sorted, unique. */
export function normalizePerms(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const set = new Set(raw.map((p) => String(p).trim()).filter((p) => ADDON_PERMS.includes(p)));
  return ADDON_PERMS.filter((p) => set.has(p));
}

/** Stored form of a permission list ("readMessages,storage"; "" for none). */
export const permsToString = (list) => normalizePerms(list).join(',');

/** { added, removed } between two permission lists. */
export function permDiff(before, after) {
  const a = normalizePerms(before);
  const b = normalizePerms(after);
  return { added: b.filter((p) => !a.includes(p)), removed: a.filter((p) => !b.includes(p)) };
}

/** True if every permission in `need` is in `have`. */
export const permsCover = (have, need) => normalizePerms(need).every((p) => normalizePerms(have).includes(p));

/** -1, 0 or 1 comparing two "major.minor.patch" versions (invalid ones sort first). */
export function compareVersions(a, b) {
  const pa = isVersion(a) ? a.split('.').map(Number) : [-1, -1, -1];
  const pb = isVersion(b) ? b.split('.').map(Number) : [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** Bytes of a string in UTF-8. */
export function utf8Length(str) {
  let n = 0;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** Runtime version field -> a small positive integer (1 = the old document model). */
function runtimeOf(v) {
  return Number.isInteger(v) && v > 0 && v < 1000 ? v : 1;
}

/**
 * Check what the builder is about to publish. Returns { ok, errors: { field: message }, value }
 * where value = { name, desc, icon, version, perms: [..], code }.
 */
export function validateDraft(draft = {}, { previousVersion } = {}) {
  const errors = {};
  const name = clean(draft.name);
  const desc = typeof draft.desc === 'string' ? draft.desc.trim().replace(/\r\n/g, '\n') : '';
  const icon = clean(draft.icon);
  const version = clean(draft.version);
  const perms = normalizePerms(draft.perms);
  const code = typeof draft.code === 'string' ? draft.code : '';

  if (!name) errors.name = 'Give your add-on a name.';
  else if (name.length > LIMITS.name) errors.name = `Names can be at most ${LIMITS.name} characters.`;
  else if (CTRL_RE.test(name)) errors.name = 'The name contains characters that are not allowed.';

  if (desc.length > LIMITS.desc) errors.desc = `Descriptions can be at most ${LIMITS.desc} characters.`;
  else if (CTRL_RE.test(desc.replace(/[\n\t]/g, ''))) errors.desc = 'The description contains characters that are not allowed.';

  if (!icon) errors.icon = 'Pick an icon (an emoji or up to 8 characters).';
  else if (icon.length > LIMITS.icon || /\s/.test(icon) || CTRL_RE.test(icon)) errors.icon = `Use one emoji or up to ${LIMITS.icon} characters without spaces.`;

  if (!isVersion(version)) errors.version = 'Use a version like 1.0.0.';
  else if (previousVersion && isVersion(previousVersion) && compareVersions(version, previousVersion) <= 0) {
    errors.version = `Raise the version above ${previousVersion} when you publish an update.`;
  }

  if (!code.trim()) errors.code = 'Write the add-on’s JavaScript.';
  else if (/^\s*<(?:!doctype|html|head|body|script|!--)/i.test(code)) {
    errors.code = 'Add-on code is JavaScript that runs in a worker, not an HTML page. Draw your UI with codehub.ui.render(html).';
  } else if (utf8Length(code) > LIMITS.codeBytes) errors.code = `The code is ${utf8Length(code)} bytes; the limit is ${LIMITS.codeBytes} (64 KB).`;

  return { ok: Object.keys(errors).length === 0, errors, value: { name, desc, icon, version, perms, code } };
}

/**
 * A pub/addons/{id} record -> { id, name, desc, icon, version, perms, sha, size, by, ts, seed, rt } or
 * null when anything is missing or out of range. `rt` is the add-on runtime the code was written for
 * (1 when the field is missing: the old document model).
 */
export function parseManifest(id, raw) {
  if (!isAddonId(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { name, desc = '', icon, version, perms = '', sha, size, by, ts, seed, rt } = raw;
  if (typeof name !== 'string' || !name.trim() || name.length > LIMITS.name || CTRL_RE.test(name)) return null;
  if (typeof desc !== 'string' || desc.length > LIMITS.desc) return null;
  if (typeof icon !== 'string' || !icon.trim() || icon.length > LIMITS.icon) return null;
  if (!isVersion(version)) return null;
  if (typeof perms !== 'string' || perms.length > 200) return null;
  const permList = normalizePerms(perms);
  // Unknown permission names mean a newer or forged manifest: refuse rather than silently drop them.
  if (perms && permList.length !== perms.split(',').filter(Boolean).length) return null;
  if (!isSha(sha)) return null;
  if (typeof by !== 'string' || !by || by.length > 128) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  const sz = typeof size === 'number' && Number.isFinite(size) && size >= 0 ? Math.round(size) : 0;
  return {
    id,
    name: name.trim(),
    desc: desc.replace(CTRL_RE_G, ''),
    icon: icon.trim(),
    version,
    perms: permList,
    sha,
    size: sz,
    by,
    ts,
    seed: typeof seed === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(seed) ? seed : null,
    rt: runtimeOf(rt),
  };
}

/** A pub/addonCode/{id} record -> { code, sha, by } or null. */
export function parseCodeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { code, sha, by } = raw;
  if (typeof code !== 'string' || !code || code.length > LIMITS.codeBytes) return null;
  if (!isSha(sha) || typeof by !== 'string' || !by) return null;
  return { code, sha, by };
}

/**
 * An install record (udata/{me}/addons/{id} or sconf/{sid}/addons/{id}) ->
 * { id, sha, perms, at, v, name, icon, auto, by, publisher, rt } or null. `by` is the server installer,
 * `publisher` the account that published the pinned code, `rt` the runtime it was written for.
 */
export function parseInstall(id, raw) {
  if (!isAddonId(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isSha(raw.sha)) return null;
  const name = typeof raw.name === 'string' && raw.name.trim() && raw.name.length <= LIMITS.name ? raw.name.trim() : 'Add-on';
  const icon = typeof raw.icon === 'string' && raw.icon.trim() && raw.icon.length <= LIMITS.icon ? raw.icon.trim() : '🧩';
  return {
    id,
    sha: raw.sha,
    perms: normalizePerms(raw.perms),
    at: typeof raw.at === 'number' ? raw.at : 0,
    v: isVersion(raw.v) ? raw.v : '',
    name: name.replace(CTRL_RE_G, ''),
    icon,
    auto: raw.auto === true,
    by: typeof raw.by === 'string' ? raw.by : '',
    publisher: typeof raw.publisher === 'string' && raw.publisher.length <= 128 ? raw.publisher : '',
    rt: runtimeOf(raw.rt),
  };
}

/** Every valid install of a map ({ id: record }), sorted by name. */
export function parseInstalls(map) {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map)
    .map(([id, raw]) => parseInstall(id, raw))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** True when a listing's code targets the current add-on runtime (so it may be installed and run). */
export const isCurrentRuntime = (m) => !!m && m.rt === RUNTIME_VERSION;

/**
 * Why an installed add-on must not run, or null when it may. `manifest` is its live directory
 * listing (parseManifest result, null when gone or invalid):
 *   'removed'    no longer published (its publisher or an app admin removed it)
 *   'runtime'    the approved copy was written for an older add-on runtime: needs an update
 *   'publisher'  listed by a different account than the one whose code was approved
 */
export function runBlock(install, manifest) {
  if (!install || !manifest) return 'removed';
  if (install.rt !== RUNTIME_VERSION) return 'runtime';
  if (!install.publisher || manifest.by !== install.publisher) return 'publisher';
  return null;
}

/**
 * Why a published update can't be accepted, or null: 'runtime' (still written for the old runtime)
 * or 'publisher' (published by another account than the approved copy; installs from before the
 * publisher was recorded can't be checked and are allowed).
 */
export function updateBlock(install, manifest) {
  if (!manifest) return 'removed';
  if (!isCurrentRuntime(manifest)) return 'runtime';
  if (install?.publisher && manifest.by !== install.publisher) return 'publisher';
  return null;
}

/** Consent key for a server add-on in udata/{me}/addonConsent: "{sid}~{id}". */
export const consentKey = (sid, id) => `${sid}~${id}`;

/** A consent record -> { perms, sha, auto } or null. */
export function parseConsent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { perms: normalizePerms(raw.perms), sha: isSha(raw.sha) ? raw.sha : '', auto: raw.auto === true };
}

/** Search + sort for the directory. sort: 'new' (default) | 'name'. */
export function filterManifests(list, q = '', sort = 'new') {
  const needle = String(q || '').trim().toLowerCase();
  const out = needle
    ? list.filter((m) => `${m.name}\n${m.desc}\n${m.perms.join(' ')}`.toLowerCase().includes(needle))
    : [...list];
  if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name) || b.ts - a.ts);
  else out.sort((a, b) => b.ts - a.ts);
  return out;
}

/** "12.3 KB" style sizes. */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  return `${(v / 1024).toFixed(v < 10240 ? 1 : 0)} KB`;
}
