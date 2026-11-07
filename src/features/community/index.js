// Workstream: community. Server events with RSVP, server templates, the welcome screen and rules
// gate, server discovery, and AutoMod. Everything is registered through the extension registries;
// see docs/features/community.md for data paths, AAD strings and limits.
import { createElement as h } from 'react';
import { register } from '../../lib/ext/registry.js';
import { automodActive, checkMessage, isExempt } from './lib/automod.js';
import { isGated } from './lib/welcome.js';
import { loadAutomod, loadGate } from './lib/data.js';
import { readOnce } from './lib/live.js';
import { openDiscover, openEventEditor, openWelcome, requestEventsPanel } from './lib/bus.js';
import CommunityHost from './components/CommunityHost.jsx';
import { EventMessageCard, EventsPanel, EventsSidebar, isEventRef } from './components/EventsViews.jsx';
import { ChatBridge, WelcomeSettings, showGateNotice } from './components/Welcome.jsx';
import { AutomodGate, AutomodSettings } from './components/Automod.jsx';
import { SaveTemplateTab, TemplatePicker } from './components/Templates.jsx';
import { DiscoverRedirect, DiscoverySettings } from './components/Discovery.jsx';
import './community.css';

const inChannel = (ctx) => ctx?.conv?.kind === 'channel' && !!ctx.conv.sid;
/** My built-in role in the conversation's server (ChatContext members may still be loading). */
async function myRole(ctx) {
  const uid = ctx.me?.uid;
  const known = ctx.members?.[uid]?.role;
  if (known) return known;
  const v = await readOnce(`servers/${ctx.conv.sid}/members/${uid}/role`).catch(() => null);
  return typeof v === 'string' ? v : 'member';
}
const isStaffRole = (r) => r === 'owner' || r === 'admin';
const currentSid = (ws) => (ws?.nav && !ws.nav.view && ws.servers?.some((s) => s.sid === ws.nav.sid) ? ws.nav.sid : null);

// ---------- app-wide host (modals, reminders, welcome screen) ----------
register('appMounts', { id: 'community.host', Component: CommunityHost });

// ---------- events (feature 26) ----------
register('sidebarSections', {
  id: 'community.events',
  order: 10,
  render: (ctx) => (ctx.view === 'server' && ctx.sid ? h(EventsSidebar, { ctx }) : null),
});
register('chatHeaderButtons', { id: 'community.events', label: 'Events', icon: '📅', panel: 'community.events', when: inChannel });
register('chatPanels', { id: 'community.events', title: 'Events', render: (ctx) => (inChannel(ctx) ? h(EventsPanel, { ctx }) : null) });
register('slashCommands', {
  name: 'event',
  description: 'Plan a server event (opens the event form)',
  args: '[title]',
  scopes: ['channel'],
  run(args, ctx) {
    openEventEditor({ sid: ctx.conv.sid, title: args, send: ctx.canSend ? ctx.send : undefined, channelName: ctx.conv.name });
    return { handled: true };
  },
});
register('messageExtras', {
  id: 'community.event',
  render: (m, ctx) => (inChannel(ctx) && isEventRef(m.body?.srvEvent) ? h(EventMessageCard, { m, ctx }) : null),
});

// ---------- welcome screen & rules gate (feature 28) ----------
register('composerButtons', { id: 'community.bridge', render: (ctx) => (inChannel(ctx) ? h(ChatBridge, { ctx }) : null) });
register('sendHooks', {
  id: 'community.gate',
  order: -1e8, // right after slash commands: local-only commands still work, posts don't
  async run(draft, ctx) {
    if (!inChannel(ctx)) return undefined;
    const uid = ctx.me?.uid;
    const role = await myRole(ctx);
    if (isStaffRole(role)) return undefined;
    const g = await loadGate(ctx.conv.sid, uid);
    if (!isGated({ req: g.req, myUid: uid, myRole: role, marker: g.marker })) return undefined;
    showGateNotice(ctx, ctx.conv.sid);
    return { cancel: true, reason: 'Accept this server’s rules before posting: see the notice above the message box.' };
  },
});
register('serverSettingsTabs', {
  id: 'community.welcome',
  label: 'Welcome',
  icon: 'chat',
  visible: (ctx) => !!ctx.perms?.manageApps,
  render: (ctx) => h(WelcomeSettings, { ctx }),
});

// ---------- AutoMod (feature 30) ----------
register('sendHooks', {
  id: 'community.automod',
  order: 1e6, // after other hooks have shaped the final text
  async run(draft, ctx) {
    if (!inChannel(ctx)) return undefined;
    const cfg = await loadAutomod(ctx.conv.sid);
    if (!automodActive(cfg) || isExempt(ctx.perms, cfg) || isStaffRole(await myRole(ctx))) return undefined;
    const v = checkMessage(draft, cfg);
    if (!v) return undefined;
    if (cfg.action === 'block') return { cancel: true, reason: `AutoMod blocked this message: ${v.reason}.` };
    ctx.toast?.(`Sent, but AutoMod hides it from other members: ${v.reason}.`);
    return undefined;
  },
});
register('messageExtras', { id: 'community.automod', render: (m, ctx) => (inChannel(ctx) ? h(AutomodGate, { m, ctx }) : null) });
register('serverSettingsTabs', {
  id: 'community.automod',
  label: 'AutoMod',
  icon: 'shield',
  visible: (ctx) => !!ctx.perms?.manageApps,
  render: (ctx) => h(AutomodSettings, { ctx }),
});

// ---------- templates (feature 27) ----------
register('serverCreateOptions', {
  id: 'community.templates',
  label: 'Start from a template',
  description: 'Study group, open-source project, game jam, hackathon, friends, or one you saved',
  icon: '🧩',
  render: (ctx) => h(TemplatePicker, { ctx }),
});
register('serverSettingsTabs', { id: 'community.template', label: 'Template', icon: 'copy', render: (ctx) => h(SaveTemplateTab, { ctx }) });

// ---------- discovery (feature 29) ----------
register('serverCreateOptions', {
  id: 'community.discover',
  label: 'Discover public servers',
  description: 'Browse servers whose owners listed them publicly',
  icon: '🧭',
  render: (ctx) => h(DiscoverRedirect, { ctx, open: openDiscover }),
});
register('serverSettingsTabs', {
  id: 'community.discovery',
  label: 'Discovery',
  icon: 'search',
  visible: (ctx) => ctx.server?.myRole === 'owner' || !!ctx.perms?.manageApps,
  render: (ctx) => h(DiscoverySettings, { ctx }),
});

// ---------- command palette ----------
register('paletteActions', { id: 'community.discover', title: 'Discover public servers', hint: 'Browse listed servers', keywords: ['explore', 'public', 'join', 'directory'], run: () => openDiscover() });
register('paletteActions', {
  id: 'community.newEvent',
  title: 'New server event',
  hint: 'Plan an event in this server',
  keywords: ['event', 'schedule', 'rsvp'],
  when: (ws) => !!currentSid(ws),
  run: (ws) => openEventEditor({ sid: currentSid(ws) }),
});
register('paletteActions', {
  id: 'community.events',
  title: 'Show server events',
  hint: 'Upcoming and past events',
  keywords: ['event', 'calendar', 'rsvp'],
  when: (ws) => !!currentSid(ws),
  run: (ws) => {
    const sid = currentSid(ws);
    requestEventsPanel(sid);
    const cid = ws.nav.chatCid?.[sid];
    if (cid) ws.openConv({ kind: 'channel', sid, cid });
    else ws.setNav((n) => ({ ...n, tab: 'chat', view: null }));
  },
});
register('paletteActions', {
  id: 'community.rules',
  title: 'Show server rules',
  hint: 'Welcome screen and rules',
  keywords: ['welcome', 'rules', 'guidelines'],
  when: (ws) => !!currentSid(ws),
  run: (ws) => openWelcome(currentSid(ws)),
});
