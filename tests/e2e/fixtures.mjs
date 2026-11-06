// Shared multi-user helpers. All interaction goes through the real UI; the only DB shortcut is
// admin seeding through the emulator REST API with the emulator's "owner" token.
import { test as base, expect } from '@playwright/test';
import { NS, DB } from './global-setup.mjs';

export { expect };
export const RUN = Date.now().toString(36);
let SEQ = 0;
export const PASSWORD = 'e2e-pass-12345';

export async function adminPut(path, value) {
  const r = await fetch(`${DB}/${path}.json?ns=${NS}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify(value) });
  if (!r.ok) throw new Error(`adminPut ${path}: ${r.status} ${await r.text()}`);
}
export async function adminGet(path) {
  const r = await fetch(`${DB}/${path}.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } });
  return r.json();
}

/** Sign up through the UI (vault is created automatically) and wait for the app shell. */
export async function createUser(page, name) {
  const errors = (page.__errors = []);
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Display name').fill(name);
  await page.getByLabel('Email').fill(`${name.toLowerCase()}-${RUN}-${++SEQ}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  try {
    await expect(page.getByRole('navigation', { name: 'Servers' })).toBeVisible({ timeout: 60_000 });
  } catch (e) {
    throw new Error(`sign-up did not reach the app shell. Page text: ${(await page.locator('body').innerText()).slice(0, 400)} | console errors: ${errors.slice(0, 5).join(' || ')}`);
  }
  return page;
}

export async function uid(page) {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const db = await new Promise((res, rej) => { const q = indexedDB.open('firebaseLocalStorageDb'); q.onsuccess = () => res(q.result); q.onerror = rej; });
    const all = await new Promise((res) => { const q = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll(); q.onsuccess = () => res(q.result); });
    return all[0]?.value?.uid;
  });
}

export async function createServer(page, name) {
  await page.getByRole('button', { name: 'Create or join a server' }).click();
  await page.locator('.ly-choice').first().click();
  await page.getByLabel('Server name').fill(name);
  await page.locator('.ly-form button.primary').click();
  await expect(page.locator('.ly-server-title')).toContainText(name, { timeout: 30_000 });
}

export async function makeInvite(page) {
  await page.locator('.ly-server-title').click();
  await page.getByRole('menuitem', { name: /Invite people/ }).click();
  const input = page.getByLabel('Invite link');
  await expect(input).toBeVisible({ timeout: 30_000 });
  const link = await input.inputValue();
  await page.keyboard.press('Escape');
  return link;
}

export async function joinServer(page, link, name) {
  await page.getByRole('button', { name: 'Create or join a server' }).click();
  await page.locator('.ly-choice').nth(1).click();
  await page.getByPlaceholder('https://…/#/join/…').fill(link);
  await page.locator('.ly-form button.primary').click();
  await expect(page.locator('.ly-server-title')).toContainText(name, { timeout: 30_000 });
}

export async function send(page, text) {
  const box = page.locator('textarea[aria-label^="Message"]');
  await box.fill(text);
  await box.press('Enter');
}

export const test = base.extend({
  /** Four isolated browser contexts, signed up lazily by calling `as('alice')`. */
  users: async ({ browser }, use) => {
    const pages = {};
    const ctxs = [];
    const as = async (name) => {
      if (pages[name]) return pages[name];
      const ctx = await browser.newContext();
      ctxs.push(ctx);
      const page = await ctx.newPage();
      await createUser(page, name[0].toUpperCase() + name.slice(1));
      pages[name] = page;
      return page;
    };
    await use(as);
    for (const c of ctxs) await c.close();
  },
});
