// Settings → Assistant: the API key (this browser only, optionally passphrase-locked), Test key,
// model / effort / translation language, the session token counter and the privacy notice.
import { useState } from 'react';
import { PasswordInput } from '../../../components/auth/AuthScreen.jsx';
import { EFFORTS, LANGUAGES, MODELS, modelLabel } from '../lib/config.js';
import { MIN_PASSPHRASE, checkApiKey } from '../lib/keyStore.js';
import { describeError } from '../lib/errors.js';
import { testKey } from '../lib/client.js';
import { currentKey, keyState, addUsage } from '../lib/session.js';
import { forget, lockNow, resetUsage, saveApiKey, setPrefs } from '../lib/actions.js';
import { KeyGate, fmtNum, useAssistant } from './common.jsx';
import '../assistant.css';

export default function AssistantSettings({ ctx }) {
  const s = useAssistant(ctx.me?.uid || ctx.user?.uid);
  if (!s) return <div className="settings-loading sm"><div className="spinner" /></div>;
  return <SettingsBody s={s} />;
}

function SettingsBody({ s }) {
  const state = keyState(s);
  const [input, setInput] = useState('');
  const [useLock, setUseLock] = useState(false);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [confirmForget, setConfirmForget] = useState(false);

  const run = async (kind, fn) => {
    setBusy(kind);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: e?.message || 'Something went wrong.' });
    } finally {
      setBusy('');
    }
  };

  const onSave = (e) => {
    e.preventDefault();
    run('save', async () => {
      const bad = checkApiKey(input);
      if (bad) throw new Error(bad);
      if (useLock) {
        if (pass.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
        if (pass !== pass2) throw new Error('The passphrases don’t match.');
      }
      await saveApiKey(input, useLock ? pass : '');
      setInput('');
      setPass('');
      setPass2('');
      setMsg({ ok: true, text: useLock ? 'Key saved in this browser, locked with your passphrase.' : 'Key saved in this browser.' });
    });
  };

  const onTest = () => run('test', async () => {
    const typed = input.trim();
    const key = typed || currentKey();
    if (!key) throw new Error(state === 'locked' ? 'Unlock the saved key first, or paste a key to test.' : 'Paste a key first.');
    if (typed) {
      const bad = checkApiKey(typed);
      if (bad) throw new Error(bad);
    }
    try {
      const res = await testKey({ apiKey: key, model: s.prefs.model });
      if (res.usage) addUsage(res.usage);
      setMsg({ ok: true, text: `The key works: ${modelLabel(res.model || s.prefs.model)} answered.` });
    } catch (err) {
      throw new Error(describeError(err, err?.sdk || {}).message);
    }
  });

  return (
    <div className="settings-section asst-settings">
      <div className="settings-card">
        <h3>Privacy</h3>
        <p>
          The assistant talks to Claude with <strong>your own Anthropic API key</strong>, straight from this browser to
          api.anthropic.com. Whatever you choose to send to it — your questions, and for Catch me up, Translate, Explain
          code, Summarize thread, writing help or “Include last messages”, the decrypted text of those messages, including
          direct messages — goes to Anthropic under your key and your Anthropic account’s terms. Nothing is sent unless you
          use an assistant action. Your key is never stored in Codehub’s database: it stays in this browser’s local storage.
        </p>
      </div>

      <div className="settings-card">
        <h3>Anthropic API key</h3>
        <p className="settings-note">
          Create a key in the <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">Claude Console</a>.
          Usage is billed to your Anthropic account.
        </p>
        <div className={`asst-keystate ${state}`} role="status">
          <span className="asst-dot" aria-hidden="true" />
          {state === 'none' && <span>No key saved in this browser</span>}
          {state === 'ready' && <span>Key saved{s.record?.hint ? <> (<code>{s.record.hint}</code>)</> : null}{s.record?.mode === 'locked' ? ', unlocked for this session' : ''}</span>}
          {state === 'locked' && <span>Key saved{s.record?.hint ? <> (<code>{s.record.hint}</code>)</> : null}, locked with a passphrase</span>}
        </div>
        {state === 'locked' && <KeyGate session={s} compact />}

        <form className="asst-keyform" onSubmit={onSave}>
          <label className="field">
            {state === 'none' ? 'API key' : 'Replace key'}
            <PasswordInput value={input} onChange={setInput} autoComplete="off" placeholder="sk-ant-…" />
          </label>
          <label className="asst-check">
            <input type="checkbox" checked={useLock} onChange={(e) => setUseLock(e.target.checked)} />
            <span>Lock the key with a passphrase (asked once per session)</span>
          </label>
          {useLock && (
            <div className="asst-grid2">
              <label className="field">
                Passphrase
                <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
              </label>
              <label className="field">
                Confirm passphrase
                <input className="input" type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
              </label>
            </div>
          )}
          <div className="settings-actions">
            {msg && <span className={msg.ok ? 'settings-ok' : 'error-text'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</span>}
            <button type="button" className="btn" onClick={onTest} disabled={!!busy || (!input.trim() && state === 'none')}>
              {busy === 'test' ? 'Testing…' : 'Test key'}
            </button>
            <button type="submit" className="btn primary" disabled={!!busy || !input.trim()}>
              {busy === 'save' ? 'Saving…' : 'Save key'}
            </button>
          </div>
        </form>
        {state !== 'none' && (
          <div className="settings-actions">
            {s.record?.mode === 'locked' && state === 'ready' && (
              <button type="button" className="btn sm" onClick={() => { lockNow(); setMsg({ ok: true, text: 'Key locked.' }); }}>Lock now</button>
            )}
            {confirmForget ? (
              <>
                <span>Remove the key from this browser?</span>
                <button type="button" className="btn sm" onClick={() => setConfirmForget(false)}>Cancel</button>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => { forget(); setConfirmForget(false); setMsg({ ok: true, text: 'Key removed from this browser.' }); }}
                >
                  Forget key
                </button>
              </>
            ) : (
              <button type="button" className="btn sm danger" onClick={() => setConfirmForget(true)}>Forget key</button>
            )}
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3>Model</h3>
        <div className="asst-grid2">
          <label className="field">
            Model
            <select className="input" value={s.prefs.model} onChange={(e) => setPrefs({ model: e.target.value })}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>)}
            </select>
          </label>
          <label className="field">
            Effort
            <select className="input" value={s.prefs.effort} onChange={(e) => setPrefs({ effort: e.target.value })}>
              {EFFORTS.map((x) => <option key={x.id} value={x.id}>{x.label} — {x.hint}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          Translate messages to
          <select className="input" value={s.prefs.lang} onChange={(e) => setPrefs({ lang: e.target.value })}>
            {LANGUAGES.map(([code, name]) => <option key={code} value={name}>{name}</option>)}
          </select>
        </label>
        <p className="settings-note">
          Opus and Sonnet requests opt into Anthropic’s server-side fallback: if a request is declined by a safety
          classifier, another Claude model may answer it, and the reply says so.
        </p>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <h3>This session</h3>
          <button type="button" className="btn sm ghost" onClick={resetUsage} disabled={!s.usage.requests}>Reset</button>
        </div>
        <dl className="asst-usage" aria-label="Token usage this session">
          <div><dt>Requests</dt><dd>{fmtNum(s.usage.requests)}</dd></div>
          <div><dt>Input tokens</dt><dd>{fmtNum(s.usage.input)}</dd></div>
          <div><dt>Output tokens</dt><dd>{fmtNum(s.usage.output)}</dd></div>
          {(s.usage.cacheRead > 0 || s.usage.cacheWrite > 0) && <div><dt>Cache read / write</dt><dd>{fmtNum(s.usage.cacheRead)} / {fmtNum(s.usage.cacheWrite)}</dd></div>}
        </dl>
        <p className="settings-note">Counted from each reply’s usage in this tab; cleared on reload. Shortcut: Ctrl/⌘ + Shift + Y opens or closes the assistant panel.</p>
      </div>
    </div>
  );
}
