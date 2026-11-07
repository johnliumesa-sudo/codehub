// Workstream: personal (custom status, DND, auto-idle, favorites and server folders, private notes,
// appearance). Docs: docs/features/personal.md. Registers:
//   appMounts          personal.host      favorites listener, status expiry, appearance sync, dialogs
//   sidebarSections    personal.favorites "Favorites" in both sidebars
//   chatHeaderButtons  personal.fav.add / personal.fav.remove (star the open conversation)
//   profileSections    personal.status (custom status), personal.note (private note)
//   paletteActions     status modes, custom status, favorites, server folders, appearance
// Not registry-based (small edits in core files): presence.js (modes, auto-idle), ServerRail
// (folders), ChannelSidebar / DmSidebar (stars, custom status), MemberList / GroupMembersPanel
// (note marks, custom status), UserPanel (status menu), Composer (status in @mentions),
// Message (12/24 h clock), SettingsModal (Appearance), notify / notifications / IncomingCallModal (DND).
import { createElement } from 'react';
import { register } from '../../lib/ext/registry.js';
import { STATUS_MODES, MODE_LABEL } from './lib/statusCore.js';
import { clearCustomStatus, setStatusMode } from './lib/status.js';
import { favKey } from './lib/favoritesCore.js';
import { isFavorite, toggleFavorite } from './lib/favorites.js';
import { getAppearance, initAppearance, setAppearance } from './lib/appearance.js';
import { openPersonalDialog } from './lib/uiBus.js';
import PersonalHost from './components/PersonalHost.jsx';
import { FavoritesSection, StarIcon } from './components/Favorites.jsx';
import { ProfileStatusSection } from './components/StatusBits.jsx';
import { UserNoteSection } from './components/UserNote.jsx';
import './personal.css';

initAppearance();

const h = createElement;
const fail = (ctx, e) => ctx.toast(e?.message || 'That didn’t work', 'error');

// ---------- favorites: chat header star (re-registered when favorites change so `when` re-runs) ----------

function registerHeaderStars() {
  register('chatHeaderButtons', {
    id: 'personal.fav.add',
    order: 50,
    label: 'Add to Favorites',
    icon: h(StarIcon, { filled: false, size: 17 }),
    when: (ctx) => !!favKey(ctx.conv) && !isFavorite(ctx.conv),
    run: (ctx) => toggleFavorite(ctx.conv).then(() => ctx.toast('Added to Favorites', 'ok'), (e) => fail(ctx, e)),
  });
  register('chatHeaderButtons', {
    id: 'personal.fav.remove',
    order: 50,
    label: 'Remove from Favorites',
    icon: h('span', { className: 'pf-star-on' }, h(StarIcon, { filled: true, size: 17 })),
    when: (ctx) => isFavorite(ctx.conv),
    run: (ctx) => toggleFavorite(ctx.conv).then(() => ctx.toast('Removed from Favorites', 'ok'), (e) => fail(ctx, e)),
  });
}
registerHeaderStars();

// ---------- app mount, sidebar, profile card ----------

register('appMounts', {
  id: 'personal.host',
  Component: ({ ctx }) => h(PersonalHost, { ctx, onFavoritesChange: registerHeaderStars }),
});

register('sidebarSections', {
  id: 'personal.favorites',
  order: -10,
  render: (ctx) => h(FavoritesSection, { ctx }),
});

register('profileSections', {
  id: 'personal.status',
  order: -10,
  render: (uid, ctx) => h(ProfileStatusSection, { uid, isMe: !!ctx.isMe }),
});

register('profileSections', {
  id: 'personal.note',
  order: 10,
  render: (uid, ctx) => (ctx.isMe || !uid ? null : h(UserNoteSection, { key: uid, uid })),
});

// ---------- command palette ----------

/** The conversation open in the workspace (from nav ids), or null. */
export function navConv(nav) {
  if (!nav || nav.view) return null;
  if (nav.sid) {
    const cid = nav.tab !== 'collab' ? nav.chatCid?.[nav.sid] : null;
    return cid ? { kind: 'channel', sid: nav.sid, cid } : null;
  }
  if (nav.gid) return { kind: 'group', gid: nav.gid };
  if (nav.dmId) return { kind: 'dm', dmId: nav.dmId };
  return null;
}

for (const m of STATUS_MODES) {
  register('paletteActions', {
    id: `personal.status.${m}`,
    title: `Set status: ${MODE_LABEL[m]}`,
    hint: 'Status',
    keywords: ['status', 'presence', 'away', 'busy', m === 'dnd' ? 'do not disturb' : m],
    run: (ctx) => setStatusMode(m).then(() => ctx.toast(`Status: ${MODE_LABEL[m]}`, 'success'), (e) => fail(ctx, e)),
  });
}

register('paletteActions', {
  id: 'personal.status.custom',
  title: 'Set a custom status…',
  hint: 'Status',
  keywords: ['status', 'emoji', 'custom', 'away'],
  run: () => openPersonalDialog('status'),
});

register('paletteActions', {
  id: 'personal.status.clear',
  title: 'Clear custom status',
  hint: 'Status',
  keywords: ['status', 'custom', 'remove'],
  run: (ctx) => clearCustomStatus().then(() => ctx.toast('Custom status cleared', 'success'), (e) => fail(ctx, e)),
});

register('paletteActions', {
  id: 'personal.fav.toggle.add',
  title: 'Add this conversation to Favorites',
  hint: 'Favorites',
  keywords: ['favorite', 'star', 'pin', 'sidebar'],
  when: (ctx) => {
    const c = navConv(ctx.nav);
    return !!favKey(c) && !isFavorite(c);
  },
  run: (ctx) => toggleFavorite(navConv(ctx.nav)).then(() => ctx.toast('Added to Favorites', 'success'), (e) => fail(ctx, e)),
});

register('paletteActions', {
  id: 'personal.fav.toggle.remove',
  title: 'Remove this conversation from Favorites',
  hint: 'Favorites',
  keywords: ['favorite', 'unstar', 'sidebar'],
  when: (ctx) => isFavorite(navConv(ctx.nav)),
  run: (ctx) => toggleFavorite(navConv(ctx.nav)).then(() => ctx.toast('Removed from Favorites', 'success'), (e) => fail(ctx, e)),
});

register('paletteActions', {
  id: 'personal.folders',
  title: 'Manage server folders…',
  hint: 'Server rail',
  keywords: ['folder', 'servers', 'group', 'organize', 'rail'],
  run: () => openPersonalDialog('folders'),
});

register('paletteActions', {
  id: 'personal.appearance',
  title: 'Appearance settings',
  hint: 'Settings',
  keywords: ['density', 'compact', 'font', 'size', 'motion', 'focus', 'width', 'clock', '24', '12', 'display'],
  run: (ctx) => ctx.openSettings('appearance'),
});

register('paletteActions', {
  id: 'personal.density',
  title: 'Toggle compact message density',
  hint: 'Appearance',
  keywords: ['density', 'compact', 'cozy', 'spacing'],
  run: () => setAppearance({ density: getAppearance().prefs.density === 'compact' ? 'cozy' : 'compact' }),
});
