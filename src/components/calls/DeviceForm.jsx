// Voice & video device settings, shared by Settings -> "Voice & video" (mode 'settings': with mic test,
// camera preview and a speaker test) and the in-call device menu (mode 'call': the meter shows the live
// call microphone). Choices are saved in this browser only (lib/calls/prefs.js) and a running call
// applies them at once (replaceTrack, no reconnect).
import { useEffect, useId, useRef, useState } from 'react';
import { useCallPrefs } from '../../lib/calls/useCall.js';
import { getCameraTrack, getMic, listDevices, playTestSound, sinkSupported, stopStream, watchLevel } from '../../lib/calls/media.js';
import { isValidPttKey, keyLabel, savePrefs } from '../../lib/calls/prefs.js';

/** Live level meter for an audio stream (local analysis only). */
export function LevelMeter({ stream, label = 'Microphone level', muted }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream) {
      setLevel(0);
      return undefined;
    }
    return watchLevel(stream, (l) => setLevel((prev) => (Math.abs(prev - l) > 0.01 ? l : prev)));
  }, [stream]);
  const pct = muted ? 0 : Math.round(level * 100);
  return (
    <div className={`call-meter ${muted ? 'muted' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} data-level={pct}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function useDeviceList() {
  const [list, setList] = useState({ audioIn: [], videoIn: [], audioOut: [] });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => listDevices().then((l) => live && setList(l)).catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener?.('devicechange', load);
    return () => {
      live = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', load);
    };
  }, [tick]);
  return [list, () => setTick((x) => x + 1)];
}

function DeviceSelect({ label, value, items, onChange, fallback }) {
  const id = useId();
  return (
    <div className="call-dev-row">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={items.some((d) => d.deviceId === value) ? value : ''} onChange={(e) => onChange(e.target.value)} disabled={!items.length}>
        <option value="">{items.length ? 'System default' : fallback}</option>
        {items.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Check({ label, hint, checked, onChange }) {
  const id = useId();
  return (
    <div className="call-check">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-h` : undefined} />
      <label htmlFor={id}>{label}</label>
      {hint && (
        <span id={`${id}-h`} className="call-dim">
          {hint}
        </span>
      )}
    </div>
  );
}

/** Push-to-talk switch and key binding (captures the next key press; Esc cancels). */
function PttControls({ prefs }) {
  const [capturing, setCapturing] = useState(false);
  const [msg, setMsg] = useState('');
  const btn = useRef(null);
  useEffect(() => {
    if (!capturing) return undefined;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setMsg('');
      } else if (isValidPttKey(e.code)) {
        savePrefs({ pttKey: e.code });
        setMsg(`Push-to-talk key set to ${keyLabel(e.code)}`);
      } else {
        setMsg(`${keyLabel(e.code) || 'That key'} can't be used for push-to-talk`);
      }
      setCapturing(false);
      btn.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);
  return (
    <fieldset className="call-fieldset">
      <legend>Push-to-talk</legend>
      <Check
        label="Use push-to-talk"
        hint="Your microphone is only on while you hold the key (this tab must be focused) or the talk button."
        checked={prefs.ptt}
        onChange={(v) => savePrefs({ ptt: v })}
      />
      <div className="call-ptt-key">
        <span>
          Key: <kbd>{keyLabel(prefs.pttKey)}</kbd>
        </span>
        <button ref={btn} type="button" className="btn sm" onClick={() => { setMsg(''); setCapturing(true); }}>
          {capturing ? 'Press a key… (Esc cancels)' : 'Change key'}
        </button>
      </div>
      <p className="call-dim" role="status">{msg}</p>
    </fieldset>
  );
}

/** Settings-mode microphone test: a short-lived stream with the chosen device and processing. */
function MicTest({ prefs }) {
  const [stream, setStream] = useState(null);
  const [on, setOn] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!on) return undefined;
    let s = null;
    let live = true;
    getMic(prefs.audioIn, prefs).then(
      (x) => {
        if (!live) return stopStream(x);
        s = x;
        setStream(x);
        setErr('');
        return undefined;
      },
      (e) => {
        if (!live) return;
        setErr(e?.message || 'Could not start your microphone');
        setOn(false);
      },
    );
    return () => {
      live = false;
      stopStream(s);
      setStream(null);
    };
  }, [on, prefs]);
  return (
    <div className="call-test">
      <button type="button" className="btn sm" onClick={() => setOn((v) => !v)} aria-pressed={on}>
        {on ? 'Stop test' : 'Test microphone'}
      </button>
      <LevelMeter stream={stream} muted={!on} />
      {err && <span className="error-text" role="alert">{err}</span>}
    </div>
  );
}

function CameraPreview({ deviceId }) {
  const [on, setOn] = useState(false);
  const [err, setErr] = useState('');
  const video = useRef(null);
  useEffect(() => {
    if (!on) return undefined;
    let t = null;
    let live = true;
    getCameraTrack(deviceId).then(
      (x) => {
        if (!live) return x.stop();
        t = x;
        if (video.current) {
          video.current.srcObject = new MediaStream([x]);
          video.current.play?.().catch(() => {});
        }
        setErr('');
        return undefined;
      },
      (e) => {
        if (!live) return;
        setErr(e?.message || 'Could not start your camera');
        setOn(false);
      },
    );
    return () => {
      live = false;
      t?.stop();
      if (video.current) video.current.srcObject = null;
    };
  }, [on, deviceId]);
  return (
    <div className="call-test">
      <button type="button" className="btn sm" onClick={() => setOn((v) => !v)} aria-pressed={on}>
        {on ? 'Stop preview' : 'Preview camera'}
      </button>
      {on && <video ref={video} className="call-preview mirror" autoPlay playsInline muted aria-label="Camera preview" />}
      {err && <span className="error-text" role="alert">{err}</span>}
    </div>
  );
}

function SpeakerTest({ sinkId }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async () => {
    setBusy(true);
    setErr('');
    try {
      await playTestSound(sinkId);
    } catch (e) {
      setErr(e?.message || 'Could not play on this speaker');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="call-test">
      <button type="button" className="btn sm" onClick={run} disabled={busy}>
        {busy ? 'Playing…' : 'Play test sound'}
      </button>
      {err && <span className="error-text" role="alert">{err}</span>}
    </div>
  );
}

/** Props: `mode` 'settings' | 'call'; `call` (active call snapshot, mode 'call'). */
export default function DeviceForm({ mode = 'settings', call }) {
  const prefs = useCallPrefs();
  const [list, reload] = useDeviceList();
  const [askErr, setAskErr] = useState('');
  const set = (patch) => savePrefs(patch);
  const noLabels = [...list.audioIn, ...list.videoIn].every((d) => /^(Microphone|Camera) \d+$/.test(d.label));
  const ask = async () => {
    setAskErr('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
      stopStream(s);
      reload();
    } catch {
      setAskErr('Permission was denied. Allow microphone and camera access for this site in your browser.');
    }
  };
  return (
    <div className={`call-devform ${mode}`}>
      {mode === 'settings' && noLabels && (
        <div className="call-devform-ask">
          <span className="call-dim">Device names appear after you allow access to your microphone and camera.</span>
          <button type="button" className="btn sm" onClick={ask}>
            Allow access
          </button>
          {askErr && <span className="error-text" role="alert">{askErr}</span>}
        </div>
      )}
      <fieldset className="call-fieldset">
        <legend>Input</legend>
        <DeviceSelect label="Microphone" value={prefs.audioIn} items={list.audioIn} onChange={(v) => set({ audioIn: v })} fallback="No microphone found" />
        {mode === 'call' ? (
          <LevelMeter stream={call?.micStream} muted={!call?.transmitting} label="Your microphone level" />
        ) : (
          <MicTest prefs={prefs} />
        )}
        <Check label="Echo cancellation" checked={prefs.ec} onChange={(v) => set({ ec: v })} />
        <Check label="Noise suppression" checked={prefs.ns} onChange={(v) => set({ ns: v })} />
        <Check label="Automatic gain control" checked={prefs.agc} onChange={(v) => set({ agc: v })} />
      </fieldset>
      <fieldset className="call-fieldset">
        <legend>Camera</legend>
        <DeviceSelect label="Camera" value={prefs.videoIn} items={list.videoIn} onChange={(v) => set({ videoIn: v })} fallback="No camera found" />
        {mode === 'settings' && <CameraPreview deviceId={prefs.videoIn} />}
      </fieldset>
      <fieldset className="call-fieldset">
        <legend>Output</legend>
        {sinkSupported() ? (
          <DeviceSelect label="Speaker" value={prefs.audioOut} items={list.audioOut} onChange={(v) => set({ audioOut: v })} fallback="System default" />
        ) : (
          <p className="call-dim">This browser always plays calls on the system's default speaker.</p>
        )}
        {mode === 'settings' && <SpeakerTest sinkId={prefs.audioOut} />}
      </fieldset>
      <PttControls prefs={prefs} />
    </div>
  );
}
