// Server templates: the built-in set, validation of saved/untrusted templates, and turning a live
// server's structure into a template. Pure (no Firebase).
//
// Template = {
//   v: 1, name, desc?, icon?, serverName?, color?,
//   categories: [{ key, name }],                              // <= 20
//   channels:   [{ type: 'text'|'code'|'voice', name, topic?, cat?: key }],   // 1..50
//   roles:      [{ name, color, position 1..899, perms: { [perm]: true } }],  // <= 20
//   welcome?:   { text, rules: [], require: bool },
//   message?:   string   // first message, posted in the first text channel
// }
// Saved templates live in udata/{me}/templates/{tid} = { iv, ct } sealed with my vault key under
// `tmpl:{uid}/{tid}` (structure only: no messages, members, invites, emotes or keys).
import { cleanWelcome } from './welcome.js';

export const TEMPLATE_LIMITS = Object.freeze({ name: 48, desc: 140, channels: 50, categories: 20, roles: 20, message: 2000, saved: 20 });
export const ROLE_PERMS = Object.freeze(['manageChannels', 'manageInvites', 'kick', 'ban', 'manageMessages', 'manageRoles', 'timeout', 'viewAudit', 'manageEmotes', 'manageApps']);
export const templateAad = (uid, tid) => `tmpl:${uid}/${tid}`;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const oneLine = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const multiLine = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
// Same shape as servers.cleanChannelName (lower-case, dashes), kept local so this file stays pure.
const chanName = (n) => String(n ?? '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_\-.]/gu, '').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);

/** Validate a template (built-in, saved or decrypted). Throws with a user-facing message. */
export function cleanTemplate(t) {
  if (!t || typeof t !== 'object') throw new Error('Not a template');
  const name = oneLine(t.name, TEMPLATE_LIMITS.name);
  if (!name) throw new Error('The template needs a name');
  const cats = [];
  const catKeys = new Set();
  for (const c of Array.isArray(t.categories) ? t.categories : []) {
    const key = oneLine(c?.key, 16);
    const cname = oneLine(c?.name, 32);
    if (!key || !cname || catKeys.has(key) || cats.length >= TEMPLATE_LIMITS.categories) continue;
    catKeys.add(key);
    cats.push({ key, name: cname });
  }
  const channels = [];
  for (const c of Array.isArray(t.channels) ? t.channels : []) {
    if (channels.length >= TEMPLATE_LIMITS.channels) break;
    const type = c?.type === 'code' || c?.type === 'voice' ? c.type : 'text';
    const cname = chanName(c?.name);
    if (!cname) continue;
    const ch = { type, name: cname };
    const topic = oneLine(c?.topic, 256);
    if (topic) ch.topic = topic;
    if (type === 'text' && typeof c?.cat === 'string' && catKeys.has(c.cat)) ch.cat = c.cat;
    channels.push(ch);
  }
  if (!channels.length) throw new Error('A template needs at least one channel');
  const roles = [];
  for (const r of Array.isArray(t.roles) ? t.roles : []) {
    if (roles.length >= TEMPLATE_LIMITS.roles) break;
    const rname = oneLine(r?.name, 48);
    const position = Number.isInteger(r?.position) && r.position >= 1 && r.position <= 899 ? r.position : null;
    if (!rname || position === null) continue;
    const perms = {};
    ROLE_PERMS.forEach((p) => { if (r?.perms?.[p] === true) perms[p] = true; });
    roles.push({ name: rname, color: HEX_RE.test(r?.color || '') ? r.color.toLowerCase() : '#8892a6', position, perms });
  }
  const out = { v: 1, name, categories: cats, channels, roles };
  const desc = oneLine(t.desc, TEMPLATE_LIMITS.desc);
  if (desc) out.desc = desc;
  const icon = oneLine(t.icon, 8);
  if (icon) out.icon = icon;
  const serverName = oneLine(t.serverName, 64);
  if (serverName) out.serverName = serverName;
  if (HEX_RE.test(t.color || '')) out.color = t.color.toLowerCase();
  if (t.welcome && typeof t.welcome === 'object') {
    const w = cleanWelcome(t.welcome);
    if (w.text || w.rules.length || t.welcome.require === true) out.welcome = { ...w, require: t.welcome.require === true };
  }
  const message = multiLine(t.message, TEMPLATE_LIMITS.message);
  if (message) out.message = message;
  return out;
}

/** Template minus channel topics (used when the sealed template would not fit one database leaf). */
export function withoutTopics(t) {
  return { ...t, channels: t.channels.map(({ topic, ...c }) => c) };
}

/**
 * A live server's structure -> template (name = the template's name, serverName = the name new
 * servers get by default). channels: [{ type, name, topic, cat, position }] (decrypted);
 * categories: [{ id, name, position }]; roles: { rid: { name, color, position, perms } };
 * welcome: { text, rules, req } or null. Undecryptable names are skipped.
 */
export function templateFromServer({ name, serverName, color, channels = [], categories = [], roles = {}, welcome = null }) {
  const sortedCats = [...categories].filter((c) => c && c.name).sort((a, b) => (a.position || 0) - (b.position || 0));
  const keyOf = new Map(sortedCats.map((c, i) => [c.id, `c${i}`]));
  const order = { text: 0, voice: 1, code: 2 };
  const chans = [...channels]
    .filter((c) => c && c.name && !c.failed && !c.pending)
    .sort((a, b) => order[a.type] - order[b.type] || (a.position || 0) - (b.position || 0))
    .map((c) => ({ type: c.type, name: c.name, ...(c.topic ? { topic: c.topic } : {}), ...(c.type === 'text' && keyOf.has(c.cat) ? { cat: keyOf.get(c.cat) } : {}) }));
  const roleList = Object.values(roles || {})
    .filter((r) => r && r.name && !r.failed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ name: r.name, color: r.color, position: r.position, perms: r.perms || {} }));
  return cleanTemplate({
    name: name || 'My template',
    serverName,
    color,
    categories: sortedCats.map((c) => ({ key: keyOf.get(c.id), name: c.name })),
    channels: chans,
    roles: roleList,
    welcome: welcome ? { text: welcome.text, rules: welcome.rules, require: welcome.req === true } : undefined,
  });
}

/** Short summary for cards: "6 channels · 2 categories · 2 roles · welcome screen". */
export function summarize(t) {
  const parts = [`${t.channels.length} channel${t.channels.length === 1 ? '' : 's'}`];
  if (t.categories.length) parts.push(`${t.categories.length} categor${t.categories.length === 1 ? 'y' : 'ies'}`);
  if (t.roles.length) parts.push(`${t.roles.length} role${t.roles.length === 1 ? '' : 's'}`);
  if (t.welcome) parts.push(t.welcome.require ? 'rules gate' : 'welcome screen');
  return parts.join(' · ');
}

const MOD = { manageMessages: true, timeout: true };
const ORGANIZER = { manageChannels: true, manageInvites: true, manageMessages: true, kick: true, timeout: true, viewAudit: true, manageApps: true, manageEmotes: true };

/** The five built-in templates. */
export const BUILTIN_TEMPLATES = Object.freeze([
  {
    id: 'study',
    name: 'Study group',
    icon: '📚',
    desc: 'Homework help, shared notes and a quiet room for focus sessions.',
    color: '#3ccf91',
    categories: [{ key: 'info', name: 'Start here' }, { key: 'study', name: 'Study' }],
    channels: [
      { type: 'text', name: 'general', topic: 'Say hi and plan your next session', cat: 'study' },
      { type: 'text', name: 'announcements', topic: 'Deadlines, exam dates and schedule changes', cat: 'info' },
      { type: 'text', name: 'homework-help', topic: 'Ask questions; show what you tried first', cat: 'study' },
      { type: 'text', name: 'resources', topic: 'Notes, links and past papers', cat: 'study' },
      { type: 'code', name: 'scratchpad', topic: 'Work through problems together' },
      { type: 'voice', name: 'study-room' },
    ],
    roles: [
      { name: 'Organizer', color: '#3ccf91', position: 60, perms: ORGANIZER },
      { name: 'Tutor', color: '#5b8cff', position: 30, perms: MOD },
    ],
    welcome: {
      text: 'Welcome to the study group! Introduce yourself in #general and check #announcements for deadlines.',
      rules: ['Be kind and patient: everyone learns at a different pace.', "Don't share answers to graded work; explain the method instead.", 'Keep #homework-help on topic.'],
      require: false,
    },
    message: '👋 Welcome to the study group! Check **#announcements** for deadlines, ask questions in **#homework-help**, and hop into the study room voice channel for focus sessions.',
  },
  {
    id: 'oss',
    name: 'Open-source project',
    icon: '🛠️',
    desc: 'Contributors, releases, help for users and a shared code workspace.',
    color: '#5b8cff',
    categories: [{ key: 'info', name: 'Project' }, { key: 'dev', name: 'Development' }, { key: 'community', name: 'Community' }],
    channels: [
      { type: 'text', name: 'general', topic: 'Anything about the project', cat: 'community' },
      { type: 'text', name: 'announcements', topic: 'Releases and roadmap updates', cat: 'info' },
      { type: 'text', name: 'contributing', topic: 'How to send your first patch', cat: 'info' },
      { type: 'text', name: 'dev', topic: 'Design discussions and code review', cat: 'dev' },
      { type: 'text', name: 'releases', topic: 'Changelogs and release planning', cat: 'dev' },
      { type: 'text', name: 'help', topic: 'Questions from users', cat: 'community' },
      { type: 'code', name: 'workspace', topic: 'Pair on patches' },
      { type: 'voice', name: 'standup' },
    ],
    roles: [
      { name: 'Maintainer', color: '#5b8cff', position: 60, perms: ORGANIZER },
      { name: 'Contributor', color: '#2bc4d9', position: 20, perms: {} },
    ],
    welcome: {
      text: 'Thanks for stopping by! Read #contributing before your first pull request, and ask usage questions in #help.',
      rules: ['Follow the code of conduct.', 'Search before asking; include versions and logs.', 'Security issues go to the maintainers privately, not in public channels.'],
      require: false,
    },
    message: '🛠️ Welcome! New here? Start with **#contributing**. Releases land in **#releases**, and **#help** is for questions.',
  },
  {
    id: 'jam',
    name: 'Game jam',
    icon: '🎮',
    desc: 'Theme reveal, team finding, devlogs and a showcase for the final builds.',
    color: '#ff8f4d',
    categories: [{ key: 'info', name: 'Jam info' }, { key: 'jam', name: 'Jamming' }],
    channels: [
      { type: 'text', name: 'general', topic: 'Chat with other jammers', cat: 'jam' },
      { type: 'text', name: 'announcements', topic: 'Theme reveal, deadlines and results', cat: 'info' },
      { type: 'text', name: 'team-finding', topic: 'Post your skills and find a team', cat: 'jam' },
      { type: 'text', name: 'devlogs', topic: 'Share progress screenshots', cat: 'jam' },
      { type: 'text', name: 'showcase', topic: 'Final builds go here', cat: 'jam' },
      { type: 'code', name: 'jam-workspace', topic: 'Prototype together' },
      { type: 'voice', name: 'voice-lounge' },
    ],
    roles: [
      { name: 'Jam host', color: '#ff8f4d', position: 60, perms: ORGANIZER },
      { name: 'Judge', color: '#f5c542', position: 40, perms: MOD },
      { name: 'Jammer', color: '#a66bff', position: 10, perms: {} },
    ],
    welcome: {
      text: 'Welcome, jammer! The theme is revealed in #announcements. Find teammates in #team-finding.',
      rules: ['Make the game during the jam; engines and libraries are fine.', 'Credit every asset you did not make.', 'Give constructive feedback.'],
      require: false,
    },
    message: '🎮 Let the jam begin! Watch **#announcements** for the theme, find a team in **#team-finding**, and post builds in **#showcase**.',
  },
  {
    id: 'hackathon',
    name: 'Hackathon',
    icon: '🚀',
    desc: 'Schedule, mentors, team formation, a help desk and submissions.',
    color: '#a66bff',
    categories: [{ key: 'info', name: 'Info' }, { key: 'hack', name: 'Hacking' }, { key: 'support', name: 'Support' }],
    channels: [
      { type: 'text', name: 'general', topic: 'Meet the other hackers', cat: 'hack' },
      { type: 'text', name: 'announcements', topic: 'Official updates from the organizers', cat: 'info' },
      { type: 'text', name: 'schedule', topic: 'Talks, workshops and deadlines', cat: 'info' },
      { type: 'text', name: 'find-a-team', topic: 'Pitch ideas and recruit teammates', cat: 'hack' },
      { type: 'text', name: 'help-desk', topic: 'Ask mentors for help', cat: 'support' },
      { type: 'text', name: 'submissions', topic: 'Post your project link and demo', cat: 'hack' },
      { type: 'code', name: 'hack-workspace', topic: 'Build together' },
      { type: 'voice', name: 'stage' },
      { type: 'voice', name: 'mentor-room' },
    ],
    roles: [
      { name: 'Organizer', color: '#a66bff', position: 70, perms: ORGANIZER },
      { name: 'Mentor', color: '#2bc4d9', position: 40, perms: MOD },
      { name: 'Hacker', color: '#5b8cff', position: 10, perms: {} },
    ],
    welcome: {
      text: 'Welcome to the hackathon! Check #schedule, form a team in #find-a-team and ask mentors in #help-desk.',
      rules: ['Respect the code of conduct.', 'Teams of up to four people.', 'Submit before the deadline in #submissions.'],
      require: true,
    },
    message: '🚀 Welcome hackers! The **#schedule** has every talk and deadline. Need help? Ask in **#help-desk**.',
  },
  {
    id: 'friends',
    name: 'Friends',
    icon: '🎉',
    desc: 'A cozy place to hang out: memes, games, music and a voice room.',
    color: '#ff6b9a',
    categories: [],
    channels: [
      { type: 'text', name: 'general', topic: 'Hang out' },
      { type: 'text', name: 'memes', topic: 'The good stuff' },
      { type: 'text', name: 'gaming', topic: 'Who is online tonight?' },
      { type: 'text', name: 'music', topic: 'Share what you are listening to' },
      { type: 'code', name: 'workspace', topic: 'Side projects' },
      { type: 'voice', name: 'hangout' },
    ],
    roles: [],
    message: '🎉 Welcome to the hangout! Grab a seat in the voice room anytime.',
  },
].map((t) => Object.freeze({ id: t.id, ...cleanTemplate(t) })));
