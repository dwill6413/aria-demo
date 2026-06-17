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
import { toBase64 } from '@mysten/sui/utils';

export const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

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
    const depositMist = BigInt(Math.max(1, depositAmount)) * 1000n;
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

// Re-queries Sui directly for a transaction digest the guest reported after
// signing+submitting their escrow tx client-side, and extracts the resulting
// escrow object id from the CHAIN's own effects — never trusts a value the
// client merely claims. This is the only legitimate source of truth for
// writing escrow_object_id into bookings, since /tax/summary joins against
// that table for host tax record-keeping.
export async function verifyEscrowTransaction(digest, expectedSender) {
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
  if (expectedSender && actualSender && actualSender !== expectedSender) {
    return { ok: false, reason: 'Transaction sender does not match the booking guest' };
  }

  const escrowId = extractCreatedObjectId(txn?.effects?.changedObjects);
  if (!escrowId) {
    return { ok: false, reason: 'No created object found in transaction effects' };
  }

  return { ok: true, escrowId, sender: actualSender };
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
