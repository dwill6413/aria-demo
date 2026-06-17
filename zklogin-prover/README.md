# Self-hosted zkLogin prover (Testnet)

Fixes: escrow signing failing with `Groth16 proof verify failed` on every
attempt. The app's default prover (`prover-dev.mystenlabs.com`) is paired
with Devnet's zkey circuit; ARIA runs on Testnet, which needs the
Mainnet/Testnet-shared `zkLogin-main.zkey` circuit instead. This folder
self-hosts the correct prover so proofs verify on-chain.

No secrets live in this folder — just public Docker images and a public
zkey file. Push it from your own machine as usual (per the project's
never-commit-secrets rule, which doesn't apply here but the push-from-your-
machine workflow still does, since this sandbox has no GitHub credentials).

## 1. Push this folder

From your machine, in the `aria-demo` repo:

```
git add zklogin-prover
git commit -m "Add self-hosted zkLogin prover for testnet"
git push
```

## 2. Add the `prover` service (private, internal only)

In the same Railway project:

1. New Service → Deploy from GitHub repo → same repo.
2. Settings → Root Directory: `zklogin-prover`. Railway will pick up
   `zklogin-prover/railway.json` and build the Dockerfile.
3. Rename the service to `zklogin-prover` (the name matters — it's used in
   step 3's private networking URL).
4. Do **not** generate a public domain for this service. It only needs to
   be reachable from `prover-fe` over Railway's private network.
5. Deploy. First build will take a while (~1GB zkey download). Check Deploy
   Logs for the prover startup message once it's up.

## 3. Add the `prover-fe` service (public)

1. New Service → Deploy from Docker Image → `mysten/zklogin:prover-fe-stable`
   (no repo needed).
2. Variables:
   - `PROVER_URI=http://zklogin-prover.railway.internal:8080/input`
   - `NODE_ENV=production`
   - `DEBUG=zkLogin:info,jwks`
3. Settings → Networking → Generate Domain (this one needs to be public —
   the browser calls it directly).
4. Deploy.

## 4. Verify the prover-fe is alive

```
curl https://<prover-fe-domain>/ping
```

Expect `pong`. If this fails, check `prover-fe`'s Deploy Logs and confirm
`prover`'s service name in `PROVER_URI` matches exactly.

## 5. Point ARIA at it

On the main ARIA Railway service, set:

```
NEXT_PUBLIC_PROVER_URL=https://<prover-fe-domain>/v1
```

Redeploy the main app.

## 6. Re-test

Sign out, sign back in fresh (new zkLogin session against the new prover),
create a new booking, and confirm escrow deposit succeeds with no Groth16
error. Check the guest wallet's Activity tab on Suiscan for a
`create_escrow` transaction.

## Sizing note

Mysten's own production prover runs on a 16 vCPU / 64GB box for
mainnet-scale traffic. For ARIA's single-user testnet use, a much smaller
Railway plan should work, but Groth16 proving is memory-hungry — if the
`prover` service OOMs or times out, bump its memory allocation first.
