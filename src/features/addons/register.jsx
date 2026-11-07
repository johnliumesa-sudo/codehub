// Registers everything the add-ons workstream adds to the app (see ARCHITECTURE.md "Round 3:
// extension points" and docs/features/addons.md).
import { register } from '../../lib/ext/registry.js';
import { openHub, useHub } from './lib/hub.js';
import { reportedAddonId } from './lib/report.js';
import ServerAddonMount from './components/ServerAddonMount.jsx';
import { Lazy } from './components/lazy.jsx';
import './addons.css';

/** appMount: the hub dialog, loaded the first time it opens. */
function HubMount({ ctx }) {
  const hub = useHub();
  if (!hub.open || !ctx?.me) return null;
  return <Lazy key={hub.seq} name="Hub" initial={hub} me={ctx.me} />;
}

const PuzzleIcon = (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 4.5a2 2 0 1 1 4 0V6h3a1 1 0 0 1 1 1v3h-1.5a2 2 0 1 0 0 4H18v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 1 0-4 0V18H7a1 1 0 0 1-1-1v-3h1.5a2 2 0 1 0 0-4H6V7a1 1 0 0 1 1-1h3V4.5Z" />
  </svg>
);

/** `m.body.addon` of a message an add-on sent: { id, name, icon } (untrusted: checked before use). */
function viaAddon(m) {
  const a = m?.body?.addon;
  if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !a.name.trim() || a.name.length > 48) return null;
  return { name: a.name.trim(), icon: typeof a.icon === 'string' && a.icon.length <= 8 ? a.icon : '🧩' };
}

register('chatHeaderButtons', { id: 'addons.open', label: 'Add-ons', icon: PuzzleIcon, panel: 'addons', order: 10 });
register('chatPanels', { id: 'addons', title: 'Add-ons', render: (ctx) => <Lazy name="AddonsPanel" ctx={ctx} /> });

register('appMounts', { id: 'addons.hub', Component: HubMount });
register('appMounts', { id: 'addons.server', Component: ServerAddonMount });

register('messageBadges', {
  id: 'addons.via',
  render: (m) => {
    const a = viaAddon(m);
    return a ? <span className="ad-via" title={`Sent with the ${a.name} add-on`}>via {a.icon} {a.name}</span> : null;
  },
  // A message sent through an add-on starts its own header, so its badge is always visible.
  groupKey: (m) => (viaAddon(m) ? `addon:${viaAddon(m).name}` : ''),
});

register('userSettingsTabs', { id: 'addonApps', label: 'Add-on apps', render: (ctx) => <Lazy name="UserAddonsTab" ctx={ctx} /> });
register('serverSettingsTabs', {
  id: 'addons',
  label: 'Add-ons',
  icon: 'code',
  visible: (ctx) => !!ctx.perms?.manageApps,
  render: (ctx) => <Lazy name="ServerAddonsTab" ctx={ctx} />,
});

register('paletteActions', {
  id: 'addons.browse',
  title: 'Browse add-ons',
  hint: 'Sandboxed apps for your chats',
  keywords: ['addons', 'apps', 'directory', 'plugins'],
  run: () => openHub({ view: 'browse' }),
});
register('paletteActions', {
  id: 'addons.create',
  title: 'Create an add-on',
  hint: 'Build and publish a sandboxed app',
  keywords: ['addons', 'builder', 'publish', 'develop'],
  run: () => openHub({ view: 'build' }),
});

// Admin panel tab and the reports queue (registries read by src/components/admin/*).
register('adminTabs', { id: 'addons', label: 'Add-ons', render: ({ me }) => <Lazy name="AdminAddonsTab" me={me} /> });
register('reportTargets', {
  id: 'addons.report',
  label: 'Add-on',
  match: (r) => !!reportedAddonId(r),
  render: (r) => <Lazy name="ReportedAddon" inline id={reportedAddonId(r)} />,
  actions: (r, opts) => <Lazy name="RemoveReportedAddon" inline id={reportedAddonId(r)} {...opts} />,
});
