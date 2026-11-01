import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';

// Firebase web config is public by design; access is enforced by database.rules.json.
const firebaseConfig = {
  apiKey: 'AIzaSyAY6pYqwvdZtxHTB-ih9OjTaaESlp-2Sog',
  authDomain: 'codehub-c1e74.firebaseapp.com',
  databaseURL: 'https://codehub-c1e74-default-rtdb.firebaseio.com',
  projectId: 'codehub-c1e74',
  storageBucket: 'codehub-c1e74.firebasestorage.app',
  messagingSenderId: '991271446721',
  appId: '1:991271446721:web:d3cc83c7f0ac643228cc40',
  measurementId: 'G-GZ21JGS7SN',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// `npm run dev:emu` points the app at the local Auth + Database emulators (`npm run emulators`).
if (import.meta.env.VITE_EMULATORS) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectDatabaseEmulator(db, '127.0.0.1', 9000);
}
