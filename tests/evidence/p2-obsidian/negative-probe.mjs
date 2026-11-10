#!/usr/bin/env node
/**
 * Independent negative probe for the allowlisted Obsidian aggregate parser.
 *
 * This is REVIEW EVIDENCE, not part of the CI suite: it is not named
 * `*.test.mjs` and is intentionally kept out of `npm test`.
 *
 * Target: apps/companion/renderer/obsidian-metadata.mjs (HEAD 0a9e389)
 * Run:    node tests/evidence/p2-obsidian/negative-probe.mjs
 * Exit:   0 only when every PASS assertion holds.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OBSIDIAN_SCHEMA, parseObsidianMetadata } from '../../../apps/companion/renderer/obsidian-metadata.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const S = OBSIDIAN_SCHEMA;
const MAX = 50_000_000;

let pass = 0;
let fail = 0;
const infos = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name} :: ${error.message}`);
  }
}

function info(name, detail) {
  infos.push({ name, detail });
  console.log(`INFO  ${name} :: ${detail}`);
}

function expect(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || 'value'}: expected ${e}, got ${a}`);
}

function expectNull(value, label) {
  if (value !== null) throw new Error(`${label || 'parse'}: expected null, got ${JSON.stringify(value)}`);
}

const ok = (notes = 1, links = 2, folders = 3, extra = {}) => ({ schema: S, notes, links, folders, ...extra });
const counts = (overrides) => ({ schema: S, notes: 1, links: 2, folders: 3, ...overrides });

/* 1 ─ positive shape */
check('01 valid aggregate parses to an exact frozen allowlist object', () => {
  const parsed = parseObsidianMetadata({ schema: S, notes: 3392, links: 24636, folders: 9, generatedAt: '2026-11-09T00:00:00.000Z' });
  expect(parsed, {
    notes: 3392,
    links: 24636,
    folders: 9,
    generatedAt: '2026-11-09T00:00:00.000Z',
    source: 'local-user-import',
    mode: 'static-snapshot',
  });
  if (!Object.isFrozen(parsed)) throw new Error('result is not frozen');
  if (parsed === undefined || Array.isArray(parsed)) throw new Error('result is not a plain object');
});

/* 2 ─ schema is exact */
check('02 wrong / missing / near-miss schema rejected', () => {
  expectNull(parseObsidianMetadata({ notes: 1, links: 2, folders: 3 }), 'missing schema');
  expectNull(parseObsidianMetadata({ schema: 'wrong', notes: 1, links: 2, folders: 3 }), 'wrong schema');
  expectNull(parseObsidianMetadata({ schema: S.toUpperCase(), notes: 1, links: 2, folders: 3 }), 'uppercase schema');
  expectNull(parseObsidianMetadata({ schema: `${S} `, notes: 1, links: 2, folders: 3 }), 'trailing space schema');
  expectNull(parseObsidianMetadata({ schema: `${S}.v2`, notes: 1, links: 2, folders: 3 }), 'suffix schema');
  expectNull(parseObsidianMetadata({ schema: 1, notes: 1, links: 2, folders: 3 }), 'numeric schema');
});

/* 3 ─ count domain */
check('03 negative counts rejected', () => {
  for (const field of ['notes', 'links', 'folders']) {
    expectNull(parseObsidianMetadata(counts({ [field]: -1 })), `${field} -1`);
    expectNull(parseObsidianMetadata(counts({ [field]: -1e-9 })), `${field} -1e-9`);
  }
});

check('04 fractional counts rejected', () => {
  for (const value of [1.5, 0.1, 1e-7, 9.999]) {
    expectNull(parseObsidianMetadata(counts({ notes: value })), `notes ${value}`);
  }
});

check('05 string / boolean / null / undefined counts rejected', () => {
  for (const value of ['9000', '0', '', true, false, null, undefined, NaN, Infinity, -Infinity]) {
    expectNull(parseObsidianMetadata(counts({ notes: value })), `notes ${String(value)}`);
  }
});

check('06 over-cap and non-safe integers rejected', () => {
  expectNull(parseObsidianMetadata(counts({ notes: MAX + 1 })), '50,000,001');
  expectNull(parseObsidianMetadata(counts({ notes: Number.MAX_SAFE_INTEGER })), 'MAX_SAFE_INTEGER');
  expectNull(parseObsidianMetadata(counts({ notes: 2 ** 60 })), '2^60');
  expectNull(parseObsidianMetadata(counts({ notes: 1e300 })), '1e300');
});

check('07 boundaries 0 and 50,000,000 accepted', () => {
  const zero = parseObsidianMetadata(counts({ notes: 0, links: 0, folders: 0 }));
  const max = parseObsidianMetadata(counts({ notes: MAX, links: MAX, folders: MAX }));
  if (!zero || zero.notes !== 0) throw new Error('zero rejected');
  if (!max || max.notes !== MAX || max.links !== MAX || max.folders !== MAX) throw new Error('cap rejected');
});

/* 4 ─ input shape */
check('08 non-object inputs rejected without throwing', () => {
  for (const value of [null, undefined, [], 'text', 42, true, () => {}]) {
    expectNull(parseObsidianMetadata(value), `input ${String(value)}`);
  }
  expectNull(parseObsidianMetadata([ok()]), 'array-wrapped object');
});

check('09 unknown / sensitive fields are stripped from the result', () => {
  const parsed = parseObsidianMetadata(ok(3392, 24636, 9, {
    path: '/private/vault/SECRET-PATH',
    titles: ['SECRET-TITLE'],
    body: 'SECRET-BODY',
    attachments: ['SECRET-ATTACH'],
    vaultName: 'SECRET-VAULT',
    owner: 'SECRET-OWNER',
  }));
  if (!parsed) throw new Error('valid allowlisted payload was rejected');
  const serialized = JSON.stringify(parsed);
  for (const marker of ['SECRET', 'private', 'path', 'titles', 'body', 'attachments', 'vaultName', 'owner']) {
    if (serialized.includes(marker)) throw new Error(`leaked "${marker}"`);
  }
  expect(Object.keys(parsed).sort(), ['folders', 'generatedAt', 'links', 'mode', 'notes', 'source']);
});

check('10 input object is not mutated and result does not alias it', () => {
  const input = ok(5, 6, 7, { generatedAt: '2026-11-09T01:02:03.000Z' });
  const before = JSON.stringify(input);
  const parsed = parseObsidianMetadata(input);
  expect(JSON.stringify(input), before, 'input mutated');
  if (parsed === input) throw new Error('result aliases the input object');
});

/* 5 ─ pollution */
check('11 JSON __proto__ / constructor.prototype payload cannot pollute Object.prototype', () => {
  const payload = JSON.parse(`{"schema":"${S}","notes":11,"links":22,"folders":33,` +
    '"__proto__":{"polluted":"yes","notes":999},"constructor":{"prototype":{"polluted2":"yes"}}}');
  const parsed = parseObsidianMetadata(payload);
  if (!parsed) throw new Error('payload with __proto__ was rejected (expected acceptance, extras dropped)');
  expect({ notes: parsed.notes, links: parsed.links, folders: parsed.folders }, { notes: 11, links: 22, folders: 33 });
  if (Object.prototype.polluted !== undefined) throw new Error('Object.prototype.polluted was set');
  if (Object.prototype.polluted2 !== undefined) throw new Error('Object.prototype.polluted2 was set');
  if (Object.hasOwn(parsed, '__proto__')) throw new Error('result carries an own __proto__ key');
  if (Object.getPrototypeOf(parsed) !== Object.prototype) throw new Error('result prototype changed');
});

check('12 output serialization contains no pollution markers', () => {
  const parsed = parseObsidianMetadata(JSON.parse(
    `{"schema":"${S}","notes":1,"links":2,"folders":3,"__proto__":{"leak":"POLLUTED"}}`,
  ));
  if (!parsed) throw new Error('unexpected rejection');
  if (JSON.stringify(parsed).includes('POLLUTED')) throw new Error('pollution payload leaked into output');
});

/* 6 ─ size / DoS */
check('13 70 KiB unknown-fields JSON yields a tiny allowlisted object', () => {
  // Simulates the app.js 64 KiB cap being absent: even then no field survives.
  const payload = JSON.parse(JSON.stringify({
    schema: S, notes: 7, links: 8, folders: 9, pad: 'x'.repeat(70 * 1024),
  }));
  const started = performance.now();
  const parsed = parseObsidianMetadata(payload);
  const ms = performance.now() - started;
  const serialized = JSON.stringify(parsed);
  if (!parsed || serialized.length > 200) throw new Error(`unexpected output length ${serialized.length}`);
  if (serialized.includes('pad')) throw new Error('unknown field kept');
  if (performance.now() - started > 1000) throw new Error(`parse too slow (${ms.toFixed(1)} ms)`);
});

check('14 20,000 extra keys are ignored', () => {
  const huge = ok();
  for (let i = 0; i < 20_000; i += 1) huge[`k${i}`] = 'x';
  const parsed = parseObsidianMetadata(huge);
  expect(parsed && parsed.notes, 1);
  if (Object.keys(parsed).length !== 6) throw new Error(`result keys ${Object.keys(parsed).length}`);
});

/* 7 ─ generatedAt */
check('15 valid ISO generatedAt normalized to toISOString', () => {
  const parsed = parseObsidianMetadata(ok(1, 2, 3, { generatedAt: '2026-11-09T00:00:00.000Z' }));
  expect(parsed && parsed.generatedAt, '2026-11-09T00:00:00.000Z');
  const offset = parseObsidianMetadata(ok(1, 2, 3, { generatedAt: '2026-11-09T08:00:00+08:00' }));
  expect(offset && offset.generatedAt, '2026-11-09T00:00:00.000Z');
});

check('16 malformed generatedAt never becomes a non-null garbage value', () => {
  for (const value of ['not-a-date', '', ' 2026-11-09T00:00:00.000Z ', '2026-13-45T00:00:00Z']) {
    const parsed = parseObsidianMetadata(ok(1, 2, 3, { generatedAt: value }));
    if (!parsed) throw new Error(`allowlisted counts rejected because of generatedAt "${value}"`);
    if (parsed.generatedAt !== null) throw new Error(`garbage generatedAt kept: ${parsed.generatedAt}`);
  }
  for (const value of [0, 1, true, [], {}, { iso: '2026-11-09' }, 1_700_000_000_000]) {
    const parsed = parseObsidianMetadata(ok(1, 2, 3, { generatedAt: value }));
    if (!parsed || parsed.generatedAt !== null) throw new Error(`non-string generatedAt accepted: ${JSON.stringify(value)}`);
  }
});

/* 8 ─ static source audit */
check('17 parser source contains no spread/copy of the untrusted object', () => {
  const source = readFileSync(path.join(REPO, 'apps/companion/renderer/obsidian-metadata.mjs'), 'utf8');
  if (/\.\.\.\s*value/.test(source)) throw new Error('source spreads the input object');
  if (!/Number\.isSafeInteger/.test(source)) throw new Error('safe-integer guard missing');
  if (!/50_000_000/.test(source)) throw new Error('upper bound missing');
  if (!/Object\.freeze/.test(source)) throw new Error('freeze missing');
});

/* 9 ─ observations that are not PASS/FAIL but matter for the review */
info('inherited properties accepted', (() => {
  const parsed = parseObsidianMetadata(Object.create({ schema: S, notes: 1, links: 2, folders: 3 }));
  return parsed ? 'parser reads via property access; an Object.create() carrier parses (LOW, unreachable from JSON.parse)' : 'rejected';
})());

info('negative zero accepted', (() => {
  const parsed = parseObsidianMetadata(counts({ notes: -0 }));
  return parsed ? `notes is ${Object.is(parsed.notes, -0) ? '-0' : parsed.notes} (Number.isSafeInteger(-0) === true)` : 'rejected';
})());

info('loose Date.parse', (() => {
  const parsed = parseObsidianMetadata(ok(1, 2, 3, { generatedAt: '1' }));
  return parsed && parsed.generatedAt ? `"1" normalizes to ${parsed.generatedAt} (Date.parse leniency, not currently displayed)` : 'normalizes to null';
})());

info('UTF-8 BOM', (() => {
  try {
    JSON.parse('\uFEFF' + JSON.stringify(ok()));
    return 'JSON.parse accepts BOM';
  } catch {
    return 'JSON.parse alone rejects a BOM, but app.js reads via File.text(), which strips the UTF-8 BOM (confirmed by the Electron E2E probe), so BOM-saved files import fine';
  }
})());

console.log(`SUMMARY pass=${pass} fail=${fail} info=${infos.length}`);
if (fail > 0) {
  console.error('NEGATIVE PROBE FAILED');
  process.exitCode = 1;
}
