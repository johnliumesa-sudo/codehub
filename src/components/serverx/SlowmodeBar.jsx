// Composer-adjacent slowmode notice with a live countdown. Render above/inside the composer.
import { formatSeconds } from '../../lib/serverx/slowmode.js';
import './serverx.css';

/** Props: { slow } where slow = useSlowmode(...). Renders nothing when slowmode is off. */
export function SlowmodeBar({ slow }) {
  if (!slow || !(slow.seconds > 0)) return null;
  return (
    <div className={`sx-slowbar${slow.blocked ? ' blocked' : ''}`} role="status" aria-live="polite">
      {slow.blocked
        ? `Slowmode: you can post again in ${formatSeconds(slow.remaining / 1000)}`
        : `Slowmode is on (${formatSeconds(slow.seconds)} between messages)`}
    </div>
  );
}
