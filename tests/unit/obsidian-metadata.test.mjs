import test from 'node:test';
import assert from 'node:assert/strict';
import { OBSIDIAN_SCHEMA, parseObsidianMetadata } from '../../apps/companion/renderer/obsidian-metadata.mjs';

test('allowlisted aggregate import strips path/title/body fields', () => {
  const parsed = parseObsidianMetadata({
    schema: OBSIDIAN_SCHEMA,
    notes: 3392,
    links: 24636,
    folders: 9,
    path: '/private/path',
    titles: ['SECRET-TITLE'],
    body: 'SECRET-BODY',
    generatedAt: '2026-11-09T00:00:00.000Z',
  });
  assert.deepEqual(parsed, {
    notes: 3392,
    links: 24636,
    folders: 9,
    generatedAt: '2026-11-09T00:00:00.000Z',
    source: 'local-user-import',
    mode: 'static-snapshot',
  });
  assert.doesNotMatch(JSON.stringify(parsed), /SECRET|private/);
});

test('Obsidian refuses wrong schema, noninteger and negative fields', () => {
  assert.equal(parseObsidianMetadata({ schema: 'wrong', notes: 1, links: 0, folders: 0 }), null);
  assert.equal(parseObsidianMetadata({ schema: OBSIDIAN_SCHEMA, notes: -1, links: 0, folders: 0 }), null);
  assert.equal(parseObsidianMetadata({ schema: OBSIDIAN_SCHEMA, notes: 1.5, links: 0, folders: 0 }), null);
  assert.equal(parseObsidianMetadata({ schema: OBSIDIAN_SCHEMA, notes: 1, links: '9000', folders: 0 }), null);
  assert.equal(parseObsidianMetadata({ schema: OBSIDIAN_SCHEMA, notes: 1, links: 0, folders: 50_000_001 }), null);
});
