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
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';

export const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

// Both PTB builders below use coinWithBalance(), which resolves a coin from
// the SENDER'S (guest's) own on-chain balance at tx.build() time. A brand-new
// zkLogin wallet that's never been funded via the testnet faucet has zero
// balance, so build() throws here — and previously both builders swallowed
// that into a bare `return null`, collapsing "guest needs to fund their
// wallet" and "unrelated build/network failure" into one generic, unhelpful
// 503. This classifies the thrown error so callers can tell the guest what
// actually went wrong instead of just "please try again."
function classifyEscrowBuildError(err) {
  const msg = String(err?.message || '');
  if (/no coins|insufficient|not enough|balance/i.test(msg)) {
    return {
      errorCode: 'insufficient_balance',
      errorMessage: 'Your wallet doesn’t have enough testnet SUI to fund this transaction yet. Get testnet SUI from the faucet, then try again.',
    };
  }
  return {
    errorCode: 'build_failed',
    errorMessage: 'Could not build the escrow transaction. Please try again in a moment.',
  };
}

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
    const id = c.objectId ?? c.id ?? c.object_id ?? c.reference?.objectId;
    if (id !== expectedObjectId) return false;
    let op = c.idOperation ?? c.operation ?? c.id_operation ?? c.$kind;
    if (op && typeof op === 'object') op = op.$kind;
    op = typeof op === 'string' ? op : '';
    if (/mutated/i.test(op)) return true;                  // legacy / JSON-RPC / mock shape
    if (/created/i.test(op) || /deleted/i.test(op)) return false;
    // Real gRPC (core API) shape: a MUTATED existing object has idOperation 'None'
    // (that field tracks only ID create/delete, not content writes). changedObjects
    // lists ONLY objects that actually changed, so an entry whose id matches and was
    // neither created nor deleted is a write to an existing object = mutated.
    return true;
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
    return { txBytes: null, ...classifyEscrowBuildError(err) };
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
    // The coin arg is a result of a SplitCoins. In the original single-escrow
    // PTB that's NestedResult[splitCmd, 0]. In the COMBINED payment+deposit PTB
    // (Phase 1h.5), coinWithBalance consolidates both coins into ONE SplitCoins
    // with amounts [payment, deposit], so the deposit coin is a LATER result
    // index (NestedResult[splitCmd, 1]). Index amounts[] by that result index —
    // reading amounts[0] unconditionally would mis-read the payment amount as
    // the deposit. Backward-compatible: single-split → resultIdx 0 → amounts[0].
    let amountMist = null;
    let splitIdx = null, resultIdx = 0;
    if (coinA?.NestedResult) { splitIdx = coinA.NestedResult[0]; resultIdx = coinA.NestedResult[1] ?? 0; }
    else if (coinA?.Result != null) { splitIdx = coinA.Result; resultIdx = 0; }
    if (splitIdx != null) {
      const sc = commands[splitIdx]?.SplitCoins;
      if (sc && Array.isArray(sc.amounts) && sc.amounts[resultIdx] != null) {
        amountMist = _asU64(inputOf(sc.amounts[resultIdx]));
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

// Decode claim_damage's claim_amount (a u64 arg) from a parsed transaction —
// lag-free, and authoritative because it's the value the HOST actually signed.
// The confirm route uses this so the DB/guest-email record the on-chain claim
// rather than a client-supplied amount (P1-2). Signature:
// claim_damage(escrow, claim_amount, clock) → the amount is arguments[1].
export function decodeClaimDamageAmountMist(transaction, moduleName) {
  try {
    const inputs = transaction?.inputs;
    const commands = transaction?.commands;
    if (!Array.isArray(inputs) || !Array.isArray(commands)) return null;
    const call = commands.find(
      (c) => c?.MoveCall && c.MoveCall.module === moduleName && c.MoveCall.function === 'claim_damage',
    )?.MoveCall;
    if (!call || !Array.isArray(call.arguments)) return null;
    const amtArg = call.arguments[1];
    if (amtArg?.Input == null) return null;
    return _asU64(inputs[amtArg.Input]); // mist string
  } catch {
    return null;
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

  const out = { ok: true, sender: actualSender };
  // For claim_damage, also surface the on-chain claim amount (lag-free decode)
  // so the confirm route can record what was actually signed, not a client value.
  if (label === 'claim_damage') {
    out.claimAmountMist = decodeClaimDamageAmountMist(txn?.transaction, process.env.ESCROW_MODULE_NAME || 'escrow');
  }
  return out;
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

// ════════════════════════════════════════════════════════════════════════════
// Phase 1h.5 — Payment escrow (rental + ARIA fee + tax)
// ════════════════════════════════════════════════════════════════════════════
//
// The deposit escrow above only holds the guest's refundable security deposit.
// The actual PAYMENT (rental subtotal -> host, ARIA fee -> fee wallet, tax ->
// remittance wallet) is held in a SEPARATE BookingPaymentEscrow, created in the
// SAME guest-signed PTB as the deposit escrow (one signature, two shared
// objects, atomic). Industry-standard "fee follows refund" (Airbnb/Vrbo): a
// cancel before check-in refunds the whole payment to the guest; at check-in the
// funds split three ways. The destination addresses + leg amounts are baked into
// the object at creation, so release is deterministic and trustlessly verified.
//
// Same non-custodial profile as the deposit path: the backend only assembles
// unsigned bytes; the guest signs/submits from their own browser; nothing is
// written to the DB until verifyBookingPaymentTransaction re-proves the on-chain
// reality by decoding the tx's own arguments (lag-free).

const COIN_TYPE = () => process.env.PAYMENT_COIN_TYPE || '0x2::sui::SUI';

// Dollar -> on-chain units. Same ×1000 testnet scaling as depositToMist so the
// payment legs and the deposit never drift. Allows 0 (e.g. a tax-exempt leg);
// depositToMist keeps its floor-at-1 for the deposit itself.
export function dollarsToUnits(amount) {
  return BigInt(Math.round(Number(amount) * 1000));
}

// BCS layout of BookingPaymentEscrow<T> (escrow.move), used only for the
// best-effort secondary object-content read — primary verification is the
// lag-free argument decode below. Field order/types mirror the Move struct.
export const BookingPaymentEscrowBcs = bcs.struct('BookingPaymentEscrow', {
  id:              bcs.Address,
  booking_ref:     bcs.string(),
  guest:           bcs.Address,
  host:            bcs.Address,
  aria_addr:       bcs.Address,
  tax_addr:        bcs.Address,
  arbitrator:      bcs.Address,
  host_amount:     bcs.u64(),
  aria_amount:     bcs.u64(),
  tax_amount:      bcs.u64(),
  coin:            CoinBcs,
  release_time_ms: bcs.u64(),
  status:          bcs.u8(),
});

// Builds (but does NOT sign/execute) the single PTB that creates BOTH the
// payment escrow and the deposit escrow with the GUEST as sender. The guest's
// own wallet funds both from its balance via coinWithBalance — the backend never
// holds a key that can move guest funds. Returns { txBytes, releaseMs, expiryMs }
// (the time values are echoed so the caller can persist them for the confirm
// route's authoritative comparison) or null if unconfigured.
//
// amounts: { subtotal, ariaFee, taxes, depositAmount, releaseMs }
//   releaseMs = check-in (mainnet: checkInMs [+grace]; testnet: a short window so
//   release_payment is exercisable without waiting — caller decides).
export async function buildBookingPaymentTransaction(bookingRef, guestAddr, hostAddr, amounts, logger = console) {
  const { subtotal, ariaFee, taxes, depositAmount, releaseMs, propertyId, checkInMs, checkOutMs } = amounts || {};
  if (!guestAddr || !hostAddr || !process.env.ESCROW_PACKAGE_ID) return null;
  const ariaAddr = process.env.ARIA_FEE_ADDRESS;
  const taxAddr  = process.env.ARIA_TAX_REMITTANCE_ADDRESS;
  if (!ariaAddr || !taxAddr) {
    logger?.warn?.('buildBookingPaymentTransaction: ARIA_FEE_ADDRESS / ARIA_TAX_REMITTANCE_ADDRESS not set');
    return null;
  }
  // Same fallback rationale as buildEscrowTransaction: never silently hand
  // arbitrator authority to the low-privilege signer just because the env var
  // is unset — fall back to hostAddr instead.
  const arbitrator = process.env.ARIA_ARBITRATOR_ADDRESS || hostAddr;
  const PKG = process.env.ESCROW_PACKAGE_ID;
  const MOD = process.env.ESCROW_MODULE_NAME || 'escrow';
  try {
    const hostUnits = dollarsToUnits(subtotal);
    const ariaUnits = dollarsToUnits(ariaFee);
    const taxUnits  = dollarsToUnits(taxes);
    const releaseMsBig = BigInt(releaseMs);
    const expiryMs  = BigInt(Date.now()) + 300_000n; // deposit: 5-min testnet window

    const tx = new Transaction();
    tx.setSender(guestAddr);

    // ── Payment escrow (new v4) ──
    const paymentCoin = coinWithBalance({ balance: hostUnits + ariaUnits + taxUnits });
    tx.moveCall({
      target: `${PKG}::${MOD}::create_payment_escrow`,
      typeArguments: [COIN_TYPE()],
      arguments: [
        tx.pure.string(bookingRef),
        tx.pure.address(guestAddr),
        tx.pure.address(hostAddr),
        tx.pure.address(ariaAddr),
        tx.pure.address(taxAddr),
        tx.pure.address(arbitrator),
        tx.pure.u64(hostUnits),
        tx.pure.u64(ariaUnits),
        tx.pure.u64(taxUnits),
        tx.pure.u64(releaseMsBig),
        paymentCoin,
        tx.object('0x6'),
      ],
    });

    // ── Deposit escrow (existing v3) ──
    const depositCoin = coinWithBalance({ balance: depositToMist(depositAmount) });
    tx.moveCall({
      target: `${PKG}::${MOD}::create_escrow`,
      typeArguments: [COIN_TYPE()],
      arguments: [
        tx.pure.string(bookingRef),
        tx.pure.address(guestAddr),
        tx.pure.address(hostAddr),
        tx.pure.address(arbitrator),
        tx.pure.u64(expiryMs),
        depositCoin,
        tx.object('0x6'),
      ],
    });

    // ── BookingPass (Phase 2a, gated) ── mint a soulbound pass to the guest in
    // the SAME PTB (no extra signature). Only when BOOKING_PASS_ENABLED is set
    // AND ESCROW_PACKAGE_ID is a v5+ package that actually has mint_booking_pass —
    // otherwise omitted so the booking PTB stays valid on v4.
    if (process.env.BOOKING_PASS_ENABLED === 'true') {
      tx.moveCall({
        target: `${PKG}::${MOD}::mint_booking_pass`,
        arguments: [
          tx.pure.string(bookingRef),
          tx.pure.address(guestAddr),
          tx.pure.address(hostAddr),
          tx.pure.u64(BigInt(propertyId || 0)),
          tx.pure.u64(BigInt(checkInMs || 0)),
          tx.pure.u64(BigInt(checkOutMs || 0)),
        ],
      });
    }

    // ── ResalePolicy (Phase 2c, gated) ── one extra moveCall so this booking can be
    // resold under the host's terms (Rail 1 opt-in + Rail 2 cap, read from the listing
    // at booking time). Only when RESALE_ENABLED is on AND the listing allows transfer;
    // otherwise omitted, so the booking PTB stays valid on packages without
    // create_resale_policy (anything before v6).
    if (process.env.RESALE_ENABLED === 'true' && amounts?.transferAllowed) {
      tx.moveCall({
        target: `${PKG}::${MOD}::create_resale_policy`,
        arguments: [
          tx.pure.string(bookingRef),
          tx.pure.address(hostAddr),
          tx.pure.bool(true),
          tx.pure.u64(BigInt(amounts.maxPremiumBps || 0)),
          tx.pure.u64(releaseMsBig),
          // No-transfer window before check-in (Rail 5). Baked per booking so testnet
          // can use a short window; defaults to 48h (172_800_000) like mainnet.
          tx.pure.u64(BigInt(amounts.resaleWindowMs ?? 172_800_000)),
          tx.pure.u64(BigInt(propertyId || 0)),
          tx.pure.u64(BigInt(checkInMs || 0)),
          tx.pure.u64(BigInt(checkOutMs || 0)),
        ],
      });
    }

    const txBytes = await tx.build({ client: suiClient });
    return { txBytes: toBase64(txBytes), releaseMs: releaseMsBig.toString(), expiryMs: expiryMs.toString() };
  } catch (err) {
    logger?.error?.({ message: err.message, name: err.name, stack: err.stack?.split('\n').slice(0, 4).join(' | ') }, 'buildBookingPaymentTransaction error');
    return { txBytes: null, ...classifyEscrowBuildError(err) };
  }
}

// ── Resale (Phase 2c) — list / buy / cancel PTB builders + buy verifier ─────────
// All amounts here are in on-chain UNITS (the same scale as create_payment_escrow's
// legs / depositToMist), NOT dollars — the caller (server route) converts dollars →
// units before listing and reads ask_price back from the on-chain ResalePolicy for a
// buy. Each builder returns an UNSIGNED PTB (txBytes) for the seller/buyer to sign in
// their own wallet, exactly like the booking flow.

/// Step 1 — SELLER lists. Consumes the soulbound pass, sets the ask. Seller signs.
export async function buildListForResaleTransaction(sellerAddr, ids, logger = console) {
  const { depositEscrowId, paymentEscrowId, policyId, passId, askPriceUnits } = ids || {};
  if (!sellerAddr || !depositEscrowId || !paymentEscrowId || !policyId || !passId || askPriceUnits == null) return null;
  if (!process.env.ESCROW_PACKAGE_ID) return null;
  const PKG = process.env.ESCROW_PACKAGE_ID;
  const MOD = process.env.ESCROW_MODULE_NAME || 'escrow';
  try {
    const tx = new Transaction();
    tx.setSender(sellerAddr);
    tx.moveCall({
      target: `${PKG}::${MOD}::list_for_resale`,
      typeArguments: [COIN_TYPE()],
      arguments: [
        tx.object(depositEscrowId),
        tx.object(paymentEscrowId),
        tx.object(policyId),
        tx.object(passId),
        tx.pure.u64(BigInt(askPriceUnits)),
        tx.object('0x6'),
      ],
    });
    const txBytes = await tx.build({ client: suiClient });
    return { txBytes: toBase64(txBytes) };
  } catch (err) {
    logger?.error?.({ message: err.message, name: err.name }, 'buildListForResaleTransaction error');
    return null;
  }
}

/// Step 2 — BUYER buys. Funds exactly the ask; gets the booking + a fresh pass. Buyer signs.
export async function buildBuyResaleTransaction(buyerAddr, ids, logger = console) {
  const { depositEscrowId, paymentEscrowId, policyId, askPriceUnits } = ids || {};
  if (!buyerAddr || !depositEscrowId || !paymentEscrowId || !policyId || askPriceUnits == null) return null;
  if (!process.env.ESCROW_PACKAGE_ID) return null;
  const PKG = process.env.ESCROW_PACKAGE_ID;
  const MOD = process.env.ESCROW_MODULE_NAME || 'escrow';
  try {
    const tx = new Transaction();
    tx.setSender(buyerAddr);
    const payCoin = coinWithBalance({ balance: BigInt(askPriceUnits) });
    tx.moveCall({
      target: `${PKG}::${MOD}::buy_resale`,
      typeArguments: [COIN_TYPE()],
      arguments: [
        tx.object(depositEscrowId),
        tx.object(paymentEscrowId),
        tx.object(policyId),
        payCoin,
        tx.object('0x6'),
      ],
    });
    const txBytes = await tx.build({ client: suiClient });
    return { txBytes: toBase64(txBytes) };
  } catch (err) {
    logger?.error?.({ message: err.message, name: err.name }, 'buildBuyResaleTransaction error');
    return null;
  }
}

/// SELLER cancels a listing — remints the pass back to the seller. Seller signs.
export async function buildCancelResaleListingTransaction(sellerAddr, policyId, logger = console) {
  if (!sellerAddr || !policyId || !process.env.ESCROW_PACKAGE_ID) return null;
  const PKG = process.env.ESCROW_PACKAGE_ID;
  const MOD = process.env.ESCROW_MODULE_NAME || 'escrow';
  try {
    const tx = new Transaction();
    tx.setSender(sellerAddr);
    tx.moveCall({
      target: `${PKG}::${MOD}::cancel_resale_listing`,
      arguments: [tx.object(policyId)],
    });
    const txBytes = await tx.build({ client: suiClient });
    return { txBytes: toBase64(txBytes) };
  } catch (err) {
    logger?.error?.({ message: err.message, name: err.name }, 'buildCancelResaleListingTransaction error');
    return null;
  }
}

/// Verify a completed buy_resale on-chain before the confirm route writes Postgres.
/// A successful buy MUST (a) be signed by the expected buyer and (b) mutate BOTH the
/// deposit and payment escrows (their `guest` reassigned to the buyer). Never trust
/// the client's report — mirrors verifyEscrowMutation.
export async function verifyBuyResaleTransaction(digest, expectedBuyer, depositEscrowId, paymentEscrowId) {
  const result = await suiClient.core.getTransaction({
    digest,
    include: { transaction: true, effects: true, objectTypes: true },
  });
  if (result?.$kind !== 'Transaction') {
    const errMsg = result?.FailedTransaction?.status?.error?.message;
    return { ok: false, reason: errMsg || 'resale buy transaction did not succeed on-chain' };
  }
  const txn = result.Transaction;
  const actualSender = txn?.transaction?.sender;
  if (expectedBuyer && actualSender && actualSender !== expectedBuyer) {
    return { ok: false, reason: 'Transaction sender does not match the expected buyer' };
  }
  const changed = txn?.effects?.changedObjects;
  if (!isObjectMutated(changed, depositEscrowId)) {
    return { ok: false, reason: `Buy did not reassign the deposit escrow (${depositEscrowId})` };
  }
  if (!isObjectMutated(changed, paymentEscrowId)) {
    return { ok: false, reason: `Buy did not reassign the payment escrow (${paymentEscrowId})` };
  }
  // The buy mints a FRESH soulbound pass to the buyer — capture its id so the
  // confirm route can repoint booking_pass_object_id (the original was burned at
  // list time). Optional: absent only if the read lags, which doesn't invalidate
  // the verified swap above.
  const mod = process.env.ESCROW_MODULE_NAME || 'escrow';
  const isPassType = (t) => typeof t === 'string' && new RegExp(`::${mod}::BookingPass$`).test(t);
  let newPassId = null;
  for (const [oid, t] of Object.entries(txn?.objectTypes || {})) {
    if (isPassType(t)) { newPassId = oid; break; }
  }
  return { ok: true, sender: actualSender, newPassId };
}

/// Verify a completed list_for_resale on-chain before the confirm route flips
/// resale_listed=true. A valid listing MUST (a) be signed by the seller and
/// (b) mutate the ResalePolicy (policy.listed -> true). The pass is consumed in
/// the same tx; we don't require reading it back (it's deleted). Never trust the
/// client report — mirrors verifyBuyResaleTransaction.
export async function verifyListResaleTransaction(digest, expectedSeller, policyId) {
  const result = await suiClient.core.getTransaction({
    digest,
    include: { transaction: true, effects: true, objectTypes: true },
  });
  if (result?.$kind !== 'Transaction') {
    const errMsg = result?.FailedTransaction?.status?.error?.message;
    return { ok: false, reason: errMsg || 'resale list transaction did not succeed on-chain' };
  }
  const txn = result.Transaction;
  const actualSender = txn?.transaction?.sender;
  if (expectedSeller && actualSender && actualSender !== expectedSeller) {
    return { ok: false, reason: 'Transaction sender does not match the expected seller' };
  }
  if (!isObjectMutated(txn?.effects?.changedObjects, policyId)) {
    return { ok: false, reason: `List did not update the resale policy (${policyId})` };
  }
  return { ok: true, sender: actualSender };
}

/// Verify a completed cancel_resale_listing on-chain before clearing the listing
/// in Postgres. Signed by the seller; mutates the ResalePolicy (listed -> false).
export async function verifyCancelResaleTransaction(digest, expectedSeller, policyId) {
  const result = await suiClient.core.getTransaction({
    digest,
    include: { transaction: true, effects: true, objectTypes: true },
  });
  if (result?.$kind !== 'Transaction') {
    const errMsg = result?.FailedTransaction?.status?.error?.message;
    return { ok: false, reason: errMsg || 'resale cancel transaction did not succeed on-chain' };
  }
  const txn = result.Transaction;
  const actualSender = txn?.transaction?.sender;
  if (expectedSeller && actualSender && actualSender !== expectedSeller) {
    return { ok: false, reason: 'Transaction sender does not match the expected seller' };
  }
  if (!isObjectMutated(txn?.effects?.changedObjects, policyId)) {
    return { ok: false, reason: `Cancel did not update the resale policy (${policyId})` };
  }
  return { ok: true, sender: actualSender };
}

// Decode create_payment_escrow's args straight from the parsed transaction —
// lag-free (they live in tx.inputs, readable immediately), so this is the
// PRIMARY verification source, not a fallback. Maps args to inputs BY INDEX.
// Signature: create_payment_escrow(booking_ref, guest, host, aria_addr,
//   tax_addr, arbitrator, host_amount, aria_amount, tax_amount,
//   release_time_ms, coin, clock)
export function decodeCreatePaymentEscrowArgs(transaction, moduleName) {
  try {
    const inputs = transaction?.inputs;
    const commands = transaction?.commands;
    if (!Array.isArray(inputs) || !Array.isArray(commands)) return null;

    const call = commands.find(
      (c) => c?.MoveCall && c.MoveCall.module === moduleName && c.MoveCall.function === 'create_payment_escrow',
    )?.MoveCall;
    if (!call || !Array.isArray(call.arguments)) return null;

    const a = call.arguments;
    const inAddr = (arg) => (arg?.Input != null ? _asAddr(inputs[arg.Input]) : null);
    const inU64  = (arg) => (arg?.Input != null ? _asU64(inputs[arg.Input]) : null);
    const inStr  = (arg) => (arg?.Input != null ? _asStr(inputs[arg.Input]) : null);

    return {
      bookingRef:  inStr(a[0]),
      guest:       inAddr(a[1]),
      host:        inAddr(a[2]),
      ariaAddr:    inAddr(a[3]),
      taxAddr:     inAddr(a[4]),
      arbitrator:  inAddr(a[5]),
      hostAmount:  inU64(a[6]),
      ariaAmount:  inU64(a[7]),
      taxAmount:   inU64(a[8]),
      releaseMs:   inU64(a[9]),
      typeArg:     call.typeArguments?.[0] ?? null,
    };
  } catch {
    return null;
  }
}

// Re-queries Sui by digest after the guest signs+submits the combined booking
// PTB and verifies BOTH escrows against the booking's server-authoritative
// values — never trusting the client's reported digest. Primary checks are the
// lag-free argument decodes (independent of the laggy getObjects read); the
// most security-critical of these is DESTINATION AUTHORITY: the rental/fee/tax
// legs must point at the authoritative host / ARIA / remittance wallets, not
// any address echoed by the client, so a tampered PTB that redirects a leg is
// rejected even while object reads lag.
//
// expected: { sender, host, bookingRef, subtotal, ariaFee, taxes, depositAmount,
//             releaseMs }
// Returns { ok:true, paymentEscrowId, depositEscrowId, sender } on success;
// { ok:false, reason } on a real mismatch (hard reject); or
// { ok:false, retryable:true, reason } when the tx isn't yet decodable.
export async function verifyBookingPaymentTransaction(digest, expected = {}) {
  const {
    sender: expectedSender, host: expectedHost, bookingRef: expectedRef,
    subtotal, ariaFee, taxes, depositAmount, releaseMs,
  } = expected;

  const ariaAddr = process.env.ARIA_FEE_ADDRESS;
  const taxAddr  = process.env.ARIA_TAX_REMITTANCE_ADDRESS;
  const expectedArbitrator = process.env.ARIA_ARBITRATOR_ADDRESS || expectedHost;
  const mod = process.env.ESCROW_MODULE_NAME || 'escrow';

  const result = await suiClient.core.getTransaction({
    digest,
    include: { transaction: true, effects: true, objectTypes: true },
  });

  if (result?.$kind !== 'Transaction') {
    const errMsg = result?.FailedTransaction?.status?.error?.message;
    return { ok: false, reason: errMsg || 'Transaction did not succeed on-chain' };
  }

  const txn = result.Transaction;
  const actualSender = txn?.transaction?.sender;
  if (expectedSender && actualSender && normalizeAddr(actualSender) !== normalizeAddr(expectedSender)) {
    return { ok: false, reason: 'Transaction sender does not match the booking guest' };
  }

  // Locate both objects' ids lag-free from the objectTypes map.
  const isPaymentType = (t) => typeof t === 'string' && new RegExp(`::${mod}::BookingPaymentEscrow<`).test(t);
  const isDepositType = (t) => typeof t === 'string' && new RegExp(`::${mod}::BookingEscrow<`).test(t);
  // BookingPass (Phase 2a) is a non-generic owned object — match the bare type.
  const isPassType    = (t) => typeof t === 'string' && new RegExp(`::${mod}::BookingPass$`).test(t);
  // ResalePolicy (Phase 2c) — non-generic shared object, minted in the same PTB
  // only when the listing opted into transfer. Optional: absent on bookings that
  // didn't enable resale, so a null id is not an error.
  const isPolicyType  = (t) => typeof t === 'string' && new RegExp(`::${mod}::ResalePolicy$`).test(t);
  const objectTypes = txn?.objectTypes || {};
  let paymentEscrowId = null, depositEscrowId = null, bookingPassId = null, resalePolicyId = null;
  for (const [oid, t] of Object.entries(objectTypes)) {
    if (!paymentEscrowId && isPaymentType(t)) paymentEscrowId = oid;
    else if (!depositEscrowId && isDepositType(t)) depositEscrowId = oid;
    else if (!bookingPassId && isPassType(t)) bookingPassId = oid;
    else if (!resalePolicyId && isPolicyType(t)) resalePolicyId = oid;
  }

  // PRIMARY: decode both calls' arguments and assert every authoritative value.
  const pay = decodeCreatePaymentEscrowArgs(txn?.transaction, mod);
  const dep = decodeCreateEscrowArgs(txn?.transaction, mod);
  if (!pay || pay.hostAmount == null) {
    return { ok: false, retryable: true, paymentEscrowId, depositEscrowId, reason: 'Payment escrow not yet verifiable on-chain — please retry in a moment.' };
  }

  const eq = (a, b) => normalizeAddr(a) === normalizeAddr(b);

  // Destination authority — the security-critical check.
  if (ariaAddr && pay.ariaAddr && !eq(pay.ariaAddr, ariaAddr)) {
    return { ok: false, reason: 'Payment ARIA-fee destination does not match the authoritative fee wallet' };
  }
  if (taxAddr && pay.taxAddr && !eq(pay.taxAddr, taxAddr)) {
    return { ok: false, reason: 'Payment tax destination does not match the authoritative remittance wallet' };
  }
  if (expectedHost && pay.host && !eq(pay.host, expectedHost)) {
    return { ok: false, reason: 'Payment host destination does not match the authoritative host payout address' };
  }
  if (expectedArbitrator && pay.arbitrator && !eq(pay.arbitrator, expectedArbitrator)) {
    return { ok: false, reason: 'Payment arbitrator does not match the configured arbitrator' };
  }
  if (expectedSender && pay.guest && !eq(pay.guest, expectedSender)) {
    return { ok: false, reason: 'Payment guest does not match the booking guest' };
  }
  if (expectedRef && pay.bookingRef && pay.bookingRef !== expectedRef) {
    return { ok: false, reason: 'Payment booking_ref does not match this booking' };
  }
  if (pay.typeArg && normalizeAddr(pay.typeArg.split('::')[0]) !== normalizeAddr(COIN_TYPE().split('::')[0])
      && pay.typeArg !== COIN_TYPE()) {
    return { ok: false, reason: `Payment coin type is not ${COIN_TYPE()}` };
  }

  // Leg amounts.
  if (subtotal != null && String(pay.hostAmount) !== dollarsToUnits(subtotal).toString()) {
    return { ok: false, reason: 'Payment rental leg is not the authoritative subtotal' };
  }
  if (ariaFee != null && String(pay.ariaAmount) !== dollarsToUnits(ariaFee).toString()) {
    return { ok: false, reason: 'Payment ARIA-fee leg is not the authoritative fee' };
  }
  if (taxes != null && String(pay.taxAmount) !== dollarsToUnits(taxes).toString()) {
    return { ok: false, reason: 'Payment tax leg is not the authoritative tax' };
  }
  if (releaseMs != null && pay.releaseMs != null && String(pay.releaseMs) !== String(releaseMs)) {
    return { ok: false, reason: 'Payment release time does not match this booking check-in' };
  }

  // The same tx must also create the matching DEPOSIT escrow (closes the
  // deposit-path amount gap lag-free too). If the deposit decode isn't yet
  // available, retry rather than accept a half-verified booking.
  if (!dep || dep.amountMist == null) {
    return { ok: false, retryable: true, paymentEscrowId, depositEscrowId, reason: 'Deposit escrow not yet verifiable on-chain — please retry in a moment.' };
  }
  if (depositAmount != null && String(dep.amountMist) !== depositToMist(depositAmount).toString()) {
    return { ok: false, reason: 'Deposit escrow is not funded with the expected deposit amount' };
  }
  if (expectedHost && dep.host && !eq(dep.host, expectedHost)) {
    return { ok: false, reason: 'Deposit escrow host does not match the authoritative host' };
  }
  if (expectedRef && dep.bookingRef && dep.bookingRef !== expectedRef) {
    return { ok: false, reason: 'Deposit escrow booking_ref does not match this booking' };
  }

  return { ok: true, paymentEscrowId, depositEscrowId, bookingPassId, resalePolicyId, sender: actualSender };
}

// Permissionless release at check-in — signed by the zero-privilege auto-release
// key (same trust profile as autoReleaseEscrow; release_payment has no sender
// check). Splits the held payment to host / ARIA / tax. Returns false on any
// failure so the check-in sweep can simply retry.
export async function releasePaymentEscrow(paymentEscrowObjectId) {
  if (!autoReleaseKeypair || !paymentEscrowObjectId || !process.env.ESCROW_PACKAGE_ID) return false;
  try {
    const tx = new Transaction();
    tx.setSender(autoReleaseKeypair.toSuiAddress());
    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::release_payment`,
      typeArguments: [COIN_TYPE()],
      arguments: [tx.object(paymentEscrowObjectId), tx.object('0x6')],
    });
    const result = await autoReleaseKeypair.signAndExecuteTransaction({
      transaction: tx, client: suiClient, include: { effects: true },
    });
    if (result?.$kind === 'FailedTransaction') {
      console.warn('releasePayment failed on-chain:', result.FailedTransaction?.status?.error?.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('releasePaymentEscrow failed:', err.message);
    return false;
  }
}

// Arbitrator-gated full refund of the payment to the guest, before check-in
// only (the contract asserts now < release_time_ms). Signed by the arbitrator
// key — same key/scope as resolveDisputeEscrow. Used by /booking/cancel.
export async function refundPaymentEscrow(paymentEscrowObjectId) {
  if (!arbitratorKeypair || !paymentEscrowObjectId || !process.env.ESCROW_PACKAGE_ID) return false;
  try {
    const tx = new Transaction();
    tx.setSender(arbitratorKeypair.toSuiAddress());
    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::refund_payment`,
      typeArguments: [COIN_TYPE()],
      arguments: [tx.object(paymentEscrowObjectId), tx.object('0x6')],
    });
    const result = await arbitratorKeypair.signAndExecuteTransaction({
      transaction: tx, client: suiClient, include: { effects: true },
    });
    if (result?.$kind === 'FailedTransaction') {
      console.warn('refundPayment failed on-chain:', result.FailedTransaction?.status?.error?.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('refundPaymentEscrow failed:', err.message);
    return false;
  }
}

// Arbitrator-gated early refund of the security DEPOSIT to the guest on cancel,
// instead of waiting for auto_release at expiry. Signed by the arbitrator key
// (refund_deposit asserts sender == escrow.arbitrator). Used by /booking/cancel
// so a cancelling guest gets deposit + payment back together.
export async function refundDepositEscrow(depositEscrowObjectId) {
  if (!arbitratorKeypair || !depositEscrowObjectId || !process.env.ESCROW_PACKAGE_ID) return false;
  try {
    const tx = new Transaction();
    tx.setSender(arbitratorKeypair.toSuiAddress());
    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::refund_deposit`,
      typeArguments: [COIN_TYPE()],
      arguments: [tx.object(depositEscrowObjectId)],
    });
    const result = await arbitratorKeypair.signAndExecuteTransaction({
      transaction: tx, client: suiClient, include: { effects: true },
    });
    if (result?.$kind === 'FailedTransaction') {
      console.warn('refundDeposit failed on-chain:', result.FailedTransaction?.status?.error?.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('refundDepositEscrow failed:', err.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BookingPass (Phase 1) — dynamic, wallet-signed check-in presentation
// ════════════════════════════════════════════════════════════════════════════
//
// The guest's app signs a FRESH `ARIA-CHECKIN:<ref>:<ts>:<nonce>` personal
// message with their zkLogin wallet each time it renders the QR; a scanner posts
// that signed payload to /checkin/verify. We recover the signer from the
// signature and confirm it controls the booking's wallet — so a stale screenshot
// (old ts) or a different wallet fails. The pass on-chain (the live escrow) is
// the source of truth; this signature is the proof-of-control in the moment.
//
// NEEDS AN IN-BROWSER SMOKE TEST: verifying a zkLogin personal-message signature
// server-side uses the SDK verifier with a client (to fetch epoch + JWK). This
// is the same class of thing as the Seal SessionKey path — it may need tweaking
// for the gRPC client (or a JSON-RPC client just for verification). Build the
// flow, then exercise it once live and adjust.
export function checkinMessageBytes(bookingRef, ts, nonce) {
  return new TextEncoder().encode(`ARIA-CHECKIN:${bookingRef}:${ts}:${nonce}`);
}

export async function verifyCheckinSignature({ bookingRef, ts, nonce, address, signature }) {
  if (!bookingRef || !ts || !nonce || !address || !signature) {
    return { ok: false, reason: 'Incomplete check-in payload' };
  }
  try {
    const message = checkinMessageBytes(bookingRef, ts, nonce);
    const publicKey = await verifyPersonalMessageSignature(message, signature, { client: suiClient });
    const signer = publicKey.toSuiAddress();
    if (normalizeAddr(signer) !== normalizeAddr(address)) {
      return { ok: false, reason: 'Signature does not match the presented wallet address' };
    }
    return { ok: true, signer };
  } catch (err) {
    return { ok: false, reason: `Invalid check-in signature: ${err.message}` };
  }
}
