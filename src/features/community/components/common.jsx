// Small shared pieces for the community UI: permissions in a server, voice join, a portal modal.
import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { permsFor } from '../../../lib/roles.js';
import { joinCall } from '../../../lib/calls/useCall.js';
import { voiceScope } from '../../../lib/calls/core.js';
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

/** Join a voice channel like clicking it in the sidebar (never rings) and show its server. */
export async function joinVoiceChannel(ws, sid, cid) {
  await joinCall(voiceScope(sid, cid), ws.me.uid, { kind: 'audio', ring: false });
  if (ws.nav?.sid !== sid || ws.nav?.view) ws.setNav((n) => ({ ...n, sid, dmId: null, gid: null, view: null }));
  ws.toast('Joined the voice channel. Open the call from the bar above your name.', 'success');
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
