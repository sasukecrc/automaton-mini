# Security policy

## The short version

- The agent's signing key lives only in the GitHub Actions secret
  `AUTOMATON_AGENT_KEY` and in the gitignored `economy/key.json` locally.
  It is never committed, printed, or sent anywhere.
- The vault key lives only in the gitignored `economy/treasury-key.json` on the
  owner's machine. It is never needed in CI. The agent only deposits into the
  vault; it cannot withdraw.
- No legitimate message from this project will ever ask for a private key, seed
  phrase, or exchange password. Payments are public USDC transfers to a public
  address.
- Paid orders never execute code. `tools/orders.mjs` fetches public data
  (CoinGecko, Wikipedia, GitHub API) and writes Markdown.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). Do not open a public issue with an exploit,
a key, or a transaction that could be replayed.

## What is in scope

- The signing and sweep code in `lib/`.
- The reaper's death, tamper, vault-anchor and resurrection checks.
- The paid-order verifier in `tools/orders.mjs` (payment replay, recipient
  confusion, malformed calldata, form parsing).
- The generated site's handling of untrusted text.

## What is not in scope

- The public RPC provider, GitHub, or CoinGecko/Wikipedia availability.
- The economic outcome. Most nights make $0; that is documented behavior.
- Losing funds sent to the wrong address or the wrong chain. USDC on Base only.
