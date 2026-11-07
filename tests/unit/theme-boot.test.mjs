// The pre-paint theme script in index.html must equal THEME_BOOT_SNIPPET and resolve like resolveTheme().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { THEME_BOOT_SNIPPET } from '../../src/lib/theme.js';

test('index.html inlines THEME_BOOT_SNIPPET verbatim in <head>', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes(`<script>${THEME_BOOT_SNIPPET}</script>`));
});

function run(stored, prefersLight, storageThrows = false) {
  const attrs = {};
  const ctx = {
    localStorage: { getItem: () => { if (storageThrows) throw new Error('blocked'); return stored; } },
    matchMedia: (q) => ({ matches: q.includes('light') && prefersLight }),
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, style: {} } },
  };
  vm.runInNewContext(THEME_BOOT_SNIPPET, ctx);
  return attrs['data-theme'];
}

test('boot snippet: stored choice wins, system follows the OS, blocked storage falls back', () => {
  assert.equal(run('light', false), 'light');
  assert.equal(run('dark', true), 'dark');
  assert.equal(run('system', true), 'light');
  assert.equal(run(null, false), 'dark');
  assert.equal(run('garbage', true), 'light');
  assert.equal(run(null, true, true), 'dark');
});
