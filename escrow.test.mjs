// escrow.test.mjs
// Unit tests for extractCreatedObjectId — no network, no Sui SDK needed.
// Run with: node escrow.test.mjs

// ─── Function under test ───────────────────────────────────────────────────
// Finding #6: this used to be a hand-copied duplicate of the function in
// server.mjs, which could silently diverge from the real implementation and
// defeat the purpose of the tests. Now imports the real (Phase 2b-relocated)
// implementation from escrow.mjs directly.

import { extractCreatedObjectId } from './escrow.mjs';

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\nextractCreatedObjectId\n');

test('normal PTB: two Created entries — returns the LAST one (the real escrow object)', () => {
  const changedObjects = [
    { objectId: 'ephemeral-coin-id', idOperation: 'Created' },  // splitCoins ephemeral coin — always first
    { objectId: 'real-escrow-id',    idOperation: 'Created' },  // BookingEscrow shared object — always last
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'real-escrow-id');
});

test('single Created entry — returns it', () => {
  const changedObjects = [
    { objectId: 'only-object-id', idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'only-object-id');
});

test('empty array — returns null', () => {
  assertEqual(extractCreatedObjectId([]), null);
});

test('null input — returns null', () => {
  assertEqual(extractCreatedObjectId(null), null);
});

test('undefined input — returns null', () => {
  assertEqual(extractCreatedObjectId(undefined), null);
});

test('no Created entries (only Mutated/Deleted) — returns null', () => {
  const changedObjects = [
    { objectId: 'gas-coin-id',  idOperation: 'Mutated' },
    { objectId: 'deleted-id',   idOperation: 'Deleted' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), null);
});

test('case-insensitive: "created" (lowercase) matches', () => {
  const changedObjects = [
    { objectId: 'lowercase-id', idOperation: 'created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'lowercase-id');
});

test('case-insensitive: "CREATED" (uppercase) matches', () => {
  const changedObjects = [
    { objectId: 'upper-id', idOperation: 'CREATED' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'upper-id');
});

test('nested $kind object (alternate SDK shape) — unwraps and matches', () => {
  const changedObjects = [
    { objectId: 'nested-id', $kind: { $kind: 'Created' } },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'nested-id');
});

test('fallback field: uses .id when .objectId absent', () => {
  const changedObjects = [
    { id: 'fallback-id', idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'fallback-id');
});

test('fallback field: uses .object_id when .objectId and .id absent', () => {
  const changedObjects = [
    { object_id: 'snake-case-id', idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'snake-case-id');
});

test('three Created entries (e.g. future multi-object PTB) — returns the last one', () => {
  const changedObjects = [
    { objectId: 'first-id',  idOperation: 'Created' },
    { objectId: 'middle-id', idOperation: 'Created' },
    { objectId: 'last-id',   idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'last-id');
});

test('mix of Mutated + Created — only Created entries counted, last is returned', () => {
  const changedObjects = [
    { objectId: 'gas-id',    idOperation: 'Mutated' },
    { objectId: 'coin-id',   idOperation: 'Created' },
    { objectId: 'escrow-id', idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'escrow-id');
});

test('operation field alias (alternate SDK shape)', () => {
  const changedObjects = [
    { objectId: 'alias-id', operation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'alias-id');
});

test('i_operation field alias (snake_case SDK shape)', () => {
  const changedObjects = [
    { objectId: 'snake-op-id', id_operation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'snake-op-id');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
