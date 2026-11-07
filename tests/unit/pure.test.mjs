// Pure helpers behind the follow-up fixes: emote reactions, the tab title, profile links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emojiFromKey, emojiKey, emoteFromKey, reactionKey } from '../../src/lib/reactions.js';
import { formatTitle } from '../../src/lib/title.js';
import { LINK_RE, cleanLink } from '../../src/lib/serverx/links.js';

test('reaction keys: emoji round-trip, server emotes as e_{name}, never colliding', () => {
  for (const e of ['👍', '❤️', '🎉', '🇺🇸', '👩‍💻']) {
    assert.equal(reactionKey(e), emojiKey(e));
    assert.equal(emojiFromKey(reactionKey(e)), e);
    assert.equal(emoteFromKey(reactionKey(e)), null);
    assert.ok(!reactionKey(e).includes('_'));
  }
  assert.equal(reactionKey(':party_parrot:'), 'e_party_parrot');
  assert.equal(emoteFromKey('e_party_parrot'), 'party_parrot');
  assert.equal(emojiFromKey('e_party_parrot'), ':party_parrot:');
  // Not an emote name (too short / bad chars): treated as text, so it never becomes an e_ key.
  assert.ok(!reactionKey(':a:').startsWith('e_'));
  assert.ok(!reactionKey(':Bad-Name:').startsWith('e_'));
  assert.ok(reactionKey(':party_parrot:').length <= 64); // rules: $emoji.length <= 64
});

test('tab title: page name, largest unread count (sources overlap), 99+ cap', () => {
  assert.equal(formatTitle('', []), 'Codehub');
  assert.equal(formatTitle('#general · Team', []), '#general · Team — Codehub');
  assert.equal(formatTitle('#general · Team', [3, 5]), '(5) #general · Team — Codehub');
  assert.equal(formatTitle('', [0, 0]), 'Codehub');
  assert.equal(formatTitle('x', [250]), '(99+) x — Codehub');
});

test('profile links: the rules use the same pattern as cleanLink, and its output always passes', () => {
  const rules = JSON.parse(readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8'));
  const v = rules.rules.users.$uid.profile.links.$i['.validate'];
  const m = /val\(\)\.matches\(\/(.*)\/\)$/.exec(v);
  assert.ok(m, 'rules link pattern not found');
  assert.equal(m[1], LINK_RE.source);
  const ok = ['example.com', 'https://a.dev:8443/x?y=1#z', 'HTTPS://Sub.Example.org/path', 'my_host.example.io'];
  for (const s of ok) {
    const out = cleanLink(s);
    assert.ok(out && LINK_RE.test(out), `${s} -> ${out}`);
  }
  for (const s of ['http://a.dev', 'javascript:alert(1)', 'https://user:pw@evil.com', 'https://localhost', 'https://a b.dev', 'ftp://x.y']) {
    assert.equal(cleanLink(s), null, s);
  }
});
