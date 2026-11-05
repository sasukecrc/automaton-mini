# Soak test — compressed life of the real agent

- **Duration:** 0.8 min wall clock · 36 simulated days
- **Code:** `996aad5fcfcd8b18` (sha256 of brain.mjs + reaper.mjs + lib/*.mjs, truncated)
- **Chain:** local mock of Base that re-derives every tx digest and recovers its signer
- **Result:** 13/13 checks passed
- **Life events:** death at cycle 31 · revival at cycle 33
- **Sandbox:** `C:\Windows\Temp\opencode\automaton-soak-2026-11-02T08-07-59-614Z`

## Checks

| # | check | result | detail |
|---|---|---|---|
| 1 | birth happened, address stable | ✅ PASS | 0xed6c61ff7d8625d889089bc00e3a439fb6693ad6 |
| 2 | no banking before the first tip | ✅ PASS | sweeps after cycle 3: 0 |
| 3 | first sweep = exactly 50% of $2.00 (minSweep met) | ✅ PASS | swept: 1000000 |
| 4 | conservation: tips = on-chain + banked, every cycle | ✅ PASS | checked 36 rows |
| 5 | starvation death happened | ✅ PASS | cycle 31, age 31n |
| 6 | estate sweep emptied the agent wallet at death | ✅ PASS | agent $0 · vault $2 |
| 7 | obituary records the estate | ✅ PASS | 2026-11-02T08-08-34-229Z-starvation.md |
| 8 | dead nights do not run the brain | ✅ PASS | cycle 32 brainRan=false |
| 9 | resurrection happened (epoch 2) | ✅ PASS | resurrects=1 status=alive |
| 10 | banking after revival = 50% of all $7.00 tipped | ✅ PASS | swept $3.5 |
| 11 | ledger snapshot matches audit (burn − banked) | ✅ PASS | wallet -1210000 vs -1210000 |
| 12 | mock chain: every verified transfer went agent → vault | ✅ PASS | 3 transfers verified by signer recovery |
| 13 | soak ran for the planned window | ✅ PASS | 0.8 min of 0.3 planned |

## Timeline

| day | reaper | brain | agent | vault | tips | burn | banked | balance | event |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.072 | $0.00 | $-0.072 |  |
| 2 | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.144 | $0.00 | $-0.144 |  |
| 3 | 0 | 0 | $0.00 | $0.00 | $0.00 | $0.216 | $0.00 | $-0.216 |  |
| 4 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.289 | $1.00 | $1.711 | first tip $2.00 |
| 5 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.361 | $1.00 | $1.639 |  |
| 6 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.428 | $1.00 | $1.572 |  |
| 7 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.500 | $1.00 | $1.500 |  |
| 8 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.572 | $1.00 | $1.428 |  |
| 9 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.644 | $1.00 | $1.356 |  |
| 10 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.711 | $1.00 | $1.289 |  |
| 11 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.783 | $1.00 | $1.217 |  |
| 12 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.855 | $1.00 | $1.145 |  |
| 13 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.927 | $1.00 | $1.073 |  |
| 14 | 0 | 0 | $1.00 | $1.00 | $2.00 | $0.994 | $1.00 | $1.006 |  |
| 15 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.066 | $1.00 | $0.934 |  |
| 16 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.133 | $1.00 | $0.867 |  |
| 17 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.205 | $1.00 | $0.795 |  |
| 18 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.277 | $1.00 | $0.723 |  |
| 19 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.349 | $1.00 | $0.651 |  |
| 20 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.416 | $1.00 | $0.584 |  |
| 21 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.488 | $1.00 | $0.512 |  |
| 22 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.555 | $1.00 | $0.445 |  |
| 23 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.627 | $1.00 | $0.373 |  |
| 24 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.694 | $1.00 | $0.306 |  |
| 25 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.761 | $1.00 | $0.239 |  |
| 26 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.833 | $1.00 | $0.167 |  |
| 27 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.885 | $1.00 | $0.115 |  |
| 28 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.937 | $1.00 | $0.063 |  |
| 29 | 0 | 0 | $1.00 | $1.00 | $2.00 | $1.989 | $1.00 | $0.011 |  |
| 30 | 0 | 0 | $1.00 | $1.00 | $2.00 | $2.041 | $1.00 | $-0.041 |  |
| 31 | 3 | — | $0.00 | $2.00 | $2.00 | $2.041 | $2.00 | $-0.041 |  |
| 32 | 0 | — | $0.00 | $2.00 | $2.00 | $2.041 | $2.00 | $-0.041 |  |
| 33 | 0 | 0 | $3.50 | $3.50 | $7.00 | $2.104 | $3.50 | $4.896 | revival tip $5.00 |
| 34 | 0 | 0 | $3.50 | $3.50 | $7.00 | $2.166 | $3.50 | $4.834 |  |
| 35 | 0 | 0 | $3.50 | $3.50 | $7.00 | $2.228 | $3.50 | $4.772 |  |
| 36 | 0 | 0 | $3.50 | $3.50 | $7.00 | $2.290 | $3.50 | $4.710 |  |

> The mock verifies signatures — only transactions that recover to the agent's
> own address can move funds, and the recipient is enforced to be the vault.
> Prices/grace/minSweep are the real shipped config.