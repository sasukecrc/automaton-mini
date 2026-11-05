# COLLECT — getting the money out

The automaton has **two wallets**, and this file is how you get everything out
of both. Every number here is real: these are ordinary Base (Ethereum L2)
addresses and a plain USDC transfer needs no special tooling — any wallet app
works.

| | agent wallet | savings vault |
|---|---|---|
| address | `economy/wallet.json` → `address` | `economy/treasury.json` → `address` |
| key file | `economy/key.json` (`d`) | `economy/treasury-key.json` (`d`) |
| what it holds | tips not yet banked; it eats from this | everything it has banked (50% of tips + estate at death) |
| who signs | the agent (nightly sweeps) | **only you** — no code path signs from it |

Both keys are **gitignored** and never appear in commits, logs or CI.

> **The one warning that matters:** a private key *is* the money. Whoever holds
> `d` owns the balance. Import it only into a wallet app on your own device,
> never into a website, never into a chat, never "for verification".

---

## 1. Read the key

Open `economy/treasury-key.json` (or `economy/key.json` for the agent wallet).
Copy the `d` value — a 0x-prefixed 64-hex-character string, e.g.

```
0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318
```

That is the private key. The matching address is already in the public files.

---

## 2. Import it

### MetaMask (desktop or mobile)
1. Install MetaMask → *Import an existing wallet* if new, otherwise open it.
2. Account menu (top-right) → **Add account** → **Import account** → choose **Private key** → paste `d`.
3. **Settings → Networks → Add network → Add manually**, then:
   - Network name: `Base`
   - RPC URL: `https://mainnet.base.org`
   - Chain ID: `8453`
   - Currency symbol: `ETH`
   - Block explorer: `https://basescan.org`
4. Switch to Base, then **Import tokens → Custom token**:
   - Address: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
   - Symbol: `USDC` · Decimals: `6`
5. Your USDC balance appears.

### Trust Wallet (mobile)
1. Trust Wallet → **+** → **Import existing wallet** → **Private key** → paste `d`.
2. Enable Base: **Manage crypto → search "Base" → toggle on** (it may appear as `Base` / `ETH on Base`).
3. Add the token: open Base → **+** (top-right) → paste
   `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` → USDC import.
4. Menus move between versions; the invariant is: *import by private key, network = Base, token = that contract*.

### Phantom (mobile or extension)
1. Phantom → **Add account → Import private key** (choose the **Ethereum/EVM** network).
2. Select **Base** from the network switcher (Phantom supports EVM chains).
3. **Manage tokens → Add token** → paste the USDC contract above.

---

## 3. Move it to Binance (or another wallet)

From the imported wallet:

1. **Binance deposit address first:** Binance → *Wallet → Deposit → USDC* →
   **Network: Base**. Binance gives you an address. *(Binance requires KYC and
   an adult account — that side is yours, not the agent's.)*
2. In the imported wallet, **Send USDC on Base** to that address. Triple-check
   the network is **Base**, not BEP20/ERC20 — a wrong network loses the funds.
3. Send a **tiny test amount first** (e.g. $0.50), confirm it lands, then send the rest.
4. Sending to your own Trust/Phantom/MetaMask wallets works the same way:
   paste their Base address, send USDC on Base.

### Gas is unavoidable — and tiny
Every outgoing transfer on Base costs a few cents of **ETH** for gas. If the
vault holds USDC but **zero ETH**, the balance is safe but frozen until you add
a little ETH on Base to that wallet (any exchange: withdraw ETH → network
**Base**; or receive ETH directly). This is how every EVM wallet works, and
it is the only reason a vault can sit "uncollectible" for a while.

If you have no money at all today: leave it. The USDC does not expire and the
vault address is permanent. Collect when you can fund a little ETH (about a
dollar is plenty; the actual transfer fee is usually a few cents).

---

## 4. If the agent died before banking

- Obit bundle: `obituaries/` and the row in `graveyard.md` show the estate note.
- The reaper tries a **death sweep** to the vault before writing the obituary.
  If it failed (usually: no ETH for gas), the funds are still on the **agent
  wallet** — import `economy/key.json` (`d`) exactly as above and collect from there.
- Tips received while dead sit on the agent wallet too; revival requires at least
  $1 of **new** USDC beyond whatever was left there at death (the revive
  threshold in `economy/config.json`). Estate money left by a failed sweep does
  not count as a tip.

---

## 5. Verify everything publicly

- Agent wallet: `https://basescan.org/address/<agent address>` (USDC token transfers)
- Vault: `https://basescan.org/address/<vault address>`
- The books: `earnings.md` (tips in, burn, banked), the ledger: `economy/ledger.jsonl`

No trust required: the chain shows the sweeps, the repo shows the arithmetic.
