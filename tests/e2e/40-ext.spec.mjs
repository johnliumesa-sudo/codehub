// Round 3 foundation: extension points in the real UI. Test-only entries are registered through
// window.__codehubTestExt (dev / emulator builds only): a slash command, a message action, a header
// button with a chat panel, and a send hook + message badge proving body extras survive encryption.
import { test, expect, createServer, send, adminGet } from './fixtures.mjs';

async function registerTestEntries(page) {
  await page.waitForFunction(() => !!window.__codehubTestExt);
  await page.evaluate(() => {
    const ext = window.__codehubTestExt;
    ext.register('slashCommands', { name: 'shout', description: 'Say it louder', args: '<text>', run: (args) => ({ text: args.toUpperCase() }) });
    ext.register('messageActions', { id: 'test.act', label: 'Test action', run: (m, ctx) => ctx.toast(`Acted on ${m.body?.text}`, 'ok') });
    ext.register('chatHeaderButtons', { id: 'test.btn', label: 'Test panel', icon: 'T', panel: 'test.panel' });
    ext.register('chatPanels', { id: 'test.panel', title: 'Test panel', render: (ctx) => `Loaded ${ctx.messages.filter((m) => m.body).length} messages in ${ctx.conv.kind}` });
    ext.register('sendHooks', {
      id: 'test.tag',
      run: (d) => (d.text.startsWith('tag:') ? { ...d, text: d.text.slice(4), extra: { testx: { v: 1 } } } : d),
    });
    ext.register('messageBadges', {
      id: 'test.badge',
      render: (m) => (m.body?.testx?.v === 1 ? 'TESTX' : null),
      groupKey: (m) => (m.body?.testx ? 'x' : ''),
    });
  });
}

test('slash menu, message action, chat panel and body extras', async ({ users }) => {
  const alice = await users('alice');
  await createServer(alice, 'Ext');
  await alice.getByRole('button', { name: /general/ }).first().click();
  await registerTestEntries(alice);
  const box = alice.locator('textarea[aria-label^="Message"]');

  // Slash autocomplete: "/" lists every command here, grouped (built-in, features, server bots) in a
  // scrolling list; arrows keep the active row in view; Tab completes; Enter runs the command.
  await box.fill('/');
  const menu = alice.getByRole('listbox', { name: 'Commands' });
  await expect(menu).toBeVisible();
  const expected = await alice.evaluate(() => {
    const seen = new Set();
    return window.__codehubTestExt.list('slashCommands').filter((c) => {
      const ok = typeof c.run === 'function' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(c.name || '') && (!c.scopes?.length || c.scopes.includes('channel')) && !seen.has(c.name);
      if (ok) seen.add(c.name);
      return ok;
    }).length;
  });
  expect(expected).toBeGreaterThan(8);
  await expect(menu.getByRole('option')).toHaveCount(expected);
  await expect(menu.getByRole('group', { name: 'Built-in' }).getByRole('option').first()).toHaveText(/\/help/);
  await expect(menu.getByRole('group', { name: 'Features' }).getByRole('option', { name: /\/shout/ })).toHaveCount(1);
  await expect(menu.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  // ArrowUp wraps to the last command, which is scrolled into view inside the list.
  await box.press('ArrowUp');
  const lastOpt = menu.getByRole('option').last();
  await expect(lastOpt).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => menu.evaluate((el) => {
    const a = el.querySelector('[aria-selected="true"]').getBoundingClientRect();
    const b = el.getBoundingClientRect();
    return el.scrollHeight > el.clientHeight && a.top >= b.top && a.bottom <= b.bottom + 1;
  })).toBe(true);
  await box.press('ArrowDown');
  await expect(menu.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  // "/sh": the built-in /shrug comes first, the feature command /shout after it.
  await box.pressSequentially('sh');
  await expect(menu.getByRole('option').first()).toHaveText(/\/shrug/);
  await expect(menu.getByRole('option', { name: /\/shrug/ })).toHaveAttribute('aria-selected', 'true');
  await box.press('ArrowDown');
  await expect(menu.getByRole('option', { name: /\/shout/ })).toHaveAttribute('aria-selected', 'true');
  await box.press('Tab');
  await expect(box).toHaveValue('/shout ');
  await expect(alice.locator('.composer-usage')).toContainText('/shout <text>');
  await box.pressSequentially('hello there');
  await box.press('Enter');
  await expect(alice.locator('.msg-text', { hasText: 'HELLO THERE' })).toBeVisible();
  await expect(box).toHaveValue('');

  // /help is local-only: nothing is sent.
  await box.fill('/help');
  await box.press('Enter');
  const help = alice.getByRole('region', { name: 'Slash commands' });
  await expect(help).toContainText('/shout <text>');
  await expect(help).toContainText('Only you can see this');
  await help.getByRole('button', { name: /Dismiss/ }).click();
  await expect(help).toHaveCount(0);

  // Unknown commands are plain text.
  await send(alice, '/nothing to see');
  await expect(alice.locator('.msg-text', { hasText: '/nothing to see' })).toBeVisible();

  // Message action in the "More actions" menu.
  const msg = alice.locator('.msg', { hasText: 'HELLO THERE' });
  await msg.hover();
  await msg.getByRole('button', { name: 'More actions' }).click();
  await alice.getByRole('menuitem', { name: 'Test action' }).click();
  await expect(alice.locator('.chat-toast')).toContainText('Acted on HELLO THERE');

  // Header button toggles the chat panel; Escape closes it and returns focus.
  const btn = alice.getByRole('button', { name: 'Test panel', exact: true });
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  const panel = alice.getByRole('complementary', { name: 'Test panel' });
  await expect(panel).toContainText(/Loaded \d+ messages in channel/);
  await panel.getByRole('heading', { name: 'Test panel' }).press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(btn).toBeFocused();

  // A send hook's `extra` rides in the encrypted body and reaches m.body after a reload.
  await send(alice, 'tag:badged message');
  const badged = alice.locator('.msg', { hasText: 'badged message' });
  await expect(badged.locator('.msg-meta')).toContainText('TESTX');
  expect(JSON.stringify(await adminGet('messages'))).not.toContain('testx');
  await alice.reload();
  await registerTestEntries(alice);
  await expect(alice.locator('.msg', { hasText: 'badged message' }).locator('.msg-meta')).toContainText('TESTX');
  await expect(alice.locator('.msg', { hasText: 'HELLO THERE' }).locator('.msg-meta')).not.toContainText('TESTX');
});

test('workspace slots: app mount, sidebar, palette, settings tabs, profile, composer button, server template', async ({ users }) => {
  const alice = await users('alice');
  await alice.waitForFunction(() => !!window.__codehubTestExt);
  await alice.evaluate(() => {
    const { register, h } = window.__codehubTestExt;
    register('appMounts', { id: 't.mount', Component: ({ ctx }) => h('span', { 'data-testid': 'ext-mount', hidden: true }, `mounted for ${ctx.me.name}`) });
    register('sidebarSections', { id: 't.side', render: (ctx) => h('div', { 'data-testid': 'ext-side' }, `Side ${ctx.view}`) });
    register('userSettingsTabs', { id: 't.tab', label: 'Test tab', render: (ctx) => h('p', null, `Hello ${ctx.me.name}`) });
    register('paletteActions', { id: 't.pal', title: 'Open the test tab', run: (ctx) => ctx.openSettings('t.tab') });
    register('serverCreateOptions', {
      id: 't.tpl',
      label: 'From the test template',
      description: 'A lobby and a voice room',
      render: (ctx) => h('button', {
        type: 'button',
        className: 'btn primary',
        onClick: () => ctx.createWith({ name: 'Templated', channels: [{ type: 'text', name: 'lobby' }, { type: 'voice', name: 'talk' }] }),
      }, 'Create from template'),
    });
    register('serverSettingsTabs', { id: 't.stab', label: 'Test server tab', visible: (ctx) => !!ctx.perms.manageApps, render: (ctx) => h('p', null, `Server tab for ${ctx.server.myRole}`) });
    register('profileSections', { id: 't.prof', render: (uid, ctx) => h('p', { 'data-testid': 'ext-prof' }, ctx.isMe ? 'this is me' : 'someone else') });
    register('composerButtons', { id: 't.cb', label: 'Insert test text', icon: '✳', run: (ctx) => ctx.insertText('inserted by ext') });
  });

  await expect(alice.getByTestId('ext-mount')).toHaveText(/mounted for Alice/);
  await expect(alice.getByTestId('ext-side')).toHaveText('Side home');

  // Palette action -> openSettings(tab id) -> the extension tab.
  await alice.keyboard.press('Control+k');
  await alice.keyboard.type('Open the test tab');
  await alice.keyboard.press('Enter');
  await expect(alice.getByRole('heading', { name: 'Test tab' })).toBeVisible();
  await expect(alice.getByText('Hello Alice')).toBeVisible();
  await alice.getByRole('button', { name: 'Close settings' }).click();

  // Server template: the create flow offers the option, createWith makes the server with its channels.
  await alice.getByRole('button', { name: 'Create or join a server' }).click();
  await alice.getByRole('button', { name: /From the test template/ }).click();
  await alice.getByRole('button', { name: 'Create from template' }).click();
  await expect(alice.locator('.ly-server-title')).toContainText('Templated', { timeout: 30_000 });
  await expect(alice.locator('.ly-chan-name', { hasText: 'lobby' })).toBeVisible();
  await expect(alice.locator('.ly-chan-name', { hasText: 'talk' })).toBeVisible();
  await expect(alice.locator('.ly-chan-name', { hasText: 'general' })).toHaveCount(0);
  await expect(alice.getByTestId('ext-side')).toHaveText('Side server');

  // Composer button -> ctx.insertText.
  await alice.getByRole('button', { name: 'Insert test text' }).click();
  await expect(alice.locator('textarea[aria-label^="Message"]')).toHaveValue('inserted by ext');

  // Profile section in the member card.
  await alice.locator('.ly-member', { hasText: 'Alice' }).click();
  await expect(alice.getByTestId('ext-prof')).toHaveText('this is me');
  await alice.keyboard.press('Escape');

  // Server settings tab (visible to the owner, who holds manageApps).
  await alice.locator('.ly-server-title').click();
  await alice.getByRole('menuitem', { name: /Server settings/ }).click();
  await alice.getByRole('tab', { name: /Test server tab/ }).click();
  await expect(alice.getByText('Server tab for owner')).toBeVisible();
});
