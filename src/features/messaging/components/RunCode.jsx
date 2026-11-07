// Run code snippets (messageExtras): a "Run" button under messages with JavaScript, HTML or HTML + CSS
// code (fenced blocks or a shared snippet). Nothing runs until the reader clicks. The code runs in the
// app's sandbox (SandboxFrame profile="play": opaque origin, no network except the public code CDNs,
// working localStorage and non-blocking alert/confirm/prompt) with the console bridge; output is shown
// as text with Stop / Clear / Run again. JavaScript runs in a worker inside the frame and is stopped
// after 5 s; an HTML page is torn down when it is busy for 5 s.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SandboxFrame from '../../../components/sandbox/SandboxFrame.jsx';
import { MAX_CONSOLE_LINES } from '../../../lib/sandbox.js';
import { RUN_LIMIT_MS, buildHtmlDocument, buildJsDocument, extractRunnables, readConsole } from '../lib/runnable.js';

const STATUS = {
  running: 'Running…',
  done: 'Finished',
  stopped: 'Stopped',
  timeout: `Stopped: still running after ${RUN_LIMIT_MS / 1000} s`,
  busy: `Stopped: the page was busy for ${RUN_LIMIT_MS / 1000} s`,
  live: 'Running',
};

function RunPanel({ unit, onClose }) {
  const [run, setRun] = useState(1); // bump to restart
  const [status, setStatus] = useState('running');
  const [lines, setLines] = useState([]);
  const [alive, setAlive] = useState(true); // the frame is mounted
  const lastBeat = useRef(Date.now());
  const finished = useRef(false);
  const logRef = useRef(null);

  const html = useMemo(
    () => (unit.kind === 'js' ? buildJsDocument(unit.code) : buildHtmlDocument(unit)),
    [unit, run], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const teardown = useCallback((st) => {
    finished.current = true;
    setAlive(false);
    setStatus(st);
  }, []);

  // Watchdog: JS must report its end within the limit (+ grace); HTML must keep sending heartbeats.
  useEffect(() => {
    if (!alive) return undefined;
    finished.current = false;
    lastBeat.current = Date.now();
    const started = Date.now();
    const t = setInterval(() => {
      if (finished.current) return;
      const now = Date.now();
      if (unit.kind === 'js' && now - started > RUN_LIMIT_MS + 1500) teardown('timeout');
      if (unit.kind === 'html' && now - lastBeat.current > RUN_LIMIT_MS) {
        finished.current = true;
        setAlive(false);
        setStatus('busy');
      }
    }, 250);
    return () => clearInterval(t);
  }, [alive, run, unit.kind, teardown]);

  const onConsole = useCallback((entry) => {
    const r = readConsole(entry);
    if (r.mark) {
      if (r.mark === 'hb') lastBeat.current = Date.now();
      // JS: "done" when the top-level code finished (async output may still follow until the limit),
      // then "end" (finished in time) or "timeout" (still busy: the worker was terminated).
      else if (unit.kind === 'js' && r.mark === 'done') setStatus('done');
      else if (unit.kind === 'js' && r.mark === 'end') teardown('done');
      else if (unit.kind === 'js' && r.mark === 'timeout') teardown('timeout');
      return;
    }
    if (r.line.level === 'clear') {
      setLines([]);
      return;
    }
    setLines((l) => (l.length >= MAX_CONSOLE_LINES ? l : [...l, r.line]));
  }, [unit.kind, teardown]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    if (unit.kind === 'html' && status === 'running') {
      const t = setTimeout(() => !finished.current && setStatus('live'), 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [unit.kind, status, run]);

  const again = () => {
    setLines([]);
    setStatus('running');
    setAlive(true);
    setRun((x) => x + 1);
  };
  const stop = () => {
    finished.current = true;
    setAlive(false);
    setStatus('stopped');
  };

  const running = alive;
  return (
    <div className="mx-run" role="region" aria-label={`${unit.label} output`}>
      <div className="mx-run-head">
        <span className={`mx-run-status ${status}`} role="status">{STATUS[status] || status}</span>
        <span className="mx-run-spacer" />
        {running ? (
          <button type="button" className="btn ghost sm" onClick={stop}>Stop</button>
        ) : (
          <button type="button" className="btn ghost sm" onClick={again}>Run again</button>
        )}
        <button type="button" className="btn ghost sm" onClick={() => setLines([])} disabled={!lines.length}>Clear</button>
        <button type="button" className="btn ghost sm" onClick={onClose} aria-label={`Close ${unit.label} output`}>Close</button>
      </div>
      {alive && (
        <SandboxFrame
          key={run}
          html={html}
          profile="play"
          mode="preview"
          onConsole={onConsole}
          title={`${unit.label} snippet (sandboxed)`}
          className={unit.kind === 'html' ? 'mx-run-frame' : 'mx-run-frame hidden'}
        />
      )}
      <pre ref={logRef} className="mx-run-log" role="log" aria-live="polite" aria-label="Console output">
        {lines.length ? lines.map((l, i) => (
          <div key={i} className={`mx-run-line ${l.level}`}>{l.text}</div>
        )) : <div className="mx-run-empty">{unit.kind === 'js' ? 'No console output yet.' : 'Console output appears here.'}</div>}
      </pre>
    </div>
  );
}

function RunCode({ m }) {
  const units = useMemo(() => extractRunnables(m?.body), [m?.body]);
  const [open, setOpen] = useState(null); // unit id
  if (!units.length) return null;
  const unit = units.find((u) => u.id === open) || null;
  return (
    <div className="mx-runner">
      {!unit && (
        <div className="mx-run-bar">
          {units.map((u) => (
            <button key={u.id} type="button" className="mx-run-btn" onClick={() => setOpen(u.id)} title="Runs in an isolated sandbox without network access">
              <span aria-hidden="true">▶</span> Run {u.label}
            </button>
          ))}
        </div>
      )}
      {unit && <RunPanel key={unit.id} unit={unit} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function runCodeExtra(m) {
  if (!m?.body || m.deleted || m.error) return null;
  return extractRunnables(m.body).length ? <RunCode m={m} /> : null;
}
