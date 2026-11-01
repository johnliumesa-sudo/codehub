import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from './lib/firebase.js';
import { isUnlocked, lock } from './lib/keystore.js';
import AuthScreen from './components/auth/AuthScreen.jsx';
import VaultScreen from './components/auth/VaultScreen.jsx';
import Workspace from './components/layout/Workspace.jsx';
import { resetProfiles } from './lib/profiles.js';

// Invite links look like  #/join/{sid}/{inviteId}/{keyB64}. The key lives in the
// fragment, which browsers never send to any server. Stash it until the vault unlocks.
function captureInvite() {
  const m = location.hash.match(/^#\/join\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (m) {
    sessionStorage.setItem('codehub.pendingInvite', JSON.stringify({ sid: m[1], inviteId: m[2], key: m[3] }));
    history.replaceState(null, '', location.pathname + location.search);
  }
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    captureInvite();
    window.addEventListener('hashchange', captureInvite);
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) {
        lock();
        resetProfiles();
        setUnlocked(false);
      }
      setUser(u);
    });
    return () => {
      unsub();
      window.removeEventListener('hashchange', captureInvite);
    };
  }, []);

  if (user === undefined) return <div className="splash"><div className="spinner" /></div>;
  if (!user) return <AuthScreen />;
  if (!unlocked || !isUnlocked()) return <VaultScreen user={user} onUnlocked={() => setUnlocked(true)} />;
  return <Workspace user={user} />;
}
