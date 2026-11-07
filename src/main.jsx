import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './components/media/media.css';
import { initTheme } from './lib/theme.js';
import './features/index.js'; // round 3 extension registrations (src/features/*)
import { startUpdateWatch } from './lib/appVersion.js';
import { getActiveCall } from './lib/calls/useCall.js';
import UpdateBanner from './components/common/UpdateBanner.jsx';

initTheme();
// Deploy notice and recovery from missing lazy chunks. Besides typed text, a reload would drop an active
// call or files waiting in a composer's attachment tray, so neither allows an automatic reload.
startUpdateWatch({ busy: () => !!getActiveCall() || !!document.querySelector('.md-tray-item') });

createRoot(document.getElementById('root')).render(
  <>
    <App />
    <UpdateBanner />
  </>,
);
