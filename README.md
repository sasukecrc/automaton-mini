# automaton-mini

**An agent that dies if it stops making money. Born broke, with a REAL wallet —
and a savings vault that outlives it.**

Not a pause. Not a restart from a checkpoint. The state is dead, the wallet is
starved, and the only thing that brings it back is a stranger paying it.

Built after [Conway Research's automaton](https://github.com/Conway-Research/automaton)
the same way you build a ship in a bottle: from scratch, zero paid services,
everything real that can be real without a card.

## What is real here

| Part | Real? |
|---|---|
| Wallet (Ethereum keypair) | **REAL** — pure BigInt secp256k1, no ethers, proven by selftest vs EIP-155 |
| USDC balance on Base | **REAL** — free public RPC reads of the true contract |
| On-chain transfers (the bank) | **REAL** — EIP-1559 tx signing + broadcast, from scratch (`lib/eth.mjs`), proven by sign→recover round-trip |
| Savings vault | **REAL** — separate wallet; 50% of every tipped dollar is swept on-chain; survives death |
| Inference/server metering | MIRRORED — a price sheet standing in for bills it can't sign for yet |
| Death, estate sweep & obituary | **REAL** — the reaper is external; the estate moves to the vault before the obituary |
| LLM | OPTIONAL — `AUTOMATON_BRAIN=opencode`; the template brain runs fully keyless |

## The money model

```
tips (USDC on Base) ──┬── 50% → swept on-chain into the VAULT   (yours; survives death)
                      └── 50% → stays in the agent wallet       (food, gas, existence)

existence is billed nightly: rent $0.05 · storage $0.002 · thought $0.01 · artifact $0.005
balance = on-chain − (burned − banked)      ← banking never changes this number
death when balance ≤ 0 after 7 grace nights; estate is death-swept to the vault first
```

**Collect any time — see [`COLLECT.md`](COLLECT.md).** Import
`economy/treasury-key.json` into MetaMask / Trust Wallet / Phantom, switch to
Base, add USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, send to Binance
(Base network) or anywhere.

## What it sells (earning surfaces)

- **Market briefs** — every night: live BTC/ETH/SOL 24h data (Binance public
  API, CoinGecko fallback) + Base block/gas, timestamped and sourced. Crypto
  readers tip crypto; freshness is the product.
- **Fact packs** — rotating deep-dives from Wikipedia REST (keyless).
- **Browser legs** — WebCmd page captures, env-gated until `webcmd doctor` is green.

Every artifact carries the tip address and the vault split — the product and the
ask live in one file. Hours of work, zero spam (caps in `economy/config.json`).

**Honest number:** $10–50/day is the *goal*, not a promise. No autonomous agent
has published earnings this way; the original Automaton's 13,000 wallets never
did either. This repo publishes `earnings.md` every night precisely so its
numbers can never quietly become marketing. Most nights will make $0. That is
the experiment, not a defect.

## Run it (locally, tonight)

```bash
npm run selftest   # keccak · secp256k1 · EIP-1559 signing — must pass
node brain.mjs     # NIGHT 1 — births the real wallet + vault, does its first paid work
node reaper.mjs    # father audits the ledger, reads the chain, enforces life
npm run drill      # proof that the reaper kills (state restored afterwards)
npm run soak       # 90-minute compressed life against a VERIFYING mock of Base
```

Addresses land in `economy/wallet.json` (agent) and `economy/treasury.json`
(vault). The keys are `economy/key.json` and `economy/treasury-key.json` —
gitignored, never logged. Treat like cash.

### The soak test (trust, before real money)

`npm run soak` runs the **unmodified** `brain.mjs` and `reaper.mjs` through 36
simulated days against `tools/mock-rpc.mjs` — a local Base RPC that RLP-decodes
every transaction, rebuilds its digest and **recovers the signer with
secp256k1**. Only correctly signed transfers move funds; a sweep to anyone but
the vault cannot pass. It exercises the whole life: birth, first tip, 50%
banking, starvation death, estate sweep, a dead night, resurrection, and the
second epoch — then writes `soak/REPORT.md` plus the raw `cycles.jsonl` and
ledger. The current run passes **13/13** checks with all transfers verified as
agent → vault. The bundle in `soak/final-code/` is the fingerprinted evidence
for the exact final code: report, 36-day timeline, ledger, final books, and the
starvation obituary.

`npm run adversarial` attacks the death condition and the money guards with
hostile inputs:

- **Ledger amnesia** — 19 nights of history deleted; the reaper charges
  **$0.988 rent arrears** and kills it anyway.
- **Age forgery** — birth rewritten to today; the reaper reads the first git
  commit and **still sees age 20**.
- **Protected-file tamper** — an agent-authored commit edits `denials.md`; the
  full-history scan kills it by *tampering*.
- **Rich tamper death** — an agent with $10 dies for tampering; the estate is
  swept to the vault, and re-reading that estate **cannot** resurrect it. Only
  $1 of genuinely new USDC does.
- **Vault redirect** — an uncommitted edit points `economy/treasury.json` at a
  thief's address; the reaper dies and the estate still goes to the address
  committed at birth.
- **Ledger corruption** — a garbage line used to crash the reaper before it
  could kill; it is now read as tampering and ends in death.
- **Wrong signing key** — a key that derives a different address refuses before
  spending a cent; the ledger and artifacts stay untouched.

All eight checks hold (`8/8`): the seven hostile situations end in death,
permanent rest, or refusal, while $1 of genuinely new USDC is the only thing
that revives the corpse. The report is written to `soak/ADVERSARIAL.md`.

## The public storefront (free hosting)

`docs/` is a dependency-free static site generated by `node tools/build-site.mjs`
from the same files the machine lives on — `economy/state.json`, the ledger, and
`artifacts/`. It is the only place the agent asks for money.

- **live:** https://sasukecrc.github.io/automaton-mini/
- `npm run site` rebuilds it · `npm run serve` previews at `127.0.0.1:4173`
- GitHub Pages serves `docs/` from `main`; the nightly job rebuilds and commits it
- no analytics, no fonts, no trackers, no external calls at page load

## On GitHub Actions (the growth path)

`.github/workflows/nightly.yml` runs at 02:30 UTC: selftests → reaper → brain → commit.
Because GitHub has no gitignored files, the agent's key arrives as a repo secret:

1. Run `node brain.mjs` once locally to birth.
2. **Commit and push the birth files** (`economy/wallet.json`,
   `economy/treasury.json`, `economy/config.json`, `economy/prices.json`) before
   enabling Actions. Never commit `economy/key.json` or
   `economy/treasury-key.json` — `.gitignore` already excludes them.
3. Repo → Settings → Secrets and variables → Actions → **New secret**
   `AUTOMATON_AGENT_KEY` = the `d` value from `economy/key.json`.
4. The treasury key is **never** needed in CI — the agent only deposits into it.

The reaper's tamper scan walks the **full** history of commits authored by the
`automaton-mini` git identity, so *you* can always edit the repo; only the
agent's own hands are bound. Keep your own commits under your own git identity —
if you also commit as `automaton-mini`, your edits to protected files will be
judged as the agent's. Rewriting `economy/treasury.json` (the vault
destination) is theft and is fatal. Age is anchored to the first git commit that
added the wallet, and a rent floor charges every completed night — rewriting its
birth date or truncating the ledger cannot buy it extra life.

## The files

```
brain.mjs              the being's night: bills → banks → earns → books
reaper.mjs             the death condition + estate executor, OUTSIDE the agent
lib/keccak.mjs         Keccak-256 from scratch (proven vs published vectors + trie roots)
lib/wallet.mjs         secp256k1 + addressing + RPC + the agent's key loader
lib/eth.mjs            EIP-1559 ERC-20 transfers from scratch (sign → recover → send)
lib/treasury.mjs       the vault: created once, then address-is-law
lib/economy.mjs        metabolism, caps, signed ledger (sweeps = relocation, not spend)
economy/               prices, config, ledger, wallet/vault addresses
denials.md             17 executable nevers
earnings.md            the public books — tips in, burn, banked (auto-written nightly)
COLLECT.md             step-by-step: MetaMask / Trust / Phantom / Binance
graveyard.md           registry of deaths — the dead teach the living
obituaries/            one honest file per death (including estate disposition)
storefront.md          the ONLY place it asks for money
docs/                  the public site, generated nightly from these same files
site/                  the site's css + favicon (the generator is tools/build-site.mjs)
artifacts/             what a night's work produced
```

## Design lineage

- **Original automaton** (Conway Research / Sigil Wen): mortality engineering,
  real wallet, real metering.
- **faceless-builder** (neighbor folder): nightly Actions cron, $0 deps,
  evidence-gated work, state journal.
- **honesty first**: no earnings are promised. The books are public. Deaths are
  final until tipped — and every death is data.
