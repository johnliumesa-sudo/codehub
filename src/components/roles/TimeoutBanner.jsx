// Replaces the composer while I'm timed out in a server. Renders nothing when I'm not.
import { useEffect, useState } from 'react';
import { fmtDuration, fmtUntil, serverNow, useMyTimeout } from '../../lib/moderation.js';
import { ClockIcon } from './RoleBadge.jsx';
import './roles.css';

function Countdown({ until }) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const left = until - serverNow();
    const step = left > 3_600_000 ? 60_000 : 1000;
    const t = setInterval(() => setNow(serverNow()), step);
    return () => clearInterval(t);
  }, [until]);
  return <span className="rl-countdown">{fmtDuration(Math.max(0, until - now))} left</span>;
}

/**
 * Props: either `until` (untilMs, e.g. from useMyTimeout in the parent) or `sid` + `uid` and the
 * banner subscribes itself.
 */
export default function TimeoutBanner({ until: untilProp, sid, uid }) {
  const own = useMyTimeout(untilProp === undefined ? sid : null, uid);
  const until = untilProp === undefined ? own : untilProp;
  if (!until || until <= serverNow()) return null;
  return (
    <div className="rl-timeout-banner" role="status">
      <ClockIcon size={18} />
      <div className="rl-timeout-text">
        <strong>You're timed out until {fmtUntil(until)}</strong>
        <span className="muted">You can read along, but can't send messages, react or type in this server until then.</span>
      </div>
      <Countdown until={until} />
    </div>
  );
}
