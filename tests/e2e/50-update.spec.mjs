// Update notice (src/lib/appVersion.js, UpdateBanner.jsx): an open tab notices a deploy through
// version.json and recovers when a lazy chunk is gone. The Vite dev server serves version.json with the
// running build's id, like a production build; routes stand in for a deploy and for deleted chunks.
import { test, expect } from './fixtures.mjs';

const VERSION_RE = /\/version\.json(\?|$)/;
const banner = (page) => page.getByRole('status', { name: 'Codehub update' });
const later = (ms) => new Date(Date.now() + ms).toISOString();
const reloadRecord = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('codehub.autoReload') || 'null'));
const markPage = (page) => page.evaluate(() => { window.__e2eSamePage = true; });
const samePage = (page) => page.evaluate(() => window.__e2eSamePage === true);

/** Load the app and return the running build's version record (served by the dev server). */
async function openApp(page) {
  const first = page.waitForResponse(VERSION_RE);
  await page.goto('/');
  const res = await first;
  expect(res.request().url()).toMatch(/\/version\.json\?t=\d+$/); // cache-busting query
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible();
  return res.json();
}

/** Ask for a version check the way the browser would (coming back online) and wait for the answer. */
async function checkNow(page) {
  const res = page.waitForResponse(VERSION_RE);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await res;
}

test('a deploy shows the update banner; Reload reloads and Later waits for the next build', async ({ page }) => {
  const running = await openApp(page);
  expect(running.v).toMatch(/^[\w.-]{1,64}$/);
  await expect(banner(page)).toBeEmpty(); // same build: nothing to say

  let deployed = { v: 'e2e-next', t: later(60_000) };
  await page.route(VERSION_RE, (route) => route.fulfill({ json: deployed, headers: { 'cache-control': 'no-store' } }));
  await checkNow(page);
  await expect(banner(page)).toContainText('Codehub has been updated. Reload to get the latest version.');

  await markPage(page);
  const loaded = page.waitForEvent('load');
  await banner(page).getByRole('button', { name: 'Reload' }).click();
  await loaded;
  expect(await samePage(page)).toBe(false);
  // The routed "deploy" is still newer than what the dev server runs, so the start-up check shows it again.
  await expect(banner(page).getByText('Codehub has been updated.')).toBeVisible();

  // Keyboard: the banner never takes focus, and its buttons are reachable.
  await expect(banner(page).getByRole('button', { name: 'Reload' })).not.toBeFocused();
  await banner(page).getByRole('button', { name: 'Later' }).focus();
  await page.keyboard.press('Enter');
  await expect(banner(page)).toBeEmpty();
  await checkNow(page);
  await page.waitForTimeout(300);
  await expect(banner(page)).toBeEmpty(); // Later holds for the same build

  deployed = { v: 'e2e-newer', t: later(120_000) };
  await checkNow(page);
  await expect(banner(page)).toContainText('Codehub has been updated.');

  // Mobile width, both themes: the card stays inside the viewport and uses the theme's surface.
  await page.setViewportSize({ width: 360, height: 720 });
  const card = banner(page).locator('.upd-card');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    const box = await card.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(14, 17, 24)');
    await page.screenshot({ path: `test-results/update-banner-${theme}-mobile.png` });
  }

  // Back on the running build (the deploy was rolled back to it): the banner goes away.
  await page.unroute(VERSION_RE);
  await checkNow(page);
  await expect(banner(page)).toBeEmpty();
});

test('a missing chunk reloads once when nothing is typed, then asks', async ({ page }) => {
  const running = await openApp(page);
  // A chunk the old build still references but the deploy deleted.
  await page.route('**/assets/Gone-e2e.js', (route) => route.fulfill({ status: 404, body: 'Not found' }));
  const loadGone = () => page.evaluate(() => { import('./assets/Gone-e2e.js'); }); // unhandled, like a lazy view

  // Something typed: never reload by itself.
  await page.getByLabel('Email').fill('half-typed@example.test');
  await markPage(page);
  await loadGone();
  await expect(banner(page)).toContainText("Part of Codehub couldn't load. Reload to get the latest version.");
  expect(await samePage(page)).toBe(true);
  expect(await reloadRecord(page)).toBeNull();
  await banner(page).getByRole('button', { name: 'Later' }).click();
  await expect(banner(page)).toBeEmpty();

  // Nothing typed: one automatic reload, recorded for the loop guard.
  await page.getByLabel('Email').fill('');
  await page.evaluate(() => document.activeElement?.blur());
  const loaded = page.waitForEvent('load');
  await loadGone();
  await loaded;
  expect(await samePage(page)).toBe(false);
  expect(await reloadRecord(page)).toMatchObject({ from: running.v });

  // Same build, same failure: no second automatic reload (no loop), the banner asks instead.
  await expect(page.getByRole('button', { name: 'Create an account' })).toBeVisible();
  await markPage(page);
  await loadGone();
  await expect(banner(page)).toContainText("Part of Codehub couldn't load.");
  await page.waitForTimeout(500);
  expect(await samePage(page)).toBe(true);
});

test('a lazy view whose chunk is gone reloads into the remembered view, then explains', async ({ users }) => {
  const alice = await users('alice');
  const gamesChunk = /\/src\/components\/games\/GamesView\.jsx(\?|$)/;
  await alice.route(gamesChunk, (route) => route.abort());
  await markPage(alice);
  const loaded = alice.waitForEvent('load');
  await alice.getByRole('button', { name: 'Arcade (public games)' }).click();
  await loaded; // the one automatic reload
  expect(await samePage(alice)).toBe(false);

  // The app reopens the Arcade, the chunk is still missing: the view and the banner explain, no loop.
  await expect(alice.getByRole('heading', { name: "This part of Codehub couldn't load" })).toBeVisible({ timeout: 60_000 });
  await expect(banner(alice)).toContainText("Part of Codehub couldn't load.");
  await markPage(alice);
  await alice.waitForTimeout(500);
  expect(await samePage(alice)).toBe(true);

  // The chunk is back (the reload gets the new build): Reload opens the Arcade.
  await alice.unroute(gamesChunk);
  const again = alice.waitForEvent('load');
  await banner(alice).getByRole('button', { name: 'Reload' }).click();
  await again;
  await expect(alice.getByRole('heading', { name: "This part of Codehub couldn't load" })).toHaveCount(0);
  await expect(alice.getByRole('heading', { level: 1, name: 'Arcade' })).toBeVisible({ timeout: 60_000 });
  await expect(banner(alice)).toBeEmpty();
});
