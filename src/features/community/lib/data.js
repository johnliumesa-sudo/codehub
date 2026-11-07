// Community features: database reads/writes and live hooks (events, RSVPs, welcome & rules gate,
// AutoMod config, saved templates, discovery listings). Pure logic lives next door (events.js,
// automod.js, welcome.js, templates.js, discovery.js); paths and AAD strings are documented in
// docs/features/community.md.
import { useCallback, useMemo } from 'react';
import { push, ref, remove, set, update } from 'firebase/database';
import { db } from '../../../lib/firebase.js';
import {
  boxFits, myUid, openForMe, openForServer, putPub, sealForMe, sealForServer, updatePub, usePub,
} from '../../../lib/ext/store.js';
import { createInvite, inviteLink, parseInviteLink } from '../../../lib/servers.js';
import { sendMessage } from '../../../lib/messages.js';
import { categoryAad } from '../../../lib/serverx/categories.js';
import { createRole } from '../../../lib/roles.js';
import { writeAudit } from '../../../lib/moderation.js';
import { openCached, readOnce, useDecrypted, useLive } from './live.js';
import {
  EVENT_LIMITS, cleanEvent, collectRsvps, eventAad, resolveRid, rsvpIndexKey, rsvpKey, sanitizeEvent,
} from './events.js';
import { automodAad, automodActive, cleanAutomod } from './automod.js';
import { cleanWelcome, welcomeAad } from './welcome.js';
import { TEMPLATE_LIMITS, cleanTemplate, templateAad, withoutTopics } from './templates.js';
import { cleanListing, sanitizeListing } from './discovery.js';

const isBox = (b) => !!b && typeof b === 'object' && typeof b.iv === 'string' && typeof b.ct === 'string';
const serverOpen = (sid) => (aad, box) => openForServer(sid, aad, box);

// ---------- events & RSVPs ----------

/**
 * Live events of a server, decrypted: { loading, error, events: [{ id, by, rid, ...body }], failed, count }.
 * `rid` is the id RSVPs use (see events.resolveRid). Undecryptable or malformed records are skipped
 * (counted in `failed`).
 */
export function useServerEvents(sid) {
  const live = useLive(sid ? `sitems/${sid}/events` : null);
  const items = useMemo(() => {
    const v = live.value && typeof live.value === 'object' ? live.value : {};
    return Object.entries(v)
      .filter(([, r]) => r && typeof r.by === 'string' && isBox(r))
      .map(([id, r]) => ({ key: id, id, by: r.by, aad: eventAad(sid, id), box: { iv: r.iv, ct: r.ct } }));
  }, [sid, live.value]);
  const open = useMemo(() => serverOpen(sid), [sid]);
  const dec = useDecrypted(items, open);
  return useMemo(() => {
    const out = [];
    let failed = 0;
    let pending = 0;
    for (const it of items) {
      const v = dec[it.key];
      if (v === undefined) { pending++; continue; }
      const body = v instanceof Error ? null : sanitizeEvent(v);
      if (!body) { failed++; continue; }
      out.push({ ...body, id: it.id, by: it.by });
    }
    const ids = new Set(out.map((e) => e.id));
    out.forEach((e) => { e.rid = resolveRid(e, ids); });
    return { loading: live.loading || pending > 0, error: live.error, events: out, failed, count: items.length };
  }, [items, dec, live.loading, live.error]);
}

/** Live RSVPs of a server: Map rid -> Map uid -> { s, ts }. */
export function useServerRsvps(sid) {
  const live = useLive(sid ? `sitems/${sid}/rsvp` : null);
  return useMemo(() => {
    const v = live.value && typeof live.value === 'object' ? live.value : {};
    return collectRsvps(Object.entries(v).map(([id, r]) => ({ id, ...(r && typeof r === 'object' ? r : {}) })));
  }, [live.value]);
}

/** My RSVP index (udata/{me}/rsvp): { `${sid}~${rid}`: state }. */
export function useMyRsvpIndex(uid) {
  const live = useLive(uid ? `udata/${uid}/rsvp` : null);
  return live.value && typeof live.value === 'object' ? live.value : {};
}

/** Create an event; resolves to its id. */
export async function createEvent(sid, input, count = 0) {
  if (count >= EVENT_LIMITS.perServer) throw new Error(`This server has ${EVENT_LIMITS.perServer} events. Delete some old ones first.`);
  const body = cleanEvent(input);
  const r = push(ref(db, `sitems/${sid}/events`));
  const box = await sealForServer(sid, eventAad(sid, r.key), body);
  if (!boxFits(box)) throw new Error('The description is too long');
  await set(r, { by: myUid(), iv: box.iv, ct: box.ct });
  return r.key;
}

/**
 * Save changes to an event (also used to cancel/uncancel). The author updates in place. A moderator
 * (manageMessages) editing someone else's event replaces it in one update (the rules only let
 * authors update): a new record by the moderator that keeps the RSVP id and remembers the original
 * author, and the old record removed. Resolves to the (possibly new) id.
 */
export async function saveEvent(sid, ev, input, { canModerate = false } = {}) {
  const me = myUid();
  const body = cleanEvent({ ...input, rid: ev.rid !== ev.id ? ev.rid : undefined, orig: ev.orig }, { isNew: false });
  if (ev.by === me) {
    const box = await sealForServer(sid, eventAad(sid, ev.id), body);
    if (!boxFits(box)) throw new Error('The description is too long');
    await set(ref(db, `sitems/${sid}/events/${ev.id}`), { by: me, iv: box.iv, ct: box.ct });
    return ev.id;
  }
  if (!canModerate) throw new Error('Only the organizer or a moderator can change this event');
  const id = push(ref(db, `sitems/${sid}/events`)).key;
  const copy = { ...body, rid: ev.rid, orig: ev.orig || ev.by };
  const box = await sealForServer(sid, eventAad(sid, id), copy);
  if (!boxFits(box)) throw new Error('The description is too long');
  await update(ref(db), {
    [`sitems/${sid}/events/${id}`]: { by: me, iv: box.iv, ct: box.ct },
    [`sitems/${sid}/events/${ev.id}`]: null,
  });
  return id;
}

/**
 * Delete an event. rsvpUids = members who answered. Moderators also clear every RSVP to it; others
 * clear only their own (removing someone else's item, or one that doesn't exist, would be refused).
 */
export async function deleteEvent(sid, ev, rsvpUids = [], { canModerate = false } = {}) {
  const me = myUid();
  const patch = { [`sitems/${sid}/events/${ev.id}`]: null };
  rsvpUids.forEach((u) => {
    if (canModerate || u === me) patch[`sitems/${sid}/rsvp/${rsvpKey(ev.rid, u)}`] = null;
  });
  await update(ref(db), patch);
  await remove(ref(db, `udata/${me}/rsvp/${rsvpIndexKey(sid, ev.rid)}`)).catch(() => {});
}

/** Answer (or clear with null) my RSVP; also keeps my private index for reminders. */
export function setRsvp(sid, rid, state) {
  const me = myUid();
  return update(ref(db), {
    [`sitems/${sid}/rsvp/${rsvpKey(rid, me)}`]: state ? { by: me, s: state, ts: Date.now() } : null,
    [`udata/${me}/rsvp/${rsvpIndexKey(sid, rid)}`]: state || null,
  });
}

// ---------- welcome screen & rules gate ----------

/**
 * Live welcome config: { loading, configured, req, v, by, text, rules, failed }.
 * configured = there is a welcome text or rules list.
 */
export function useWelcome(sid) {
  const live = useLive(sid ? `sconf/${sid}/welcome` : null);
  const msg = live.value?.msg;
  const items = useMemo(() => (isBox(msg) ? [{ key: 'msg', aad: welcomeAad(sid), box: { iv: msg.iv, ct: msg.ct } }] : []), [sid, msg?.iv, msg?.ct]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = useMemo(() => serverOpen(sid), [sid]);
  const dec = useDecrypted(items, open);
  return useMemo(() => {
    const v = dec.msg;
    const w = v && !(v instanceof Error) ? cleanWelcome(v) : { text: '', rules: [] };
    return {
      loading: live.loading || (items.length > 0 && v === undefined),
      error: live.error,
      req: live.value?.req === true,
      v: typeof msg?.v === 'number' ? msg.v : 0,
      by: typeof msg?.by === 'string' ? msg.by : null,
      failed: v instanceof Error,
      configured: !!(w.text || w.rules.length),
      ...w,
    };
  }, [live.loading, live.error, live.value, items.length, dec.msg, msg?.v, msg?.by]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** My acceptance marker in a server (or null). */
export function useAcceptMarker(sid, uid) {
  const live = useLive(sid && uid ? `sitems/${sid}/accepted/${uid}` : null);
  return { loading: live.loading, marker: live.value && typeof live.value === 'object' ? live.value : null };
}

/** The welcome version I've seen in a server (udata). */
export function useSeenWelcome(sid, uid) {
  const live = useLive(sid && uid ? `udata/${uid}/welcome/${sid}` : null);
  return { loading: live.loading, seenV: typeof live.value === 'number' ? live.value : 0 };
}

/**
 * Save the welcome screen. bump: show it again to members who saw (or accepted) an older version.
 * Empty text + no rules + no gate removes it.
 */
export async function saveWelcome(sid, { text, rules, require }, { prevV = 0, bump = false } = {}) {
  const w = cleanWelcome({ text, rules });
  const r = ref(db, `sconf/${sid}/welcome`);
  if (!w.text && !w.rules.length && !require) return remove(r);
  const box = await sealForServer(sid, welcomeAad(sid), w);
  if (!boxFits(box)) throw new Error('The welcome text and rules are too long');
  const v = bump || !prevV ? Date.now() : prevV;
  return set(r, { msg: { iv: box.iv, ct: box.ct, v, by: myUid() }, ...(require ? { req: true } : {}) });
}

/** Accept the rules (the marker the database rules check) and remember the version. */
export function acceptRules(sid, v) {
  const me = myUid();
  return update(ref(db), {
    [`sitems/${sid}/accepted/${me}`]: { by: me, v: v || 0, ts: Date.now() },
    [`udata/${me}/welcome/${sid}`]: v || 0,
  });
}

/** Remember that I've seen this welcome version (no acceptance needed). */
export const markWelcomeSeen = (sid, v) => set(ref(db, `udata/${myUid()}/welcome/${sid}`), v || 0);

/** One-shot: am I gated in this server? (send hook; uses live snapshots when loaded). */
export async function loadGate(sid, uid) {
  const [req, marker] = await Promise.all([
    readOnce(`sconf/${sid}/welcome/req`).catch(() => null),
    readOnce(`sitems/${sid}/accepted/${uid}`).catch(() => null),
  ]);
  return { req: req === true, marker: marker && typeof marker === 'object' ? marker : null };
}

// ---------- AutoMod ----------

/** Live AutoMod config: { loading, cfg (clean, or null when off), failed }. */
export function useAutomod(sid) {
  const live = useLive(sid ? `sconf/${sid}/automod/cfg` : null);
  const b = live.value;
  const items = useMemo(() => (isBox(b) ? [{ key: 'cfg', aad: automodAad(sid), box: { iv: b.iv, ct: b.ct } }] : []), [sid, b?.iv, b?.ct]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = useMemo(() => serverOpen(sid), [sid]);
  const dec = useDecrypted(items, open);
  const v = dec.cfg;
  return useMemo(() => ({
    loading: live.loading || (items.length > 0 && v === undefined),
    failed: v instanceof Error,
    cfg: v && !(v instanceof Error) ? cleanAutomod(v) : null,
  }), [live.loading, items.length, v]);
}

/** One-shot AutoMod config (send hook). null when off or unreadable. */
export async function loadAutomod(sid) {
  const b = await readOnce(`sconf/${sid}/automod/cfg`).catch(() => null);
  if (!isBox(b)) return null;
  try {
    return cleanAutomod(await openCached(automodAad(sid), b, () => openForServer(sid, automodAad(sid), b)));
  } catch {
    return null;
  }
}

export async function saveAutomod(sid, cfg) {
  const c = cleanAutomod(cfg);
  const r = ref(db, `sconf/${sid}/automod/cfg`);
  if (!automodActive(c)) return remove(r);
  const box = await sealForServer(sid, automodAad(sid), c);
  if (!boxFits(box)) throw new Error('The word list is too long');
  return set(r, { iv: box.iv, ct: box.ct });
}

// ---------- templates ----------

/** My saved templates, decrypted: { loading, list: [{ tid, ...template }] }. */
export function useMyTemplates(uid) {
  const live = useLive(uid ? `udata/${uid}/templates` : null);
  const items = useMemo(() => {
    const v = live.value && typeof live.value === 'object' ? live.value : {};
    return Object.entries(v).filter(([, b]) => isBox(b)).map(([tid, b]) => ({ key: tid, aad: templateAad(uid, tid), box: { iv: b.iv, ct: b.ct } }));
  }, [uid, live.value]);
  const open = useCallback((aad, box) => openForMe(aad, box), []);
  const dec = useDecrypted(items, open);
  return useMemo(() => {
    const list = [];
    let pending = 0;
    for (const it of items) {
      const v = dec[it.key];
      if (v === undefined) { pending++; continue; }
      if (v instanceof Error) continue;
      try {
        list.push({ ...cleanTemplate(v), tid: it.key });
      } catch { /* malformed: skip */ }
    }
    return { loading: live.loading || pending > 0, list: list.sort((a, b) => a.tid.localeCompare(b.tid)), count: items.length };
  }, [items, dec, live.loading]);
}

/** Save a template (structure only) to udata/{me}/templates; drops topics if it would not fit. */
export async function saveTemplate(template, count = 0) {
  if (count >= TEMPLATE_LIMITS.saved) throw new Error(`You can keep ${TEMPLATE_LIMITS.saved} templates. Delete one first.`);
  const uid = myUid();
  const tid = push(ref(db, `udata/${uid}/templates`)).key;
  let t = cleanTemplate(template);
  let box = await sealForMe(templateAad(uid, tid), t);
  let trimmed = false;
  if (!boxFits(box)) {
    t = withoutTopics(t);
    box = await sealForMe(templateAad(uid, tid), t);
    trimmed = true;
    if (!boxFits(box)) throw new Error('This server is too large to save as a template');
  }
  await set(ref(db, `udata/${uid}/templates/${tid}`), { iv: box.iv, ct: box.ct });
  return { tid, trimmed };
}

export const deleteTemplate = (tid) => remove(ref(db, `udata/${myUid()}/templates/${tid}`));

/**
 * Apply the rest of a template to a server just created from its channel list (serverCreateOptions
 * `after`): categories (+ each channel's `cat`) in one update, roles, the welcome screen, and the
 * first message in the first text channel.
 */
export async function applyTemplate(t, { sid, cids, generalCid, uid }) {
  const tpl = cleanTemplate(t);
  if (tpl.categories.length) {
    const ids = {};
    const patch = {};
    await Promise.all(tpl.categories.map(async (c, i) => {
      const catId = push(ref(db, `servers/${sid}/categories`)).key;
      ids[c.key] = catId;
      const enc = await sealForServer(sid, categoryAad(sid, catId), { name: c.name.slice(0, 32) });
      patch[`servers/${sid}/categories/${catId}`] = { enc, position: i };
    }));
    tpl.channels.forEach((c, i) => {
      if (c.cat && ids[c.cat] && cids[i]) patch[`servers/${sid}/channels/${cids[i]}/cat`] = ids[c.cat];
    });
    await update(ref(db), patch);
  }
  for (const r of tpl.roles) await createRole(sid, r);
  if (tpl.welcome) await saveWelcome(sid, tpl.welcome);
  if (tpl.message && generalCid) {
    const { done } = await sendMessage({ kind: 'channel', sid, cid: generalCid }, { uid }, { text: tpl.message });
    await done;
  }
}

// ---------- discovery ----------

/** My server's public listing (pub/servers/{sid}), sanitized, or null. */
export function useListing(sid) {
  const live = useLive(sid ? `pub/servers/${sid}` : null);
  return { loading: live.loading, listing: live.value ? sanitizeListing(sid, live.value) : null, raw: live.value };
}

/** Public listings, newest 200, sanitized (invalid ones dropped). */
export function useListings() {
  const st = usePub('servers', null, { last: 200 });
  const list = useMemo(() => st.items.map((it) => sanitizeListing(it.id, it)).filter(Boolean), [st.items]);
  return { loading: st.loading, error: st.error, list };
}

/**
 * List (or update the listing of) a server I own. A new listing creates a dedicated invite (no
 * expiry, no use limit) whose link, key included, becomes public. An existing listing keeps its
 * invite unless `newInvite`.
 */
export async function publishListing(sid, form, { current = null, newInvite = false } = {}) {
  const fields = cleanListing(form);
  const me = myUid();
  if (current && !newInvite) {
    await updatePub('servers', sid, fields);
    return current.iid;
  }
  const iid = await createInvite(sid, me, { expiresInMs: 0, maxUses: 0 });
  try {
    const inv = parseInviteLink(await inviteLink(sid, iid));
    if (!inv?.key) throw new Error('Could not build the invite link');
    await putPub('servers', sid, { ...fields, iid, k: inv.key });
  } catch (e) {
    await remove(ref(db, `servers/${sid}/invites/${iid}`)).catch(() => {});
    throw e;
  }
  await set(ref(db, `sconf/${sid}/discovery/listing`), { iid }).catch(() => {});
  if (current?.iid && current.iid !== iid) {
    await remove(ref(db, `servers/${sid}/invites/${current.iid}`)).catch(() => {});
    writeAudit(sid, me, { action: 'invite.revoke', target: current.iid, detail: 'replaced the public discovery invite' });
  }
  writeAudit(sid, me, { action: 'invite.create', target: iid, detail: 'public discovery listing · never expires · no limit' });
  return iid;
}

/** Unlist: remove the listing and revoke its invite in one update. */
export async function unlistServer(sid, listing) {
  const patch = { [`pub/servers/${sid}`]: null, [`sconf/${sid}/discovery`]: null };
  if (listing?.iid) patch[`servers/${sid}/invites/${listing.iid}`] = null;
  await update(ref(db), patch);
  if (listing?.iid) writeAudit(sid, myUid(), { action: 'invite.revoke', target: listing.iid, detail: 'unlisted from discovery' });
}

/** App admins remove someone else's listing (the invite stays; only its owner can revoke it). */
export const adminRemoveListing = (sid) => remove(ref(db, `pub/servers/${sid}`));
