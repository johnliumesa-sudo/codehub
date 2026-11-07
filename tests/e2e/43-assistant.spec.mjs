// Assistant workstream (features 7–11) in the real UI. The Claude API is never reached: every request
// to https://api.anthropic.com is answered by a Playwright route that streams a fake SSE response, and
// the key is a made-up string. The mock records each request so the tests check what was sent.
import { test, expect, createServer, send, adminGet, makeInvite, joinServer } from './fixtures.mjs';

const FAKE_KEY = 'sk-ant-api03-e2e-fake-key-never-valid-0000';
const PASS = 'correct horse battery';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-expose-headers': '*',
};

function sse({ text, stop = 'end_turn', model, details = null }) {
  const chunks = text ? text.match(/[\s\S]{1,12}/g) : [];
  const ev = [
    { type: 'message_start', message: { id: 'msg_e2e', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ...chunks.map((t) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })),
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null, stop_details: details }, usage: { output_tokens: 25 } },
    { type: 'message_stop' },
  ];
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const lastUser = (body) => {
  const m = [...(body.messages || [])].reverse().find((x) => x.role === 'user');
  return typeof m?.content === 'string' ? m.content : '';
};

/** Canned replies keyed on what the app asked for. */
function cannedReply(body) {
  const system = typeof body.system === 'string' ? body.system : '';
  const content = lastUser(body);
  if (system.includes('Translate the text')) return 'Hello, how are you?';
  if (system.includes('about to send')) return content.includes('<draft>') ? 'I have an idea.' : "Sounds good, I'll be there at 5.";
  if (content.includes('## Key points')) return '## Key points\n- The deploy is broken\n\n## Decisions\nNone';
  if (content.startsWith('Explain')) return 'This code **logs** the number 1.';
  if (content.startsWith('Summarize this thread')) return 'They agreed to **roll back** the deploy.';
  const q = content.trim().split('\n').filter(Boolean).at(-1) || '';
  return `**Answer:** ${q}`;
}

async function mockClaude(page) {
  const mock = { requests: [], queue: [] };
  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*' } });
      return;
    }
    const body = JSON.parse(req.postData() || '{}');
    mock.requests.push({ url: req.url(), body, headers: await req.allHeaders() });
    const next = mock.queue.shift() || {};
    if (next.delay) await new Promise((r) => setTimeout(r, next.delay));
    try {
      if (next.status) {
        await route.fulfill({
          status: next.status,
          headers: { ...CORS, 'content-type': 'application/json', ...(next.headers || {}) },
          body: JSON.stringify({ type: 'error', error: { type: next.type, message: next.message || 'error' } }),
        });
      } else if (!body.stream) {
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } }),
        });
      } else {
        await route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'text/event-stream' },
          body: sse({ text: next.text ?? cannedReply(body), stop: next.stop, model: body.model, details: next.details }),
        });
      }
    } catch {
      /* the page aborted the request (Stop) */
    }
  });
  return mock;
}

const composer = (page) => page.locator('textarea[aria-label^="Message"]');
const panelOf = (page) => page.getByRole('complementary', { name: 'Assistant' });
const headerBtn = (page, name) => page.locator('.chat-header').getByRole('button', { name, exact: true });

async function openAssistantSettings(page) {
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Assistant settings');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Anthropic API key' })).toBeVisible();
}

async function saveKey(page, { passphrase } = {}) {
  await openAssistantSettings(page);
  await page.getByLabel('API key', { exact: true }).fill(FAKE_KEY);
  if (passphrase) {
    await page.getByLabel('Lock the key with a passphrase').check();
    await page.getByLabel('Passphrase', { exact: true }).fill(passphrase);
    await page.getByLabel('Confirm passphrase').fill(passphrase);
  }
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.locator('.settings-ok')).toContainText('Key saved in this browser');
}

async function messageAction(page, text, action) {
  const msg = page.locator('.msg', { hasText: text }).last();
  await msg.hover();
  await msg.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

test('setup, streaming panel, context, catch me up, /ask + share, workspace toggle, locked key', async ({ users }) => {
  const alice = await users('alice');
  const mock = await mockClaude(alice);
  await createServer(alice, 'AI Lab');
  await alice.getByRole('button', { name: /general/ }).first().click();
  await send(alice, 'Deploy is broken again');
  await expect(alice.locator('.msg-text', { hasText: 'Deploy is broken again' })).toBeVisible();

  // ---- Settings → Assistant: privacy notice, key with passphrase, Test key, effort ----
  await openAssistantSettings(alice);
  await expect(alice.getByText(/Nothing is sent unless you use an assistant action/)).toBeVisible();
  await expect(alice.getByText('No key saved in this browser')).toBeVisible();
  await alice.getByLabel('API key', { exact: true }).fill(FAKE_KEY);
  await alice.getByLabel('Lock the key with a passphrase').check();
  await alice.getByLabel('Passphrase', { exact: true }).fill(PASS);
  await alice.getByLabel('Confirm passphrase').fill(PASS);
  await alice.getByRole('button', { name: 'Save key' }).click();
  await expect(alice.locator('.settings-ok')).toHaveText('Key saved in this browser, locked with your passphrase.');
  await expect(alice.getByText(/locked with a passphrase|unlocked for this session/)).toContainText('unlocked for this session');

  await alice.getByRole('button', { name: 'Test key' }).click();
  await expect(alice.locator('.settings-ok')).toHaveText('The key works: Claude Opus 5.5 answered.');
  const testReq = mock.requests.at(-1);
  expect(testReq.body.stream).toBeFalsy();
  expect(testReq.body.max_tokens).toBeLessThanOrEqual(64);
  expect(testReq.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  expect(`${testReq.headers.authorization || ''} ${testReq.headers['x-api-key'] || ''}`).toContain(FAKE_KEY);
  await expect(alice.getByLabel('Token usage this session')).toContainText('Requests1');

  await alice.getByLabel('Effort').selectOption('medium');
  // The key never reaches the database, and localStorage only holds ciphertext.
  const stored = await alice.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('codehub.assistant.key.')).map(([, v]) => v).join(''));
  expect(stored).toContain('"mode":"locked"');
  expect(stored).not.toContain(FAKE_KEY);
  expect(JSON.stringify(await adminGet(''))).not.toContain(FAKE_KEY);
  await alice.getByRole('button', { name: 'Close settings' }).click();

  // ---- Panel: streamed Markdown reply; exact request shape; nothing from the chat by default ----
  await headerBtn(alice, 'Assistant').click();
  const panel = panelOf(alice);
  await expect(panel).toBeVisible();
  await panel.getByLabel('Ask Claude').fill('What is RTDB?');
  await panel.getByLabel('Ask Claude').press('Enter');
  await expect(panel.locator('.asst-turn.bot.done')).toHaveCount(1);
  await expect(panel.locator('.asst-turn.bot strong', { hasText: 'Answer:' })).toBeVisible();
  await expect(panel.locator('.asst-turn.bot')).toContainText('What is RTDB?');
  let req = mock.requests.at(-1);
  expect(req.body.model).toBe('claude-opus-5-5');
  expect(req.body.max_tokens).toBe(64000);
  expect(req.body.stream).toBe(true);
  expect(req.body.output_config).toEqual({ effort: 'medium' });
  expect(req.body.fallbacks).toBe('default');
  expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
  for (const k of ['thinking', 'temperature', 'top_p', 'top_k']) expect(req.body[k]).toBeUndefined();
  expect(req.body.messages).toEqual([{ role: 'user', content: 'What is RTDB?' }]);
  expect(req.body.system).toContain('helping Alice');
  expect(JSON.stringify(req.body)).not.toContain('Deploy is broken');

  // "Include last N messages" sends the decrypted recent messages, and the history goes back too.
  await panel.getByLabel('Include last').check();
  await panel.getByLabel('Ask Claude').fill('What broke?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.asst-turn.bot.done')).toHaveCount(2);
  req = mock.requests.at(-1);
  expect(req.body.messages).toHaveLength(3);
  expect(req.body.messages[1]).toEqual({ role: 'assistant', content: '**Answer:** What is RTDB?' });
  expect(req.body.messages[2].content).toContain('<transcript>');
  expect(req.body.messages[2].content).toContain('Alice (me): Deploy is broken again');
  await panel.getByLabel('Include last').uncheck();

  // Copy-free hand-off: insert a reply into the composer.
  await panel.getByRole('button', { name: 'Insert into composer' }).last().click();
  await expect(composer(alice)).toHaveValue('**Answer:** What broke?');
  await composer(alice).fill('');

  // ---- Catch me up (header button): sections, the conversation's messages ----
  await headerBtn(alice, 'Catch me up').click();
  await expect(panel.locator('.asst-turn.user').last()).toContainText('Catch me up on #general');
  await expect(panel.locator('.asst-turn.bot').last().getByRole('heading', { name: 'Key points' })).toBeVisible();
  req = mock.requests.at(-1);
  expect(lastUser(req.body)).toContain('## Mentions of me');
  expect(lastUser(req.body)).toContain('Deploy is broken again');

  // ---- /ask: private answer in the panel, never posted, until "Share to #general" ----
  await composer(alice).fill('/ask How do I roll back?');
  await composer(alice).press('Enter');
  await expect(panel.locator('.asst-turn.user').last()).toContainText('/ask How do I roll back?');
  await expect(panel.locator('.asst-turn.bot.done').last()).toContainText('Answer: How do I roll back?');
  await expect(composer(alice)).toHaveValue('');
  await expect(alice.locator('.msg-text', { hasText: 'roll back' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Share to #general' }).click();
  const shared = alice.locator('.msg', { hasText: 'Asked Claude:' });
  await expect(shared).toBeVisible();
  await expect(shared.locator('.asst-badge')).toHaveText('AI');
  expect(JSON.stringify(await adminGet('messages'))).not.toContain('roll back');

  // ---- Workspace-level toggle: sidebar button and Ctrl+Shift+Y; the panel follows conversations ----
  const sideToggle = alice.locator('.asst-side-toggle');
  await expect(sideToggle).toHaveAttribute('aria-pressed', 'true');
  await alice.getByRole('button', { name: 'Create text channel' }).click();
  await alice.getByRole('dialog', { name: 'Create channel' }).getByLabel('Name').fill('random');
  await alice.getByRole('dialog', { name: 'Create channel' }).getByRole('button', { name: 'Create' }).click();
  await expect(alice.locator('.chat-title-text')).toHaveText('random');
  await expect(panelOf(alice)).toBeVisible();
  await expect(panelOf(alice).locator('.asst-turn.bot.done')).toHaveCount(4); // same conversation, kept in memory
  // The /ask answer from #general can't be shared into #random (it may quote #general's messages).
  await expect(panelOf(alice).getByRole('button', { name: /^Share to/ })).toHaveCount(0);
  await expect(panelOf(alice).locator('.asst-share-note')).toHaveText('Asked in #general: open it to share this answer there.');
  await sideToggle.click();
  await expect(panelOf(alice)).toHaveCount(0);
  await expect(sideToggle).toHaveAttribute('aria-pressed', 'false');
  await alice.locator('body').press('Control+Shift+Y');
  await expect(panelOf(alice)).toBeVisible();
  await headerBtn(alice, 'Assistant').click();
  await expect(panelOf(alice)).toHaveCount(0);
  await expect(sideToggle).toHaveAttribute('aria-pressed', 'false');

  // ---- Reload: conversation gone, locked key asks for the passphrase once ----
  await alice.reload();
  await expect(alice.getByRole('navigation', { name: 'Servers' })).toBeVisible({ timeout: 60_000 });
  await headerBtn(alice, 'Assistant').click();
  await expect(panelOf(alice).locator('.asst-turn')).toHaveCount(0);
  await panelOf(alice).getByLabel('Assistant key passphrase').fill('wrong passphrase');
  await panelOf(alice).getByRole('button', { name: 'Unlock' }).click();
  await expect(panelOf(alice).getByRole('alert')).toHaveText('Wrong passphrase.');
  await panelOf(alice).getByLabel('Assistant key passphrase').fill(PASS);
  await panelOf(alice).getByRole('button', { name: 'Unlock' }).click();
  await expect(panelOf(alice).getByLabel('Assistant key passphrase')).toHaveCount(0);
  await panelOf(alice).getByLabel('Ask Claude').fill('Still there?');
  await panelOf(alice).getByLabel('Ask Claude').press('Enter');
  await expect(panelOf(alice).locator('.asst-turn.bot.done')).toContainText('Answer: Still there?');
});

test('message actions and writing help', async ({ users }) => {
  const bob = await users('bob');
  const mock = await mockClaude(bob);
  await createServer(bob, 'Bots');
  await bob.getByRole('button', { name: /general/ }).first().click();
  await saveKey(bob);
  await bob.getByRole('button', { name: 'Close settings' }).click();

  await send(bob, 'Hola, ¿cómo estás?');
  await send(bob, 'Try this:\n```js\nconsole.log(1)\n```');
  await expect(bob.locator('.msg', { hasText: 'console.log(1)' })).toBeVisible();
  const count = await bob.locator('.msg').count();

  // ---- Translate: inline under the message, only for me, never sent ----
  await messageAction(bob, 'Hola, ¿cómo estás?', 'Translate');
  const tr = bob.getByRole('region', { name: 'Translation to English' });
  await expect(tr).toContainText('Hello, how are you?');
  await expect(tr).toContainText('only you see this');
  let req = mock.requests.at(-1);
  expect(req.body.system).toContain('into English');
  expect(lastUser(req.body)).toBe('<text>\nHola, ¿cómo estás?\n</text>');
  await expect(bob.locator('.msg')).toHaveCount(count);
  await tr.getByRole('button', { name: 'Hide translation' }).click();
  await expect(tr).toHaveCount(0);

  // ---- Explain code: opens the panel ----
  await messageAction(bob, 'console.log(1)', 'Explain code');
  const panel = panelOf(bob);
  await expect(panel.locator('.asst-turn.bot.done')).toContainText('This code logs the number 1.');
  expect(lastUser(mock.requests.at(-1).body)).toContain('console.log(1)');

  // ---- Summarize thread: the message and its replies ----
  const root = bob.locator('.msg', { hasText: 'Hola, ¿cómo estás?' });
  await root.hover();
  await root.getByRole('button', { name: 'Reply' }).click();
  await composer(bob).fill('Muy bien, gracias');
  await composer(bob).press('Enter');
  await expect(bob.locator('.msg-text', { hasText: 'Muy bien, gracias' })).toBeVisible();
  await messageAction(bob, 'Muy bien, gracias', 'Summarize thread');
  await expect(panel.locator('.asst-turn.bot.done').last()).toContainText('They agreed to roll back the deploy.');
  req = mock.requests.at(-1);
  expect(lastUser(req.body)).toContain('Hola, ¿cómo estás?');
  expect(lastUser(req.body)).toContain('Bob (me) (replying to Bob): Muy bien, gracias');
  expect(lastUser(req.body)).not.toContain('console.log');

  // ---- Writing help: preview, then accept into the composer (nothing sent) ----
  const before = await bob.locator('.msg').count();
  await composer(bob).fill('i has a idea');
  await bob.getByRole('button', { name: 'Writing help' }).click();
  await bob.getByRole('menuitem', { name: 'Fix grammar' }).click();
  const dlg = bob.getByRole('dialog', { name: 'Writing help: Fix grammar' });
  await expect(dlg.getByLabel('Suggestion')).toHaveValue('I have an idea.');
  expect(lastUser(mock.requests.at(-1).body)).toContain('<draft>\ni has a idea\n</draft>');
  await dlg.getByRole('button', { name: 'Replace my draft' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(composer(bob)).toHaveValue('I have an idea.');
  await composer(bob).fill('');
  // Draft a reply waits for permission to read the conversation.
  await bob.getByRole('button', { name: 'Writing help' }).click();
  await bob.getByRole('menuitem', { name: 'Draft a reply' }).click();
  const reply = bob.getByRole('dialog', { name: 'Writing help: Draft a reply' });
  await expect(reply.getByLabel('Suggestion')).toHaveValue('');
  await reply.getByLabel(/Let Claude read the last 20 messages/).check();
  await reply.getByRole('button', { name: 'Write it' }).click();
  await expect(reply.getByLabel('Suggestion')).toHaveValue("Sounds good, I'll be there at 5.");
  expect(lastUser(mock.requests.at(-1).body)).toContain('Muy bien, gracias');
  await reply.getByRole('button', { name: 'Put in message box' }).click();
  await expect(composer(bob)).toHaveValue("Sounds good, I'll be there at 5.");
  await composer(bob).fill('');
  await expect(bob.locator('.msg')).toHaveCount(before);
  expect(bob.__errors.filter((e) => !/api\.anthropic\.com|Failed to load resource/.test(e))).toEqual([]);
});

test('errors, retry, stop and Haiku', async ({ users }) => {
  const carol = await users('carol');
  const mock = await mockClaude(carol);
  await createServer(carol, 'Errors');
  await carol.getByRole('button', { name: /general/ }).first().click();
  await saveKey(carol);
  await carol.getByRole('button', { name: 'Close settings' }).click();
  await headerBtn(carol, 'Assistant').click();
  const panel = panelOf(carol);
  let req;

  // ---- Errors are explained; Retry recovers ----
  const ask = async (q) => {
    await panel.getByLabel('Ask Claude').fill(q);
    await panel.getByLabel('Ask Claude').press('Enter');
  };
  const lastBot = () => panel.locator('.asst-turn.bot').last();
  mock.queue.push({ status: 401, type: 'authentication_error', message: 'invalid x-api-key' });
  await ask('first');
  await expect(lastBot()).toContainText('Anthropic rejected this API key (401)');
  await expect(lastBot().getByRole('button', { name: 'Assistant settings' })).toBeVisible();

  mock.queue.push({ status: 429, type: 'rate_limit_error', headers: { 'retry-after': '12' } });
  await ask('second');
  await expect(lastBot()).toContainText(/rate limit \(429\)/);
  await expect(lastBot()).toContainText('Try again in 12 s.');
  const n = mock.requests.length;
  await lastBot().getByRole('button', { name: 'Retry' }).click();
  await expect(lastBot()).toContainText('Answer: second');
  expect(mock.requests.length).toBe(n + 1);

  mock.queue.push({ status: 529, type: 'overloaded_error' });
  await ask('third');
  await expect(lastBot()).toContainText('overloaded right now (529)');

  mock.queue.push({ text: 'Partial text before the decline', stop: 'refusal', details: { type: 'refusal', category: 'cyber', explanation: null } });
  await ask('fourth');
  await expect(lastBot().getByRole('alert')).toContainText('Claude declined this request (cyber safety policy)');
  await expect(lastBot()).not.toContainText('Partial text before the decline'); // a declined partial is discarded

  mock.queue.push({ text: 'A long answer that ends abruptly', stop: 'max_tokens' });
  await ask('fifth');
  await expect(lastBot()).toContainText('This reply was cut off because it reached the length limit.');

  // Stop aborts the request.
  mock.queue.push({ delay: 4000 });
  await ask('slow one');
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(lastBot()).toContainText('Stopped.');
  await expect(panel.getByRole('button', { name: 'Send' })).toBeVisible();

  // ---- Haiku: plain endpoint, no fallback ----
  await openAssistantSettings(carol);
  await carol.getByLabel('Model').selectOption('claude-haiku-5-5');
  await carol.getByRole('button', { name: 'Close settings' }).click();
  await ask('haiku please');
  await expect(lastBot()).toContainText('Answer: haiku please');
  req = mock.requests.at(-1);
  expect(req.body.model).toBe('claude-haiku-5-5');
  expect(req.body.fallbacks).toBeUndefined();
  expect(req.headers['anthropic-beta'] || '').not.toContain('server-side-fallback');
  expect(req.body.output_config).toEqual({ effort: 'low' });
  expect(carol.__errors.filter((e) => !/api\.anthropic\.com|Failed to load resource/.test(e))).toEqual([]);
});

test('catch me up reads only what arrived since I last read', async ({ users }) => {
  const alice = await users('alice');
  const dave = await users('dave');
  const mock = await mockClaude(alice);
  await createServer(alice, 'Unread');
  await alice.getByRole('button', { name: /general/ }).first().click();
  await send(alice, 'Old news from before');
  await expect(alice.locator('.msg-text', { hasText: 'Old news from before' })).toBeVisible();
  await saveKey(alice);
  await alice.getByRole('button', { name: 'Close settings' }).click();
  const link = await makeInvite(alice);
  // Alice looks elsewhere while Dave posts in #general.
  await alice.getByRole('button', { name: 'Create text channel' }).click();
  await alice.getByRole('dialog', { name: 'Create channel' }).getByLabel('Name').fill('elsewhere');
  await alice.getByRole('dialog', { name: 'Create channel' }).getByRole('button', { name: 'Create' }).click();
  await expect(alice.locator('.chat-title-text')).toHaveText('elsewhere');

  await joinServer(dave, link, 'Unread');
  await dave.getByRole('button', { name: /general/ }).first().click();
  await send(dave, 'The build is red, @Alice can you look?');
  await send(dave, 'We decided to ship on Friday');
  await expect(dave.locator('.msg-text', { hasText: 'ship on Friday' })).toBeVisible();

  await alice.getByRole('button', { name: /general/ }).first().click();
  await expect(alice.locator('.msg-text', { hasText: 'ship on Friday' })).toBeVisible();
  await headerBtn(alice, 'Catch me up').click();
  const panel = panelOf(alice);
  await expect(panel.locator('.asst-turn.user').last()).toContainText('Catch me up on #general (2 unread messages)');
  await expect(panel.locator('.asst-turn.bot.done')).toHaveCount(1);
  const content = lastUser(mock.requests.at(-1).body);
  expect(content).toContain('Dave: The build is red, @Alice can you look?');
  expect(content).toContain('Dave: We decided to ship on Friday');
  expect(content).not.toContain('Old news from before');
  expect(content).toContain('## Questions for me');

  // The panel's scope picker re-runs it over the last 50 messages, which include the old one.
  await panel.getByLabel('Messages to catch up on').selectOption('last50');
  await panel.getByRole('button', { name: 'Catch me up' }).click();
  await expect(panel.locator('.asst-turn.bot.done')).toHaveCount(2);
  expect(lastUser(mock.requests.at(-1).body)).toContain('Alice (me): Old news from before');
});
