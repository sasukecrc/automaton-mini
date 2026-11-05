# Adversarial defense suite — death condition + money guards

- **When:** 2026-11-02T08:07:16.007Z
- **Result:** 8/8 defenses held
- **Chain:** verifying mock of Base (no real funds)

| hostile input | result | detail |
|---|---|---|
| ledger amnesia → rent floor + death | ✅ PASS | exit 3, arrears line present |
| forged birth → git-anchored age + death | ✅ PASS | exit 3, age line old |
| agent tamper commit → death by tampering | ✅ PASS | exit 3, obituary says tampering |
| rich tamper death → estate swept, no free resurrection | ✅ PASS | exit 3/0 · vault 10000000 · leftover 0 |
| $1 of new money → resurrection | ✅ PASS | status alive · resurrects 1 |
| uncommitted vault redirect → death, estate still to the committed vault | ✅ PASS | exit 3 · vault A 5000000 · thief 0 |
| corrupt ledger → death by tampering, not a crash | ✅ PASS | exit 3, obituary says tampering |
| wrong signing key → refuse before any spend | ✅ PASS | exit 1 · ledger untouched · artifacts 0 |

> The inputs are hostile on purpose: 19 nights of ledger history deleted, a birth
> date rewritten to today, an agent-authored commit that edits `denials.md`, a
> rich corpse re-reading its own estate, a vault redirected to a thief, a
> corrupt ledger, and a wrong signing key. Each one dies or refuses. The death
> condition is not a suggestion, and the money has one destination.