# automaton-mini — DESIGN

## The one-line spec
An agent exists only as long as someone values what it makes. Everything else
is bookkeeping — and the bookkeeping is public.

## Why "born broke"
The real automaton is funded at birth by its creator. We have no funder, so
funding is the *experiment*: its wallet opens at real $0.00 and its entire
lifeblood is tips from strangers to its Base address. Every night ends with an
automatic commit of the wallet, the ledger, the books and the report — so unlike
the original's 13,000 wallets, this one cannot hide its numbers.

## Two wallets, two fates
- **Agent wallet** (`economy/wallet.json`) — signs, eats, pays gas, sweeps.
- **Vault** (`economy/treasury.json`) — public address + policy, committed.
  The agent only ever *deposits* into it; no code path signs from its key
  (`economy/treasury-key.json`, gitignored, yours).

## Economy (economy/)
Units are **micro-USDC** (1,000,000 = $1). `balance = onChain(USDC) − (burn − banked)`
— negative means debt. The on-chain read is truth; the ledger is arithmetic.

| kind | price/night | what it mirrors |
|---|---|---|
| `rent_night` | 50,000 ($0.05) | metered server |
| `storage_day` | 2,000 ($0.002) | metered disk |
| `thought` | 10,000 ($0.01) | one reasoning turn |
| `artifact` | 5,000 ($0.005) | publishing a unit of work |
| `browser_run` | 10,000 ($0.01) | one page action |
| `sweep_fee` | 1,000 ($0.001) | on-chain banking admin |

`$1 tip ≈ 20 full nights`. Burn without income ≈ $0.062/night.

### Sweeps are relocations, not spends
The ledger records a sweep as a **signed** line (`kind:"sweep"`, `micro` negative):

```
balance = onChain − (burn − swept)
```

Moving its own USDC into the vault therefore **cannot change its paper wealth** —
the agent can neither save its way out of death nor burn its way past its
obligation. Everything on paper and on chain stays conserved:

```
tips received, all time = onChain + swept        ← the identity earnings.md shows
owed to bank = floor(tips × 50%) − alreadyBanked ← sweepTips(); never negative
```

Banking bounds: share ≤ 50% of cumulative tips (denial 12), minimum sweep $1
(gas is worth more than dust), and a sweep only happens when the wallet holds
enough ETH for gas. When there is no gas, **tips simply wait on the agent
wallet — nothing is lost**, and the report says exactly why banking paused.

## Death (reaper.mjs — outside the agent)
Triggers: `balance ≤ 0` after grace nights **OR** a tamper hit on protected
paths anywhere in the **agent-authored** history.

The reaper is also the **estate executor**: before the obituary it signs a
transfer of *every remaining unit* of USDC to the vault. Death takes the agent;
it never takes the owner's savings. If the estate sweep fails (usually: no ETH
for gas), the obituary says so and states the funds are still collectible from
`economy/key.json`.

**tamper-proofing**: the ledger can only be falsified in the direction of
self-harm, and a corrupt or forged line cannot crash the reaper into inaction —
the valid arithmetic is still read and corruption is death by *tampering*.
Protected files (including `economy/treasury.json`, the sweep destination) are
scanned across the full history, and every broadcast is self-proven: sign →
parse the raw tx back → recover the signer → must equal the agent's own address,
or nothing leaves (denial 13). Human commits are exempt so the owner stays free.

Three loopholes are closed deliberately:
- **Age forgery** — the agent can write `wallet.json`, so age is anchored to the
  *earliest* of its committed birth and the first git commit that added the
  wallet (`--diff-filter=A`). Rewriting `birth` cannot buy younger nights.
- **Ledger amnesia** — every completed night of the epoch owes rent+storage. If
  the ledger is short (truncated, failed runs), the reaper charges the arrears
  itself (`recordArrears`). Forgetting the bill does not cancel it.
- **Vault redirect** — the sweep destination is anchored to the first git commit
  that added `economy/treasury.json`. A working-tree edit the commit scan has not
  seen yet is caught before any sweep: death by *tampering*, and the estate still
  goes to the original address (`treasury.anchoredAddress()`).

**resurrection**: while dead, at least `reviveTipMicro` ($1) of **new** USDC must
arrive at the agent wallet after death. The reaper freezes the leftover balance
at death as the baseline, so estate money from a failed sweep cannot count as a
tip, and a rich tamper-death cannot resurrect itself by re-reading its own
swept estate. Tips are the only miracle available.

## What a night buys (skills)
- **Market brief** — Binance public 24h tickers (CoinGecko fallback) + Base
  block/gas from RPC; computed TAKE lines (biggest mover, ETH/BTC spread);
  timestamped, sourced, verified. Freshness is the product.
- **Fact pack** — rotating topic from `topics.json`, Wikipedia REST summaries,
  6 distilled facts, angle line when a frontier brain is configured.
- **Browser leg (WebCmd)** — page reads for capture/verification. Env-gated
  (`WEB_CMD_SESSION`) until `webcmd doctor` is green.

All free/keyless. Every network call is timeout-bounded (`AbortSignal`), RPC
reads retry once — a hung API can never hang a night.

## Tiers (lib/economy.mjs: tierOf)
runway = balance ÷ (rent+storage)
- **normal** ≥ 10 nights — brief + fact pack + browser leg
- **low** 3–10 — same work, heavier scrutiny
- **critical** < 3 (incl. negative) — existence only, storefront refresh
- **dim** — RPC down: no spends that need it, never killed on infra errors (fail-open honesty)

**Juvenile allowance**: inside grace a broke agent may still run work at "low"
tier — grace is for nights before earning is plausible, not a fake subsidy.

## Fast + strong (engineering features)
- **Zero dependencies, runtime and test.** Crypto is proven against published
  Keccak vectors, `EMPTY_TRIE_ROOT`, the official EIP-155 signature, and
  EIP-1559 sign→recover round-trips on random wallets (RFC6979 deterministic).
- Key/address mismatch guard: if the CI secret derives a different address than
  `wallet.json`, the night refuses to run rather than orphan funds.
- Parallel market/RPC fetches; bounded retries; atomic ledger lines.
- Tamper scan author-filtered (owner free, agent bound).

## Roadmap (only when it has proven it can earn)
1. **WebCmd legs green** (daemon fix) — verified page-work, screenshots as proof.
2. **Real metering** — once first tips + gas arrive, rent/burn mirror becomes a
   real on-chain transfer to a burn address (the wallet actually eats).
3. **x402 storefront** — serve artifacts behind HTTP 402 priced in USDC (needs
   a hosted endpoint; the wallet is already able to receive).
4. **Replication** — when cumulative profit > spawn cost, birth a child agent
   funded with 100% of *its own* money (never the owner's).
5. **Frontier brain** — `AUTOMATON_BRAIN=opencode` for strategy nights.

## Honesty (the fine print)
No machine has ever earned a living purely by browsing. Most automata die
broke, and $10–50/day is a target, not an entitlement. This project's value is
the *evidence*: wallet, ledger, books, artifacts and obituaries — public,
forever, for free.
