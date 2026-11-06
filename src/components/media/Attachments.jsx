// Encrypted image attachments UI (feature 9): picker button, drop zone, paste handler, pending tray,
// lazy ImageAttachment and Lightbox. Encryption/chunking/caching lives in src/lib/media/attachments.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAttachmentSrc } from '../../lib/media/attachments.js';
import { Icon } from '../layout/ui.jsx';
import { ACCEPT_IMAGES, MAX_ATTACHMENTS, isRasterImage } from './util.js';

/** Draft state for the composer: files (<= 4), add() filters non-images, per-file progress. */
export function useAttachmentDraft(max = MAX_ATTACHMENTS) {
  const [files, setFiles] = useState([]);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState({}); // index -> 0..1
  const add = useCallback((list) => {
    const arr = Array.from(list || []);
    const imgs = arr.filter(isRasterImage);
    setNotice(imgs.length < arr.length ? 'Only PNG, JPEG, WebP and GIF images can be attached.' : '');
    setFiles((cur) => {
      const next = [...cur, ...imgs].slice(0, max);
      if (cur.length + imgs.length > max) setNotice(`You can attach up to ${max} images.`);
      return next;
    });
  }, [max]);
  const remove = useCallback((i) => setFiles((c) => c.filter((_, j) => j !== i)), []);
  const clear = useCallback(() => {
    setFiles([]);
    setProgress({});
    setNotice('');
  }, []);
  return { files, add, remove, clear, notice, progress, setProgress, full: files.length >= max };
}

export function AttachmentButton({ onFiles, disabled, title = 'Attach images' }) {
  const input = useRef(null);
  return (
    <>
      <button type="button" className="btn ghost sm md-attach-btn" disabled={disabled} title={title} aria-label={title} onClick={() => input.current?.click()}>
        <Icon name="plus" size={18} />
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT_IMAGES}
        multiple
        hidden
        onChange={(e) => {
          onFiles?.(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** Wrap the chat pane: shows an overlay while an image file is dragged over it. */
export function DropZone({ onFiles, disabled, children, className = '' }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  if (disabled) return <div className={className}>{children}</div>;
  return (
    <div
      className={`md-drop ${className}`}
      onDragEnter={(e) => hasFiles(e) && (depth.current++, setOver(true))}
      onDragLeave={(e) => hasFiles(e) && (depth.current = Math.max(0, depth.current - 1)) === 0 && setOver(false)}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        onFiles?.(e.dataTransfer.files);
      }}
    >
      {children}
      {over && <div className="md-drop-overlay" aria-hidden="true">Drop images to attach</div>}
    </div>
  );
}

/** Returns an onPaste handler for the composer textarea: pasted image files go to onFiles, text pastes are untouched. */
export function usePasteFiles(onFiles) {
  return useCallback(
    (e) => {
      const files = Array.from(e.clipboardData?.files || []).filter(isRasterImage);
      if (!files.length) return;
      e.preventDefault();
      onFiles?.(files);
    },
    [onFiles],
  );
}

/** Pending files above the composer with thumbnails, remove buttons and upload progress. */
export function AttachmentTray({ files, progress = {}, onRemove, notice, busy }) {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  if (!files.length && !notice) return null;
  return (
    <div className="md-tray">
      {files.map((f, i) => (
        <div key={`${f.name}-${f.size}-${i}`} className="md-tray-item" title={f.name}>
          <img src={urls[i]} alt="" draggable={false} />
          {busy ? (
            <span className="md-tray-bar"><span style={{ width: `${Math.round((progress[i] || 0) * 100)}%` }} /></span>
          ) : (
            <button type="button" className="md-tray-x" aria-label={`Remove ${f.name}`} onClick={() => onRemove?.(i)}>
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      ))}
      {notice && <p className="md-error md-tray-note" role="status">{notice}</p>}
    </div>
  );
}

export function Lightbox({ src, alt = '', onClose }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  if (!src) return null;
  return (
    <div className="md-lightbox" role="dialog" aria-modal="true" aria-label="Image viewer" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <button type="button" className="btn ghost md-lightbox-x" onClick={onClose} aria-label="Close">
        <Icon name="x" size={22} />
      </button>
      <img src={src} alt={alt} draggable={false} />
    </div>
  );
}

/** One attachment `{ attId, w, h, mime, size }` of a message. Chunks are fetched only once scrolled near view. */
export function ImageAttachment({ scope, att, maxW = 360, maxH = 320 }) {
  const box = useRef(null);
  const [seen, setSeen] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (seen || !box.current) return undefined;
    if (typeof IntersectionObserver === 'undefined') return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setSeen(true), io.disconnect()), { rootMargin: '300px' });
    io.observe(box.current);
    return () => io.disconnect();
  }, [seen]);

  const res = useAttachmentSrc(scope, att);
  const libRef = res && typeof res.ref === 'function' ? res.ref : null;
  const setBox = useCallback((el) => {
    box.current = el;
    if (libRef) libRef(el);
  }, [libRef]);
  const src = typeof res === 'string' ? res : res?.src || res?.url || null;
  const error = res && typeof res === 'object' ? res.error : null;

  const w = Math.max(+att?.w || 320, 1);
  const h = Math.max(+att?.h || 240, 1);
  const k = Math.min(1, maxW / w, maxH / h);
  const dw = Math.round(w * k);
  const dh = Math.round(h * k);
  return (
    <div ref={setBox} className="md-att" style={{ width: dw, height: dh }}>
      {src ? (
        <>
          <button type="button" className="md-att-open" onClick={() => setOpen(true)} aria-label="Open image">
            <img src={src} alt="Attachment" width={dw} height={dh} draggable={false} />
          </button>
          {open && <Lightbox src={src} onClose={() => setOpen(false)} />}
        </>
      ) : (
        <span className="md-att-ph">{error ? 'Image unavailable' : seen ? 'Decrypting…' : ''}</span>
      )}
    </div>
  );
}

/** All attachments of a message. */
export function MessageAttachments({ scope, attachments }) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  return (
    <div className="md-atts">
      {attachments.slice(0, MAX_ATTACHMENTS).map((a) => (
        <ImageAttachment key={a.attId} scope={scope} att={a} />
      ))}
    </div>
  );
}
