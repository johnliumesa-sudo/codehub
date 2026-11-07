// Agentic coding mode for codespaces (premium; the member's own Anthropic API key).
// Registers the Agent button (collabTools: the workspace toolbar and the empty workspace's actions)
// and the Agent panel (collabMounts: beside the editor, kept while files open and close).
// See docs/features/premium.md "Agent mode".
import { Suspense, createElement as h, lazy } from 'react';
import { register } from '../../../lib/ext/registry.js';
import { onLock } from '../../../lib/keystore.js';
import { resetAll } from './lib/run.js';

// The panel (and the collab code it uses) loads with the workspace, not with the app shell.
const panel = () => import('./components/AgentPanel.jsx');
const AgentButton = lazy(() => panel().then((m) => ({ default: m.AgentButton })));
const AgentMount = lazy(() => panel().then((m) => ({ default: m.AgentMount })));

register('collabTools', { id: 'premium.agent', order: 100, render: (ctx, place) => h(Suspense, { fallback: null }, h(AgentButton, { ctx, place })) });
register('collabMounts', { id: 'premium.agent', render: (ctx) => h(Suspense, { fallback: null }, h(AgentMount, { ctx })) });

// Locking the vault (or signing out) stops every run and drops the transcripts (they hold decrypted
// file contents) and the undo records.
onLock(() => resetAll());
