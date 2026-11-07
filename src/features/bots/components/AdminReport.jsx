// Admin reports queue: how a reported bot (kind `bot`, target = its pub/bots id) is shown, and the
// app admin's "Remove bot" action (removes it from the directory; installed copies keep working).
import { useMemo } from 'react';
import { usePub } from '../../../lib/ext/store.js';
import { useProfile } from '../../../lib/profiles.js';
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { parseBotEntry } from '../lib/schema.js';
import { PUB_KIND, unpublishBot } from '../lib/store.js';
import BotAvatar from './BotAvatar.jsx';

const BOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The bot a report is about, or null. */
export const reportedBotId = (r) => (r?.kind === 'bot' && typeof r.target === 'string' && BOT_ID.test(r.target) ? r.target : null);

function useBotEntry(id) {
  const st = usePub(PUB_KIND, id);
  const entry = useMemo(() => (st.value && typeof st.value === 'object' ? parseBotEntry(id, st.value) : null), [id, st.value]);
  return { loading: st.loading, entry };
}

function Publisher({ uid }) {
  const p = useProfile(uid);
  return <span className="adm-user" style={{ color: p?.color }}>{p?.name || '…'}</span>;
}

export function ReportedBot({ id }) {
  const { loading, entry } = useBotEntry(id);
  return (
    <span className="bt-report-target">
      {loading ? '…' : !entry ? (
        <em className="muted">Bot no longer in the directory</em>
      ) : entry.ok ? (
        <>
          <BotAvatar glyph={entry.def.glyph} image={entry.image} size={20} />
          <strong>{entry.def.name}</strong> <span className="muted">v{entry.ver} by <Publisher uid={entry.by} /></span>
        </>
      ) : (
        <>
          <em className="muted">Invalid bot entry</em>
          {entry.by && <span className="muted"> by <Publisher uid={entry.by} /></span>}
        </>
      )}
      <code className="adm-id">{id}</code>
    </span>
  );
}

export function RemoveReportedBot({ id, act, dismiss, busy }) {
  const { entry } = useBotEntry(id);
  if (!entry) return null;
  return (
    <ConfirmButton
      confirmLabel="Remove for everyone?"
      disabled={busy}
      onConfirm={() => act(async () => {
        await unpublishBot(id);
        await dismiss();
      })}
    >
      Remove bot
    </ConfirmButton>
  );
}
