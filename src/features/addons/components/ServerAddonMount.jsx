// appMount: while a server is open, each add-on installed on it gets its own channel-header button
// (chatHeaderButtons) and chat panel (chatPanels). Entries are registered for the current server
// only and removed when the server or its add-ons change.
import { createElement, useEffect } from 'react';
import { register } from '../../../lib/ext/registry.js';
import { useServerInstalls } from '../lib/store.js';
import { Lazy } from './lazy.jsx';

/** At most this many server add-ons get their own header button; all of them are in the Add-ons panel. */
export const MAX_HEADER_ADDONS = 4;

export const serverPanelId = (sid, id) => `addons.s.${sid}.${id}`;

export default function ServerAddonMount({ ctx }) {
  const sid = ctx?.nav && !ctx.nav.view ? ctx.nav.sid || null : null;
  const { list } = useServerInstalls(sid);
  const key = list.slice(0, MAX_HEADER_ADDONS).map((i) => `${i.id}|${i.name}|${i.icon}`).join(',');

  useEffect(() => {
    if (!sid) return undefined;
    const offs = [];
    list.slice(0, MAX_HEADER_ADDONS).forEach((inst, i) => {
      const id = serverPanelId(sid, inst.id);
      const when = (c) => c?.conv?.kind === 'channel' && c.conv.sid === sid;
      offs.push(register('chatPanels', {
        id,
        title: inst.name,
        render: (c) => createElement(Lazy, { name: 'ServerAddonPanel', ctx: c, sid, id: inst.id }),
      }));
      offs.push(register('chatHeaderButtons', { id, label: `${inst.name} (add-on)`, icon: inst.icon, panel: id, order: 20 + i, when }));
    });
    return () => offs.forEach((off) => off());
  }, [sid, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
