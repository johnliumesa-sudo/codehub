// Server roles (custom ranks + permission flags). Mirrors the rule macros in
// database.rules.json exactly — the rules are the real gate; these helpers only decide what the
// UI offers. Semantics (see the spec's section 0.5):
//   rank: owner 1000, admin 900, member with a valid roleId = that role's position (1..899), member 0
//   owner/admin implicitly hold every permission; a custom-role member holds p iff role.perms[p] === true
//   a dangling roleId (role deleted) fails closed: rank 0, no permissions
//
// Crypto: the role NAME is encrypted with the server key under AAD `role:{sid}/{rid}`. Color,
// position and permission flags are plaintext metadata so database.rules.json can enforce them.
import { useEffect, useMemo, useState } from 'react';
import { onValue, push, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { db } from './firebase.js';
import { decryptText, encryptText } from './crypto.js';
import * as keystore from './keystore.js';

export const PERMS = ['manageChannels', 'manageInvites', 'kick', 'ban', 'manageMessages', 'manageRoles', 'timeout', 'viewAudit'];

export const PERM_LABELS = {
  manageChannels: 'Manage channels',
  manageInvites: 'Manage invites',
  kick: 'Kick members',
  ban: 'Ban members',
  manageMessages: 'Manage messages',
  manageRoles: 'Manage roles',
  timeout: 'Time out members',
  viewAudit: 'View audit log',
};

export const PERM_HINTS = {
  manageChannels: 'Create, rename and delete channels and code workspaces.',
  manageInvites: 'Create and revoke invite links.',
  kick: 'Remove members ranked below you.',
  ban: 'Ban members ranked below you, and lift bans.',
  manageMessages: "Delete and pin other people's messages.",
  manageRoles: 'Create and edit roles below your own, and assign them.',
  timeout: 'Stop members ranked below you from chatting for a while.',
  viewAudit: 'Read the encrypted moderation audit log.',
};

export const RANK = { owner: 1000, admin: 900 };
export const MAX_POSITION = 899;
export const MAX_ROLE_NAME = 48;
export const ROLE_COLORS = ['#5b8cff', '#a66bff', '#ff6b9a', '#ff8f4d', '#f5c542', '#3ccf91', '#2bc4d9', '#8892a6', '#e5484d', '#30a46c'];
export const DEFAULT_ROLE_COLOR = '#8892a6';

export const roleAad = (sid, rid) => `role:${sid}/${rid}`;

export const isHexColor = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
export const isValidPosition = (p) => Number.isInteger(p) && p >= 1 && p <= MAX_POSITION;
export const cleanRoleName = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ROLE_NAME);

// ---------- Pure permission logic (mirrors the rules) ----------

const isStaffRole = (r) => r === 'owner' || r === 'admin';

/** The member's custom role record if its roleId points at an existing role, else null (fail closed). */
export function roleOf(member, roles) {
  const rid = member?.roleId;
  if (typeof rid !== 'string' || !rid) return null;
  const r = roles?.[rid];
  return r && typeof r === 'object' ? r : null;
}

export const isStaff = (member) => !!member && isStaffRole(member.role);

/** Numeric rank: owner 1000, admin 900, custom role position, plain member 0. Non-member -1. */
export function rankOf(member, roles) {
  if (!member) return -1;
  if (member.role === 'owner') return RANK.owner;
  if (member.role === 'admin') return RANK.admin;
  const r = roleOf(member, roles);
  return r && typeof r.position === 'number' ? r.position : 0;
}

export function can(member, roles, perm) {
  if (!member || !PERMS.includes(perm)) return false;
  if (isStaffRole(member.role)) return true;
  const r = roleOf(member, roles);
  return !!r && r.perms?.[perm] === true;
}

/** { [perm]: boolean } for every permission, plus `staff`. */
export function permsFor(member, roles) {
  const out = { staff: isStaff(member) };
  PERMS.forEach((p) => {
    out[p] = can(member, roles, p);
  });
  return out;
}

/** True if `me` may moderate `them` (OUTRANKS in the rules). Members are { uid, role, roleId? }. */
export function outranks(me, them, roles) {
  if (!me || !them || !me.uid || me.uid === them.uid) return false;
  if (them.role === 'owner') return false;
  if (me.role === 'owner') return true;
  if (me.role === 'admin') return them.role === 'member';
  if (me.role === 'member' && them.role === 'member') {
    const mine = roleOf(me, roles);
    if (!mine) return false;
    const theirs = roleOf(them, roles);
    return !theirs || mine.position > theirs.position;
  }
  return false;
}

/** RANKABOVE(position): staff, or my custom role sits strictly above that position. */
export function rankAbove(me, roles, position) {
  if (isStaff(me)) return true;
  const mine = roleOf(me, roles);
  return !!mine && typeof position === 'number' && mine.position > position;
}

/** Roles sorted high → low (position desc, then name, then id). Accepts the roles map. */
export function sortRoles(roles) {
  return Object.values(roles || {}).sort(
    (a, b) => b.position - a.position || String(a.name || '').localeCompare(String(b.name || '')) || a.rid.localeCompare(b.rid),
  );
}

/** Roles I may hand out: position strictly below my rank. Empty unless I can manageRoles. */
export function assignableRoles(me, roles) {
  if (!can(me, roles, 'manageRoles')) return [];
  return sortRoles(roles).filter((r) => rankAbove(me, roles, r.position));
}

/**
 * Why `me` may not save `next` over `role` (null = create, next = null = delete), or null if allowed.
 * Mirrors the roles/$rid .write rule plus the shape .validate.
 */
export function roleEditBlocker(me, roles, role, next) {
  if (!can(me, roles, 'manageRoles')) return 'You need the “Manage roles” permission.';
  const staff = isStaff(me);
  const mine = roleOf(me, roles);
  if (!staff) {
    if (!mine) return 'You need a role to manage roles.';
    if (role && !(mine.position > role.position)) return 'This role is at or above your highest role.';
    if (next && !(mine.position > next.position)) return `Position must be below your own role (${mine.position}).`;
  }
  if (next) {
    if (!cleanRoleName(next.name)) return 'Give the role a name.';
    if (!isHexColor(next.color)) return 'Pick a color like #5b8cff.';
    if (!isValidPosition(next.position)) return `Position must be a whole number from 1 to ${MAX_POSITION}.`;
    if (!staff) {
      const bad = PERMS.find((p) => next.perms?.[p] === true && !can(me, roles, p));
      if (bad) return `You can't grant “${PERM_LABELS[bad]}” because you don't have it.`;
    }
  }
  return null;
}

export const canEditRole = (me, roles, role, next) => roleEditBlocker(me, roles, role, next) === null;

/** Can I tick this permission box? Staff: always; custom: only perms I hold. */
export const canGrantPerm = (me, roles, perm) => can(me, roles, perm);

/** Highest position I may give a new role (null if I can't create any). */
export function maxAssignablePosition(me, roles) {
  if (!can(me, roles, 'manageRoles')) return null;
  if (isStaff(me)) return MAX_POSITION;
  const mine = roleOf(me, roles);
  return mine && mine.position > 1 ? mine.position - 1 : null;
}

/** Suggested position for a new role: just above the current top role I can manage. */
export function suggestPosition(me, roles) {
  const max = maxAssignablePosition(me, roles);
  if (max === null) return 1;
  const below = sortRoles(roles).filter((r) => r.position <= max);
  const top = below.length ? below[0].position : 0;
  return Math.min(max, top + 1) || 1;
}

/**
 * Member list sections: Owner, Admins, each custom role by position (role color), then Members.
 * `nameOf(uid)` (optional) sorts within a section. Empty sections are dropped.
 */
export function groupMembersByRole(members, roles, nameOf) {
  const owner = [];
  const admins = [];
  const plain = [];
  const byRole = new Map();
  (members || []).forEach((m) => {
    if (m.role === 'owner') owner.push(m);
    else if (m.role === 'admin') admins.push(m);
    else {
      const r = roleOf(m, roles);
      if (!r) plain.push(m);
      else {
        if (!byRole.has(r.rid)) byRole.set(r.rid, []);
        byRole.get(r.rid).push(m);
      }
    }
  });
  const sortList = (list) =>
    nameOf
      ? [...list].sort((a, b) => String(nameOf(a.uid) || '').localeCompare(String(nameOf(b.uid) || ''), undefined, { sensitivity: 'base' }))
      : list;
  const out = [
    { key: 'owner', title: 'Owner', color: null, role: null, members: sortList(owner) },
    { key: 'admin', title: 'Admins', color: null, role: null, members: sortList(admins) },
  ];
  sortRoles(roles).forEach((r) => {
    const list = byRole.get(r.rid);
    if (list?.length) {
      out.push({ key: `role:${r.rid}`, title: r.failed ? 'Locked role' : r.name || 'Role', color: r.color, role: r, members: sortList(list) });
    }
  });
  out.push({ key: 'member', title: 'Members', color: null, role: null, members: sortList(plain) });
  return out.filter((g) => g.members.length > 0);
}

/** Find a member record by uid in a members array (from useMembers). */
export const memberOf = (members, uid) => (members || []).find((m) => m.uid === uid) || null;

// ---------- Name decryption cache (in memory; cleared on vault lock) ----------

const names = new Map(); // `${sid}/${rid}|${iv}|${ct}` -> name | Error
const nameKey = (sid, rid, box) => `${sid}/${rid}|${box?.iv}|${box?.ct}`;
// keystore.onLock arrives with the keystore additions (spec 0.3); optional until integrated.
try {
  keystore.onLock?.(() => names.clear());
} catch {
  /* older keystore without onLock */
}

async function decryptRoleName(sid, rid, box) {
  const k = nameKey(sid, rid, box);
  if (names.has(k)) return names.get(k);
  const key = await keystore.getServerKey(sid);
  const name = await decryptText(key, box, roleAad(sid, rid));
  names.set(k, name);
  return name;
}

function normalizePerms(perms) {
  const out = {};
  PERMS.forEach((p) => {
    out[p] = perms?.[p] === true;
  });
  return out;
}

/**
 * Live roles of a server, names decrypted.
 * -> { roles: { rid: { rid, name, color, position, perms, createdAt, pending?, failed? } }, list, loading, error }
 * Records with an invalid shape are skipped (the rules never accept them, but stay defensive).
 */
export function useServerRoles(sid, nonce) {
  const [st, setSt] = useState({ sid, raw: null, loading: !!sid, error: null });
  const [dec, setDec] = useState({}); // nameKey -> name | { failed: true }

  useEffect(() => {
    if (!sid) {
      setSt({ sid, raw: null, loading: false, error: null });
      return undefined;
    }
    setSt((s) => (s.sid === sid ? s : { sid, raw: null, loading: true, error: null }));
    return onValue(
      ref(db, `servers/${sid}/roles`),
      (snap) => setSt({ sid, raw: snap.val() || {}, loading: false, error: null }),
      (error) => setSt({ sid, raw: {}, loading: false, error }),
    );
  }, [sid, nonce]);

  const raw = st.sid === sid ? st.raw : null;

  useEffect(() => {
    if (!raw || !sid) return undefined;
    let alive = true;
    Object.entries(raw).forEach(([rid, r]) => {
      if (!r?.nameEnc) return;
      const k = nameKey(sid, rid, r.nameEnc);
      if (names.has(k)) return;
      decryptRoleName(sid, rid, r.nameEnc).then(
        (name) => alive && setDec((d) => ({ ...d, [k]: name })),
        () => alive && setDec((d) => ({ ...d, [k]: { failed: true } })),
      );
    });
    return () => {
      alive = false;
    };
  }, [sid, raw]);

  const roles = useMemo(() => {
    const out = {};
    Object.entries(raw || {}).forEach(([rid, r]) => {
      if (!r || typeof r !== 'object' || typeof r.position !== 'number') return;
      const k = r.nameEnc ? nameKey(sid, rid, r.nameEnc) : null;
      const v = k ? (names.has(k) ? names.get(k) : dec[k]) : { failed: true };
      const failed = !!(v && typeof v === 'object' && v.failed);
      out[rid] = {
        rid,
        name: typeof v === 'string' ? v : null,
        color: isHexColor(r.color) ? r.color : DEFAULT_ROLE_COLOR,
        position: r.position,
        perms: normalizePerms(r.perms),
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
        pending: v === undefined,
        failed,
      };
    });
    return out;
  }, [sid, raw, dec]);

  const list = useMemo(() => sortRoles(roles), [roles]);
  return { roles, list, loading: !!sid && (st.sid !== sid || st.loading), error: st.sid === sid ? st.error : null };
}

/** Display name for a role (handles pending/failed decryption). */
export function roleLabel(role) {
  if (!role) return '';
  if (role.failed) return 'Locked role';
  if (role.pending || !role.name) return '…';
  return role.name;
}

// ---------- Writes ----------

function checkInput({ name, color, position }) {
  const clean = cleanRoleName(name);
  if (!clean) throw new Error('Give the role a name');
  if (!isHexColor(color)) throw new Error('Pick a valid color (#rrggbb)');
  if (!isValidPosition(position)) throw new Error(`Position must be a whole number from 1 to ${MAX_POSITION}`);
  return clean;
}

/** Creates a role; returns its rid. */
export async function createRole(sid, { name, color, position, perms }) {
  const clean = checkInput({ name, color, position });
  const r = push(ref(db, `servers/${sid}/roles`));
  const key = await keystore.getServerKey(sid);
  const nameEnc = await encryptText(key, clean, roleAad(sid, r.key));
  await set(r, { nameEnc, color: color.toLowerCase(), position, perms: normalizePerms(perms), createdAt: serverTimestamp() });
  names.set(nameKey(sid, r.key, nameEnc), clean);
  return r.key;
}

/** patch: any of { name, color, position, perms } */
export async function updateRole(sid, rid, patch) {
  const out = {};
  if (patch.name !== undefined) {
    const clean = cleanRoleName(patch.name);
    if (!clean) throw new Error('Give the role a name');
    const key = await keystore.getServerKey(sid);
    out.nameEnc = await encryptText(key, clean, roleAad(sid, rid));
    names.set(nameKey(sid, rid, out.nameEnc), clean);
  }
  if (patch.color !== undefined) {
    if (!isHexColor(patch.color)) throw new Error('Pick a valid color (#rrggbb)');
    out.color = patch.color.toLowerCase();
  }
  if (patch.position !== undefined) {
    if (!isValidPosition(patch.position)) throw new Error(`Position must be a whole number from 1 to ${MAX_POSITION}`);
    out.position = patch.position;
  }
  if (patch.perms !== undefined) out.perms = normalizePerms(patch.perms);
  if (Object.keys(out).length) await update(ref(db, `servers/${sid}/roles/${rid}`), out);
}

/**
 * Deletes a role and clears `roleId` on the members holding it that I outrank (atomically when
 * possible). Members I can't touch keep a dangling roleId, which fails closed in rules and UI.
 */
export async function deleteRole(sid, rid, members, me, roles) {
  const holders = (members || []).filter((m) => m.roleId === rid && (!roles || !me || outranks(me, m, roles)));
  const patch = { [`servers/${sid}/roles/${rid}`]: null };
  holders.forEach((m) => {
    patch[`servers/${sid}/members/${m.uid}/roleId`] = null;
  });
  try {
    await update(ref(db), patch);
  } catch (e) {
    if (!holders.length) throw e;
    // Fall back: delete the role alone, then clear what we can one by one.
    await remove(ref(db, `servers/${sid}/roles/${rid}`));
    await Promise.allSettled(holders.map((m) => remove(ref(db, `servers/${sid}/members/${m.uid}/roleId`))));
  }
}

/** Sets (rid) or clears (null) a member's custom role. */
export function assignRole(sid, uid, rid) {
  const r = ref(db, `servers/${sid}/members/${uid}/roleId`);
  return rid ? set(r, rid) : remove(r);
}
