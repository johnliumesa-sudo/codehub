// Copy-to-clipboard button with a short "Copied" confirmation (falls back to a hidden textarea).
import { useEffect, useState } from 'react';

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

export function CopyButton({ text, label = 'Copy', small = false, children }) {
  const [state, setState] = useState('');
  useEffect(() => {
    if (!state) return undefined;
    const t = setTimeout(() => setState(''), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className={`btn ${small ? 'sm ghost' : 'sm'}`}
      aria-label={label}
      title={label}
      onClick={async () => setState((await copyText(text)) ? 'ok' : 'fail')}
    >
      <span aria-live="polite">{state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : children || 'Copy'}</span>
    </button>
  );
}
