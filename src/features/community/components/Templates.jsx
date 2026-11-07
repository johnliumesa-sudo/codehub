// Server templates: the "Start from a template" choice in "Add a server" (serverCreateOptions) and
// the "Template" server settings tab ("Save as template").
import { useMemo, useState } from 'react';
import { ColorPicker } from '../../../components/layout/modals.jsx';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { useChannels } from '../../../components/layout/hooks.js';
import { useCategories } from '../../../lib/serverx/categories.js';
import { MAX_SERVER_NAME, SERVER_COLORS } from '../../../lib/servers.js';
import { BUILTIN_TEMPLATES, TEMPLATE_LIMITS, summarize, templateFromServer } from '../lib/templates.js';
import { applyTemplate, deleteTemplate, saveTemplate, useMyTemplates, useWelcome } from '../lib/data.js';
import { errText } from './common.jsx';

const ICON = { text: '#', code: '</>', voice: '🔊' };

/** Read-only outline of a template: categories with their channels, roles, welcome. */
function TemplateOutline({ t }) {
  const groups = useMemo(() => {
    const byCat = new Map(t.categories.map((c) => [c.key, { name: c.name, list: [] }]));
    const loose = [];
    t.channels.forEach((c) => (c.cat && byCat.has(c.cat) ? byCat.get(c.cat).list : loose).push(c));
    return [...(loose.length ? [{ name: null, list: loose }] : []), ...byCat.values()].filter((g) => g.list.length);
  }, [t]);
  return (
    <div className="cm-outline">
      {groups.map((g, i) => (
        <div key={i} className="cm-outline-group">
          {g.name && <div className="cm-outline-cat">{g.name}</div>}
          <ul>
            {g.list.map((c, j) => (
              <li key={j}><span className="cm-outline-icon" aria-hidden="true">{ICON[c.type]}</span>{c.name}{c.topic && <span className="muted"> · {c.topic}</span>}</li>
            ))}
          </ul>
        </div>
      ))}
      {t.roles.length > 0 && (
        <div className="cm-outline-roles" aria-label="Roles">
          {t.roles.map((r, i) => <span key={i} className="cm-role-chip" style={{ '--role': r.color }}>{r.name}</span>)}
        </div>
      )}
      {t.welcome && (
        <p className="muted cm-hint">
          {t.welcome.require ? '📜 Members accept the rules before posting' : '👋 Welcome screen'}
          {t.welcome.rules.length ? ` with ${t.welcome.rules.length} rules` : ''}
        </p>
      )}
    </div>
  );
}

/** serverCreateOptions 'community.templates'. */
export function TemplatePicker({ ctx }) {
  const mine = useMyTemplates(ctx.me.uid);
  const all = useMemo(() => [
    ...BUILTIN_TEMPLATES.map((t) => ({ ...t, key: `b:${t.id}` })),
    ...mine.list.map((t) => ({ ...t, key: `u:${t.tid}`, saved: true })),
  ], [mine.list]);
  const [pick, setPick] = useState(null);
  const t = all.find((x) => x.key === pick) || null;
  const [name, setName] = useState('');
  const [color, setColor] = useState(null);
  const [error, setError] = useState('');

  const choose = (x) => {
    setPick(x.key);
    setName((x.serverName || x.name).slice(0, MAX_SERVER_NAME));
    setColor(SERVER_COLORS.includes(x.color) ? x.color : ctx.color);
    setError('');
  };
  const create = async (e) => {
    e.preventDefault();
    if (!t) return;
    setError('');
    await ctx.createWith({
      name: name.trim() || t.name,
      color: color || ctx.color,
      channels: t.channels.map(({ type, name: n, topic }) => ({ type, name: n, topic })),
      after: (res) => applyTemplate(t, res),
    });
  };
  const remove = async (x) => {
    try {
      await deleteTemplate(x.tid);
      if (pick === x.key) setPick(null);
    } catch (err) {
      setError(errText(err));
    }
  };

  if (!t) {
    return (
      <div className="cm-templates">
        <p className="muted ly-lead">Pick a starting point. Channels, categories, roles and a welcome screen are set up for you; change anything later.</p>
        <div className="cm-template-grid" role="list">
          {all.map((x) => (
            <div key={x.key} className="cm-template" role="listitem">
              <button type="button" className="cm-template-pick" onClick={() => choose(x)}>
                <span className="cm-template-icon" style={{ background: x.color || 'var(--accent)' }} aria-hidden="true">{x.icon || x.name.slice(0, 1).toUpperCase()}</span>
                <span className="cm-template-text">
                  <strong>{x.name}</strong>
                  <span className="muted">{x.desc || (x.saved ? 'Saved from one of your servers' : '')}</span>
                  <span className="cm-template-sum">{summarize(x)}</span>
                </span>
              </button>
              {x.saved && (
                <ConfirmButton className="btn ghost sm cm-danger" confirmLabel="Delete?" onConfirm={() => remove(x)}>
                  Delete
                </ConfirmButton>
              )}
            </div>
          ))}
        </div>
        {mine.loading && <p className="muted cm-hint">Loading your saved templates…</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="ly-form-actions">
          <button type="button" className="btn ghost" onClick={ctx.back}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <form className="ly-form cm-templates" onSubmit={create}>
      <div className="cm-template-head">
        <span className="cm-template-icon" style={{ background: color || t.color || 'var(--accent)' }} aria-hidden="true">{t.icon || t.name.slice(0, 1).toUpperCase()}</span>
        <div><strong>{t.name}</strong><div className="muted">{summarize(t)}</div></div>
      </div>
      <TemplateOutline t={t} />
      <label className="field">
        Server name
        <input className="input" value={name} maxLength={MAX_SERVER_NAME} onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      <div className="ly-field">
        Color
        <ColorPicker value={color} onChange={setColor} />
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="ly-form-actions">
        <button type="button" className="btn ghost" onClick={() => setPick(null)} disabled={ctx.busy}>Back</button>
        <button className="btn primary" disabled={ctx.busy || !name.trim()}>
          {ctx.busy ? <span className="spinner ly-spinner-sm" /> : 'Create server'}
        </button>
      </div>
    </form>
  );
}

/** serverSettingsTabs 'community.template': save this server's structure as a private template. */
export function SaveTemplateTab({ ctx }) {
  const { sid, server } = ctx;
  const { channels, loading } = useChannels(sid, 0);
  const categories = useCategories(sid);
  const welcome = useWelcome(sid);
  const mine = useMyTemplates(ctx.me.uid);
  const [name, setName] = useState(server?.meta?.name || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const template = useMemo(() => {
    try {
      return templateFromServer({
        name: name.trim() || server?.meta?.name || 'My template',
        serverName: server?.meta?.name,
        color: server?.meta?.color,
        channels,
        categories,
        roles: server?.roles || {},
        welcome: welcome.configured || welcome.req ? welcome : null,
      });
    } catch {
      return null;
    }
  }, [name, server?.meta?.name, server?.meta?.color, channels, categories, server?.roles, welcome]);

  const save = async (e) => {
    e.preventDefault();
    if (!template) return;
    setBusy(true);
    setMsg(null);
    try {
      const { trimmed } = await saveTemplate(template, mine.count);
      setMsg({ ok: true, text: trimmed ? 'Template saved (channel topics were left out to make it fit).' : 'Template saved. Find it under “Start from a template” when you add a server.' });
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cm-settings">
      <form className="cm-settings" onSubmit={save}>
        <p className="muted">
          Saves this server's structure: channels, categories, roles and the welcome screen. No messages, members, invites, emotes or keys.
          Templates are encrypted with your vault key and only you can see them.
        </p>
        <label className="field">
          Template name
          <input className="input" value={name} maxLength={TEMPLATE_LIMITS.name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {loading || welcome.loading ? <p className="muted">Loading the server's structure…</p> : template ? <TemplateOutline t={template} /> : <p className="error-text">Nothing to save yet.</p>}
        {msg && <p className={msg.ok ? 'cm-ok' : 'error-text'} role="status">{msg.text}</p>}
        <div className="ly-form-actions">
          <button className="btn primary" disabled={busy || !template || !name.trim() || loading}>
            {busy ? <span className="spinner ly-spinner-sm" /> : 'Save as template'}
          </button>
        </div>
      </form>
      {mine.list.length > 0 && (
        <div className="cm-saved">
          <h4>Your templates ({mine.list.length}/{TEMPLATE_LIMITS.saved})</h4>
          <ul>
            {mine.list.map((t) => (
              <li key={t.tid}>
                <span><strong>{t.name}</strong> <span className="muted">{summarize(t)}</span></span>
                <ConfirmButton className="btn ghost sm cm-danger" confirmLabel="Delete?" onConfirm={() => deleteTemplate(t.tid).catch((err) => setMsg({ ok: false, text: errText(err) }))}>
                  Delete
                </ConfirmButton>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
