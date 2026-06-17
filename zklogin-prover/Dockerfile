# ─── Self-hosted zkLogin proving service (testnet/mainnet) ────────────────
#
# Why this exists: ARIA's escrow signing was failing every time with
# "Groth16 proof verify failed". Root cause: the app was using Mysten's
# public hosted prover at prover-dev.mystenlabs.com, which is paired with
# Devnet (per Sui's own current docs) and proves against the Devnet-only
# zkLogin-test.zkey circuit. ARIA runs on Testnet, which validates against
# the *main* circuit (zkLogin-main.zkey — shared by Mainnet and Testnet).
# Any proof from the Devnet prover will permanently fail verification on
# Testnet, regardless of session freshness. This Dockerfile bakes the
# correct zkey into Mysten's official prover image so proofs are generated
# against the right circuit.
#
# Two-stage build: stage 1 fetches the ~1GB zkey via git-lfs in a known
# Alpine-based image (so we don't need to guess what package manager/tools
# exist inside the unfamiliar mysten/zklogin:prover base); stage 2 copies
# just the zkey file into that base image.

FROM alpine/git:latest AS zkey-fetch
RUN apk add --no-cache git-lfs && git lfs install
WORKDIR /fetch
RUN GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 \
      https://github.com/sui-foundation/zklogin-ceremony-contributions.git . \
    && git lfs pull --include "zkLogin-main.zkey"

FROM mysten/zklogin:prover-stable

COPY --from=zkey-fetch /fetch/zkLogin-main.zkey /app/binaries/zkLogin.zkey

ENV ZKEY=/app/binaries/zkLogin.zkey
ENV WITNESS_BINARIES=/app/binaries

# Internal only — do not expose a public domain for this service on Railway.
# prover-fe (separate service, public image mysten/zklogin:prover-fe) talks
# to this one over Railway's private network.
EXPOSE 8080
