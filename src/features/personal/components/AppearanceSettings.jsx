// Settings -> Appearance (below the theme picker): density, font size, chat width, clock format,
// reduced motion, strong focus rings, and "Sync across my devices".
import { useEffect, useId, useState } from 'react';
import {
  CLOCKS, CLOCK_LABEL, DENSITIES, FONT_MAX, FONT_MIN, FONT_STEP, WIDTHS, WIDTH_LABEL, formatClock,
} from '../lib/appearanceCore.js';
import { deviceReducesMotion, resetAppearance, setAppearance, setAppearanceSync, useAppearance } from '../lib/appearance.js';

const DENSITY_LABEL = { cozy: 'Cozy', compact: 'Compact' };
const DENSITY_HINT = { cozy: 'Roomy messages with large avatars.', compact: 'Tighter spacing, smaller avatars: more messages on screen.' };
const SAMPLE_TS = new Date(2026, 0, 1, 14, 30).getTime();

function useDeviceReduce() {
  const [on, setOn] = useState(deviceReducesMotion);
  useEffect(() => {
    let mq;
    try {
      mq = matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return undefined;
    }
    const f = () => setOn(mq.matches);
    mq.addEventListener?.('change', f);
    return () => mq.removeEventListener?.('change', f);
  }, []);
  return on;
}

function Radios({ label, value, options, onChange, render }) {
  const id = useId();
  const onKeyDown = (e) => {
    const i = options.indexOf(value);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n]);
    e.currentTarget.querySelectorAll('[role="radio"]')[n]?.focus();
  };
  return (
    <div className="pf-field">
      <span className="pf-field-label" id={id}>{label}</span>
      <div className="pf-seg" role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} tabIndex={value === o ? 0 : -1} className={`pf-seg-btn${value === o ? ' on' : ''}`} onClick={() => onChange(o)}>
            {render(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function AppearanceSettings() {
  const { prefs, sync } = useAppearance();
  const device = useDeviceReduce();
  const fontId = useId();
  const widthId = useId();
  const motionId = useId();
  const ringId = useId();
  const syncId = useId();

  return (
    <section className="pf-appearance" aria-labelledby={`${fontId}-h`}>
      <h3 id={`${fontId}-h`}>Display</h3>
      <p className="muted pf-lead">Saved in this browser and applied before the page paints.</p>

      <Radios
        label="Message density"
        value={prefs.density}
        options={DENSITIES}
        onChange={(density) => setAppearance({ density })}
        render={(d) => (
          <span className="pf-seg-text">
            <strong>{DENSITY_LABEL[d]}</strong>
            <span className="pf-muted-sm">{DENSITY_HINT[d]}</span>
          </span>
        )}
      />

      <div className="pf-field">
        <label className="pf-field-label" htmlFor={fontId}>Font size</label>
        <div className="pf-range-row">
          <span className="pf-muted-sm" aria-hidden="true">A</span>
          <input
            id={fontId}
            type="range"
            min={FONT_MIN}
            max={FONT_MAX}
            step={FONT_STEP}
            value={prefs.font}
            onChange={(e) => setAppearance({ font: Number(e.target.value) })}
            aria-valuetext={`${prefs.font}%`}
          />
          <span className="pf-big-a" aria-hidden="true">A</span>
          <output htmlFor={fontId} className="pf-range-out">{prefs.font}%</output>
        </div>
        <p className="pf-font-sample" aria-hidden="true">The quick brown fox types <code>console.log()</code> in #general.</p>
      </div>

      <div className="pf-field">
        <label className="pf-field-label" htmlFor={widthId}>Chat width</label>
        <select id={widthId} className="input pf-select" value={prefs.chatWidth} onChange={(e) => setAppearance({ chatWidth: e.target.value })}>
          {WIDTHS.map((w) => <option key={w} value={w}>{WIDTH_LABEL[w]}</option>)}
        </select>
        <span className="pf-muted-sm">Limits how wide messages and the composer get on large screens.</span>
      </div>

      <Radios
        label="Timestamps"
        value={prefs.clock}
        options={CLOCKS}
        onChange={(clock) => setAppearance({ clock })}
        render={(c) => (
          <span className="pf-seg-text">
            <strong>{c === 'auto' ? 'Automatic' : `${c}-hour`}</strong>
            <span className="pf-muted-sm">{c === 'auto' ? `${formatClock(SAMPLE_TS, 'auto')} · ${CLOCK_LABEL.auto.toLowerCase()}` : formatClock(SAMPLE_TS, c)}</span>
          </span>
        )}
      />

      <div className="pf-field pf-check">
        <input id={motionId} type="checkbox" checked={prefs.reduceMotion || device} disabled={device} onChange={(e) => setAppearance({ reduceMotion: e.target.checked })} aria-describedby={`${motionId}-h`} />
        <label htmlFor={motionId}>Reduce motion</label>
        <span id={`${motionId}-h`} className="pf-muted-sm">
          {device ? 'On because your device asks for reduced motion.' : 'Turns off animations and smooth transitions.'}
        </span>
      </div>

      <div className="pf-field pf-check">
        <input id={ringId} type="checkbox" checked={prefs.focusRings} onChange={(e) => setAppearance({ focusRings: e.target.checked })} aria-describedby={`${ringId}-h`} />
        <label htmlFor={ringId}>High-contrast focus rings</label>
        <span id={`${ringId}-h`} className="pf-muted-sm">A thick, high-contrast outline around whatever has keyboard focus.</span>
      </div>

      <div className="pf-field pf-check">
        <input id={syncId} type="checkbox" checked={sync} onChange={(e) => setAppearanceSync(e.target.checked)} aria-describedby={`${syncId}-h`} />
        <label htmlFor={syncId}>Sync across my devices</label>
        <span id={`${syncId}-h`} className="pf-muted-sm">
          Keeps these display choices in your private account data (only you can read it) so your other devices that sync, and new browsers you sign in on, use them too. Turning it off removes the synced copy.
        </span>
      </div>

      <div className="pf-actions">
        <button type="button" className="btn ghost sm" onClick={resetAppearance}>Reset display settings</button>
      </div>
    </section>
  );
}
