# Soak evidence

All runs use `tools/mock-rpc.mjs` — a local Base JSON-RPC that re-derives every
transaction digest and **recovers the signer** with secp256k1. Only correctly
signed transfers move funds, and the recipient is enforced to be the vault.
**No real funds are involved.**

| evidence | what it is |
|---|---|
| `REPORT.md` + `cycles.jsonl` + `ledger.jsonl` | **87.5-minute endurance run**, 36 simulated days, **13/13**. Started before the last two guards (vault anchor, corrupt-ledger death) landed; it validates the core life loop under real network calls. |
| `final-code/` | the **exact final tree** (`996aad5fcfcd8b18`, sha256 of `brain.mjs` + `reaper.mjs` + `lib/*.mjs`, truncated): 36-day life, **13/13**, death at cycle 31, revival at 33, final vault **$3.50 = 50% of $7** tipped. Includes report, timeline, ledger, final books, and the starvation obituary. |
| `ADVERSARIAL.md` | **8/8** hostile cases: ledger amnesia, forged birth, protected-file tamper, rich-tamper auto-resurrection, uncommitted vault redirect, corrupt ledger, wrong signing key. |

## What the 13 checks mean

1. birth happened and the address stayed stable
2. nothing was banked before the first tip
3. the first $2 tip swept exactly $1 on-chain (the real $1 minimum)
4. conservation held every cycle: `tips = on-chain + banked`
5. starvation death fired at cycle 31 (age 31)
6. the estate sweep emptied the agent wallet at death
7. the obituary records the estate
8. a dead night did not run the brain
9. resurrection fired as epoch 2
10. banking after revival reached exactly 50% of all $7 tipped
11. the committed ledger snapshot equals `burn − banked`
12. all 3 transfers were verified by signer recovery as **agent → vault**
13. the run covered its planned window

## Honest limits

The mock proves signing, routing, accounting, death, estate, and revival. It
does **not** prove a mainnet broadcast, gas-price estimation against a live
Base mempool, or a real tip arriving. The real wallets hold **$0 USDC / $0
ETH**, so the first real tip (plus a little ETH for gas) is the remaining
live-fire test.
