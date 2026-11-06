// UNVERIFIED: written but never executed (Playwright test runner hung in the overnight sandbox).
import { test, expect } from './fixtures.mjs';

test('theme toggle light/dark persists across reload', async ({ users }) => {
  const a = await users('alice');
  await a.getByRole('button', { name: /settings/i }).first().click();
  await a.getByRole('tab', { name: /Appearance/i }).click();
  const group = a.getByRole('radiogroup', { name: 'Theme' });
  await group.getByRole('radio', { name: /light/i }).click();
  await expect(a.locator('html')).toHaveAttribute('data-theme', 'light');
  await a.screenshot({ path: 'test-results/theme-light.png' });
  await a.reload();
  await expect(a.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await a.evaluate(() => localStorage.getItem('codehub.theme'))).toBe('light');
  await a.getByRole('button', { name: /settings/i }).first().click();
  await a.getByRole('tab', { name: /Appearance/i }).click();
  await a.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: /dark/i }).click();
  await expect(a.locator('html')).toHaveAttribute('data-theme', 'dark');
  await a.screenshot({ path: 'test-results/theme-dark.png' });
});
