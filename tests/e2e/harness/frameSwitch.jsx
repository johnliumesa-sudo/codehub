// Test harness (served by the e2e Vite dev server, never bundled): mounts the real SandboxFrame with the
// real saved-game storage in a parent shaped like the Arcade player, so a test can switch the game id
// while a game is running. That path has no UI trigger while the Arcade is shown, but SandboxFrame
// must keep each document's messages away from another game's storage regardless.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import SandboxFrame from '../../../src/components/sandbox/SandboxFrame.jsx';
import { loadGameSave, peekGameSave, storeGameSave } from '../../../src/lib/gameSaves.js';

const UID = 'harness-user';

function Player({ gameId, code }) {
  const [doc, setDoc] = useState({ status: 'loading', html: '' });
  const load = useCallback(async () => {
    setDoc({ status: 'loading', html: '' });
    const [html] = await Promise.all([new Promise((r) => setTimeout(() => r(code[gameId]), 50)), loadGameSave(UID, gameId)]);
    setDoc({ status: 'ready', html });
  }, [gameId, code]);
  useEffect(() => {
    load();
  }, [load]);
  const storage = useMemo(() => ({ load: () => peekGameSave(UID, gameId), save: (a, d) => storeGameSave(UID, gameId, a, d) }), [gameId]);
  if (doc.status !== 'ready') return <p>loading</p>;
  // No key per game on purpose: the frame must not depend on its parent remounting it.
  return <SandboxFrame html={doc.html} profile="play" mode="game" storage={storage} title="harness game" />;
}

/** Mount into a fresh element; returns { open(gameId), peek(gameId) }. */
export function mount(code, start) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  let open = null;
  function App() {
    const [g, setG] = useState(start);
    open = setG;
    return <Player gameId={g} code={code} />;
  }
  const root = createRoot(el);
  root.render(<App />);
  return {
    open: (g) => open(g),
    peek: (g) => peekGameSave(UID, g),
    unmount: () => {
      root.unmount();
      el.remove();
    },
  };
}
