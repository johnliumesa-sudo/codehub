// Slowmode picker for a channel's settings (render for users holding manageChannels).
import { useEffect, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { db } from '../../lib/firebase.js';
import { SLOWMODE_PRESETS, cleanSlowmode, formatSeconds, setSlowmode, slowmodePath } from '../../lib/serverx/slowmode.js';
import './serverx.css';

/** Props: { sid, cid, disabled?, onError?(err) } */
export function SlowmodeControl({ sid, cid, disabled, onError }) {
  const [value, setValue] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => onValue(ref(db, slowmodePath(sid, cid)), (s) => setValue(cleanSlowmode(s.val())), () => {}), [sid, cid]);
  const options = SLOWMODE_PRESETS.includes(value) ? SLOWMODE_PRESETS : [...SLOWMODE_PRESETS, value].sort((a, b) => a - b);
  const change = async (e) => {
    setBusy(true);
    try {
      await setSlowmode(sid, cid, e.target.value);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="sx-field">
      <span className="sx-label">Slowmode</span>
      <select className="input sx-select" value={value} onChange={change} disabled={disabled || busy} aria-label="Slowmode">
        {options.map((s) => (
          <option key={s} value={s}>{s === 0 ? 'Off' : formatSeconds(s)}</option>
        ))}
      </select>
      <span className="sx-hint">Members without message-management rights can post once per interval. Enforced by the database rules.</span>
    </label>
  );
}
