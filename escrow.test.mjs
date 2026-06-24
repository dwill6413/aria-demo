// escrow.test.mjs
// Unit tests for extractCreatedObjectId and friends — no network needed.
// Run with: node escrow.test.mjs

// ─── Function under test ───────────────────────────────────────────────────
// Finding #6: this used to be a hand-copied duplicate of the function in
// server.mjs, which could silently diverge from the real implementation and
// defeat the purpose of the tests. Now imports the real (Phase 2b-relocated)
// implementation from escrow.mjs directly.

import {
  extractCreatedObjectId, verifyEscrowTransaction, suiClient,
  isObjectMutated, verifyClaimDamageTransaction, verifyDisputeClaimTransaction,
  depositToMist, BookingEscrowBcs, decodeCreateEscrowArgs, decodeClaimDamageAmountMist,
  dollarsToUnits, decodeCreatePaymentEscrowArgs, verifyBookingPaymentTransaction,
  verifyBuyResaleTransaction
} from './escrow.mjs';
import { bcs } from '@mysten/sui/bcs';
import { toBase64 } from '@mysten/sui/utils';

// ── Helpers for the hardened verifyEscrowTransaction (Finding #1) ───────────
// Realistic 32-byte addresses so normalizeAddr comparisons behave like prod.
const GUEST = '0x' + '2'.repeat(64);
const HOST  = '0x' + '3'.repeat(64);
const ARB   = '0x' + '4'.repeat(64);
const UID1  = '0x' + '1'.repeat(64);
const UID5  = '0x' + '5'.repeat(64);

// Builds the BCS `content` bytes a getObjects() call would return for a
// BookingEscrow with the given fields, so tests can exercise the on-chain
// field verification without a live node.
function escrowContent({ guest = GUEST, host = HOST, bookingRef = 'ARIA-2-x', amount = 661000 } = {}) {
  return BookingEscrowBcs.serialize({
    id: UID1, booking_ref: bookingRef, guest, host, arbitrator: ARB,
    amount: String(amount), coin: { id: UID5, balance: { value: String(amount) } },
    expiry_ms: '1718600000000', status: 0, claim_amount: '0',
  }).toBytes();
}

// Mock both chain reads verifyEscrowTransaction now makes: getTransaction
// (the digest) and getObjects (the created escrow's content/type).
function mockEscrowChain({ sender = GUEST, createdId = 'real-escrow-id', objType = '0xpkg::escrow::BookingEscrow<0x2::sui::SUI>', content = escrowContent() } = {}) {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender },
      effects: { changedObjects: [
        { objectId: 'ephemeral-coin', idOperation: 'Created' },
        { objectId: createdId, idOperation: 'Created' },
      ] },
    },
  });
  suiClient.core.getObjects = async () => ({
    objects: [{ objectId: createdId, type: objType, content }],
  });
}

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

await test('successful transaction, matching escrow object — returns ok:true with escrowId', async () => {
  mockEscrowChain({ sender: GUEST });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST, host: HOST, bookingRef: 'ARIA-2-x', depositAmount: 661 });
  assertEqual(result.ok, true, 'expected ok:true');
  assertEqual(result.escrowId, 'real-escrow-id');
  assertEqual(result.sender, GUEST);
});

await test('failed transaction ($kind: FailedTransaction) — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'FailedTransaction',
    FailedTransaction: {
      status: { success: false, error: { message: 'InsufficientGas' } },
    },
  });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST });
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'InsufficientGas');
});

await test('sender mismatch on a successful transaction — returns ok:false', async () => {
  mockEscrowChain({ sender: '0x' + '9'.repeat(64) });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST });
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'Transaction sender does not match the booking guest');
});

// ── Finding #1: created object must really be OUR escrow, funded & addressed
// as the booking dictates — a guest can otherwise substitute a cheaper/wrong
// create_escrow and report that digest.

await test('created object is not a BookingEscrow type — returns ok:false', async () => {
  mockEscrowChain({ sender: GUEST, objType: '0x2::coin::Coin<0x2::sui::SUI>' });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST, host: HOST, bookingRef: 'ARIA-2-x', depositAmount: 661 });
  assertEqual(result.ok, false, 'expected ok:false');
  if (!/not a escrow::BookingEscrow/.test(result.reason)) throw new Error(`unexpected reason: ${result.reason}`);
});

await test('escrow under-funded vs booking deposit — returns ok:false', async () => {
  // Guest funded only 1000 mist ($1) but the booking deposit is $661.
  mockEscrowChain({ sender: GUEST, content: escrowContent({ amount: 1000 }) });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST, host: HOST, bookingRef: 'ARIA-2-x', depositAmount: 661 });
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'Escrow is not funded with the expected deposit amount');
});

await test('escrow names a different host — returns ok:false', async () => {
  mockEscrowChain({ sender: GUEST, content: escrowContent({ host: '0x' + '7'.repeat(64) }) });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST, host: HOST, bookingRef: 'ARIA-2-x', depositAmount: 661 });
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'Escrow host does not match the booking host');
});

await test('escrow booking_ref does not match — returns ok:false', async () => {
  mockEscrowChain({ sender: GUEST, content: escrowContent({ bookingRef: 'ARIA-9-other' }) });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST, host: HOST, bookingRef: 'ARIA-2-x', depositAmount: 661 });
  assertEqual(result.ok, false, 'expected ok:false');
  assertEqual(result.reason, 'Escrow booking_ref does not match this booking');
});

await test('created object unreadable (RPC/indexing lag) — returns retryable, does NOT mark held (finding #1)', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: GUEST },
      effects: { changedObjects: [{ objectId: 'real-escrow-id', idOperation: 'Created' }] },
    },
  });
  // getObjects keeps returning an error (object not yet queryable) — after
  // retries, verify must fall back to ok:true rather than reject a confirmed,
  // guest-signed deposit. Override readEscrowObject's retry timing for speed.
  suiClient.core.getObjects = async () => ({ objects: [new Error('not found')] });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST, depositAmount: 661 }, { attempts: 1, delayMs: 0 });
  assertEqual(result.ok, false, 'expected ok:false (not accepted on weak evidence)');
  assertEqual(result.retryable, true, 'expected retryable:true');
  assertEqual(result.escrowId, 'real-escrow-id');
});

await test('object content unreadable BUT create_escrow args decodable — verifies amount/host/ref/guest lag-free (finding #1 durable fix)', async () => {
  // Durable fix: under getObjects lag we no longer accept on type+sender alone.
  // Instead we decode create_escrow's own args from the tx (lag-free) and run the
  // FULL strict check — so an under-funded/wrong-host escrow is still rejected.
  const pure = (ser) => ({ Pure: { bytes: toBase64(ser.toBytes()) } });
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: {
        sender: GUEST,
        inputs: [
          pure(bcs.string().serialize('ARIA-2-x')),     // 0 booking_ref
          pure(bcs.Address.serialize(GUEST)),           // 1 guest
          pure(bcs.Address.serialize(HOST)),            // 2 host
          pure(bcs.Address.serialize(ARB)),             // 3 arbitrator
          pure(bcs.u64().serialize(1n)),                // 4 expiry_ms
          pure(bcs.u64().serialize(661000n)),           // 5 split amount = depositToMist(661)
        ],
        commands: [
          { SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 5 }] } },
          { MoveCall: { module: 'escrow', function: 'create_escrow', typeArguments: ['0x2::sui::SUI'],
            arguments: [{ Input: 0 }, { Input: 1 }, { Input: 2 }, { Input: 3 }, { Input: 4 }, { NestedResult: [0, 0] }, { Input: 6 }] } },
        ],
      },
      effects: { changedObjects: [{ objectId: 'real-escrow-id', idOperation: 'Created' }] },
      objectTypes: { 'real-escrow-id': '0xpkg::escrow::BookingEscrow<0x2::sui::SUI>' },
    },
  });
  suiClient.core.getObjects = async () => ({ objects: [new Error('not found')] });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST, host: HOST, bookingRef: 'ARIA-2-x', depositAmount: 661 }, { attempts: 1, delayMs: 0 });
  assertEqual(result.ok, true, 'expected ok:true (verified lag-free from decoded args)');
  assertEqual(result.amountVerified, true, 'amount IS re-verified lag-free via decoded args');
  assertEqual(result.verifiedVia, 'decoded-inputs');
  assertEqual(result.escrowId, 'real-escrow-id');
});

await test('object content unreadable AND create_escrow args undecodable — retryable, never a blind accept (finding #1)', async () => {
  // Type-confirmed, but the tx carries no decodable create_escrow args (e.g. an
  // unexpected shape). Must NOT fall back to accepting on type+sender — retryable.
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: GUEST }, // no inputs/commands to decode
      effects: { changedObjects: [{ objectId: 'real-escrow-id', idOperation: 'Created' }] },
      objectTypes: { 'real-escrow-id': '0xpkg::escrow::BookingEscrow<0x2::sui::SUI>' },
    },
  });
  suiClient.core.getObjects = async () => ({ objects: [new Error('not found')] });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST, depositAmount: 661 }, { attempts: 1, delayMs: 0 });
  assertEqual(result.ok, false, 'undecodable args under content lag must NOT be accepted');
  assertEqual(result.retryable, true, 'expected retryable:true');
});

await test('tx-effects shows no BookingEscrow type AND content unreadable — NOT accepted (retryable, safe)', async () => {
  // A guest reports a tx that created only a non-escrow object (e.g. a Coin) and
  // the content read lags. The type scan finds no BookingEscrow, so it is never
  // type-confirmed; with content unreadable it must NOT be accepted — retryable.
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender: GUEST },
      effects: { changedObjects: [{ objectId: 'real-escrow-id', idOperation: 'Created' }] },
      objectTypes: { 'real-escrow-id': '0x2::coin::Coin<0x2::sui::SUI>' },
    },
  });
  suiClient.core.getObjects = async () => ({ objects: [new Error('not found')] });
  const result = await verifyEscrowTransaction('0xdigest', { sender: GUEST }, { attempts: 1, delayMs: 0 });
  assertEqual(result.ok, false, 'expected ok:false (no escrow type confirmed)');
  assertEqual(result.retryable, true, 'expected retryable:true (not accepted on weak evidence)');
});

console.log('\ndepositToMist\n');

await test('depositToMist: dollars * 1000, floors at 1', () => {
  assertEqual(depositToMist(661).toString(), '661000');
  assertEqual(depositToMist(0).toString(), '1000');   // Math.max(1, 0) * 1000
  assertEqual(depositToMist(1).toString(), '1000');
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

// ─── decodeCreateEscrowArgs (lag-free PTB-arg verification, ARIA_FEE_DESIGN §13) ──
// Builds the parsed-transaction shape (SerializedTransactionDataV2) the gRPC
// getTransaction response carries under `Transaction.transaction`, so the decoder
// can be exercised with no network. create_escrow's Coin arg is a NestedResult of
// a SplitCoins whose amount is a pure u64 input — that's how the funded deposit is
// recovered lag-free.
const _DGUEST = '0x' + '2'.repeat(64);
const _DHOST  = '0x' + '3'.repeat(64);
const _DARB   = '0x' + '4'.repeat(64);
const _pure = (ser) => ({ Pure: { bytes: toBase64(ser.toBytes()) } });
function createEscrowTxData({ ref = 'ARIA-2-x', guest = _DGUEST, host = _DHOST, amount = 661000 } = {}) {
  return {
    inputs: [
      _pure(bcs.string().serialize(ref)),          // 0 booking_ref
      _pure(bcs.Address.serialize(guest)),         // 1 guest
      _pure(bcs.Address.serialize(host)),          // 2 host
      _pure(bcs.Address.serialize(_DARB)),         // 3 arbitrator
      _pure(bcs.u64().serialize(1n)),              // 4 expiry_ms
      _pure(bcs.u64().serialize(BigInt(amount))),  // 5 split amount (deposit)
    ],
    commands: [
      { SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 5 }] } },
      { MoveCall: { module: 'escrow', function: 'create_escrow', typeArguments: ['0x2::sui::SUI'],
        arguments: [{ Input: 0 }, { Input: 1 }, { Input: 2 }, { Input: 3 }, { Input: 4 }, { NestedResult: [0, 0] }, { Input: 6 }] } },
    ],
  };
}

await test('decodeCreateEscrowArgs: decodes ref/guest/host/amount/type lag-free', () => {
  const d = decodeCreateEscrowArgs(createEscrowTxData(), 'escrow');
  assertEqual(d.bookingRef, 'ARIA-2-x');
  assertEqual(d.guest, _DGUEST);
  assertEqual(d.host, _DHOST);
  assertEqual(d.amountMist, '661000');
  assertEqual(d.typeArg, '0x2::sui::SUI');
});

await test('decodeCreateEscrowArgs: surfaces an under-funded deposit amount', () => {
  const d = decodeCreateEscrowArgs(createEscrowTxData({ amount: 1 }), 'escrow');
  assertEqual(d.amountMist, '1'); // verifier compares this to depositToMist(expected)
});

await test('decodeCreateEscrowArgs: wrong module name — returns null', () => {
  assertEqual(decodeCreateEscrowArgs(createEscrowTxData(), 'nope'), null);
});

await test('decodeCreateEscrowArgs: malformed transaction — returns null (no throw)', () => {
  assertEqual(decodeCreateEscrowArgs({}, 'escrow'), null);
  assertEqual(decodeCreateEscrowArgs(null, 'escrow'), null);
});

// Combined payment+deposit PTB: coinWithBalance consolidates both coins into ONE
// SplitCoins [payment, deposit], so create_escrow's coin is NestedResult[split, 1].
// The decoder must read amounts[1] (deposit), not amounts[0] (payment) — the bug
// that rejected the first live combined booking. Regression lock.
await test('decodeCreateEscrowArgs: consolidated split — reads deposit at the coin result index', () => {
  const tx = {
    inputs: [
      _pure(bcs.string().serialize('ARIA-1-y')),   // 0 ref
      _pure(bcs.Address.serialize(_DGUEST)),       // 1 guest
      _pure(bcs.Address.serialize(_DHOST)),        // 2 host
      _pure(bcs.Address.serialize(_DARB)),         // 3 arbitrator
      _pure(bcs.u64().serialize(1n)),              // 4 expiry
      _pure(bcs.u64().serialize(331000n)),         // 5 payment split amount
      _pure(bcs.u64().serialize(66000n)),          // 6 deposit split amount
    ],
    commands: [
      { SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 5 }, { Input: 6 }] } },
      { MoveCall: { module: 'escrow', function: 'create_escrow', typeArguments: ['0x2::sui::SUI'],
        arguments: [{ Input: 0 }, { Input: 1 }, { Input: 2 }, { Input: 3 }, { Input: 4 }, { NestedResult: [0, 1] }, { Input: 7 }] } },
    ],
  };
  const d = decodeCreateEscrowArgs(tx, 'escrow');
  assertEqual(d.amountMist, '66000'); // deposit (result idx 1), not payment (331000)
});

// ─── decodeClaimDamageAmountMist (P1-2: authoritative claim amount) ──────────
// claim_damage(escrow, claim_amount, clock) — amount is arguments[1], a pure u64.
function claimDamageTxData({ claimMist = 50000 } = {}) {
  return {
    inputs: [
      { Object: { ImmOrOwnedObject: {} } },        // 0 escrow object
      _pure(bcs.u64().serialize(BigInt(claimMist))), // 1 claim_amount
      { Object: { SharedObject: {} } },            // 2 clock
    ],
    commands: [
      { MoveCall: { module: 'escrow', function: 'claim_damage', typeArguments: ['0x2::sui::SUI'],
        arguments: [{ Input: 0 }, { Input: 1 }, { Input: 2 }] } },
    ],
  };
}

await test('decodeClaimDamageAmountMist: reads the signed claim amount (arg[1]) lag-free', () => {
  assertEqual(decodeClaimDamageAmountMist(claimDamageTxData({ claimMist: 50000 }), 'escrow'), '50000'); // $50
});

await test('decodeClaimDamageAmountMist: wrong module — returns null', () => {
  assertEqual(decodeClaimDamageAmountMist(claimDamageTxData(), 'nope'), null);
});

await test('decodeClaimDamageAmountMist: malformed transaction — returns null (no throw)', () => {
  assertEqual(decodeClaimDamageAmountMist({}, 'escrow'), null);
  assertEqual(decodeClaimDamageAmountMist(null, 'escrow'), null);
});

// ─── Phase 1h.5: payment escrow (rental + ARIA fee + tax) ───────────────────
// dollarsToUnits scaling, the lag-free create_payment_escrow arg decoder, and
// the verifier's adversarial matrix (§12) — all network-free via mocks.

await test('dollarsToUnits: ×1000 scaling, zero leg, and cents', () => {
  assertEqual(dollarsToUnits(1000).toString(), '1000000');
  assertEqual(dollarsToUnits(0).toString(), '0');          // tax-exempt leg
  assertEqual(dollarsToUnits(661.5).toString(), '661500'); // cents round-trip
});

// Treasury + party addresses for the payment-escrow tests.
const P_ARIA = '0x' + 'a'.repeat(64);
const P_TAX  = '0x' + 'b'.repeat(64);
// create_payment_escrow(ref, guest, host, aria_addr, tax_addr, arbitrator,
//   host_amount, aria_amount, tax_amount, release_ms, coin, clock)  +  the
// deposit create_escrow in the SAME tx. Builds the parsed-tx (inputs/commands)
// shape getTransaction carries under Transaction.transaction.
function combinedTxData(o = {}) {
  const {
    ref = 'ARIA-2-x', guest = GUEST, host = HOST,
    ariaAddr = P_ARIA, taxAddr = P_TAX, arb = ARB,
    hostUnits = 1000000, ariaUnits = 30000, taxUnits = 130000,
    releaseMs = 9999, depUnits = depositToMist(232).toString(),
  } = o;
  return {
    sender: o.sender || guest,
    inputs: [
      _pure(bcs.string().serialize(ref)),                  // 0 booking_ref
      _pure(bcs.Address.serialize(guest)),                 // 1 guest
      _pure(bcs.Address.serialize(host)),                  // 2 host
      _pure(bcs.Address.serialize(ariaAddr)),              // 3 aria_addr
      _pure(bcs.Address.serialize(taxAddr)),               // 4 tax_addr
      _pure(bcs.Address.serialize(arb)),                   // 5 arbitrator
      _pure(bcs.u64().serialize(BigInt(hostUnits))),       // 6 host_amount
      _pure(bcs.u64().serialize(BigInt(ariaUnits))),       // 7 aria_amount
      _pure(bcs.u64().serialize(BigInt(taxUnits))),        // 8 tax_amount
      _pure(bcs.u64().serialize(BigInt(releaseMs))),       // 9 release_time_ms
      _pure(bcs.u64().serialize(1n)),                      // 10 deposit expiry_ms
      _pure(bcs.u64().serialize(BigInt(depUnits))),        // 11 deposit split amount
      _pure(bcs.u64().serialize(BigInt(hostUnits) + BigInt(ariaUnits) + BigInt(taxUnits))), // 12 payment split amount
      { Object: { SharedObject: {} } },                    // 13 clock
    ],
    commands: [
      { SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 12 }] } }, // cmd 0 -> payment coin
      { SplitCoins: { coin: { GasCoin: true }, amounts: [{ Input: 11 }] } }, // cmd 1 -> deposit coin
      { MoveCall: { module: 'escrow', function: 'create_payment_escrow', typeArguments: ['0x2::sui::SUI'],
        arguments: [{ Input: 0 }, { Input: 1 }, { Input: 2 }, { Input: 3 }, { Input: 4 }, { Input: 5 },
          { Input: 6 }, { Input: 7 }, { Input: 8 }, { Input: 9 }, { NestedResult: [0, 0] }, { Input: 13 }] } },
      { MoveCall: { module: 'escrow', function: 'create_escrow', typeArguments: ['0x2::sui::SUI'],
        arguments: [{ Input: 0 }, { Input: 1 }, { Input: 2 }, { Input: 5 }, { Input: 10 }, { NestedResult: [1, 0] }, { Input: 13 }] } },
    ],
  };
}

await test('decodeCreatePaymentEscrowArgs: decodes all legs/destinations lag-free', () => {
  const d = decodeCreatePaymentEscrowArgs(combinedTxData(), 'escrow');
  assertEqual(d.bookingRef, 'ARIA-2-x');
  assertEqual(d.guest, GUEST);
  assertEqual(d.host, HOST);
  assertEqual(d.ariaAddr, P_ARIA);
  assertEqual(d.taxAddr, P_TAX);
  assertEqual(d.arbitrator, ARB);
  assertEqual(d.hostAmount, '1000000');
  assertEqual(d.ariaAmount, '30000');
  assertEqual(d.taxAmount, '130000');
  assertEqual(d.releaseMs, '9999');
  assertEqual(d.typeArg, '0x2::sui::SUI');
});

await test('decodeCreatePaymentEscrowArgs: wrong module / malformed — returns null', () => {
  assertEqual(decodeCreatePaymentEscrowArgs(combinedTxData(), 'nope'), null);
  assertEqual(decodeCreatePaymentEscrowArgs({}, 'escrow'), null);
  assertEqual(decodeCreatePaymentEscrowArgs(null, 'escrow'), null);
});

// Wire the env the verifier reads, and a mock getTransaction returning a
// combined booking tx with both escrow object types present lag-free.
process.env.ESCROW_MODULE_NAME = 'escrow';
process.env.ARIA_FEE_ADDRESS = P_ARIA;
process.env.ARIA_TAX_REMITTANCE_ADDRESS = P_TAX;
process.env.ARIA_ARBITRATOR_ADDRESS = ARB;
const PAY_ID = '0x' + '7'.repeat(64);
const DEP_ID = '0x' + '8'.repeat(64);
function mockPaymentChain(o = {}) {
  const tx = combinedTxData(o);
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      transaction: tx,
      effects: { changedObjects: [] },
      objectTypes: {
        [PAY_ID]: '0xpkg::escrow::BookingPaymentEscrow<0x2::sui::SUI>',
        [DEP_ID]: '0xpkg::escrow::BookingEscrow<0x2::sui::SUI>',
      },
    },
  });
}
// Server-authoritative expected values matching the happy-path tx.
const EXPECTED = {
  sender: GUEST, host: HOST, bookingRef: 'ARIA-2-x',
  subtotal: 1000, ariaFee: 30, taxes: 130, depositAmount: 232, releaseMs: 9999,
};

await test('verifyBookingPaymentTransaction: happy path returns both escrow ids', async () => {
  mockPaymentChain();
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, true);
  assertEqual(r.paymentEscrowId, PAY_ID);
  assertEqual(r.depositEscrowId, DEP_ID);
});

await test('verify §12 T1: tampered ARIA-fee destination is rejected', async () => {
  mockPaymentChain({ ariaAddr: '0x' + 'c'.repeat(64) }); // attacker wallet
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

await test('verify §12 T1: tampered host (rental) destination is rejected', async () => {
  mockPaymentChain({ host: '0x' + 'd'.repeat(64) });
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

await test('verify §12: under-funded rental leg is rejected', async () => {
  mockPaymentChain({ hostUnits: 1 });
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

await test('verify §12: wrong ARIA-fee leg amount is rejected', async () => {
  mockPaymentChain({ ariaUnits: 1 });
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

await test('verify: wrong release time (check-in) is rejected', async () => {
  mockPaymentChain({ releaseMs: 5 });
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

await test('verify: booking_ref mismatch is rejected', async () => {
  mockPaymentChain({ ref: 'ARIA-9-evil' });
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

await test('verify: sender not the booking guest is rejected', async () => {
  mockPaymentChain({ sender: '0x' + 'e'.repeat(64) });
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

await test('verify: under-funded deposit escrow in same tx is rejected', async () => {
  mockPaymentChain({ depUnits: '1' });
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

await test('verify: failed on-chain tx is rejected', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'FailedTransaction',
    FailedTransaction: { status: { error: { message: 'boom' } } },
  });
  const r = await verifyBookingPaymentTransaction('digest', EXPECTED);
  assertEqual(r.ok, false);
});

console.log('\nverifyBuyResaleTransaction (Phase 2c)\n');

// A valid buy reassigns BOTH escrows to the buyer (both objects Mutated), signed
// by the buyer.
function mockBuyResaleChain({ sender = '0xbuyer', deposit = true, payment = true } = {}) {
  const changedObjects = [{ objectId: 'gas-coin-id', idOperation: 'Mutated' }];
  if (deposit) changedObjects.push({ objectId: 'deposit-id', idOperation: 'Mutated' });
  if (payment) changedObjects.push({ objectId: 'payment-id', idOperation: 'Mutated' });
  suiClient.core.getTransaction = async () => ({
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      transaction: { sender },
      effects: { changedObjects },
    },
  });
}

await test('buy_resale: buyer signed + both escrows reassigned — returns ok:true', async () => {
  mockBuyResaleChain({ sender: '0xbuyer' });
  const r = await verifyBuyResaleTransaction('0xdigest', '0xbuyer', 'deposit-id', 'payment-id');
  assertEqual(r.ok, true, 'expected ok:true');
  assertEqual(r.sender, '0xbuyer');
});

await test('buy_resale: wrong sender (not the buyer) — returns ok:false', async () => {
  mockBuyResaleChain({ sender: '0xsomeoneelse' });
  const r = await verifyBuyResaleTransaction('0xdigest', '0xbuyer', 'deposit-id', 'payment-id');
  assertEqual(r.ok, false, 'expected ok:false');
  assertEqual(r.reason, 'Transaction sender does not match the expected buyer');
});

await test('buy_resale: deposit escrow not reassigned — returns ok:false', async () => {
  mockBuyResaleChain({ sender: '0xbuyer', deposit: false });
  const r = await verifyBuyResaleTransaction('0xdigest', '0xbuyer', 'deposit-id', 'payment-id');
  assertEqual(r.ok, false, 'expected ok:false');
});

await test('buy_resale: payment escrow not reassigned — returns ok:false', async () => {
  mockBuyResaleChain({ sender: '0xbuyer', payment: false });
  const r = await verifyBuyResaleTransaction('0xdigest', '0xbuyer', 'deposit-id', 'payment-id');
  assertEqual(r.ok, false, 'expected ok:false');
});

await test('buy_resale: failed on-chain tx — returns ok:false', async () => {
  suiClient.core.getTransaction = async () => ({
    $kind: 'FailedTransaction',
    FailedTransaction: { status: { error: { message: 'boom' } } },
  });
  const r = await verifyBuyResaleTransaction('0xdigest', '0xbuyer', 'deposit-id', 'payment-id');
  assertEqual(r.ok, false, 'expected ok:false');
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
