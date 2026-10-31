import { useEffect, useRef } from 'react';

export default function ConfirmModal({ title, children, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  const btn = useRef(null);
  useEffect(() => {
    btn.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true">
        <h2>{title}</h2>
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button ref={btn} type="button" className={`btn ${danger ? 'danger-solid' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
