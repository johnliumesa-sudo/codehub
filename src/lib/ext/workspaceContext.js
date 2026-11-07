// Round 3: the workspace-level extension context, provided once inside the signed-in Workspace.
// paletteActions, appMounts, userSettingsTabs, profileSections and sidebarSections get it (merged
// into their own ctx). Fields (documented in ARCHITECTURE.md):
//   me            { uid, name, color, email, ...profile }
//   nav           Workspace navigation state (ids only; see ARCHITECTURE.md "Workspace navigation")
//   setNav(fn|obj) update nav (prefer the helpers below)
//   servers       [{ sid, joinedAt }] from userServers/{me}
//   openSettings(tabId?)        open user settings (a built-in tab id or a userSettingsTabs id)
//   openServerSettings(tabId?)  open the current server's settings (built-in or serverSettingsTabs id)
//   openConv(conv)              navigate to { kind: 'channel', sid, cid } | { kind: 'dm', dmId } | { kind: 'group', gid }
//   openVoice(sid, cid) -> Promise   join a voice channel and show its call view, like clicking it in
//                               the sidebar (never rings); rejects with the join error
//   toast(text, kind?)          'success' | 'error' | 'info'
import { createContext, useContext } from 'react';

export const WorkspaceContext = createContext(null);

/** The workspace ctx, or null outside the signed-in Workspace. */
export function useWorkspaceCtx() {
  return useContext(WorkspaceContext);
}
