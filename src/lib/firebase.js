import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';

// Firebase web config is public by design; access is enforced by database.rules.json.
const firebaseConfig = {
  apiKey: 'AIzaSyAjkYA-NXFzC6-6KuY2ayvKEOJ4w-GnVeA',
  authDomain: 'codehub-dc9a4.firebaseapp.com',
  databaseURL: 'https://codehub-dc9a4-default-rtdb.firebaseio.com',
  projectId: 'codehub-dc9a4',
  storageBucket: 'codehub-dc9a4.firebasestorage.app',
  messagingSenderId: '541796055224',
  appId: '1:541796055224:web:4b4a61e891d1a868ebdc4d',
  measurementId: 'G-0PGZC98BNP',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// `npm run dev:emu` points the app at the local Auth + Database emulators (`npm run emulators`).
// Browser tests on another port block (CODEHUB_PORT_BASE) pass VITE_EMU_AUTH_PORT / VITE_EMU_DB_PORT.
if (import.meta.env.VITE_EMULATORS) {
  connectAuthEmulator(auth, `http://127.0.0.1:${Number(import.meta.env.VITE_EMU_AUTH_PORT) || 9099}`, { disableWarnings: true });
  connectDatabaseEmulator(db, '127.0.0.1', Number(import.meta.env.VITE_EMU_DB_PORT) || 9000);
}
