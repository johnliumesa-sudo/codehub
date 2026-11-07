// Workstream: bots (slash commands, bot builder and directory, bots in servers).
// Everything is registered through the round 3 extension registries; see docs/features/bots.md.
import { createElement } from 'react';
import { register } from '../../lib/ext/registry.js';
import { BUILTIN_COMMANDS } from './lib/builtins.js';
import { gifsEnabled } from './lib/store.js';
import { triggerHook } from './lib/runtime.js';
import BotsHost from './components/BotsHost.jsx';
import { BotBadge, CommandNote, botGroupKey } from './components/MessageParts.jsx';
import BotsTab, { requestBotsView } from './components/BotsTab.jsx';
import ServerBotsTab from './components/ServerBotsTab.jsx';
import { RemoveReportedBot, ReportedBot, reportedBotId } from './components/AdminReport.jsx';
import './bots.css';

const h = createElement;

// 1. Built-in slash commands (listed with /help under "Built-in" in the "/" menu; order 50 keeps
// them after /help). /gif first checks that GIPHY is configured.
for (const cmd of BUILTIN_COMMANDS) {
  const run = cmd.name !== 'gif'
    ? cmd.run
    : async (args, ctx) => {
      if (!(await gifsEnabled())) return { cancel: true, reason: 'GIFs are not set up on this Codehub (an app admin adds a GIPHY key).' };
      return cmd.run(args, ctx);
    };
  register('slashCommands', { ...cmd, id: `bots.${cmd.name}`, group: 'builtin', order: 50, run });
}

// Readers: the bot line in the message header, and the "used /roll" note under the body.
register('messageBadges', {
  id: 'bots.badge',
  render: (m, ctx) => (m.body?.bot ? h(BotBadge, { m, ctx }) : null),
  groupKey: botGroupKey,
});
register('messageExtras', {
  id: 'bots.note',
  render: (m) => (m.body?.cmd || m.body?.bot ? h(CommandNote, { m }) : null),
});

// 3. Bots in servers: the composer host (commands, trigger replies, welcome messages, /poll and
// /gif tools) and the keyword-trigger send hook (late, so it sees the final text).
register('composerButtons', { id: 'bots.host', render: (ctx) => h(BotsHost, { ctx }) });
register('sendHooks', { id: 'bots.triggers', order: 1e6, run: triggerHook });

// 2. Directory and builder (Settings → Bots), server installs (Server settings → Bots).
register('userSettingsTabs', { id: 'bots', label: 'Bots', render: (ctx) => h(BotsTab, { ctx }) });
register('serverSettingsTabs', { id: 'bots', label: 'Bots', icon: 'code', render: (ctx) => h(ServerBotsTab, { ctx }) });

// Reports of kind `bot` in the admin reports queue: the bot, and "Remove bot" for app admins.
register('reportTargets', {
  id: 'bots.report',
  label: 'Bot',
  match: (r) => !!reportedBotId(r),
  render: (r) => h(ReportedBot, { id: reportedBotId(r) }),
  actions: (r, opts) => h(RemoveReportedBot, { id: reportedBotId(r), ...opts }),
});

register('paletteActions', {
  id: 'bots.directory',
  title: 'Open the bot directory',
  hint: 'Bots',
  keywords: ['bots', 'bot', 'directory', 'commands'],
  run: (ctx) => ctx.openSettings('bots'),
});
register('paletteActions', {
  id: 'bots.create',
  title: 'Create a bot',
  hint: 'Bots',
  keywords: ['bots', 'bot', 'builder', 'new'],
  run: (ctx) => {
    requestBotsView('create');
    ctx.openSettings('bots');
  },
});
register('paletteActions', {
  id: 'bots.server',
  title: 'Manage this server’s bots',
  hint: 'Bots',
  keywords: ['bots', 'bot', 'install', 'server'],
  when: (ctx) => !!ctx.nav?.sid && !ctx.nav?.view,
  run: (ctx) => ctx.openServerSettings('bots'),
});
