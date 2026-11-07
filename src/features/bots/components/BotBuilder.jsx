// Create or edit a bot: name, icon (glyph or small image), description, slash commands, keyword
// triggers and a welcome message, with a live preview of any response template.
import { useId, useMemo, useState } from 'react';
import { renderMarkdown } from '../../../lib/markdown.js';
import { processImage } from '../../../lib/media/image.js';
import {
  BOT_LIMITS, DEF_VERSION, DEFAULT_GLYPH, IMG_TYPES, emptyDef, newTriggerId, serializeBotDef, validateBotDef,
} from '../lib/schema.js';
import { PLACEHOLDERS, escapeMentions, renderTemplate } from '../lib/template.js';
import { RESERVED_NAMES } from '../lib/builtins.js';
import { publishBot, saveBotVersion } from '../lib/store.js';
import BotAvatar from './BotAvatar.jsx';

const L = BOT_LIMITS;
let rowSeq = 0;
const rowKey = () => `r${++rowSeq}`;

function fromDef(def) {
  const d = def || emptyDef();
  return {
    name: d.name || '',
    glyph: d.glyph || '',
    desc: d.desc || '',
    welcome: d.welcome || '',
    commands: (d.commands || []).map((c) => ({ key: rowKey(), name: c.name, usage: c.usage || '', desc: c.desc || '', response: c.response })),
    triggers: (d.triggers || []).map((t) => ({ key: rowKey(), id: t.id, match: t.match, response: t.response, cooldown: String(t.cooldown) })),
  };
}

function toDef(form) {
  return {
    v: DEF_VERSION,
    name: form.name,
    glyph: form.glyph.trim() || DEFAULT_GLYPH,
    desc: form.desc,
    commands: form.commands.map((c) => ({ name: c.name.trim().replace(/^\//, '').toLowerCase(), usage: c.usage, desc: c.desc, response: c.response })),
    triggers: form.triggers.map((t) => ({ id: t.id, match: t.match, response: t.response, cooldown: Number(t.cooldown) })),
    welcome: form.welcome,
  };
}

/**
 * entry: the directory entry being edited (null = new bot). me: { uid, name }.
 * onDone(id) after saving; onCancel().
 */
export default function BotBuilder({ entry, me, onDone, onCancel }) {
  const uid = useId();
  const [form, setForm] = useState(() => fromDef(entry?.def));
  const [image, setImage] = useState(entry?.image || null);
  const [imgBusy, setImgBusy] = useState(false);
  const [imgErr, setImgErr] = useState('');
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [previewSrc, setPreviewSrc] = useState('');
  const [previewArgs, setPreviewArgs] = useState('');

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setRow = (list, i, patch) => setForm((f) => ({ ...f, [list]: f[list].map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const removeRow = (list, i) => setForm((f) => ({ ...f, [list]: f[list].filter((_, j) => j !== i) }));

  const def = useMemo(() => toDef(form), [form]);
  const size = useMemo(() => serializeBotDef(def).length, [def]);

  // Preview sources: every command, trigger and the welcome message.
  const sources = useMemo(() => [
    ...form.commands.map((c, i) => ({ id: `c${i}`, label: `/${c.name || `command ${i + 1}`}`, template: c.response, args: true })),
    ...form.triggers.map((t, i) => ({ id: `t${i}`, label: `Trigger “${t.match || i + 1}”`, template: t.response })),
    ...(form.welcome.trim() ? [{ id: 'w', label: 'Welcome message', template: form.welcome, welcome: true }] : []),
  ], [form]);
  const src = sources.find((s) => s.id === previewSrc) || sources[0] || null;
  const previewHtml = useMemo(() => {
    if (!src?.template?.trim()) return '';
    const out = renderTemplate(src.template, {
      user: me?.name || 'You',
      channel: 'general',
      server: 'My server',
      args: src.args ? previewArgs : '',
      count: 1,
    });
    const text = src.welcome ? escapeMentions(out) : out; // as welcomeDraft posts it: no mentions
    return renderMarkdown(text, { selfName: me?.name || '' });
  }, [src, previewArgs, me?.name]);

  async function onPickImage(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImgErr('');
    setImgBusy(true);
    try {
      const out = await processImage(file, { maxDim: L.imgDim, maxBytes: L.imgBytes, allowAnimated: false });
      if (!IMG_TYPES.includes(out.mime) || out.base64.length > L.imgChars) throw new Error('Could not compress that image small enough');
      setImage({ img: out.base64, imgType: out.mime });
    } catch (err) {
      setImgErr(err?.message || 'Could not use that image');
    } finally {
      setImgBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    if (busy) return;
    const res = validateBotDef(def, { reserved: RESERVED_NAMES });
    if (!res.ok) {
      setErrors(res.errors);
      requestAnimationFrame(() => document.getElementById(`${uid}-errors`)?.focus());
      return;
    }
    setErrors([]);
    setBusy(true);
    try {
      const id = entry ? (await saveBotVersion(entry.id, entry.ver, res.def, image), entry.id) : await publishBot(res.def, image);
      onDone(id);
    } catch (err) {
      setErrors([err?.message || 'Could not save the bot.']);
      setBusy(false);
    }
  }

  const f = (name) => `${uid}-${name}`;

  return (
    <form className="bt-builder" onSubmit={save} aria-label={entry ? `Edit ${entry.def.name}` : 'Create a bot'}>
      <div className="bt-builder-head">
        <h3>{entry ? `Edit ${entry.def.name}` : 'Create a bot'}</h3>
        <p className="muted">
          Bots answer with text you write — no code. They run in members&apos; browsers: a bot message is sent by the
          member who used it, and nothing happens while nobody is online. Bots are public: anyone can read this
          definition in the directory.
        </p>
      </div>

      <section className="bt-card" aria-labelledby={f('id-h')}>
        <h4 id={f('id-h')}>Identity</h4>
        <div className="bt-identity">
          <BotAvatar glyph={form.glyph.trim() || DEFAULT_GLYPH} image={image} size={56} />
          <div className="bt-grid">
            <label className="bt-field">
              <span>Name</span>
              <input className="input" value={form.name} maxLength={L.name} aria-required="true" onChange={(e) => set({ name: e.target.value })} placeholder="Helper" />
            </label>
            <label className="bt-field bt-field-sm">
              <span>Icon (emoji)</span>
              <input className="input" value={form.glyph} maxLength={L.glyph} onChange={(e) => set({ glyph: e.target.value })} placeholder={DEFAULT_GLYPH} />
            </label>
          </div>
        </div>
        <div className="bt-row">
          <label className="btn sm bt-file">
            {imgBusy ? 'Processing…' : image ? 'Change image' : 'Upload image'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onPickImage} disabled={imgBusy} />
          </label>
          {image && <button type="button" className="btn ghost sm" onClick={() => setImage(null)}>Remove image</button>}
          <span className="muted bt-small">Optional. Resized to {L.imgDim} px; replaces the emoji.</span>
        </div>
        {imgErr && <p className="error-text" role="alert">{imgErr}</p>}
        <label className="bt-field">
          <span>Description</span>
          <textarea className="input" rows={2} value={form.desc} maxLength={L.desc} onChange={(e) => set({ desc: e.target.value })} placeholder="What does this bot do?" />
        </label>
      </section>

      <section className="bt-card" aria-labelledby={f('cmd-h')}>
        <div className="bt-card-head">
          <h4 id={f('cmd-h')}>Slash commands <span className="muted">({form.commands.length}/{L.commands})</span></h4>
          <button
            type="button"
            className="btn sm"
            disabled={form.commands.length >= L.commands}
            onClick={() => set({ commands: [...form.commands, { key: rowKey(), name: '', usage: '', desc: '', response: '' }] })}
          >
            Add command
          </button>
        </div>
        {form.commands.length === 0 && <p className="muted bt-small">Commands run when a member types <code>/name</code> in a server that installed the bot.</p>}
        {form.commands.map((c, i) => (
          <fieldset key={c.key} className="bt-item">
            <legend>Command {i + 1}</legend>
            <div className="bt-grid">
              <label className="bt-field">
                <span>Name</span>
                <span className="bt-prefix">
                  <span aria-hidden="true">/</span>
                  <input className="input" value={c.name} maxLength={L.cmdName} onChange={(e) => setRow('commands', i, { name: e.target.value.toLowerCase().replace(/\s+/g, '') })} placeholder="hello" aria-label={`Command ${i + 1} name`} />
                </span>
              </label>
              <label className="bt-field">
                <span>Arguments hint</span>
                <input className="input" value={c.usage} maxLength={L.usage} onChange={(e) => setRow('commands', i, { usage: e.target.value })} placeholder="<name>" aria-label={`Command ${i + 1} arguments hint`} />
              </label>
            </div>
            <label className="bt-field">
              <span>Description</span>
              <input className="input" value={c.desc} maxLength={L.cmdDesc} onChange={(e) => setRow('commands', i, { desc: e.target.value })} placeholder="Say hello" aria-label={`Command ${i + 1} description`} />
            </label>
            <label className="bt-field">
              <span>Response</span>
              <textarea className="input bt-mono" rows={3} value={c.response} maxLength={L.response} onChange={(e) => setRow('commands', i, { response: e.target.value })} placeholder="Hello {mention}! You said: {args}" aria-label={`Command ${i + 1} response`} />
            </label>
            <button type="button" className="btn ghost sm bt-remove" onClick={() => removeRow('commands', i)} aria-label={`Remove command ${i + 1}`}>Remove</button>
          </fieldset>
        ))}
      </section>

      <section className="bt-card" aria-labelledby={f('trg-h')}>
        <div className="bt-card-head">
          <h4 id={f('trg-h')}>Keyword triggers <span className="muted">({form.triggers.length}/{L.triggers})</span></h4>
          <button
            type="button"
            className="btn sm"
            disabled={form.triggers.length >= L.triggers}
            onClick={() => set({ triggers: [...form.triggers, { key: rowKey(), id: newTriggerId(), match: '', response: '', cooldown: '60' }] })}
          >
            Add trigger
          </button>
        </div>
        <p className="muted bt-small">
          When a member&apos;s message contains the word or phrase (whole words, any case), their browser posts the reply right
          after it. One reply per message; bot messages never trigger bots.
        </p>
        {form.triggers.map((t, i) => (
          <fieldset key={t.key} className="bt-item">
            <legend>Trigger {i + 1}</legend>
            <div className="bt-grid">
              <label className="bt-field">
                <span>Word or phrase</span>
                <input className="input" value={t.match} maxLength={L.match} onChange={(e) => setRow('triggers', i, { match: e.target.value })} placeholder="good morning" aria-label={`Trigger ${i + 1} word or phrase`} />
              </label>
              <label className="bt-field bt-field-sm">
                <span>Cooldown (seconds)</span>
                <input className="input" type="number" min={L.cooldownMin} max={L.cooldownMax} step={1} value={t.cooldown} onChange={(e) => setRow('triggers', i, { cooldown: e.target.value })} aria-label={`Trigger ${i + 1} cooldown in seconds`} />
              </label>
            </div>
            <label className="bt-field">
              <span>Response</span>
              <textarea className="input bt-mono" rows={2} value={t.response} maxLength={L.response} onChange={(e) => setRow('triggers', i, { response: e.target.value })} placeholder="Good morning, {user}!" aria-label={`Trigger ${i + 1} response`} />
            </label>
            <button type="button" className="btn ghost sm bt-remove" onClick={() => removeRow('triggers', i)} aria-label={`Remove trigger ${i + 1}`}>Remove</button>
          </fieldset>
        ))}
      </section>

      <section className="bt-card" aria-labelledby={f('wel-h')}>
        <h4 id={f('wel-h')}>Welcome message</h4>
        <label className="bt-field">
          <span>Posted automatically once for each new member, from their own account, in the server&apos;s first text channel. It never mentions or notifies anyone, and readers see it marked as an automatic bot welcome (optional)</span>
          <textarea className="input bt-mono" rows={2} value={form.welcome} maxLength={L.welcome} onChange={(e) => set({ welcome: e.target.value })} placeholder="Welcome to {server}, {mention}!" />
        </label>
      </section>

      <section className="bt-card" aria-labelledby={f('pv-h')}>
        <h4 id={f('pv-h')}>Preview</h4>
        {sources.length === 0 ? (
          <p className="muted bt-small">Add a command, trigger or welcome message to preview it.</p>
        ) : (
          <>
            <div className="bt-grid">
              <label className="bt-field">
                <span>Show</span>
                <select className="input" value={src?.id || ''} onChange={(e) => setPreviewSrc(e.target.value)}>
                  {sources.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
              </label>
              {src?.args && (
                <label className="bt-field">
                  <span>Typed after the command</span>
                  <input className="input" value={previewArgs} onChange={(e) => setPreviewArgs(e.target.value)} placeholder="world" />
                </label>
              )}
            </div>
            <div className="bt-preview" aria-live="polite" aria-label="Preview">
              <BotAvatar glyph={form.glyph.trim() || DEFAULT_GLYPH} image={image} size={32} />
              <div className="bt-preview-body">
                <div className="bt-preview-meta"><strong>{form.name.trim() || 'Your bot'}</strong> <span className="bt-badge-tag">BOT</span> <span className="muted">via @{me?.name || 'you'}</span></div>
                {previewHtml
                  // Sanitized by DOMPurify in renderMarkdown().
                  ? <div className="md bt-preview-text" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  : <p className="muted bt-small">Nothing to show yet.</p>}
              </div>
            </div>
          </>
        )}
        <details className="bt-help">
          <summary>Template placeholders</summary>
          <dl>
            {PLACEHOLDERS.map(([k, v]) => (
              <div key={k}><dt><code>{k}</code></dt><dd>{v}</dd></div>
            ))}
          </dl>
          <p className="muted bt-small">Text members type (names, arguments) is shown literally: their Markdown and @mentions are escaped. Unknown placeholders stay as written.</p>
        </details>
      </section>

      {errors.length > 0 && (
        <div id={`${uid}-errors`} className="bt-errors" role="alert" tabIndex={-1}>
          <strong>Please fix:</strong>
          <ul>{errors.map((er, i) => <li key={i}>{er}</li>)}</ul>
        </div>
      )}

      <div className="bt-actions">
        <span className={`bt-size${size > L.defChars ? ' over' : ''}`}>Definition: {size.toLocaleString()} / {L.defChars.toLocaleString()} characters</span>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : entry ? 'Save new version' : 'Publish bot'}</button>
      </div>
    </form>
  );
}
