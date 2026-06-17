// escrow.test.mjs
// Unit tests for extractCreatedObjectId — no network, no Sui SDK needed.
// Run with: node escrow.test.mjs

// ─── Function under test ───────────────────────────────────────────────────
// Finding #6: this used to be a hand-copied duplicate of the function in
// server.mjs, which could silently diverge from the real implementation and
// defeat the purpose of the tests. Now imports the real (Phase 2b-relocated)
// implementation from escrow.mjs directly.

import {
  extractCreatedObjectId, verifyEscrowTransaction, suiClient,
  isObjectMutated, verifyClaimDamageTransaction, verifyDisputeClaimTransaction
} from './escrow.mjs';

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

await test('normal PTB: two Created entries — returns the LAST one (the real escrow object)', () => {
  const changedObjects = [
    { objectId: 'ephemeral-coin-id', idOperation: 'Created' },  // splitCoins ephemeral coin — always first
    { objectId: 'real-escrow-id',    idOperation: 'Created' },  // BookingEscrow shared object — always last
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'real-escrow-id');
});

await test('single Created entry — returns it', () => {
  const changedObjects = [
    { objectId: 'only-object-id', idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'only-object-id');
});

await test('empty array — returns null', () => {
  assertEqual(extractCreatedObjectId([]), null);
});

await test('null input — returns null', () => {
  assertEqual(extractCreatedObjectId(null), null);
});

await test('undefined input — returns null', () => {
  assertEqual(extractCreatedObjectId(undefined), null);
});

await test('no Created entries (only Mutated/Deleted) — returns null', () => {
  const changedObjects = [
    { objectId: 'gas-coin-id',  idOperation: 'Mutated' },
    { objectId: 'deleted-id',   idOperation: 'Deleted' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), null);
});

await test('case-insensitive: "created" (lowercase) matches', () => {
  const changedObjects = [
    { objectId: 'lowercase-id', idOperation: 'created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'lowercase-id');
});

await test('case-insensitive: "CREATED" (uppercase) matches', () => {
  const changedObjects = [
    { objectId: 'upper-id', idOperation: 'CREATED' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'upper-id');
});

await test('nested $kind object (alternate SDK shape) — unwraps and matches', () => {
  const changedObjects = [
    { objectId: 'nested-id', $kind: { $kind: 'Created' } },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'nested-id');
});

await test('fallback field: uses .id when .objectId absent', () => {
  const changedObjects = [
    { id: 'fallback-id', idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'fallback-id');
});

await test('fallback field: uses .object_id when .objectId and .id absent', () => {
  const changedObjects = [
    { object_id: 'snake-case-id', idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'snake-case-id');
});

await test('three Created entries (e.g. future multi-object PTB) — returns the last one', () => {
  const changedObjects = [
    { objectId: 'first-id',  idOperation: 'Created' },
    { objectId: 'middle-id', idOperation: 'Created' },
    { objectId: 'last-id',   idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'last-id');
});

await test('mix of Mutated + Created — only Created entries counted, last is returned', () => {
  const changedObjects = [
    { objectId: 'gas-id',    idOperation: 'Mutated' },
    { objectId: 'coin-id',   idOperation: 'Created' },
    { objectId: 'escrow-id', idOperation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'escrow-id');
});

await test('operation field alias (alternate SDK shape)', () => {
  const changedObjects = [
    { objectId: 'alias-id', operation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'alias-id');
});

await test('i_operation field alias (snake_case SDK shape)', () => {
  const changedObjects = [
    { objectId: 'snake-op-id', id_operation: 'Created' },
  ];
  assertEqual(extractCreatedObjectId(changedObjects), 'snake-op-id');
});

console.log('\nverifyEscrowTransaction\n');

// suiClient.core is a plain instance property (new GrpcCoreClient(...)), not a
// getter, so it can be monkey-patched directly for these tests — no network
// calls happen. These tests exist specifically to catch the bug found during
// live testing: suiClient.core.getTransaction() returns a discriminated union
// ({$kind:'Transaction', Transaction:{status, transaction, effects, ...}} or
// {$kind:'FailedTransaction', FailedTransaction:{...}}) per @mysten/sui's own
// SuiClientTypes.TransactionResult — NOT a flat object with top-level
// status/transaction/effects. Reading result.status directly (the old,
// buggy code) is always undefined, so it silently reported every successful
// transaction as failed. These tests assert against the real wrapped shape.

await test('successful transaction ($kind: Transaction) — returns ok:true with escrowId', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: '0xguest' },
      effects: {
        changedObjects: [
          { objectId: 'ephemeral-coin', idOperation: 'Created' },
          { objectId: 'real-escrow-id', idOperation: 'Created' },
        ],
      },
    },
  });
  const result = await verifyEscrowTransaction('0xdigest', '0xguest');
  assertEqual(result.ok, true, 'expected ok:true');
  assertEqual(result.escrowId, 'real-escrow-id');
  assertEqual(result.sender, '0xguest');
});

await test('failed transaction ($kind: FailedTransaction) — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'FailedTransaction',
    FailedTransaction: {
      status: { success: false, error: { message: 'InsufficientGas' } },
    },
  });
  const result = await verifyEscrowTransaction('0xdigest', '0xguest');
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'InsufficientGas');
});

await test('sender mismatch on a successful transaction — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: '0xsomeoneelse' },
      effects: { changedObjects: [{ objectId: 'escrow-id', idOperation: 'Created' }] },
    },
  });
  const result = await verifyEscrowTransaction('0xdigest', '0xguest');
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'Transaction sender does not match the booking guest');
});

console.log('\nisObjectMutated\n');

await test('expectedObjectId mutated — returns true', () => {
  const changedObjects = [
    { objectId: 'gas-coin-id', idOperation: 'Mutated' },
    { objectId: 'escrow-id',   idOperation: 'Mutated' },
  ];
  assertEqual(isObjectMutated(changedObjects, 'escrow-id'), true);
});

await test('expectedObjectId present but Created, not Mutated — returns false', () => {
  const changedObjects = [
    { objectId: 'escrow-id', idOperation: 'Created' },
  ];
  assertEqual(isObjectMutated(changedObjects, 'escrow-id'), false);
});

await test('expectedObjectId absent from changedObjects — returns false', () => {
  const changedObjects = [
    { objectId: 'some-other-id', idOperation: 'Mutated' },
  ];
  assertEqual(isObjectMutated(changedObjects, 'escrow-id'), false);
});

await test('no expectedObjectId passed — returns false', () => {
  const changedObjects = [
    { objectId: 'escrow-id', idOperation: 'Mutated' },
  ];
  assertEqual(isObjectMutated(changedObjects, null), false);
});

await test('empty changedObjects — returns false', () => {
  assertEqual(isObjectMutated([], 'escrow-id'), false);
});

await test('null changedObjects — returns false', () => {
  assertEqual(isObjectMutated(null, 'escrow-id'), false);
});

await test('case-insensitive "mutated" lowercase matches', () => {
  const changedObjects = [{ objectId: 'escrow-id', idOperation: 'mutated' }];
  assertEqual(isObjectMutated(changedObjects, 'escrow-id'), true);
});

await test('fallback field .id used when .objectId absent', () => {
  const changedObjects = [{ id: 'escrow-id', idOperation: 'Mutated' }];
  assertEqual(isObjectMutated(changedObjects, 'escrow-id'), true);
});

console.log('\nverifyClaimDamageTransaction\n');

await test('successful claim_damage tx, correct host sender, escrow mutated — returns ok:true', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: '0xhost' },
      effects: { changedObjects: [{ objectId: 'escrow-id', idOperation: 'Mutated' }] },
    },
  });
  const result = await verifyClaimDamageTransaction('0xdigest', '0xhost', 'escrow-id');
  assertEqual(result.ok, true, 'expected ok:true');
  assertEqual(result.sender, '0xhost');
});

await test('claim_damage tx with wrong sender — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: '0xnothost' },
      effects: { changedObjects: [{ objectId: 'escrow-id', idOperation: 'Mutated' }] },
    },
  });
  const result = await verifyClaimDamageTransaction('0xdigest', '0xhost', 'escrow-id');
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'Transaction sender does not match the expected signer');
});

await test('claim_damage tx that did not mutate the expected escrow — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: '0xhost' },
      effects: { changedObjects: [{ objectId: 'some-other-id', idOperation: 'Mutated' }] },
    },
  });
  const result = await verifyClaimDamageTransaction('0xdigest', '0xhost', 'escrow-id');
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'Transaction did not mutate the expected escrow object (escrow-id)');
});

await test('failed claim_damage transaction ($kind: FailedTransaction) — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'FailedTransaction',
    FailedTransaction: { status: { success: false, error: { message: 'ENotHost' } } },
  });
  const result = await verifyClaimDamageTransaction('0xdigest', '0xhost', 'escrow-id');
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'ENotHost');
});

console.log('\nverifyDisputeClaimTransaction\n');

await test('successful dispute_claim tx, correct guest sender, escrow mutated — returns ok:true', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: '0xguest' },
      effects: { changedObjects: [{ objectId: 'escrow-id', idOperation: 'Mutated' }] },
    },
  });
  const result = await verifyDisputeClaimTransaction('0xdigest', '0xguest', 'escrow-id');
  assertEqual(result.ok, true, 'expected ok:true');
  assertEqual(result.sender, '0xguest');
});

await test('dispute_claim tx with wrong sender — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: '0xnotguest' },
      effects: { changedObjects: [{ objectId: 'escrow-id', idOperation: 'Mutated' }] },
    },
  });
  const result = await verifyDisputeClaimTransaction('0xdigest', '0xguest', 'escrow-id');
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'Transaction sender does not match the expected signer');
});

await test('failed dispute_claim transaction ($kind: FailedTransaction) — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'FailedTransaction',
    FailedTransaction: { status: { success: false, error: { message: 'ENotGuest' } } },
  });
  const result = await verifyDisputeClaimTransaction('0xdigest', '0xguest', 'escrow-id');
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'ENotGuest');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
