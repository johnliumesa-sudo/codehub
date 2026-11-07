// Favorites: the "Favorites" sidebar section (sidebarSections, both sidebars) and the star toggles used
// in sidebar rows. Records hold ids only (udata/{me}/favorites); names are resolved live and decrypted
// locally like everywhere else, so a renamed channel or group shows its new name.
import { useEffect, useMemo, useState } from 'react';
import { decryptChannel, channelCacheKey, channelScope, dmScope, peekPlain, peerFromDmId } from '../../../lib/servers.js';
import { decryptGroupName, groupScope, peekGroupName } from '../../../lib/groups.js';
import { useProfile } from '../../../lib/profiles.js';
import { usePresence } from '../../../lib/presence.js';
import { isMuted, useNotifPrefs } from '../../../lib/notify.js';
import { isUnread, useDbValue, useLastMessages, useServerMeta } from '../../../components/layout/hooks.js';
import { Avatar, Icon } from '../../../components/layout/ui.jsx';
import GroupAvatar from '../../../components/groups/GroupAvatar.jsx';
import { favConv, favKey } from '../lib/favoritesCore.js';
import { moveFavorite, removeFavorite, toggleFavorite, useFavorites } from '../lib/favorites.js';

const COLLAPSE_KEY = 'codehub.favoritesCollapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Channel favorite: decrypted channel name + server name, unread from the last message. */
function useChannelInfo(me, sid, cid) {
  const { loading: chLoading, value: ch, error } = useDbValue(`servers/${sid}/channels/${cid}`);
  const meta = useServerMeta(sid);
  const [dec, setDec] = useState({ k: null, name: null, failed: false });
  const k = ch?.enc ? channelCacheKey(sid, cid, ch.enc) : null;
  useEffect(() => {
    if (!k) return undefined;
    const hit = peekPlain(k); // filled after this render read it: adopt it (see layout/hooks.js useChannels)
    if (hit !== undefined) {
      setDec((d) => (d.k === k && d.name === hit.name ? d : { k, name: hit.name, failed: false }));
      return undefined;
    }
    let alive = true;
    decryptChannel(sid, cid, ch.enc).then(
      (v) => alive && setDec({ k, name: v.name, failed: false }),
      () => alive && setDec({ k, name: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (k && peekPlain(k)?.name) || (dec.k === k ? dec.name : null);
  const last = useLastMessages(`messages/${sid}`, useMemo(() => [cid], [cid]))[cid];
  const { value: readTs } = useDbValue(`reads/${me}/${channelScope(sid, cid)}`);
  const gone = !!error || (!chLoading && ch === null) || meta.status === 'denied' || meta.status === 'missing';
  return {
    name: name ? `#${name}` : dec.k === k && dec.failed ? 'Encrypted channel' : null,
    sub: meta.name || '',
    gone,
    unread: isUnread(last, readTs, me),
    scope: channelScope(sid, cid),
    icon: <Icon name="hash" size={16} className="ly-chan-icon" />,
  };
}

function useDmInfo(me, dmId) {
  const peer = peerFromDmId(dmId, me);
  const profile = useProfile(peer);
  const presence = usePresence(peer);
  // A closed DM (no userDms entry) can still be reopened from here: its id never changes.
  const { value: entry } = useDbValue(`userDms/${me}/${dmId}`);
  const { value: readTs } = useDbValue(`reads/${me}/${dmScope(dmId)}`);
  return {
    name: profile?.name || null,
    sub: 'Direct message',
    gone: !peer,
    unread: !!entry && (entry.lastTs || 0) > (readTs || 0),
    scope: dmScope(dmId),
    icon: <Avatar profile={profile ? { ...profile, uid: peer } : null} size={22} presence={presence} />,
  };
}

function useGroupInfo(me, gid) {
  const { loading: metaLoading, value: meta, error } = useDbValue(`groups/${gid}/meta`);
  const { value: last } = useDbValue(`groups/${gid}/last`);
  const { value: readTs } = useDbValue(`reads/${me}/${groupScope(gid)}`);
  const [dec, setDec] = useState({ k: null, name: null, failed: false });
  const k = meta?.nameEnc ? `${meta.epoch}|${meta.nameEnc.ct}` : null;
  useEffect(() => {
    if (!k || peekGroupName(gid, meta) !== undefined) return undefined;
    let alive = true;
    decryptGroupName(gid, meta).then(
      (name) => alive && setDec({ k, name, failed: false }),
      () => alive && setDec({ k, name: null, failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = peekGroupName(gid, meta) || (dec.k === k ? dec.name : null);
  const failed = dec.k === k && dec.failed;
  return {
    name: name || (failed ? 'Encrypted group' : null),
    sub: 'Group',
    gone: !!error || (!metaLoading && meta === null),
    unread: isUnread(last, readTs, me),
    scope: groupScope(gid),
    icon: <GroupAvatar gid={gid} name={name} failed={failed} size={22} />,
  };
}

const ChannelInfo = ({ me, fav, children }) => children(useChannelInfo(me, fav.sid, fav.cid));
const DmInfo = ({ me, fav, children }) => children(useDmInfo(me, fav.dmId));
const GroupInfo = ({ me, fav, children }) => children(useGroupInfo(me, fav.gid));
const INFO = { channel: ChannelInfo, dm: DmInfo, group: GroupInfo };

function isActive(nav, fav) {
  if (!nav || nav.view) return false;
  if (fav.kind === 'channel') return nav.sid === fav.sid && nav.tab !== 'collab' && nav.chatCid?.[fav.sid] === fav.cid;
  if (fav.kind === 'dm') return !nav.sid && !nav.gid && nav.dmId === fav.dmId;
  return !nav.sid && nav.gid === fav.gid;
}

function FavoriteRow({ fav, index, count, ctx, notifPrefs, drag, setDrag }) {
  const me = ctx.me.uid;
  const Info = INFO[fav.kind];
  const active = isActive(ctx.nav, fav);
  const fail = (e) => ctx.toast(e?.message || "Couldn't update Favorites", 'error');
  const move = (to) => moveFavorite(fav.key, to).catch(fail);
  return (
    <Info me={me} fav={fav}>
      {(info) => {
        const label = info.name || '…';
        const unread = !active && info.unread && !isMuted(notifPrefs, info.scope, Date.now(), fav.kind === 'channel' ? { sid: fav.sid } : {});
        return (
          <li
            className={`ly-dm pf-fav ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${info.gone ? 'gone' : ''} ${drag?.over === fav.key ? 'drop-target' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-codehub-favorite', fav.key);
              setDrag({ key: fav.key, over: null });
            }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => {
              if (!drag || drag.key === fav.key) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (drag.over !== fav.key) setDrag({ ...drag, over: fav.key });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag && drag.key !== fav.key) moveFavorite(drag.key, index).catch(fail);
              setDrag(null);
            }}
          >
            <button
              type="button"
              className="ly-dm-main pf-fav-main"
              onClick={() => !info.gone && ctx.openConv(favConv(fav))}
              aria-current={active ? 'page' : undefined}
              aria-disabled={info.gone || undefined}
              title={info.gone ? 'No longer available' : `${label}${info.sub ? ` · ${info.sub}` : ''}`}
            >
              <span className="pf-fav-icon">{info.icon}</span>
              <span className="ly-dm-text">
                <span className="ly-dm-name">{label}</span>
                <span className="ly-dm-status">{info.gone ? 'No longer available' : info.sub}</span>
              </span>
              {unread && <span className="ly-unread-dot" aria-label="unread" />}
            </button>
            <span className="pf-fav-actions">
              <button type="button" className="pf-icon-btn" onClick={() => move(index - 1)} disabled={index === 0} aria-label={`Move ${label} up`} title="Move up">
                <Icon name="chevron" size={13} className="pf-up" />
              </button>
              <button type="button" className="pf-icon-btn" onClick={() => move(index + 1)} disabled={index === count - 1} aria-label={`Move ${label} down`} title="Move down">
                <Icon name="chevron" size={13} />
              </button>
              <button type="button" className="pf-icon-btn" onClick={() => removeFavorite(fav.key).catch(fail)} aria-label={`Remove ${label} from Favorites`} title="Remove from Favorites">
                <Icon name="x" size={13} />
              </button>
            </span>
          </li>
        );
      }}
    </Info>
  );
}

/** sidebarSections entry: shown in both sidebars when I have favorites. */
export function FavoritesSection({ ctx }) {
  const { list } = useFavorites();
  const notifPrefs = useNotifPrefs(ctx.me?.uid);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drag, setDrag] = useState(null); // { key, over }
  if (!ctx.me?.uid || !list.length) return null;
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* storage blocked */
      }
      return !c;
    });
  };
  return (
    <section className="ly-section pf-favs" aria-label="Favorites">
      <div className="ly-section-head">
        <button type="button" className="ly-section-title" onClick={toggle} aria-expanded={!collapsed}>
          <Icon name="chevron" size={12} stroke={2.4} className={collapsed ? 'rot' : ''} />
          Favorites
        </button>
        <span className="pf-count-badge" aria-label={`${list.length} favorites`}>{list.length}</span>
      </div>
      {!collapsed && (
        <ul className="pf-fav-list">
          {list.map((f, i) => (
            <FavoriteRow key={f.key} fav={f} index={i} count={list.length} ctx={ctx} notifPrefs={notifPrefs} drag={drag} setDrag={setDrag} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Star toggle for a sidebar row (channel or DM). `name` is used in the label. */
export function FavoriteStar({ conv, name, onError }) {
  const { keys } = useFavorites();
  const key = favKey(conv);
  if (!key) return null;
  const on = keys.has(key);
  const label = on ? `Remove ${name || 'this conversation'} from Favorites` : `Add ${name || 'this conversation'} to Favorites`;
  return (
    <button
      type="button"
      className={`pf-star${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label={label}
      title={on ? 'Remove from Favorites' : 'Add to Favorites'}
      onClick={(e) => {
        e.stopPropagation();
        toggleFavorite(conv).catch((err) => onError?.(err?.message || "Couldn't update Favorites"));
      }}
    >
      <StarIcon filled={on} />
    </button>
  );
}

export function StarIcon({ filled, size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" />
    </svg>
  );
}
