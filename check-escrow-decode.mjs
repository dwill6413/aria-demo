// check-escrow-decode.mjs
// ─── One-off live validation for the lag-free decode path (ARIA_FEE_DESIGN §13) ──
//
// Confirms, against a REAL fetched testnet create_escrow transaction, that:
//   1. suiClient.core.getTransaction exposes `txn.transaction.inputs/commands`
//      in the SerializedTransactionDataV2 shape the decoder assumes, and
//   2. decodeCreateEscrowArgs() actually decodes booking_ref / guest / host /
//      amount / typeArg from it (i.e. the deposit amount is recoverable from the
//      SplitCoins input even though create_escrow takes a Coin, no amount arg).
//
// This is the build-time check that retires the §13 caveat. It uses the REAL
// exported suiClient + decodeCreateEscrowArgs from escrow.mjs, so a PASS here
// means the production verification path works against this network/SDK version.
//
// Usage (run where @mysten/sui is installed, e.g. the project root):
//   node check-escrow-decode.mjs <digest> [expectedDepositDollars]
// e.g.
//   node check-escrow-decode.mjs 7Xb...digest 661
//
// Get a digest from any past create_escrow: a booking's escrow-creation tx
// (Suiscan testnet, or the digest your frontend logged after the guest signed).

import { suiClient, decodeCreateEscrowArgs, depositToMist } from './escrow.mjs';

const digest = process.argv[2];
const expectedDeposit = process.argv[3] != null ? Number(process.argv[3]) : null;
const MODULE = process.env.ESCROW_MODULE_NAME || 'escrow';

if (!digest) {
  console.error('Usage: node check-escrow-decode.mjs <digest> [expectedDepositDollars]');
  process.exit(2);
}

// Compact preview of a value so we can see the real shape if something differs.
const preview = (v) => {
  try { return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `Uint8Array(${x.length})` : x)).slice(0, 240); }
  catch { return String(v); }
};

function ok(msg)   { console.log(`  ✅ ${msg}`); }
function bad(msg)  { console.log(`  ❌ ${msg}`); }
function info(msg) { console.log(`  • ${msg}`); }

let failures = 0;
const fail = (m) => { bad(m); failures++; };

console.log(`\nFetching ${digest} (network: testnet, module: ${MODULE})\n`);

let result;
try {
  result = await suiClient.core.getTransaction({
    digest,
    include: { transaction: true, effects: true, objectTypes: true },
  });
} catch (err) {
  console.error('getTransaction threw:', err?.message || err);
  process.exit(1);
}

// 1. Unwrap the discriminated union (same as verifyEscrowTransaction).
if (result?.$kind !== 'Transaction') {
  const msg = result?.FailedTransaction?.status?.error?.message;
  fail(`result.$kind is "${result?.$kind}" (expected "Transaction")${msg ? ` — ${msg}` : ''}`);
  console.log(`\nResult preview: ${preview(result)}\n`);
  process.exit(1);
}
ok('result.$kind === "Transaction"');
const txn = result.Transaction;

// 2. The parsed transaction with inputs/commands must be present.
const t = txn?.transaction;
if (!t) { fail('txn.transaction is missing — did include.transaction take effect?'); process.exit(1); }
info(`sender: ${t.sender}`);

if (!Array.isArray(t.inputs))   fail('txn.transaction.inputs is not an array'); else ok(`inputs: ${t.inputs.length}`);
if (!Array.isArray(t.commands)) fail('txn.transaction.commands is not an array'); else ok(`commands: ${t.commands.length}`);

// 3. Show the live shape of the first Pure input + the command kinds, so if the
//    decoder assumptions are off we can see exactly how this SDK/network differs.
if (Array.isArray(t.inputs)) {
  const firstPure = t.inputs.find((i) => i && i.Pure);
  info(`first Pure input shape: ${firstPure ? preview(firstPure) : '(none found — inputs may use a different envelope)'}`);
}
if (Array.isArray(t.commands)) {
  info(`command kinds: ${t.commands.map((c) => Object.keys(c)[0]).join(', ')}`);
}

// 4. The real decoder, on the real fetched transaction.
const decoded = decodeCreateEscrowArgs(t, MODULE);
if (!decoded) {
  fail('decodeCreateEscrowArgs returned null — no create_escrow call decoded, or unexpected shape.');
  console.log('\n   The decoder maps MoveCall args to inputs by index and reads the SplitCoins');
  console.log('   amount feeding the coin arg. If the command/input envelope above differs from');
  console.log('   { Pure: { bytes } } / { MoveCall } / { SplitCoins: { amounts:[{Input}] } } /');
  console.log('   { NestedResult } / { Input }, update decodeCreateEscrowArgs in escrow.mjs to match.\n');
  process.exit(1);
}

console.log('\nDecoded create_escrow args:');
info(`booking_ref: ${decoded.bookingRef}`);
info(`guest:       ${decoded.guest}`);
info(`host:        ${decoded.host}`);
info(`amount:      ${decoded.amountMist} (on-chain units)`);
info(`typeArg:     ${decoded.typeArg}`);

if (decoded.amountMist == null) fail('amount could not be recovered from the SplitCoins input.');
else ok('deposit amount recovered lag-free from the SplitCoins input.');

// 5. Optional: confirm the decoded amount matches an expected deposit (dollars).
if (expectedDeposit != null) {
  const expectedMist = depositToMist(expectedDeposit).toString();
  if (String(decoded.amountMist) === expectedMist) ok(`amount matches depositToMist(${expectedDeposit}) = ${expectedMist}`);
  else fail(`amount ${decoded.amountMist} != depositToMist(${expectedDeposit}) = ${expectedMist}`);
}

console.log(
  failures === 0
    ? '\n✅ LIVE CHECK PASSED — the gRPC response shape matches the decoder; §13 caveat can be retired.\n'
    : `\n❌ LIVE CHECK FAILED (${failures}) — see the shape diagnostics above and adjust decodeCreateEscrowArgs.\n`,
);
process.exit(failures === 0 ? 0 : 1);
