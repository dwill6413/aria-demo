// ─── Sui Escrow Helpers (Phase 2b extraction) ─────────────────────────────────
// Moved out of server.mjs verbatim so ai_route.mjs (via bookings.mjs) can build
// the same guest-signed escrow PTB that server.mjs's REST /booking/create path
// already used. Previously this lived only in server.mjs, which meant
// AI-chat-created bookings (ai_route.mjs's create_booking tool) never built an
// escrow transaction at all — the AI flow told guests their deposit was "held
// in Sui escrow" when no escrow object had ever been created. Centralizing
// these helpers here closes that gap by giving both call sites the exact same
// on-chain logic instead of one having it and the other silently lacking it.
//
// Nothing about the non-custodial design changes: the backend still only
// assembles unsigned transaction bytes and hands them back to the caller —
// it never holds a key that can move guest funds. See buildEscrowTransaction's
// comments below for the full reasoning (unchanged from the original).

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { toBase64, fromBase64 } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';

export const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

// BCS layout of the on-chain BookingEscrow<T> struct (escrow.move), used to
// decode an object's raw `content` bytes and verify its fields actually match
// the booking before we trust a guest-reported escrow-creation digest. A UID
// serializes as a bare 32-byte address; Coin<T> is { id: UID, balance:
// Balance<T> { value: u64 } }. Order/types must mirror the Move struct exactly.
const BalanceBcs = bcs.struct('Balance', { value: bcs.u64() });
const CoinBcs = bcs.struct('Coin', { id: bcs.Address, balance: BalanceBcs });
// Exported so unit tests can construct matching object `content` bytes without
// a live chain (see escrow.test.mjs).
export const BookingEscrowBcs = bcs.struct('BookingEscrow', {
  id:           bcs.Address,
  booking_ref:  bcs.string(),
  guest:        bcs.Address,
  host:         bcs.Address,
  arbitrator:   bcs.Address,
  amount:       bcs.u64(),
  coin:         CoinBcs,
  expiry_ms:    bcs.u64(),
  status:       bcs.u8(),
  claim_amount: bcs.u64(),
});

// Converts a dollar deposit amount to the symbolic testnet mist value the
// escrow actually holds — the SINGLE source of this conversion so
// buildEscrowTransaction (which funds the coin) and verifyEscrowTransaction
// (which checks the funded amount) can never drift apart. See
// buildEscrowTransaction for why it's depositAmount * 1000 on testnet.
export function depositToMist(depositAmount) {
  return BigInt(Math.max(1, depositAmount)) * 1000n;
}

// Normalizes a Sui address for comparison (lowercase, 0x-prefixed, unpadded
// leading zeros stripped) so two encodings of the same address compare equal.
function normalizeAddr(a) {
  if (!a) return '';
  let h = String(a).toLowerCase();
  if (!h.startsWith('0x')) h = '0x' + h;
  const body = h.slice(2).replace(/^0+/, '') || '0';
  return '0x' + body;
}

// Reads a BookingEscrow object's decoded fields from the chain by id. Returns
// `{ type, fields }` on success, or `{ error }` describing why it couldn't be
// read (object not yet queryable, RPC error, or content decode failure).
//
// RETRY: the guest submits their escrow tx and immediately reports the digest;
// the backend then queries getTransaction (available right after execution) AND
// getObjects (current object state, which can lag a beat behind on the read
// node). A read-after-write race here would otherwise wrongly reject a perfectly
// valid, on-chain-confirmed deposit — so we retry the object read a few times
// with backoff before giving up. A BCS-decode failure is NOT retried (it won't
// improve) and is surfaced distinctly so it can be diagnosed.
export async function readEscrowObject(escrowObjectId, {
  attempts = Number(process.env.ESCROW_READ_ATTEMPTS || 3),
  delayMs = Number(process.env.ESCROW_READ_DELAY_MS || 1500),
  logger = console,
} = {}) {
  // Public testnet fullnodes serve getTransaction instantly but lag on
  // getObjects for a just-created object (often >5s, varying by replica). The
  // window below (~18s by default) is sized so the strict object validation
  // actually completes rather than falling through to the retryable path on
  // every booking. Tune via ESCROW_READ_ATTEMPTS / ESCROW_READ_DELAY_MS.
  let lastError = 'unknown';
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await suiClient.core.getObjects({
        objectIds: [escrowObjectId],
        include: { content: true },
      });
      const obj = resp?.objects?.[0];
      if (obj && !(obj instanceof Error) && obj.type && obj.content) {
        try {
          return { type: obj.type, fields: BookingEscrowBcs.parse(obj.content) };
        } catch (e) {
          logger?.warn?.({ escrowObjectId, err: e.message }, 'readEscrowObject: BCS decode failed');
          return { error: `bcs-decode: ${e.message}` };
        }
      }
      lastError = obj instanceof Error ? `object-error: ${obj.message}`
        : (!obj ? 'object-not-found' : 'object-missing-content');
    } catch (e) {
      lastError = `rpc-error: ${e.message}`;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  logger?.warn?.({ escrowObjectId, lastError }, 'readEscrowObject: object not readable after retries');
  return { error: lastError };
}

// P1b (key separation): this used to be ARIA_DEPLOYER_KEY, the same hot key
// that originally published the package and held the UpgradeCap. Now that
// escrow CREATION is guest-signed (P0b), the only thing the backend itself
// still signs is auto_release — and auto_release is permissionless on-chain
// (see escrow.move: "Callable by anyone"), so this key carries zero special
// privilege. It only needs enough gas to submit the call. The original
// deployer/UpgradeCap key has been retired from Railway and moved to cold
// KeePass-only storage; it is never loaded by this backend anymore.
export let autoReleaseKeypair = null;
try {
  if (process.env.ARIA_AUTO_RELEASE_KEY) {
    const { secretKey } = decodeSuiPrivateKey(process.env.ARIA_AUTO_RELEASE_KEY);
    autoReleaseKeypair = Ed25519Keypair.fromSecretKey(secretKey);
    console.log('Sui auto-release keypair loaded:', autoReleaseKeypair.toSuiAddress());
  }
} catch (err) {
  console.warn('ARIA_AUTO_RELEASE_KEY invalid or missing — auto_release transactions disabled:', err.message);
}

// P2 / Phase 1j: resolve_dispute asserts tx_context::sender == escrow.arbitrator
// on-chain (unlike auto_release, which is permissionless — see the long
// comment above autoReleaseEscrow below). That means SOME key has to actually
// be the arbitrator for ARIA to fulfil the roadmap's "ARIA calls
// resolve_dispute on contract with the final split" design. Following the
// same P1b narrow-scoping principle as ARIA_AUTO_RELEASE_KEY: this key's only
// job is signing resolve_dispute calls after a human (ARIA admin) has already
// decided the split via the /booking/resolve-dispute route's HOST_ADDRESSES
// gate — it never touches a guest- or host-owned coin directly, the Move
// contract itself enforces guest_amount + host_amount == escrow.amount.
//
// For resolve_dispute to actually succeed on a given escrow, that escrow's
// `arbitrator` field (set once, at create_escrow time, from
// ARIA_ARBITRATOR_ADDRESS) must equal this keypair's address. Set
// ARIA_ARBITRATOR_ADDRESS to this key's public address so new bookings pick
// it up — escrows created before that env var was set still have the old
// fallback (hostAddr) baked in immutably and cannot be resolved by this key.
export let arbitratorKeypair = null;
try {
  if (process.env.ARIA_ARBITRATOR_KEY) {
    const { secretKey } = decodeSuiPrivateKey(process.env.ARIA_ARBITRATOR_KEY);
    arbitratorKeypair = Ed25519Keypair.fromSecretKey(secretKey);
    console.log('Sui arbitrator keypair loaded:', arbitratorKeypair.toSuiAddress());
  }
} catch (err) {
  console.warn('ARIA_ARBITRATOR_KEY invalid or missing — resolve_dispute transactions disabled:', err.message);
}

// Extracts the ID of the last "Created" object from a PTB's changedObjects array.
// When a transaction splits a coin AND creates a shared object, both appear as
// "Created" entries. PTB execution order guarantees the ephemeral split-coin
// comes FIRST and the real persistent object comes LAST — so we always take last.
// Covered by 15 unit tests in escrow.test.mjs.
export function extractCreatedObjectId(changedObjects) {
  const createdEntries = (changedObjects || []).filter(c => {
    let op = c.idOperation ?? c.operation ?? c.id_operation ?? c.$kind;
    if (op && typeof op === 'object') op = op.$kind;
    return typeof op === 'string' && /created/i.test(op);
  });
  const chosen = createdEntries[createdEntries.length - 1];
  return chosen?.objectId ?? chosen?.id ?? chosen?.object_id ?? null;
}

// P2 / Phase 1j: claim_damage and dispute_claim take `&mut BookingEscrow<T>`
// rather than consuming it — the shared object keeps its existing ID and
// shows up in a PTB's effects as a "Mutated" changedObjects entry, not
// "Created". This checks that the specific escrow object id we expect to see
// mutated actually appears with a mutated-type operation, so a digest that
// happened to touch some unrelated object can't be mistaken for a real
// claim/dispute confirmation.
export function isObjectMutated(changedObjects, expectedObjectId) {
  if (!expectedObjectId) return false;
  return (changedObjects || []).some(c => {
    const id = c.objectId ?? c.id ?? c.object_id;
    if (id !== expectedObjectId) return false;
    let op = c.idOperation ?? c.operation ?? c.id_operation ?? c.$kind;
    if (op && typeof op === 'object') op = op.$kind;
    return typeof op === 'string' && /mutated/i.test(op);
  });
}

// Builds (but does NOT sign or execute) the PTB that creates a BookingEscrow
// shared object on Sui testnet, with the GUEST set as sender. This is the
// non-custodial flip for P0b: ARIA's backend never holds a key that can move
// guest funds — it only assembles the transaction's logic, then hands back
// unsigned BCS bytes for the guest's own browser (via zkLogin) to sign and
// submit directly to Sui. coinWithBalance resolves the deposit coin from the
// SENDER's on-chain balance at build time, so once setSender(guestAddr)
// replaces the old deployer sender, the guest's own SUI funds the deposit —
// the deployer is never debited and never has signing authority over this tx.
// depositMist: use depositAmount (dollars) * 1000 as a symbolic testnet amount.
// For testnet testing, expiry is set to 5 minutes from now so auto_release
// can be triggered quickly. Change to checkoutMs + FIVE_DAYS_MS for mainnet.
//
// Returns { txBytes: base64 string } on success, or null if escrow is
// unconfigured/unbuildable. Caller ships txBytes to the guest's browser;
// nothing is written to the DB here — see verifyEscrowTransaction below (used
// by the /booking/:bookingRef/escrow/confirm route) for the verified,
// chain-checked write, which is the only path allowed to set escrow_object_id.
export async function buildEscrowTransaction(bookingRef, guestAddr, hostAddr, depositAmount, logger = console) {
  if (!guestAddr || !hostAddr || !process.env.ESCROW_PACKAGE_ID) return null;
  // P1b: no longer falls back to the backend signer's own address. That key
  // is now intentionally low-privilege (gas-only, for auto_release) and must
  // never end up holding arbitrator authority (resolve_dispute checks
  // tx_context::sender == escrow.arbitrator on-chain) just because
  // ARIA_ARBITRATOR_ADDRESS happened to be unset. Fall back to hostAddr
  // instead, same as before P1a's dedicated arbitrator key existed.
  const arbitrator = process.env.ARIA_ARBITRATOR_ADDRESS || hostAddr;
  try {
    const depositMist = depositToMist(depositAmount);
    const expiryMs    = BigInt(Date.now()) + 300_000n; // 5-min testnet window

    const tx = new Transaction();
    tx.setSender(guestAddr);

    // coinWithBalance resolves a coin of this balance from the SENDER's
    // (guest's) holdings automatically — no manual getCoins/splitCoins needed.
    const coin = coinWithBalance({ balance: depositMist });

    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::create_escrow`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.pure.string(bookingRef),
        tx.pure.address(guestAddr),
        tx.pure.address(hostAddr),
        tx.pure.address(arbitrator),
        tx.pure.u64(expiryMs),
        coin,
        tx.object('0x6'), // Clock — client resolves shared object version
      ],
    });

    const txBytes = await tx.build({ client: suiClient });
    return { txBytes: toBase64(txBytes) };
  } catch (err) {
    logger?.error?.({ message: err.message, name: err.name, stack: err.stack?.split('\n').slice(0, 4).join(' | ') }, 'buildEscrowTransaction error');
    return null;
  }
}

// ── Lag-free PTB-argument decoding ──────────────────────────────────────────
// The strict object-content check below depends on getObjects, which on public
// testnet fullnodes can fail to serve a just-created object for >1 min. These
// helpers instead decode create_escrow's arguments straight from the parsed
// transaction (`txn.transaction.{inputs,commands}`, present in the SAME
// getTransaction response, so lag-free) — closing the under-funding gap where a
// guest could report a digest for a near-zero / wrong-host escrow during lag.
//
// Validated against @mysten/sui: pure u64/address/string inputs round-trip via
// BCS, and create_escrow's Coin arg is a NestedResult of a SplitCoins whose
// amount is itself a pure u64 input — so the funded deposit is recoverable
// without reading the object. See ARIA_FEE_DESIGN.md §13.
const _pureBytes = (inp) => fromBase64(inp.Pure.bytes);
const _asU64  = (inp) => bcs.u64().parse(_pureBytes(inp));      // -> decimal string
const _asAddr = (inp) => bcs.Address.parse(_pureBytes(inp));   // -> 0x… (64 hex)
const _asStr  = (inp) => bcs.string().parse(_pureBytes(inp));

// Decode create_escrow's args from a parsed transaction. Returns null if the
// shape isn't what we expect (caller then falls back to retryable, never to a
// blind accept). Maps args to inputs BY INDEX — never guesses by byte length.
export function decodeCreateEscrowArgs(transaction, moduleName) {
  try {
    const inputs = transaction?.inputs;
    const commands = transaction?.commands;
    if (!Array.isArray(inputs) || !Array.isArray(commands)) return null;

    const call = commands.find(
      (c) => c?.MoveCall && c.MoveCall.module === moduleName && c.MoveCall.function === 'create_escrow',
    )?.MoveCall;
    if (!call || !Array.isArray(call.arguments)) return null;

    const inputOf = (arg) => (arg && arg.Input != null ? inputs[arg.Input] : arg);
    // create_escrow(booking_ref, guest, host, arbitrator, expiry_ms, coin, clock)
    const [refA, guestA, hostA, , , coinA] = call.arguments;

    // Deposit amount = the SplitCoins amount whose result feeds the coin arg.
    let amountMist = null;
    const splitIdx = coinA?.Result ?? (coinA?.NestedResult ? coinA.NestedResult[0] : null);
    if (splitIdx != null) {
      const sc = commands[splitIdx]?.SplitCoins;
      if (sc && Array.isArray(sc.amounts) && sc.amounts[0]) {
        amountMist = _asU64(inputOf(sc.amounts[0]));
      }
    }

    return {
      bookingRef: refA?.Input != null ? _asStr(inputs[refA.Input]) : null,
      guest:      guestA?.Input != null ? _asAddr(inputs[guestA.Input]) : null,
      host:       hostA?.Input != null ? _asAddr(inputs[hostA.Input]) : null,
      amountMist,
      typeArg:    call.typeArguments?.[0] ?? null,
    };
  } catch {
    return null; // unexpected shape → caller treats as not-yet-verifiable
  }
}

// Re-queries Sui directly for a transaction digest the guest reported after
// signing+submitting their escrow tx client-side, and extracts the resulting
// escrow object id from the CHAIN's own effects — never trusts a value the
// client merely claims. This is the only legitimate source of truth for
// writing escrow_object_id into bookings, since /tax/summary joins against
// that table for host tax record-keeping.
// `expected` carries the booking's own authoritative values so the chain
// result can be checked AGAINST them, not just for internal success:
//   { sender, host, bookingRef, depositAmount }
// Because the guest signs and submits this transaction in their own browser,
// they could otherwise substitute a create_escrow that funds a near-zero
// deposit, names a different host, or even creates an unrelated object, then
// report that digest here — the backend would mark deposit_status='held' on a
// worthless escrow, silently gutting the host's damage protection. So beyond
// confirming the tx succeeded and the sender is the guest, we now re-read the
// created object on-chain and assert it really is OUR BookingEscrow type,
// funded with the expected amount, naming the expected guest/host/booking_ref.
export async function verifyEscrowTransaction(digest, expected = {}, readOptions = {}) {
  const { sender: expectedSender, host: expectedHost, bookingRef: expectedRef, depositAmount } = expected;

  const result = await suiClient.core.getTransaction({
    digest,
    include: { transaction: true, effects: true, objectTypes: true },
  });

  // suiClient.core.getTransaction returns a discriminated union, NOT a flat
  // object — per @mysten/sui's own SuiClientTypes.TransactionResult, the real
  // payload (status/transaction/effects) lives nested under `.Transaction`
  // (success) or `.FailedTransaction` (failure), keyed by top-level `$kind`.
  // The old code read result.status/.transaction/.effects directly, which are
  // always undefined on the wrapper itself — so this reported "failed" for
  // every transaction, including ones that succeeded on-chain (confirmed via
  // Suiscan during live testing). See autoReleaseEscrow below, which already
  // unwraps this same shape correctly via result.$kind/.FailedTransaction.
  if (result?.$kind !== 'Transaction') {
    const errMsg = result?.FailedTransaction?.status?.error?.message;
    return { ok: false, reason: errMsg || 'Transaction did not succeed on-chain' };
  }

  const txn = result.Transaction;

  const actualSender = txn?.transaction?.sender;
  if (expectedSender && actualSender && normalizeAddr(actualSender) !== normalizeAddr(expectedSender)) {
    return { ok: false, reason: 'Transaction sender does not match the booking guest' };
  }

  const mod = process.env.ESCROW_MODULE_NAME || 'escrow';
  const isOurEscrowType = (t) => typeof t === 'string' && new RegExp(`::${mod}::BookingEscrow<`).test(t);

  // PRIMARY (lag-free) type gate. The created object's type comes from the
  // transaction's OWN effects (the objectTypes map in the same getTransaction
  // response), so it does NOT depend on the separate getObjects read — which on
  // public testnet fullnodes can fail to serve a just-created object for >1 min.
  // We scan the map by VALUE for our BookingEscrow type and take that key as the
  // escrow id — robust to objectId key-formatting differences between the map
  // and the changedObjects list, and to which "Created" entry happens to be last.
  const objectTypes = txn?.objectTypes || {};
  let escrowId = null;
  for (const [oid, t] of Object.entries(objectTypes)) {
    if (isOurEscrowType(t)) { escrowId = oid; break; }
  }
  const typeConfirmed = !!escrowId;

  // Fall back to the last-created heuristic only if objectTypes didn't yield our
  // escrow (e.g. the node didn't populate the map).
  if (!escrowId) escrowId = extractCreatedObjectId(txn?.effects?.changedObjects);
  if (!escrowId) {
    return { ok: false, reason: 'No created object found in transaction effects' };
  }

  // SECONDARY (best-effort) strict check: read the object's content to verify it
  // is funded with the expected deposit and names the right guest/host/booking_ref
  // (guards against under-funding / wrong host). This depends on the laggy
  // getObjects, so it's a bonus when available — never the gate.
  const onChain = await readEscrowObject(escrowId, readOptions);

  if (onChain?.fields) {
    if (!isOurEscrowType(onChain.type)) {
      return { ok: false, reason: `Created object is not a ${mod}::BookingEscrow (got ${onChain.type})` };
    }
    const f = onChain.fields;
    if (expectedSender && normalizeAddr(f.guest) !== normalizeAddr(expectedSender)) {
      return { ok: false, reason: 'Escrow guest does not match the booking guest' };
    }
    if (expectedHost && normalizeAddr(f.host) !== normalizeAddr(expectedHost)) {
      return { ok: false, reason: 'Escrow host does not match the booking host' };
    }
    if (expectedRef && f.booking_ref !== expectedRef) {
      return { ok: false, reason: 'Escrow booking_ref does not match this booking' };
    }
    if (depositAmount != null) {
      const expectedMist = depositToMist(depositAmount).toString();
      if (String(f.amount) !== expectedMist || String(f.coin?.balance?.value) !== expectedMist) {
        return { ok: false, reason: 'Escrow is not funded with the expected deposit amount' };
      }
    }
    return { ok: true, escrowId, sender: actualSender, amountVerified: true };
  }

  // Object content unreadable (getObjects lag). Instead of the old weak
  // "accept on type+sender only" path, do the STRICT amount/host/ref check
  // lag-free by decoding create_escrow's own arguments from the transaction
  // (present in this same response, independent of getObjects). This closes the
  // under-funding gap: a guest who reports a digest for a near-zero-deposit or
  // wrong-host escrow is rejected even while the object read is lagging.
  if (typeConfirmed) {
    const decoded = decodeCreateEscrowArgs(txn?.transaction, mod);
    if (decoded && decoded.amountMist != null) {
      if (expectedHost && decoded.host && normalizeAddr(decoded.host) !== normalizeAddr(expectedHost)) {
        return { ok: false, reason: 'Escrow host does not match the booking host (decoded)' };
      }
      if (expectedRef && decoded.bookingRef && decoded.bookingRef !== expectedRef) {
        return { ok: false, reason: 'Escrow booking_ref does not match this booking (decoded)' };
      }
      if (expectedSender && decoded.guest && normalizeAddr(decoded.guest) !== normalizeAddr(expectedSender)) {
        return { ok: false, reason: 'Escrow guest does not match the booking guest (decoded)' };
      }
      if (depositAmount != null) {
        const expectedMist = depositToMist(depositAmount).toString();
        if (String(decoded.amountMist) !== expectedMist) {
          return { ok: false, reason: 'Escrow is not funded with the expected deposit amount (decoded)' };
        }
      }
      console.warn('verifyEscrowTransaction: object content unreadable; verified lag-free from decoded create_escrow args', { escrowId });
      return { ok: true, escrowId, sender: actualSender, amountVerified: true, verifiedVia: 'decoded-inputs' };
    }
    // Decode failed (unexpected tx shape) — do NOT fall back to a blind accept.
    console.warn('verifyEscrowTransaction: object content unreadable AND create_escrow args undecodable — retryable', { escrowId, reason: onChain?.error });
    return { ok: false, retryable: true, escrowId, reason: 'Escrow not yet verifiable on-chain — please retry in a moment.' };
  }

  // Neither object content NOR tx-effects type available — genuinely cannot
  // verify yet. Retryable so the booking stays pending (never marked held).
  console.warn('verifyEscrowTransaction: neither object content nor tx-effects type available — retryable', { escrowId, reason: onChain?.error });
  return { ok: false, retryable: true, escrowId, reason: 'Escrow not yet verifiable on-chain — please retry in a moment.' };
}

// ── P2 / Phase 1j: claim_damage / dispute_claim ─────────────────────────────
// Both functions assert a specific sender on-chain (escrow.host for
// claim_damage, escrow.guest for dispute_claim) that the ARIA backend does
// not hold a key for — these follow the exact same non-custodial pattern as
// buildEscrowTransaction: the backend only assembles unsigned tx bytes, the
// host/guest signs and submits from their own browser (zkLogin), and the
// backend re-verifies the resulting digest on-chain before writing anything
// to Postgres (see verifyClaimDamageTransaction / verifyDisputeClaimTransaction
// below, used by the /booking/claim-damage/confirm and
// /booking/dispute-claim/confirm routes).
//
// claimAmount arrives in dollars (same unit as bookings.deposit_amount) and
// is converted to mist the same way buildEscrowTransaction converts
// depositAmount, so a claim of "the full deposit" round-trips exactly.
export async function buildClaimDamageTransaction(escrowObjectId, hostAddr, claimAmount, logger = console) {
  if (!escrowObjectId || !hostAddr || !process.env.ESCROW_PACKAGE_ID) return null;
  try {
    const claimMist = BigInt(Math.max(1, claimAmount)) * 1000n;
    const tx = new Transaction();
    tx.setSender(hostAddr);
    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::claim_damage`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.object(escrowObjectId),
        tx.pure.u64(claimMist),
        tx.object('0x6'),
      ],
    });
    const txBytes = await tx.build({ client: suiClient });
    return { txBytes: toBase64(txBytes) };
  } catch (err) {
    logger?.error?.({ message: err.message, name: err.name }, 'buildClaimDamageTransaction error');
    return null;
  }
}

export async function buildDisputeClaimTransaction(escrowObjectId, guestAddr, logger = console) {
  if (!escrowObjectId || !guestAddr || !process.env.ESCROW_PACKAGE_ID) return null;
  try {
    const tx = new Transaction();
    tx.setSender(guestAddr);
    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::dispute_claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.object(escrowObjectId),
      ],
    });
    const txBytes = await tx.build({ client: suiClient });
    return { txBytes: toBase64(txBytes) };
  } catch (err) {
    logger?.error?.({ message: err.message, name: err.name }, 'buildDisputeClaimTransaction error');
    return null;
  }
}

// Shared verification core for claim_damage/dispute_claim digests — same
// discriminated-union unwrapping as verifyEscrowTransaction (see that
// function's comment for why result.$kind must be checked rather than
// reading result.status/.transaction/.effects directly), but checks for a
// Mutated entry matching the known escrow object id instead of a Created one,
// since these calls take `&mut BookingEscrow<T>` rather than consuming it.
async function verifyEscrowMutation(digest, expectedSender, expectedEscrowId, label) {
  const result = await suiClient.core.getTransaction({
    digest,
    include: { transaction: true, effects: true, objectTypes: true },
  });

  if (result?.$kind !== 'Transaction') {
    const errMsg = result?.FailedTransaction?.status?.error?.message;
    return { ok: false, reason: errMsg || `${label} transaction did not succeed on-chain` };
  }

  const txn = result.Transaction;
  const actualSender = txn?.transaction?.sender;
  if (expectedSender && actualSender && actualSender !== expectedSender) {
    return { ok: false, reason: 'Transaction sender does not match the expected signer' };
  }

  if (!isObjectMutated(txn?.effects?.changedObjects, expectedEscrowId)) {
    return { ok: false, reason: `Transaction did not mutate the expected escrow object (${expectedEscrowId})` };
  }

  return { ok: true, sender: actualSender };
}

export async function verifyClaimDamageTransaction(digest, expectedHost, escrowObjectId) {
  return verifyEscrowMutation(digest, expectedHost, escrowObjectId, 'claim_damage');
}

export async function verifyDisputeClaimTransaction(digest, expectedGuest, escrowObjectId) {
  return verifyEscrowMutation(digest, expectedGuest, escrowObjectId, 'dispute_claim');
}

// ── P1b (key separation, corrects an earlier inaccurate comment here): who
// needs to sign auto_release, and why a minimally-scoped key is sufficient.
//
// 1. This call never moves a deployer-owned coin. The deposit already lives
//    in the on-chain BookingEscrow shared object (funded by the guest's own
//    signature at creation time, see buildEscrowTransaction above). Calling
//    auto_release only invokes that shared object's own release logic; the
//    Move contract — not this signer — decides where the held coin goes.
//    Signing this tx costs only gas and grants no custody, so it doesn't
//    reintroduce the custodial gap P0b closed.
// 2. Unlike resolve_dispute (which asserts tx_context::sender ==
//    escrow.arbitrator on-chain), auto_release in escrow.move has NO sender
//    check at all — its doc comment says so explicitly: "Callable by
//    anyone." An earlier version of this comment claimed the contract
//    expected the caller to be the arbitrator; that was wrong for this
//    function specifically (true only for resolve_dispute). Because
//    auto_release is permissionless, this signer needs no special on-chain
//    privilege — it only needs to exist and hold enough gas, which is
//    exactly why it's safe to give it its own narrowly-scoped key
//    (ARIA_AUTO_RELEASE_KEY) instead of reusing the deployer/UpgradeCap key.
// 3. Some address still has to be the one with a server actually watching
//    the clock and submitting the call — Sui has no native cron, so without
//    a keeper able to call this, expired escrows could only ever be
//    released by the guest or host manually. ARIA's backend plays that
//    keeper role; it just no longer needs deployer-level trust to do it.
//
// If/when host accounts get their own Sui addresses, the better long-term
// design is to make the Move contract's auto_release independently
// re-check the expiry/dispute conditions on-chain (not just trust the
// caller), and let the host sign it directly — removing ARIA's backend from
// this path entirely. Tracked as a follow-up, not done here.
export async function autoReleaseEscrow(escrowObjectId) {
  if (!autoReleaseKeypair || !escrowObjectId || !process.env.ESCROW_PACKAGE_ID) return false;
  const sender = autoReleaseKeypair.toSuiAddress();
  try {
    const tx = new Transaction();
    tx.setSender(sender);

    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::auto_release`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.object(escrowObjectId), // shared object — client resolves version
        tx.object('0x6'),          // Clock — client resolves version
      ],
    });

    const result = await autoReleaseKeypair.signAndExecuteTransaction({
      transaction: tx,
      client: suiClient,
      include: { effects: true },
    });

    if (result?.$kind === 'FailedTransaction') {
      console.warn('autoRelease failed on-chain:', result.FailedTransaction?.status?.error?.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('autoReleaseEscrow failed:', err.message);
    return false;
  }
}

// Finding #7 (CLAIMED deadlock): permissionless keeper call for a claim the
// guest never responded to. Same trust profile as autoReleaseEscrow — the
// contract's finalize_claim has no sender check and only triggers the escrow's
// own split logic (claim_amount to host, remainder to guest), so the
// auto-release key signing it carries no special privilege beyond paying gas.
// Returns false (not throwing) on any failure so the sweep can simply retry.
// NOTE: finalize_claim ships in escrow.move but requires the v3 package upgrade
// to be published before it exists on-chain; until then this returns false and
// the sweep harmlessly retries — no code change needed once it's deployed.
export async function finalizeClaimEscrow(escrowObjectId) {
  if (!autoReleaseKeypair || !escrowObjectId || !process.env.ESCROW_PACKAGE_ID) return false;
  const sender = autoReleaseKeypair.toSuiAddress();
  try {
    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::finalize_claim`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.object(escrowObjectId),
        tx.object('0x6'),
      ],
    });
    const result = await autoReleaseKeypair.signAndExecuteTransaction({
      transaction: tx, client: suiClient, include: { effects: true },
    });
    if (result?.$kind === 'FailedTransaction') {
      console.warn('finalizeClaim failed on-chain:', result.FailedTransaction?.status?.error?.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('finalizeClaimEscrow failed:', err.message);
    return false;
  }
}

// P2 / Phase 1j: unlike claim_damage/dispute_claim, resolve_dispute IS
// backend-signed — per the roadmap's Phase 3 design, ARIA itself decides and
// submits the final split after reviewing a dispute, rather than the guest or
// host signing it. arbitratorKeypair is the narrowly-scoped key for exactly
// this one call (see comment above its declaration). guestAmount/hostAmount
// arrive in dollars and are converted to mist the same way the deposit itself
// was; the Move contract asserts they sum to escrow.amount exactly, so a
// mismatched split fails on-chain rather than silently misallocating funds.
export async function resolveDisputeEscrow(escrowObjectId, guestAmount, hostAmount) {
  if (!arbitratorKeypair || !escrowObjectId || !process.env.ESCROW_PACKAGE_ID) return false;
  const sender = arbitratorKeypair.toSuiAddress();
  try {
    const guestMist = BigInt(Math.max(0, guestAmount)) * 1000n;
    const hostMist  = BigInt(Math.max(0, hostAmount)) * 1000n;

    const tx = new Transaction();
    tx.setSender(sender);
    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::resolve_dispute`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.object(escrowObjectId),
        tx.pure.u64(guestMist),
        tx.pure.u64(hostMist),
      ],
    });

    const result = await arbitratorKeypair.signAndExecuteTransaction({
      transaction: tx,
      client: suiClient,
      include: { effects: true },
    });

    if (result?.$kind === 'FailedTransaction') {
      console.warn('resolveDispute failed on-chain:', result.FailedTransaction?.status?.error?.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('resolveDisputeEscrow failed:', err.message);
    return false;
  }
}
