// Welcome screen & rules gate: pure helpers.
//
// sconf/{sid}/welcome/msg   { iv, ct, v, by }  ct = sealForServer(sid, `welcome:{sid}/msg`, { text, rules })
//                                              v = version (ms when saved), by = who saved it
// sconf/{sid}/welcome/req   true | absent      "require acceptance": the database rules refuse channel
//                                              messages from members (not owner/admin) without a marker
// sitems/{sid}/accepted/{uid}  { by: uid, v, ts }  my acceptance (the rules check by === uid)
// udata/{me}/welcome/{sid}  v                  the version I've seen (no acceptance needed)

export const WELCOME_LIMITS = Object.freeze({ text: 2000, rules: 25, rule: 300 });
export const welcomeAad = (sid) => `welcome:${sid}/msg`;

const multiLine = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** { text, rules[] } from the editor or the database (untrusted) -> clean copy. */
export function cleanWelcome(w) {
  const text = multiLine(w?.text, WELCOME_LIMITS.text);
  const rules = (Array.isArray(w?.rules) ? w.rules : [])
    .map((r) => oneLine(r, WELCOME_LIMITS.rule))
    .filter(Boolean)
    .slice(0, WELCOME_LIMITS.rules);
  return { text, rules };
}

/** Rules typed one per line -> list. */
export const parseRules = (text) => cleanWelcome({ rules: String(text ?? '').split('\n') }).rules;

/**
 * What the welcome modal should do for me in a server:
 *   'gate'    acceptance required and I haven't accepted (I can't post until I do)
 *   'update'  I accepted an older version of the rules (client-side re-prompt; I can still post)
 *   'show'    welcome not seen yet (no acceptance needed)
 *   null      nothing to show
 * welcome = { configured, req, v, by }; marker = sitems accepted record or null; seenV = udata value.
 */
export function welcomeState({ welcome, myUid, myRole, marker, seenV }) {
  if (!welcome || !(welcome.configured || welcome.req)) return null;
  const exempt = myRole === 'owner' || myRole === 'admin';
  const accepted = !!marker && marker.by === myUid;
  const v = typeof welcome.v === 'number' ? welcome.v : 0;
  if (welcome.req && !exempt) {
    if (!accepted) return 'gate';
    if (typeof marker.v === 'number' && marker.v < v) return 'update';
    return null;
  }
  if (welcome.by === myUid) return null; // I wrote it
  if (myRole === 'owner') return null;
  const seen = typeof seenV === 'number' ? seenV : 0;
  if (accepted && typeof marker.v === 'number' && marker.v >= v) return null;
  return welcome.configured && seen < v ? 'show' : null;
}

/** True if I can't post in this server's channels until I accept its rules. */
export const isGated = ({ req, myUid, myRole, marker }) =>
  req === true && myRole !== 'owner' && myRole !== 'admin' && !(marker && marker.by === myUid);
