// lib/treasury.mjs — THE VAULT. The savings wallet that survives death.
//
// Two wallets, two fates:
//   economy/key.json            → the AGENT (it needs its key to eat, sweep, pay gas)
//   economy/treasury-key.json   → the OPERATOR'S vault (the agent only ever
//                                 sends INTO it; the agent's code never reads it)
//
// `ensure()` creates the treasury ONCE. After that, the committed public
// address in economy/treasury.json is law: agent commits that sweep to
// another address are theft, and theft is guarded by `reaper.mjs`.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as wal from "./wallet.mjs";

const ECO = path.resolve("economy");
const run = promisify(execFile);
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** The vault address as FIRST committed. Once created, the destination is law:
 *  a later working-tree edit (even one the commit scan has not seen yet) must
 *  never redirect the money. Falls back to the working file when git is absent. */
export async function anchoredAddress() {
  const current = await load();
  if (!current?.address) return null;
  if (!process.env.CI) return current.address;
  try {
    const { stdout: hashOut } = await run("git", [
      "log", "--reverse", "--diff-filter=A", "--format=%H", "--", "economy/treasury.json"
    ]);
    const first = hashOut.trim().split("\n").filter(Boolean)[0];
    if (!first) return current.address;
    const { stdout: blob } = await run("git", ["show", `${first}:economy/treasury.json`]);
    const anchored = JSON.parse(blob)?.address;
    return typeof anchored === "string" && /^0x[0-9a-fA-F]{40}$/.test(anchored)
      ? anchored : current.address;
  } catch { return current.address; }
}

/** Create the vault the first time. After that: read-only, forever. */
export async function ensure() {
  const existing = await load();
  if (existing) {
    const anchored = await anchoredAddress();
    if (anchored && anchored.toLowerCase() !== existing.address.toLowerCase()) {
      console.log("[treasury] 🛑 vault address mismatch — refusing the redirected address, using the committed vault", anchored);
      return { ...existing, address: anchored, redirected: existing.address };
    }
    return existing;
  }
  const { address, d } = wal.newWallet();
  await fs.writeFile(path.join(ECO, "treasury-key.json"), JSON.stringify({
    comment: [
      "GITIGNORED. OWNER'S VAULT — whoever imports this private key owns the savings.",
      "Import into MetaMask / Trust Wallet / Phantom, switch to Base, add native USDC.",
      "See COLLECT.md. The agent's code never reads this file — it only deposits here."
    ].join("\n"),
    kty: "EC", crv: "secp256k1",
    d: "0x" + d.toString(16).padStart(64, "0")
  }, null, 2));
  const pub = {
    address,
    role: "savings vault — survives the agent's death; collectible via MetaMask/Trust/Phantom",
    chain: { name: "Base", id: 8453, rpc: "https://mainnet.base.org" },
    token: { symbol: "USDC", contract: USDC_BASE, decimals: 6 },
    policy: { sweepSharePct: 50, note: "half of every tipped inflow is swept here nightly; the reaper death-sweeps whatever remains" },
    created: new Date().toISOString()
  };
  await fs.writeFile(path.join(ECO, "treasury.json"), JSON.stringify(pub, null, 2));
  return pub;
}

/** Public part only (address + policy). Never touches the key. */
export async function load() {
  try { return JSON.parse(await fs.readFile(path.join(ECO, "treasury.json"), "utf8")); }
  catch { return null; }
}

/** Live USDC balance of the vault (free RPC, no key needed to READ). */
export async function balance(address) {
  return wal.usdcBalance(address);
}
