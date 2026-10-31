// Server clock estimate via .info/serverTimeOffset (used for staleness checks and snapshot ts).
import { onValue, ref } from 'firebase/database';
import { db } from '../firebase.js';

let offset = 0;
let started = false;

function start() {
  if (started) return;
  started = true;
  onValue(ref(db, '.info/serverTimeOffset'), (s) => {
    offset = Number(s.val()) || 0;
  });
}

export function serverNow() {
  start();
  return Date.now() + offset;
}

start();
