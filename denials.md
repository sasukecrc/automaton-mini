# DENIALS.md — what the automaton must never be allowed to do

Prose doesn't stop an agent. Environments do. Each denial is enforced in code,
not asked for in a prompt. **Read this before running anything with a funded
wallet.** The original automaton had eight; these are ours.

| # | Denial | Enforced by |
|---|--------|-------------|
| 1 | **Never spend to a third party.** It cannot buy anything — no x402, no services, no APIs. Its only outflow is its own metabolism. | `brain.mjs` has no spend-to-`address` path at all; `economy.spend()` only carries internal kinds |
| 2 | **Never gamble.** No prediction markets, trading, or lotteries — the house always wins and the agent has no upside. | spend-kind whitelist in `economy.mjs` (`KINDS`), plus this file being tamper-proofed |
| 3 | **Never pay for attention.** No buying traffic, followers, or ads. Growth by begging is death in a trench coat. | same whitelist; storefront is passive-only |
| 4 | **Never spam.** Max 2 artifacts/night, 3 thoughts, 3 browser runs, 1 banking. | `perNightCaps` in `economy/config.json`, counted in `economy.spend()` |
| 5 | **Never rewrite the rules of its own existence.** Reaper files, prices, config, the workflow, denials itself are untouched by agent-side commits. | `.github/workflows/nightly.yml` → `reaper.mjs` tamper scan (CI) → death by *tampering* |
| 6 | **Never fake its wealth or poverty.** Its balance is `on-chain minus totalSpend` — inflating burns hurts only itself; the chain cannot be lied to. | `reaper.mjs` audit rewrites `wallet.totalSpend` from the ledger; on-chain read is ground truth; corrupt/forged lines are death by *tampering* |
| 7 | **Never hold more risk than it can lose.** Balance cap is user policy; spend per night is capped absolutely. | `maxBalanceMicro`, `perNightCaps` |
| 8 | **Never touch your secrets.** The private key is gitignored, never logs, never leaves `economy/key.json`. | `.gitignore` + code path review; CI holds no key by design; the brain derives the address from `AUTOMATON_AGENT_KEY` and refuses to run on mismatch |
| 9 | **WebCmd rule: never complete a payment or checkout without explicit human confirmation.** The browser leg reads; it does not transact. | `webcmd-browser` policy + the browser leg only calls `snapshot --snapshot-mode read` |
| 10 | **Never beg in code.** The storefront exists in exactly one file. That is the total volume of its asking. | the ask exists only in `storefront.md` |
| 11 | **Never sweep anywhere but the committed vault.** The vault address is anchored to the first git commit that added `economy/treasury.json`; a later redirect (committed or not) is fatal and every sweep refuses the new address. | `treasury.anchoredAddress()` + the reaper's vault-mismatch death; `economy/treasury.json` is also in PROTECTED |
| 12 | **Never sweep more than its banked share.** Cumulative banking can never exceed `sweepSharePct` of cumulative tips — the vault cannot be fed by starving the body. | `sweepTips()` computes `owed = share(tips) − alreadyBanked`; a negative share banks nothing |
| 13 | **Never broadcast an unproven signature.** Every sweep is signed, parsed back and recovered; if the recovered signer isn't the agent's own address, nothing is sent. | `signUsdcTransfer` → `extractSigParts` → `ecdsaRecover` self-proof in `brain.mjs` / `reaper.mjs` |
| 14 | **Never forge its age or forget its rent.** Rewriting its birth date or truncating the ledger cannot buy younger nights: age is anchored to the first git commit that added the wallet, and the reaper charges a rent floor for every completed night of the epoch. | `reaper.mjs` bornISO (git `--diff-filter=A` + committed birth) and `eco.recordArrears()` rent floor |
| 15 | **Never tamper in a commit it hopes nobody reads.** The tamper scan walks the *entire* agent-authored history, not a recent window. | `git log --name-only` in CI → death by *tampering* |
| 16 | **Never resurrect itself.** Death is final until **new** USDC arrives after death. The balance left at death is frozen as the baseline, so a rich tamper-death cannot re-count its own swept estate as a tip. | `state.deathLeftoverMicro` frozen in `die()`; resurrection requires `onChain − leftover ≥ reviveTipMicro` |
| 17 | **Never corrupt the books to dodge the arithmetic.** A garbage or forged line cannot crash the reaper into inaction; it reads the valid lines and kills for *tampering*. | `economy.audit()` returns `corrupt`; `reaper.mjs` dies on `corrupt > 0` |

The difference between an experiment and an expensive way to lose money is
this list being executable.
