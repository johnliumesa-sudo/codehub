// Premium: the owner unlocks the dashboard (random passcode written with admin REST), generates the
// monthly codes and copies this month's; another member redeems it and gets the badge, the premium look
// and double daily coins; premium-only shop items; the owner revokes; the Database rules panel.
import { randomBytes } from 'node:crypto';
import { test, expect, uid, adminGet, adminPut, createServer, makeInvite, joinServer, send } from './fixtures.mjs';

const monthKey = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function openSettingsTab(page, tab) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'Settings' });
  await dlg.getByRole('button', { name: tab, exact: true }).click();
  return dlg;
}

async function openOwnerTab(page) {
  await page.getByRole('button', { name: 'Open admin panel' }).click();
  const panel = page.getByRole('dialog', { name: 'Admin panel' });
  await panel.getByRole('button', { name: 'Owner', exact: true }).click();
  return panel;
}

async function openShop(page) {
  await page.getByRole('button', { name: 'Add-on shop' }).click();
  await expect(page.getByRole('heading', { name: 'Add-on shop' })).toBeVisible();
}

test('owner dashboard, redeem, perks, premium-only items, revoke, rules panel', async ({ users }) => {
  test.setTimeout(240_000);
  const passcode = randomBytes(12).toString('base64url'); // random per run, never a real value

  // ---- Owner: an app admin unlocks the dashboard with the passcode set in "the console" (admin REST).
  const owner = await users('alice');
  const ownerUid = await uid(owner);
  await adminPut(`admins/${ownerUid}`, { at: Date.now() });
  await adminPut('config/ownerPass', passcode);

  let panel = await openOwnerTab(owner);
  await expect(panel.getByRole('heading', { name: 'Owner dashboard is locked' })).toBeVisible();
  await panel.getByLabel('Owner passcode').fill(`${passcode}x`);
  await panel.getByRole('button', { name: 'Unlock' }).click();
  await expect(panel.getByRole('alert')).toContainText('Wrong passcode');
  // One guess per 30 s per account (rules): the button counts down, then the right passcode works.
  await expect(panel.getByRole('button', { name: /^Wait \d+ s$/ })).toBeVisible();
  await panel.getByLabel('Owner passcode').fill(passcode);
  await expect(panel.getByRole('button', { name: 'Unlock' })).toBeEnabled({ timeout: 35_000 });
  await panel.getByRole('button', { name: 'Unlock' }).click();
  await expect(panel.getByText(/Unlocked · locks in 1[45]:\d\d/)).toBeVisible();
  await expect(panel.getByLabel('Owner passcode')).toHaveCount(0);

  // Generate this month's and the next 11 months' codes.
  await panel.getByRole('button', { name: /Generate codes \(12 missing\)/ }).click();
  await expect(panel.getByText('Created 12 codes.')).toBeVisible();
  const cur = monthKey(Date.now());
  const codes = await adminGet('premiumCodes');
  expect(Object.keys(codes)).toHaveLength(12);
  expect(codes[cur].c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await expect(panel.getByTestId(`code-${cur}`)).toHaveText(codes[cur].c);
  await expect(panel.getByRole('button', { name: /Generate codes$/ })).toBeDisabled();

  // Copy this month's code.
  await panel.getByRole('button', { name: /^Copy .* code$/ }).first().click();
  const code = await owner.evaluate(() => navigator.clipboard.readText());
  expect(code).toBe(codes[cur].c);

  // Database rules panel: the minified rules the build serves, with their size.
  await panel.getByRole('button', { name: 'Show rules' }).click();
  const rulesText = await panel.getByLabel('Minified database rules').inputValue();
  expect(() => JSON.parse(rulesText)).not.toThrow();
  const bytes = Buffer.byteLength(rulesText);
  expect(bytes).toBeLessThanOrEqual(102400);
  await expect(panel.getByTestId('rules-bytes')).toHaveText(bytes.toLocaleString('en-US'));
  await expect(panel.getByText('of 102,400 bytes')).toBeVisible();
  await panel.getByRole('button', { name: 'Copy rules' }).click();
  expect(await owner.evaluate(() => navigator.clipboard.readText())).toBe(rulesText);
  await panel.getByRole('button', { name: 'Close admin panel' }).click();

  // ---- Member: redeems this month's code in Settings → Premium.
  const bob = await users('bob');
  const bobUid = await uid(bob);
  let dlg = await openSettingsTab(bob, 'Premium');
  await expect(dlg.getByRole('heading', { name: 'Codehub Premium' })).toBeVisible();
  await dlg.getByRole('textbox', { name: 'Premium code' }).fill(code.toLowerCase().replace(/-/g, ' '));
  await dlg.getByRole('button', { name: 'Redeem' }).click();
  await expect(dlg.getByRole('status').filter({ hasText: 'Premium is active until' })).toBeVisible();
  await expect(dlg.getByRole('heading', { name: "You're a premium member" })).toBeVisible();
  const rec = await adminGet(`premium/${bobUid}`);
  expect(rec.m).toBe(cur);
  expect(rec.until - rec.at).toBeGreaterThan(30 * 86400000 - 120000);
  // The guess never stays in the page.
  await expect(dlg.getByRole('textbox', { name: 'Premium code' })).toHaveValue('');

  // Premium look: tag, name effect, banner, card effect, avatar frame.
  const look = dlg.getByRole('form', { name: 'Premium look' });
  await look.getByLabel(/^Text/).fill('🚀 Rustacean');
  await look.getByLabel('Name effect').selectOption('gradient');
  await look.getByLabel('Profile banner').selectOption('aurora');
  await look.getByLabel('Profile card effect').selectOption('sparkles');
  await look.getByLabel('Avatar frame').selectOption('gradient');
  await expect(look.locator('.pm-preview .pm-tag')).toHaveText('🚀 Rustacean');
  await look.getByRole('button', { name: 'Save look' }).click();
  await expect(look.getByText(/^Saved\./)).toBeVisible();
  expect(await adminGet(`upub/${bobUid}/premium/look`)).toMatchObject({ tag: '🚀 Rustacean', nameFx: 'gradient', banner: 'aurora', cardFx: 'sparkles', frame: 'gradient' });
  await dlg.getByRole('button', { name: 'Close settings' }).click();

  // Bob's own badge in the user panel; then in a server everyone sees badge, tag and effects.
  await expect(bob.locator('.ly-userpanel .pm-badge')).toBeVisible();
  await createServer(bob, 'Premium Club');
  await send(bob, 'hello from a member');
  const link = await makeInvite(bob);
  await joinServer(owner, link, 'Premium Club');
  const msg = owner.locator('.msg', { hasText: 'hello from a member' });
  await expect(msg.getByRole('img', { name: 'Premium member' })).toBeVisible();
  await expect(msg.locator('.pm-tag')).toHaveText('🚀 Rustacean');
  await expect(msg.locator('.msg-author .pm-name-gradient')).toHaveText('Bob');
  await expect(msg.locator('.pm-frame-gradient')).toBeVisible();
  // Profile card from the member list: banner, card effect, frame, badge.
  if (!(await owner.locator('.ly-members-inner').isVisible())) await owner.getByRole('button', { name: 'Toggle member list' }).click();
  await owner.locator('.ly-member', { hasText: 'Bob' }).click();
  const card = owner.getByRole('dialog', { name: 'Bob' });
  await expect(card.locator('.pm-banner-aurora')).toBeVisible();
  await expect(card.locator('.pm-cardfx-sparkles')).toHaveCount(1);
  await expect(card.locator('.pm-frame-gradient')).toBeVisible();
  await expect(card.locator('.pm-tag')).toHaveText('🚀 Rustacean');
  await owner.keyboard.press('Escape');

  // A non-member writing the same upub block gets nothing shown.
  const ownerLook = { tag: 'Fake VIP', tagA: '#ff0000', nameFx: 'rainbow', fxA: '#ff0000', fxB: '#00ff00', cardFx: 'snow', banner: 'aurora', frame: 'rainbow' };
  await adminPut(`upub/${ownerUid}/premium/look`, ownerLook);
  await send(owner, 'not premium here');
  const plain = bob.locator('.msg', { hasText: 'not premium here' });
  await expect(plain).toBeVisible();
  await expect(plain.locator('.pm-tag, .pm-badge, .pm-name, .pm-frame')).toHaveCount(0);

  // ---- Double daily coins, premium-only items.
  await adminPut('shop/items/premItem', {
    name: 'Members Gem', desc: 'For premium members', kind: 'badge', price: 50, data: { glyph: '💎' }, active: true, premium: true, updatedAt: Date.now(), updatedBy: ownerUid,
  });
  await openShop(bob);
  await bob.getByRole('button', { name: /Claim 100 starter coins/ }).click();
  await expect(bob.locator('.shop-head .shop-wallet-balance strong')).toHaveText('100');
  await adminPut(`wallets/${bobUid}/lastClaim`, Date.now() - 21 * 3600 * 1000);
  await bob.getByRole('button', { name: 'Claim daily coins (+200, premium)' }).click();
  await expect(bob.locator('.shop-head .shop-wallet-balance strong')).toHaveText('300');
  const bobCard = bob.getByRole('article', { name: 'Members Gem' });
  await expect(bobCard.getByText('Premium', { exact: true })).toBeVisible();
  await bobCard.getByRole('button', { name: 'Buy' }).click();
  await bobCard.getByRole('button', { name: /Pay 50/ }).click();
  await expect(bobCard.getByRole('button', { name: 'Equip' })).toBeVisible();
  expect((await adminGet(`wallets/${bobUid}`)).balance).toBe(250);

  await openShop(owner);
  const ownerCard = owner.getByRole('article', { name: 'Members Gem' });
  await expect(ownerCard.getByText('Premium only')).toBeVisible();
  await expect(ownerCard.getByRole('button', { name: 'Buy' })).toHaveCount(0);

  // ---- Revoke: the owner removes Bob's membership; his perks disappear for everyone.
  panel = await openOwnerTab(owner);
  const members = panel.getByRole('list', { name: 'Premium members' });
  const row = members.getByRole('listitem').filter({ hasText: 'Bob' });
  await expect(row).toContainText('expires');
  await row.getByRole('button', { name: 'Revoke' }).click();
  await row.getByRole('button', { name: 'Revoke?' }).click();
  await expect(panel.getByText('Nobody has redeemed a code yet.')).toBeVisible();
  expect(await adminGet(`premium/${bobUid}`)).toBeNull();
  // Lock: the dashboard asks for the passcode again.
  await panel.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(panel.getByLabel('Owner passcode')).toBeVisible();
  await panel.getByRole('button', { name: 'Close admin panel' }).click();

  await expect(bob.locator('.ly-userpanel .pm-badge')).toHaveCount(0);
  dlg = await openSettingsTab(bob, 'Premium');
  await expect(dlg.getByRole('heading', { name: 'Redeem a premium code' })).toBeVisible();
  // Redeeming the same month's code again after a revoke is the owner's call: replace the code to stop it.
  expect(owner.__errors.filter((e) => !/permission_denied|PERMISSION_DENIED|Failed to load resource/.test(e))).toEqual([]);
  expect(bob.__errors.filter((e) => !/permission_denied|PERMISSION_DENIED|Failed to load resource/.test(e))).toEqual([]);
});
