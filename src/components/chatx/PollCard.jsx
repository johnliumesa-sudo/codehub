// Renders a poll inside a message and handles voting. Props: conv, mid, poll (decrypted body.poll), me ({uid}).
import { useEffect, useMemo, useState } from 'react';
import { castVote, sanitizePoll, subscribeVotes, tally } from '../../lib/chatx/polls.js';
import './chatx.css';

export default function PollCard({ conv, mid, poll: rawPoll, me }) {
  const poll = useMemo(() => sanitizePoll(rawPoll), [rawPoll]);
  const [votes, setVotes] = useState({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!poll) return undefined;
    return subscribeVotes(conv, mid, setVotes);
  }, [conv?.scope, conv?.sid, conv?.cid, conv?.dmId, conv?.gid, mid, !!poll]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!poll) return null;
  const { counts, total, mine } = tally(votes, poll.options.length, me?.uid);

  async function vote(i) {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await castVote(conv, mid, me.uid, mine === i ? null : i);
    } catch {
      setErr('Could not record your vote.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cx-poll" role="group" aria-label={`Poll: ${poll.q}`}>
      <div className="cx-poll-q">{poll.q}</div>
      {poll.options.map((o, i) => {
        const pct = total ? Math.round((counts[i] / total) * 100) : 0;
        return (
          <button
            key={i}
            type="button"
            className={`cx-poll-opt ${mine === i ? 'mine' : ''}`}
            onClick={() => vote(i)}
            aria-pressed={mine === i}
            disabled={busy}
          >
            <span className="cx-poll-bar" style={{ width: `${pct}%` }} />
            <span className="cx-poll-label">{o}</span>
            <span className="cx-poll-pct">{counts[i]} · {pct}%</span>
          </button>
        );
      })}
      <div className="cx-poll-foot">
        {total} vote{total === 1 ? '' : 's'}
        {mine !== null && ' · click your choice again to retract'}
      </div>
      {err && <div className="cx-err" role="alert">{err}</div>}
    </div>
  );
}
