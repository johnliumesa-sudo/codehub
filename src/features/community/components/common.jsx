// Small shared pieces for the community UI: permissions in a server, voice join, a portal modal.
import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { permsFor } from '../../../lib/roles.js';
import { closeEventDetail } from '../lib/bus.js';
import { Modal } from '../../../components/layout/ui.jsx';
import { useLive } from '../lib/live.js';

/** A member's record and permissions in a server (raw roles: flags only, no names needed). */
export function useServerPerms(sid, uid) {
  const member = useLive(sid && uid ? `servers/${sid}/members/${uid}` : null);
  const roles = useLive(sid ? `servers/${sid}/roles` : null);
  return useMemo(() => {
    const m = member.value && typeof member.value === 'object' ? member.value : null;
    const rec = m ? { uid, role: m.role === 'owner' || m.role === 'admin' ? m.role : 'member', roleId: typeof m.roleId === 'string' ? m.roleId : undefined } : null;
    return {
      loading: member.loading,
      member: rec,
      role: rec?.role || null,
      perms: rec ? permsFor(rec, roles.value || {}) : {},
    };
  }, [member.value, member.loading, roles.value, uid]);
}

/**
 * "Join voice": exactly like clicking the voice channel in the sidebar (WorkspaceContext.openVoice:
 * shows the server, joins without ringing and opens the call view). Closes an open event detail
 * dialog so the call is in front.
 */
export async function joinVoiceChannel(ws, sid, cid) {
  await ws.openVoice(sid, cid);
  closeEventDetail();
}

/** The layout Modal, portalled to <body> so it stacks above the workspace's own modals. */
export function PortalModal(props) {
  if (typeof document === 'undefined') return null;
  return createPortal(<Modal {...props} />, document.body);
}

export const errText = (e) => String(e?.message || e || 'Something went wrong').replace(/^Error:\s*/, '').replace(/^PERMISSION_DENIED.*$/i, "You don't have permission to do that.");

/** Trigger a local file download (nothing is uploaded). */
export function downloadText(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.setAttribute('data-trusted-link', '');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
