import { useEffect, useRef, useState } from 'react';
import { block, unblock, useBlocks } from '../../lib/blocks.js';
import { Icon, useToast } from '../layout/ui.jsx';
import './safety.css';

/**
 * Block / Unblock toggle (F11).
 * Props:
 *  - me: uid or { uid } (required)
 *  - uid: the other user (required)
 *  - name: their display name (for labels/toasts)
 *  - variant: 'button' (default, .btn sm) | 'menu' (row inside a layout <Menu>) | 'icon' (round icon button)
 *  - onDone(blocked: boolean): called after a successful change (e.g. close the DM, close the card)
 *
 * Blocking is two-step (first click arms, second confirms) because it also removes the friendship.
 * In the 'menu' variant the arming click stops propagation so the surrounding Menu stays open.
 */
export default function BlockButton({ me, uid, name, variant = 'button', onDone, className = '' }) {
  const myUid = typeof me === 'string' ? me : me?.uid;
  const blocked = useBlocks(myUid).has(uid);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => alive.current && setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!myUid || !uid || uid === myUid) return null;
  const who = name || 'this user';

  const run = async (e) => {
    if (busy) return;
    if (!blocked && !armed) {
      e.stopPropagation();
      e.preventDefault();
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      if (blocked) {
        await unblock(myUid, uid);
        toast(`Unblocked ${who}`, 'success');
      } else {
        await block(myUid, uid);
        toast(`Blocked ${who}`, 'success');
      }
      onDone?.(!blocked);
    } catch (err) {
      toast(err?.message || 'Could not update block', 'error');
    } finally {
      if (alive.current) {
        setBusy(false);
        setArmed(false);
      }
    }
  };

  const label = blocked ? 'Unblock' : armed ? `Block ${who}? Click again` : 'Block';
  const title = blocked
    ? `Unblock ${who}`
    : `Block ${who}: they can't DM you, react in your DMs, friend you or add you to groups. Removes your friendship.`;

  if (variant === 'menu') {
    return (
      <button type="button" role="menuitem" className={`ly-menu-item sf-block-item ${blocked ? '' : 'danger'} ${armed ? 'sf-armed' : ''} ${className}`}
        onClick={run} disabled={busy} title={title}>
        <span>{busy ? 'Working…' : label}</span>
        <Icon name={blocked ? 'check' : 'ban'} size={16} />
      </button>
    );
  }
  if (variant === 'icon') {
    return (
      <button type="button" className={`sf-icon-btn ${blocked ? '' : 'danger'} ${armed ? 'sf-armed' : ''} ${className}`}
        onClick={run} disabled={busy} title={armed ? label : title} aria-label={blocked ? `Unblock ${who}` : `Block ${who}`}>
        {armed ? <span className="sf-icon-btn-confirm">Block?</span> : <Icon name={blocked ? 'check' : 'ban'} size={17} />}
      </button>
    );
  }
  return (
    <button type="button" className={`btn sm ${blocked ? '' : 'danger'} sf-block-btn ${armed ? 'sf-armed' : ''} ${className}`}
      onClick={run} disabled={busy} title={title}>
      {busy ? <span className="spinner sf-spinner-sm" /> : <Icon name={blocked ? 'check' : 'ban'} size={14} />}
      {label}
    </button>
  );
}
