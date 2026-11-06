// Extension slot in the CollabView toolbar (spec 0.7). Composes the buttons other features export;
// each takes the shared `ctx` ({ space, key, me, readOnly, title, files, activeFid, activePath,
// provider, insertText, getSelection, openFile, notify }).
import PreviewButton from '../sandbox/PreviewButton.jsx';
import PublishGameButton from '../games/PublishGameButton.jsx';
import CheckpointsButton from '../productivity/CheckpointsButton.jsx';
import SnippetsButton from '../productivity/SnippetsButton.jsx';
import ExportImportMenu from '../productivity/ExportImportMenu.jsx';

export default function CollabExtras({ ctx, previewOpen, onPreviewOpenChange }) {
  return (
    <>
      <PreviewButton ctx={ctx} open={previewOpen} onOpenChange={onPreviewOpenChange} />
      <PublishGameButton ctx={ctx} />
      <CheckpointsButton ctx={ctx} />
      <SnippetsButton ctx={ctx} />
      <ExportImportMenu ctx={ctx} />
    </>
  );
}
