import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TOKEN_HEX_RE,
  ensureToken,
  generateToken,
  maskToken,
  readToken,
  readTokenFile,
  redactSecrets,
  timingSafeEqual,
  tokenPath,
  writeTokenFile,
} from '../src/token.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'haloflux-token-test-'));
}

test('generateToken produces 32 random bytes as 64 lowercase hex chars', () => {
  const first = generateToken();
  const second = generateToken();
  assert.equal(first.length, 64);
  assert.match(first, TOKEN_HEX_RE);
  assert.notEqual(first, second);
});

test('ensureToken creates the token file under HALOFLUX_HOME and reuses it', () => {
  const home = tempDir();
  try {
    const file = tokenPath({ HALOFLUX_HOME: home });
    assert.equal(path.basename(file), 'token');

    const created = ensureToken({ env: { HALOFLUX_HOME: home }, file });
    assert.equal(created.source, 'generated');
    assert.equal(created.created, true);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), created.token);
    assert.match(created.token, TOKEN_HEX_RE);

    const second = ensureToken({ env: { HALOFLUX_HOME: home }, file });
    assert.equal(second.source, 'file');
    assert.equal(second.created, false);
    assert.equal(second.token, created.token);
    assert.equal(readTokenFile(file), created.token);
    assert.equal(readToken({ env: {}, file }), created.token);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('HALOFLUX_TOKEN overrides the token file and is not written to disk', () => {
  const home = tempDir();
  try {
    const explicit = 'f'.repeat(64);
    const file = tokenPath({ HALOFLUX_HOME: home });
    const resolved = ensureToken({ env: { HALOFLUX_HOME: home, HALOFLUX_TOKEN: explicit }, file });
    assert.equal(resolved.source, 'env');
    assert.equal(resolved.token, explicit);
    assert.equal(fs.existsSync(file), false);
    assert.equal(readToken({ env: { HALOFLUX_TOKEN: explicit }, file }), explicit);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('writeTokenFile rejects malformed tokens and leaves no temp files behind', () => {
  const home = tempDir();
  try {
    const file = path.join(home, 'nested', 'token');
    assert.throws(() => writeTokenFile(file, 'not-hex'), /64 hex/);
    const token = generateToken();
    writeTokenFile(file, token);
    assert.equal(readTokenFile(file), token);
    const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('timingSafeEqual is length-independent and rejects empty/non-string input', () => {
  assert.equal(timingSafeEqual('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(timingSafeEqual('a'.repeat(64), 'a'.repeat(63) + 'b'), false);
  assert.equal(timingSafeEqual('short', 'short'), true);
  assert.equal(timingSafeEqual('short', 'longer-value'), false);
  assert.equal(timingSafeEqual('', ''), false);
  assert.equal(timingSafeEqual(null, 'token'), false);
  assert.equal(timingSafeEqual(undefined, undefined), false);
});

test('logs never need to contain the token: maskToken/redactSecrets are safe', () => {
  const token = generateToken();
  const masked = maskToken(token);
  assert.equal(masked.includes(token), false);
  assert.match(masked, /^token:sha256:[0-9a-f]{8}/);
  assert.equal(maskToken(''), '(none)');

  const text = `authorization failed for ${token} and again ${token}`;
  const redacted = redactSecrets(text, [token]);
  assert.equal(redacted.includes(token), false);
  assert.equal(redactSecrets(`raw ${token}`, []).includes(token), false);
});
