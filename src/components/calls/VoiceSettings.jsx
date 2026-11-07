// Settings -> "Voice & video" (registered from src/features/calls/index.js as a userSettingsTabs entry).
import { useActiveCall } from '../../lib/calls/useCall.js';
import DeviceForm from './DeviceForm.jsx';
import './calls.css';

export default function VoiceSettings() {
  const call = useActiveCall();
  const inCall = !!call && (call.status === 'live' || call.status === 'joining');
  return (
    <div className="settings-section call-settings">
      <div className="settings-card">
        <h3>Voice &amp; video</h3>
        <p className="muted">
          Choose your microphone, camera and speaker, test them, and set up push-to-talk. These choices are kept in this
          browser only.{inCall ? ' Changes apply to your current call right away.' : ''}
        </p>
        <DeviceForm mode="settings" />
      </div>
      <div className="settings-card">
        <h3>How calls connect</h3>
        <p className="muted">
          Calls go directly between browsers (peer-to-peer, up to 6 people), so the people in a call can see each other’s IP
          addresses. If a call shows “Couldn’t connect”, one of the networks blocks direct connections and an app admin
          needs to add a TURN relay (Admin panel → GIFs &amp; calls). Speaking indicators and the level meter are measured
          on your device; nothing about them is sent.
        </p>
      </div>
    </div>
  );
}
