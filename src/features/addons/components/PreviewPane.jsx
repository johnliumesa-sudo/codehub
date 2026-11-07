// Live preview of add-on code with a mock bridge: sample conversation data, in-memory storage, and
// a log of what the add-on asked for (nothing is inserted, sent or saved for real).
import { useMemo, useRef, useState } from 'react';
import { applyStorageOp, toAddonContext } from '../lib/bridge.js';
import { normalizePerms } from '../lib/manifest.js';
import AddonFrame from './AddonFrame.jsx';

// Sample conversation the mock bridge serves to getMessages() in previews.
const SAMPLE_AUTHORS = ['Ada', 'Linus', 'Grace', 'Margaret'];
const SAMPLE_LINES = [
  'Morning! Pushed the parser fix, CI is green again.',
  'Nice. Can someone review the websocket reconnect PR?',
  'On it. The backoff looks right but the jitter is missing.',
  'Good catch, adding jitter now.',
  'Standup in 10 minutes, bring your blockers.',
  'The flaky test was a timezone bug, fixed with UTC everywhere.',
  'Shipping the release candidate after lunch.',
  'Docs for the new config flags are up for review.',
  'Who broke the build? Just kidding, it was me. Reverting.',
  'Reminder: freeze starts Friday, merge your features before then.',
];

export function sampleMessages(n) {
  const now = Date.now();
  const all = SAMPLE_LINES.map((text, i) => ({
    id: `sample-${i + 1}`,
    author: SAMPLE_AUTHORS[i % SAMPLE_AUTHORS.length],
    text,
    ts: now - (SAMPLE_LINES.length - i) * 4 * 60_000,
  }));
  return all.slice(-Math.max(1, Math.min(100, n)));
}

/** Props: code, perms, meName, height? */
export default function PreviewPane({ code, perms, meName, title = 'Add-on preview', runKey = 0 }) {
  const [log, setLog] = useState([]);
  const [localRun, setLocalRun] = useState(0);
  const storage = useRef({});
  const add = (level, text) => setLog((l) => [...l.slice(-199), { id: `${Date.now()}-${Math.random()}`, level, text }]);
  const p = normalizePerms(perms);

  const handlers = useMemo(() => ({
    messages: (n) => sampleMessages(n),
    insertText: (text) => {
      add('bridge', `insertText → “${text}” (preview: not inserted)`);
      return true;
    },
    sendMessage: (text) => {
      add('bridge', `sendMessage → “${text}” (preview: not sent; real add-ons ask you first)`);
      return true;
    },
    storage: (op, key, value) => {
      const r = applyStorageOp(storage.current, op, key, value);
      storage.current = r.map;
      if (op === 'set' || op === 'remove') add('bridge', `storage.${op}(${JSON.stringify(key)}) (preview: kept in memory)`);
      return r.result;
    },
  }), []);

  const context = useMemo(() => toAddonContext({ kind: 'preview', name: 'Preview' }, { name: meName || 'You' }, 'preview'), [meName]);

  return (
    <div className="ad-preview">
      <div className="ad-preview-bar">
        <span className="ad-preview-label">Preview <span className="muted">· sample data, nothing is sent</span></span>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            storage.current = {};
            setLog([]);
            setLocalRun((k) => k + 1);
          }}
        >
          Restart
        </button>
      </div>
      <div className="ad-preview-frame">
        {code && code.trim() ? (
          <AddonFrame
            code={code}
            perms={p}
            handlers={handlers}
            context={context}
            title={title}
            preview
            runKey={runKey * 1000 + localRun}
            onConsole={(level, args) => add(level, args.join(' '))}
          />
        ) : (
          <p className="muted ad-empty-text">Write some code to see it here.</p>
        )}
      </div>
      <div className="ad-log" role="log" aria-label="Preview console" aria-live="polite">
        {log.length === 0 ? (
          <span className="muted">Console output and bridge calls show up here.</span>
        ) : (
          log.map((l) => (
            <div key={l.id} className={`ad-log-line ${l.level}`}>
              <span className="ad-log-level">{l.level}</span>
              <span>{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
