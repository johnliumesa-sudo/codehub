// AvatarUploader (profile picture) and ServerIconUploader. Processing, size caps and encryption live in src/lib/media.
import { useRef, useState } from 'react';
import { setAvatar, clearAvatar, useAvatar } from '../../lib/media/avatars.js';
import { clearServerIcon, setServerIcon, useServerIcon } from '../../lib/media/icons.js';
import { useToast } from '../layout/ui.jsx';
import { Avatar, ServerIcon } from './Avatar.jsx';
import { ACCEPT_IMAGES, errMsg, isRasterImage } from './util.js';

function useUploader(apply) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
      toast?.(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Picker({ preview, busy, error, onFile, onRemove, hasImage, label, hint }) {
  const input = useRef(null);
  const pick = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!isRasterImage(f)) return onFile(null, 'Choose a PNG, JPEG, WebP or GIF image.');
    onFile(f);
  };
  return (
    <div className="md-uploader">
      {preview}
      <div className="md-uploader-body">
        <div className="md-uploader-actions">
          <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Working…' : hasImage ? `Change ${label}` : `Upload ${label}`}
          </button>
          {hasImage && (
            <button type="button" className="btn ghost sm" disabled={busy} onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
        <p className="md-hint">{hint}</p>
        {error && <p className="md-error" role="alert">{error}</p>}
      </div>
      <input ref={input} type="file" accept={ACCEPT_IMAGES} hidden onChange={pick} />
    </div>
  );
}

export function AvatarUploader({ uid, size = 72 }) {
  const { busy, error, run } = useUploader();
  const [localErr, setLocalErr] = useState('');
  const has = !!useAvatar(uid);
  return (
    <Picker
      label="picture"
      busy={busy}
      error={error || localErr}
      hasImage={has}
      hint="Resized to 256 px and stored publicly so everyone can see it. Metadata is stripped."
      preview={<Avatar uid={uid} size={size} />}
      onFile={(f, msg) => (msg ? setLocalErr(msg) : (setLocalErr(''), run(() => setAvatar(uid, f))))}
      onRemove={() => run(() => clearAvatar(uid))}
    />
  );
}

export function ServerIconUploader({ sid, name, size = 72, canEdit = true }) {
  const { busy, error, run } = useUploader();
  const [localErr, setLocalErr] = useState('');
  const has = !!useServerIcon(sid);
  if (!canEdit) return <ServerIcon sid={sid} name={name} size={size} />;
  return (
    <Picker
      label="icon"
      busy={busy}
      error={error || localErr}
      hasImage={has}
      hint="Encrypted with the server key. Only members can see it. Without an icon the server shows its initials."
      preview={<ServerIcon sid={sid} name={name} size={size} />}
      onFile={(f, msg) => (msg ? setLocalErr(msg) : (setLocalErr(''), run(() => setServerIcon(sid, f))))}
      onRemove={() => run(() => clearServerIcon(sid))}
    />
  );
}
