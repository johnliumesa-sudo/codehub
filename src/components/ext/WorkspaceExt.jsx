// Round 3: workspace extension slots (app mounts, sidebar sections, profile sections, settings tabs).
import { useMemo } from 'react';
import { useRegistry } from '../../lib/ext/registry.js';
import { useWorkspaceCtx } from '../../lib/ext/workspaceContext.js';
import { ExtBoundary, ExtRender, passes } from './ExtRender.jsx';
import './ext.css';

/** appMounts: { id, Component } (gets `ctx` as a prop) or { id, render(ctx) }, mounted once per Workspace. */
export function AppMounts() {
  const ctx = useWorkspaceCtx();
  const entries = useRegistry('appMounts');
  if (!ctx) return null;
  return entries.map((e) => {
    if (typeof e.Component === 'function' || (e.Component && typeof e.Component === 'object')) {
      const C = e.Component;
      return (
        <ExtBoundary key={e.id} label={e.id}>
          <C ctx={ctx} />
        </ExtBoundary>
      );
    }
    return <ExtRender key={e.id} entry={e} args={[ctx]} />;
  });
}

/** sidebarSections at the top of the channel / DM sidebar. `extra` = { view, sid?, server? }. */
export function SidebarSections({ extra }) {
  const ws = useWorkspaceCtx();
  const entries = useRegistry('sidebarSections');
  const ctx = useMemo(() => ({ ...(ws || {}), ...extra }), [ws, extra]);
  if (!ws || !entries.length) return null;
  return (
    <div className="ext-sidebar-sections">
      {entries.map((e) => <ExtRender key={e.id} entry={e} args={[ctx]} />)}
    </div>
  );
}

/** profileSections in the profile card. `extra` = { sid?, member?, isMe, close }. */
export function ProfileSections({ uid, extra }) {
  const ws = useWorkspaceCtx();
  const entries = useRegistry('profileSections');
  if (!entries.length) return null;
  const ctx = { ...(ws || {}), ...extra };
  return (
    <div className="ext-profile-sections">
      {entries.map((e) => <ExtRender key={e.id} entry={e} args={[uid, ctx]} />)}
    </div>
  );
}

/**
 * Settings tabs from a registry, minus ids that collide with built-in tabs and entries whose
 * visible(ctx) is false. Returns [{ id, label, icon?, entry }].
 */
export function useExtTabs(name, builtinIds, ctx) {
  const entries = useRegistry(name);
  return entries
    .filter((e) => e.label && typeof e.render === 'function' && !builtinIds.includes(e.id) && passes(e.visible, ctx))
    .map((e) => ({ id: e.id, label: String(e.label), icon: e.icon, entry: e }));
}

/** Body of an extension settings tab. */
export function ExtTabBody({ tab, ctx }) {
  if (!tab) return null;
  return (
    <div className="ext-tab-body">
      <ExtRender entry={tab.entry} args={[ctx]} label={tab.label} notice resetKey={tab.id} />
    </div>
  );
}
