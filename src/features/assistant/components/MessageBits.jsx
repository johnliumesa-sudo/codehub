// Per-message assistant UI: the inline translation under a message (messageExtras; local only, never
// sent) and the "AI" badge on answers someone shared from the assistant (messageBadges).
import { useSession } from '../lib/session.js';
import { hideTranslation, translate } from '../lib/actions.js';
import { useWorkspaceCtx } from '../../../lib/ext/workspaceContext.js';
import { modelLabel } from '../lib/config.js';
import { Markdown } from './common.jsx';
import '../assistant.css';

const selectTranslations = (s) => s.translations;

export function TranslationExtra({ m, ctx }) {
  const all = useSession(selectTranslations);
  const ws = useWorkspaceCtx();
  const t = all[m.mid];
  if (!t) return null;
  return (
    <section className={`asst-translation ${t.status}`} aria-label={`Translation to ${t.lang}`} aria-busy={t.status === 'loading'}>
      <div className="asst-translation-head">
        <span className="asst-translation-tag">Translated to {t.lang} by Claude · only you see this</span>
        <span className="asst-translation-btns">
          {(t.status === 'error' || t.status === 'refusal') && (
            <button type="button" className="asst-link" onClick={() => translate(m, ctx).catch((e) => ctx.toast(e?.message))}>Retry</button>
          )}
          {t.status === 'error' && (t.error?.kind === 'nokey' || t.error?.kind === 'locked' || t.error?.kind === 'auth') && ws?.openSettings && (
            <button type="button" className="asst-link" onClick={() => ws.openSettings('assistant')}>Settings</button>
          )}
          <button type="button" className="asst-link" onClick={() => hideTranslation(m.mid)} aria-label="Hide translation">Hide</button>
        </span>
      </div>
      {t.text ? <Markdown text={t.text} /> : t.status === 'loading' ? <p className="asst-thinking">Translating…</p> : null}
      {t.note && <p className="asst-note warn">{t.note}</p>}
      {t.status === 'error' && t.error && <p className="error-text" role="alert">{t.error.message}</p>}
    </section>
  );
}

const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** body.assistant = { v: 1, model } on a shared answer; untrusted, so validated before use. */
export function sharedAnswerInfo(m) {
  const a = m?.body?.assistant;
  if (!a || typeof a !== 'object' || a.v !== 1) return null;
  return { model: typeof a.model === 'string' && MODEL_RE.test(a.model) ? a.model : '' };
}

export function AiBadge({ m }) {
  const info = sharedAnswerInfo(m);
  if (!info) return null;
  return (
    <span className="asst-badge" title={`Answer written by ${info.model ? modelLabel(info.model) : 'Claude'} and shared by this member`}>
      AI
    </span>
  );
}
