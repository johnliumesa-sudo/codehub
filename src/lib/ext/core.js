// Round 3 core extensions, loaded once before the feature folders: the slash-command send hook,
// the built-in /help command and, in dev or emulator builds only, a test hook for browser tests.
import { createElement } from 'react';
import { list, register, unregister } from './registry.js';
import { installCoreExtensions } from './send.js';

installCoreExtensions();

// Browser tests register throwaway entries through window.__codehubTestExt (h = React.createElement
// for render functions). Never in production builds.
if ((import.meta.env.DEV || import.meta.env.VITE_EMULATORS) && typeof window !== 'undefined') {
  window.__codehubTestExt = Object.freeze({ register, unregister, list, h: createElement });
}
