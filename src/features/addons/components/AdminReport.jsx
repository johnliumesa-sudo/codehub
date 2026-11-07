// Admin reports queue: how a reported add-on (target `addon:{id}`) is shown, and its "Remove" action.
import { ConfirmButton } from '../../../components/layout/ui.jsx';
import { unpublishAddon, useManifest } from '../lib/store.js';
import { Publisher } from './bits.jsx';

export function ReportedAddon({ id }) {
  const { manifest, loading } = useManifest(id);
  return (
    <span>
      {loading ? '…' : manifest ? (
        <>
          <strong>{manifest.icon} {manifest.name}</strong> <span className="muted">v{manifest.version} by <Publisher uid={manifest.by} /></span>
        </>
      ) : (
        <em className="muted">Add-on no longer published</em>
      )}
      <code className="adm-id">{id}</code>
    </span>
  );
}

export function RemoveReportedAddon({ id, act, dismiss, busy }) {
  const { manifest } = useManifest(id);
  if (!manifest) return null;
  return (
    <ConfirmButton
      confirmLabel="Remove for everyone?"
      disabled={busy}
      onConfirm={() => act(async () => {
        await unpublishAddon(id);
        await dismiss();
      })}
    >
      Remove add-on
    </ConfirmButton>
  );
}
