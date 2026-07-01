// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { isValidTransactionDigest, isValidSuiAddress, parseToMist } from '@mysten/sui/utils';
import { pool } from '../db.mjs';
import { normalizeAddr, buildSendTransaction, verifySendTransaction } from '../escrow.mjs';
import { validateBody, walletSendBuildSchema, walletSendConfirmSchema } from '../validation.mjs';
import { getAuthedSession } from '../authz.mjs';

export default async function walletRoutes(fastify) {
// ── Plain wallet send (P3) ───────────────────────────────────────────────────
// Lets a user move SUI out of their ARIA zkLogin wallet to ANY address — their
// own Sui Wallet, an exchange, another testnet address — without installing an
// external wallet extension. Same non-custodial build -> sign -> submit ->
// confirm path as escrow/resale above: the backend only assembles the PTB;
// the user's own browser session (via zkLogin) signs and submits it directly
// to a public Sui fullnode. ARIA's backend never holds a key that can move it.
fastify.post('/wallet/send/build', {
  config: { rateLimit: { max: 20, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many send attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(walletSendBuildSchema, request, reply)) return;

  const { toAddress } = request.body;
  if (!isValidSuiAddress(toAddress)) return reply.code(400).send({ error: 'Enter a valid Sui address (0x followed by 64 hex characters).' });
  if (normalizeAddr(toAddress) === normalizeAddr(session.suiAddress))
    return reply.code(400).send({ error: 'You cannot send to your own wallet address.' });

  let amountMist;
  try {
    amountMist = parseToMist(String(request.body.amount));
  } catch {
    return reply.code(400).send({ error: 'Enter a valid SUI amount.' });
  }
  if (amountMist <= 0n) return reply.code(400).send({ error: 'Amount must be greater than 0.' });

  const built = await buildSendTransaction(session.suiAddress, { toAddress, amountMist }, fastify.log);
  if (!built?.txBytes) {
    return reply.code(502).send({
      error: built?.errorMessage || 'Could not build the send transaction.',
      errorCode: built?.errorCode || 'build_failed',
    });
  }
  return { success: true, sendTxBytes: built.txBytes,
    message: 'Sign this transaction in your wallet, then report the digest to /wallet/send/confirm' };
});

// POST /wallet/send/confirm — independently verify the transfer on-chain
// (never trust the client's reported digest at face value — same posture as
// every other confirm route above), then record it in wallet_sends purely as
// an audit trail. Unlike resales/bookings, nothing else in the app reads this
// row back to drive state, so a failed insert doesn't block the user's
// success: the transfer already landed on-chain regardless.
fastify.post('/wallet/send/confirm', {
  config: { rateLimit: { max: 20, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many confirmation attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(walletSendConfirmSchema, request, reply)) return;

  const { digest, toAddress } = request.body;
  if (!isValidTransactionDigest(digest)) return reply.code(400).send({ error: 'A valid transaction digest is required' });
  if (!isValidSuiAddress(toAddress)) return reply.code(400).send({ error: 'Enter a valid Sui address.' });

  let amountMist;
  try {
    amountMist = parseToMist(String(request.body.amount));
  } catch {
    return reply.code(400).send({ error: 'Enter a valid SUI amount.' });
  }

  let v;
  try {
    v = await verifySendTransaction(digest, session.suiAddress, toAddress, amountMist, fastify.log);
  } catch (err) {
    fastify.log.error({ err, digest }, 'wallet/send/confirm verification failed');
    return reply.code(503).send({ error: 'Could not verify the send on-chain — it may still be processing.', retryable: true });
  }
  if (!v.ok) {
    return reply.code(v.retryable ? 503 : 400).send({ error: v.reason || 'Send could not be verified on-chain', retryable: !!v.retryable });
  }

  try {
    await pool.query(
      `INSERT INTO wallet_sends (from_address, to_address, amount_mist, tx_digest) VALUES ($1,$2,$3,$4)`,
      [session.suiAddress, toAddress, amountMist.toString(), digest]
    );
  } catch (err) {
    if (err?.code === '23505') return { success: true, digest, alreadyRecorded: true };
    fastify.log.error({ err, digest }, 'wallet/send/confirm: audit insert failed');
  }
  fastify.log.info({ from: session.suiAddress, to: toAddress, amountMist: amountMist.toString(), digest }, 'Wallet send verified on-chain');
  return { success: true, digest };
});
}
