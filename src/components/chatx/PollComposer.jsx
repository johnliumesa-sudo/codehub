// Modal to create a poll. Props: onClose, onCreate(poll) -> Promise (caller sends the message with body.poll).
import { useState } from 'react';
import { Modal } from '../layout/ui.jsx';
import { buildPoll, MAX_POLL_OPTION, MAX_POLL_OPTIONS, MAX_POLL_Q } from '../../lib/chatx/polls.js';
import './chatx.css';

export default function PollComposer({ onClose, onCreate }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '']);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const setOpt = (i, v) => setOpts((o) => o.map((x, j) => (j === i ? v : x)));

  async function submit(e) {
    e?.preventDefault();
    const r = buildPoll(q, opts);
    if (r.error) return setErr(r.error);
    setBusy(true);
    try {
      await onCreate(r.poll);
      onClose();
    } catch (ex) {
      setErr(ex?.message || 'Could not create poll.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create poll"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" form="cx-poll-form" className="btn primary" disabled={busy}>Post poll</button>
        </>
      }
    >
      <form id="cx-poll-form" className="cx-form" onSubmit={submit}>
        <label className="cx-field">
          <span>Question</span>
          <input value={q} maxLength={MAX_POLL_Q} onChange={(e) => setQ(e.target.value)} placeholder="What should we ship first?" />
        </label>
        {opts.map((o, i) => (
          <div className="cx-opt-row" key={i}>
            <input
              value={o}
              maxLength={MAX_POLL_OPTION}
              onChange={(e) => setOpt(i, e.target.value)}
              placeholder={`Option ${i + 1}`}
              aria-label={`Option ${i + 1}`}
            />
            {opts.length > 2 && (
              <button type="button" className="btn ghost sm" onClick={() => setOpts(opts.filter((_, j) => j !== i))} aria-label={`Remove option ${i + 1}`}>
                Remove
              </button>
            )}
          </div>
        ))}
        {opts.length < MAX_POLL_OPTIONS && (
          <button type="button" className="btn ghost sm" onClick={() => setOpts([...opts, ''])}>Add option</button>
        )}
        <p className="cx-note">Votes are visible to the server as "member picked option N". Option text stays encrypted.</p>
        {err && <div className="cx-err" role="alert">{err}</div>}
      </form>
    </Modal>
  );
}
