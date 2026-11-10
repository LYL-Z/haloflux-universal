import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(path.join(root, 'apps/companion/renderer/styles.css'), 'utf8');
const html = readFileSync(path.join(root, 'apps/companion/renderer/index.html'), 'utf8');

test('narrow layout keeps the central visual primary and agents collapsible', () => {
  assert.match(html, /id="btn-agents"/);
  assert.match(html, /id="agent-panel"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(css, /#btn-agents\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(max-width:\s*1100px\)/);
  assert.match(css, /body\.agents-open \.agent-panel\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /body\.agents-open \.agent-panel\s*\{[^}]*overflow-y:\s*auto/s);
});

test('narrow TRACE and Evidence are independent fixed sheets, not full-page flow', () => {
  assert.match(css, /\.trace-panel\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.lab-evidence\s*\{[^}]*position:\s*fixed/s);
  assert.match(css, /\.trace-panel\s*\{[^}]*width:\s*calc\(50vw - 18px\)/s);
  assert.match(css, /\.lab-evidence\s*\{[^}]*width:\s*calc\(50vw - 18px\)/s);
  assert.match(css, /\.lab-evidence\s*\{[^}]*overflow:\s*auto/s);
  assert.match(css, /\.replay-bar\s*\{[^}]*flex-wrap:\s*wrap/s);
});
