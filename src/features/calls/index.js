// Workstream: calls (reliability, device settings, push-to-talk, speaking indicators, raise hand, reactions, spotlight).
// The call UI itself lives in src/components/calls (CallView, tiles, device menu); this file registers the
// Settings tab and command palette actions. See docs/features/calls.md.
import { createElement } from 'react';
import { register } from '../../lib/ext/registry.js';
import { callActions, getActiveCall } from '../../lib/calls/useCall.js';
import { loadPrefs, savePrefs } from '../../lib/calls/prefs.js';
import VoiceSettings from '../../components/calls/VoiceSettings.jsx';

register('userSettingsTabs', {
  id: 'voice',
  label: 'Voice & video',
  render: () => createElement(VoiceSettings),
});

register('paletteActions', {
  id: 'calls.settings',
  title: 'Voice & video settings',
  hint: 'Microphone, camera, speaker, push-to-talk',
  keywords: ['audio', 'devices', 'microphone', 'camera', 'speaker', 'call'],
  run: (ctx) => ctx.openSettings?.('voice'),
});

register('paletteActions', {
  id: 'calls.ptt',
  title: 'Toggle push-to-talk',
  hint: 'Talk only while holding a key',
  keywords: ['ptt', 'voice', 'call', 'microphone'],
  run: (ctx) => {
    const on = !loadPrefs().ptt;
    savePrefs({ ptt: on });
    ctx.toast?.(on ? 'Push-to-talk on' : 'Push-to-talk off', 'info');
  },
});

register('paletteActions', {
  id: 'calls.hand',
  title: 'Raise or lower hand',
  hint: 'In the current call',
  keywords: ['call', 'hand', 'raise'],
  run: (ctx) => {
    if (getActiveCall()?.status !== 'live') ctx.toast?.("You're not in a call", 'info');
    else callActions.raiseHand();
  },
});
