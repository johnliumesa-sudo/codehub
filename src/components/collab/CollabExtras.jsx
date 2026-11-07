// Extension slot in the CollabView toolbar (spec 0.7). Composes the buttons other features export;
// each takes the shared `ctx` ({ space, key, me, readOnly, title, files, activeFid, activePath,
// provider, insertText, getSelection, openFile, notify }).
//
// Feature registries (src/lib/ext/registry.js), each entry rendered inside its own error boundary:
//   collabTools   { id, render(ctx, place) }  buttons: the toolbar (place 'toolbar') and the empty
//                 workspace's welcome actions (place 'welcome')
//   collabMounts  { id, render(ctx) }         mounted once per open workspace, beside the editor area
//                 (panels, background work); stays mounted while files are opened and closed
import { useRegistry } from '../../lib/ext/registry.js';
import { ExtRender } from '../ext/ExtRender.jsx';
import PreviewButton from '../sandbox/PreviewButton.jsx';
import PublishGameButton from '../games/PublishGameButton.jsx';
import CheckpointsButton from '../productivity/CheckpointsButton.jsx';
import SnippetsButton from '../productivity/SnippetsButton.jsx';
import ExportImportMenu from '../productivity/ExportImportMenu.jsx';

export function CollabTools({ ctx, place }) {
  const entries = useRegistry('collabTools');
  return entries.map((e) => <ExtRender key={e.id} entry={e} args={[ctx, place]} />);
}

export function CollabMounts({ ctx }) {
  const entries = useRegistry('collabMounts');
  return entries.map((e) => <ExtRender key={e.id} entry={e} args={[ctx]} notice />);
}

export default function CollabExtras({ ctx, previewOpen, onPreviewOpenChange }) {
  return (
    <>
      <PreviewButton ctx={ctx} open={previewOpen} onOpenChange={onPreviewOpenChange} />
      <PublishGameButton ctx={ctx} />
      <CheckpointsButton ctx={ctx} />
      <SnippetsButton ctx={ctx} />
      <ExportImportMenu ctx={ctx} />
      <CollabTools ctx={ctx} place="toolbar" />
    </>
  );
}
