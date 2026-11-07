// Round 3 community shop: a member publishes an item from the shop (live immediately), another member
// buys it, and the creator collects the earning. Everything goes through the real UI and the real rules
// on the emulator; adminGet only checks the resulting database state.
import { test, expect, uid, adminGet } from './fixtures.mjs';

async function openShop(page) {
  await page.getByRole('button', { name: 'Add-on shop' }).click();
  await expect(page.getByRole('heading', { name: 'Add-on shop' })).toBeVisible();
}

async function claim(page) {
  await page.getByRole('button', { name: /Claim 100 starter coins/ }).click();
  await expect(page.locator('.shop-head .shop-wallet-balance strong')).toHaveText('100');
}

test('create an item, sell it, collect the earning', async ({ users }) => {
  const carol = await users('carol');
  const carolUid = await uid(carol);
  await openShop(carol);
  await claim(carol);

  // My items -> Create item: live preview, readability check, then publish.
  await carol.getByRole('tab', { name: /My items/ }).click();
  await expect(carol.getByText("You haven't published anything yet")).toBeVisible();
  await carol.getByRole('button', { name: 'Create item' }).click();
  const form = carol.getByRole('form', { name: 'Create an item' });
  await expect(form).toBeVisible();

  // Nothing is flagged before the first edit; then the empty name is.
  await expect(form.getByRole('alert')).toHaveCount(0);
  await form.getByLabel('Price (coins)').fill('30');
  await expect(form.getByRole('alert')).toContainText('Name is required');
  await form.getByLabel('Name', { exact: true }).fill('Pixel Fox');

  // Editor theme: eleven color tokens, previewed live; an unreadable palette can't be published.
  await form.getByLabel('Kind').selectOption('editorTheme');
  await expect(form.getByRole('group', { name: 'Editor colors' })).toBeVisible();
  await expect(form.getByLabel(/hex$/)).toHaveCount(11);
  await form.getByLabel('Background hex').fill('#102030');
  await expect(form.locator('.shop-pv-code')).toHaveCSS('background-color', 'rgb(16, 32, 48)');
  await form.getByLabel('Foreground hex').fill('#112233');
  await expect(form.getByRole('alert')).toContainText('Foreground needs more contrast');
  await expect(form.getByRole('button', { name: 'Publish item' })).toBeDisabled();
  // Editor add-ons are not offered to creators.
  await expect(form.getByLabel('Kind').locator('option')).toHaveText(['App theme', 'Editor theme', 'Badge', 'Name color']);

  // A badge with a link in its description is refused before it is sent.
  await form.getByLabel('Kind').selectOption('badge');
  await form.getByLabel(/Glyph/).fill('🦊');
  await form.getByLabel('Description').fill('more at example.com');
  await expect(form.getByRole('alert')).toContainText('Links, HTML, CSS and code are not allowed');
  await form.getByLabel('Description').fill('A tiny fox for your name');
  await expect(form.locator('.shop-pv-badge-glyph')).toHaveText('🦊');
  await form.getByRole('button', { name: 'Publish item' }).click();
  await expect(carol.locator('.ly-toast', { hasText: 'Pixel Fox is live in the shop' })).toBeVisible();
  const row = carol.getByRole('list', { name: 'Your items' }).getByRole('listitem').filter({ hasText: 'Pixel Fox' });
  await expect(row).toContainText('Live');
  await expect(row).toContainText('0 sales');

  // One new item per minute: a second publish right away is refused with a clear message.
  await carol.getByRole('button', { name: 'Create item' }).click();
  const again = carol.getByRole('form', { name: 'Create an item' });
  await again.getByLabel('Name', { exact: true }).fill('Second');
  await again.getByLabel(/Glyph/).fill('⭐');
  await again.getByRole('button', { name: 'Publish item' }).click();
  await expect(again.getByRole('alert')).toContainText('one item per minute');
  await again.getByRole('button', { name: 'Cancel' }).click();

  const items = await adminGet('shop/items');
  const [itemId, item] = Object.entries(items).find(([, v]) => v.name === 'Pixel Fox');
  expect(item.by).toBe(carolUid);
  expect(item.price).toBe(30);
  expect(itemId.startsWith('-')).toBe(true);

  // Dave buys it: the card credits Carol, filtering by creator works, the purchase debits exactly 30.
  const dave = await users('dave');
  await openShop(dave);
  await claim(dave);
  const card = dave.getByRole('article', { name: 'Pixel Fox' });
  await expect(card.getByRole('button', { name: 'by Carol' })).toBeVisible();
  await card.getByRole('button', { name: 'by Carol' }).click();
  await expect(dave.locator('.shop-filter-bar')).toContainText('Items by Carol');
  await expect(dave.locator('.shop-grid').getByRole('article')).toHaveCount(1);
  await card.getByRole('button', { name: 'Buy' }).click();
  await card.getByRole('button', { name: 'Pay 30?' }).click();
  await expect(dave.locator('.ly-toast', { hasText: 'Bought Pixel Fox' })).toBeVisible();
  await expect(dave.locator('.shop-head .shop-wallet-balance strong')).toHaveText('70');
  await card.getByRole('button', { name: 'Equip' }).click();
  await expect(card.locator('.shop-card-flag.on')).toContainText('Equipped');
  await dave.getByRole('button', { name: "Show everyone's" }).click();

  const daveUid = await uid(dave);
  expect(await adminGet(`earnings/${carolUid}/${daveUid}_${itemId}`)).toMatchObject({ price: 30 });

  // Carol collects: the Earnings tab shows the sale, Collect all adds exactly 30 and empties the list.
  const earnTab = carol.getByRole('tab', { name: /Earnings/ });
  await expect(earnTab).toContainText('30');
  await earnTab.click();
  await expect(carol.getByRole('list', { name: 'Sales to collect' })).toContainText('Pixel Fox');
  await expect(carol.getByRole('list', { name: 'Sales to collect' })).toContainText('bought by Dave');
  await carol.getByRole('button', { name: 'Collect all' }).click();
  await expect(carol.locator('.ly-toast', { hasText: '+30 coins from 1 sale' })).toBeVisible();
  await expect(carol.locator('.shop-head .shop-wallet-balance strong')).toHaveText('130');
  await expect(carol.getByText('Nothing to collect')).toBeVisible();
  expect(await adminGet(`earnings/${carolUid}`)).toBeNull();
  expect((await adminGet(`wallets/${carolUid}`)).lastEarn).toBe(`${daveUid}_${itemId}`);

  // The sale is counted in My items (history kept in udata).
  await carol.getByRole('tab', { name: /My items/ }).click();
  await expect(row).toContainText('1 sale');

  // Switching the item off hides it from new buyers but Dave keeps it.
  await row.getByRole('button', { name: 'Switch off' }).click();
  await expect(row).toContainText('Off');
  await dave.getByRole('checkbox', { name: 'Owned only' }).check();
  await expect(dave.getByRole('article', { name: 'Pixel Fox' })).toBeVisible();
});
