// The browser tab title has one owner. Workspace names the page; unread sources report counts.
//   "(3) #general · My server — Codehub"
// The count shown is the largest one reported, not the sum: the sources overlap (a new DM is both an
// unread message for notify.js and an unread item in the notification center).
const counts = new Map(); // source -> unread count
let page = '';

/** Pure: the title for a page name and a list of unread counts. */
export function formatTitle(name, values = []) {
  const n = Math.max(0, ...values.filter((v) => Number.isFinite(v)));
  const base = name ? `${name} — Codehub` : 'Codehub';
  return n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base;
}

function render() {
  if (typeof document !== 'undefined') document.title = formatTitle(page, [...counts.values()]);
}

/** Workspace: the open view's name ('' for none). */
export function setTitlePage(name) {
  page = name ? String(name) : '';
  render();
}

/** An unread source ('messages', 'notifs', ...) reports its count; 0 clears it. */
export function setTitleCount(source, n) {
  if (n > 0) counts.set(source, n);
  else counts.delete(source);
  render();
}
