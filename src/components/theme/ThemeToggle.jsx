// Appearance control: Dark / Light / System. Used in Settings -> Appearance (variant "card", default)
// or as a compact pill (variant "inline"). The choice is device-local (localStorage), never synced.
import { useRef } from 'react';
import { THEMES, useTheme } from '../../lib/theme.js';
import './theme.css';

const LABELS = { dark: 'Dark', light: 'Light', system: 'System' };
const HINTS = { dark: 'Easy on the eyes at night.', light: 'Bright surfaces for daytime.', system: 'Follow your device setting.' };

export default function ThemeToggle({ variant = 'card' }) {
  const { theme, resolved, setTheme } = useTheme();
  const groupRef = useRef(null);

  // Radiogroup keyboard model: arrows move + select, focus follows.
  const onKeyDown = (e) => {
    const i = THEMES.indexOf(theme);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % THEMES.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i + THEMES.length - 1) % THEMES.length;
    if (next < 0) return;
    e.preventDefault();
    setTheme(THEMES[next]);
    groupRef.current?.querySelectorAll('[role="radio"]')[next]?.focus();
  };

  const radios = (render) =>
    THEMES.map((t) => render(t, theme === t));

  if (variant === 'inline') {
    return (
      <div className="th-inline" role="radiogroup" aria-label="Theme" ref={groupRef} onKeyDown={onKeyDown}>
        {radios((t, on) => (
          <button key={t} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} onClick={() => setTheme(t)}>
            {LABELS[t]}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="th-card">
      <div>
        <h3>Theme</h3>
        <p className="muted">
          Choose how Codehub looks on this device.
          {theme === 'system' ? ` Currently ${resolved}.` : ''}
        </p>
      </div>
      <div className="th-options" role="radiogroup" aria-label="Theme" ref={groupRef} onKeyDown={onKeyDown}>
        {radios((t, on) => (
          <button key={t} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} className="th-option" onClick={() => setTheme(t)}>
            <span className={`th-preview ${t}`} aria-hidden="true">
              <i />
              <span className="th-main"><b /><b /></span>
            </span>
            <span className="th-label">
              {LABELS[t]}
              {on ? <span className="th-check" aria-hidden="true">Selected</span> : null}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>{HINTS[t]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
