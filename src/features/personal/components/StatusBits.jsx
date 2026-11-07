// Small read-only status pieces used in lists: custom status text, the mention-popover status, and the
// profile card section. Everything shown comes from other users' public records, so it is validated
// (readCustomStatus) and rendered as React text only.
import { usePresence } from '../../../lib/presence.js';
import { MODE_LABEL, describeUntil } from '../lib/statusCore.js';
import { useCustomStatus } from '../lib/status.js';
import { openPersonalDialog } from '../lib/uiBus.js';

/** A colored presence dot (online / idle / dnd / offline / invisible) with a text alternative. */
export function StatusDot({ state, label = true }) {
  const s = MODE_LABEL[state] ? state : 'offline';
  return (
    <span className={`pf-dot ${s}`} role={label ? 'img' : undefined} aria-label={label ? MODE_LABEL[s] : undefined} aria-hidden={label ? undefined : true} />
  );
}

/** "💻 Coding" (custom status) or the fallback text (legacy profile status), for list rows. */
export function CustomStatusText({ uid, fallback, className = 'ly-dm-status' }) {
  const cs = useCustomStatus(uid);
  if (cs) {
    return (
      <span className={`${className} pf-cstatus`} title={cs.text || undefined}>
        {cs.emoji && <span className="pf-cstatus-emoji" aria-hidden={cs.text ? true : undefined}>{cs.emoji}</span>}
        {cs.text && <span className="pf-cstatus-text">{cs.text}</span>}
      </span>
    );
  }
  return fallback ? <span className={className}>{fallback}</span> : null;
}

/** Presence + custom status for a member in the composer's @mention list. */
export function MentionStatus({ uid }) {
  const presence = usePresence(uid);
  const cs = useCustomStatus(uid);
  return (
    <span className="pf-mention-status">
      <StatusDot state={presence} />
      {presence === 'dnd' && <span className="pf-mention-dnd">Do not disturb</span>}
      {cs && (
        <span className="pf-mention-cs" title={cs.text || undefined}>
          {cs.emoji}
          {cs.emoji && cs.text ? ' ' : ''}
          {cs.text}
        </span>
      )}
    </span>
  );
}

/** Profile card: the custom status, and for me a button to change it. */
export function ProfileStatusSection({ uid, isMe }) {
  const cs = useCustomStatus(uid);
  if (!cs && !isMe) return null;
  return (
    <div className="pf-profile-status">
      {cs ? (
        <p className="pf-profile-cs">
          {cs.emoji && <span className="pf-cstatus-emoji" aria-hidden={cs.text ? true : undefined}>{cs.emoji}</span>}
          {cs.text && <span>{cs.text}</span>}
          {isMe && cs.until > 0 && <span className="pf-muted-sm"> · {describeUntil(cs.until)}</span>}
        </p>
      ) : null}
      {isMe && (
        <button type="button" className="btn ghost sm" onClick={() => openPersonalDialog('status')}>
          {cs ? 'Edit custom status' : 'Set a custom status'}
        </button>
      )}
    </div>
  );
}
