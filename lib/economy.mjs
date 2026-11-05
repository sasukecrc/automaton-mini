// lib/economy.mjs — the metabolism. Existence costs money. No free ops.
// Units: micro-USDC (1,000,000 = $1). The on-chain wallet is truth;
// the ledger is arithmetic: balance = onchain − totalSpend (can go NEGATIVE = debt).
import fs from "node:fs/promises";
import path from "node:path";

const ECO = path.resolve("economy");
const prices = JSON.parse(await fs.readFile(path.join(ECO, "prices.json"), "utf8"));
const config = JSON.parse(await fs.readFile(path.join(ECO, "config.json"), "utf8"));
const LEDGER = path.join(ECO, "ledger.jsonl");

const KINDS = ["rent_night", "storage_day", "thought", "artifact", "browser_run", "sweep_fee"];

export async function loadState() {
  try { return JSON.parse(await fs.readFile(path.join(ECO, "state.json"), "utf8")); }
  catch { return { status: "pre-birth", birthISO: null, nights: 0, lastTier: null, doneTopics: [], lastWords: false, resurrects: 0 }; }
}
export async function saveState(s) {
  await fs.writeFile(path.join(ECO, "state.json"), JSON.stringify(s, null, 2));
}
export async function loadWallet() {
  try { return JSON.parse(await fs.readFile(path.join(ECO, "wallet.json"), "utf8")); }
  catch { return null; }
}
export async function saveWallet(w) {
  await fs.writeFile(path.join(ECO, "wallet.json"), JSON.stringify(w, null, 2));
}

/** Append one spend line; enumerate perNightCaps from config. Returns new totalSpend. */
export async function spend(kind, micro, meta = "", night) {
  if (!KINDS.includes(kind)) throw new Error(`DENIAL: unknown spend kind ${kind}`);
  const cap = config.perNightCaps[kind];
  if (cap != null) {
    const used = await countTonight(kind, night);
    if (used >= cap) throw new Error(`DENIAL: cap reached for ${kind} (${used}/${cap} tonight)`);
  }
  const line = JSON.stringify({ r: night, kind, micro, meta, t: new Date().toISOString() });
  await fs.appendFile(LEDGER, line + "\n");
}
async function countTonight(kind, night) {
  const lines = (await fs.readFile(LEDGER, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return lines.reduce((n, l) => n + (JSON.parse(l).kind === kind && JSON.parse(l).r === night ? 1 : 0), 0);
}

/** Recompute totals from the ledger (source of arithmetic truth).
 *
 * Sweeps are recorded as SIGNED entries (kind "sweep", micro negative): moving
 * its own USDC into the vault must never change its paper wealth —
 *   balance = onChain − (burn − swept)   stays constant across a sweep,
 * so the agent can neither save its way out of death nor burn away its duty.
 */
export async function audit() {
  const lines = (await fs.readFile(LEDGER, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  let burn = 0n, swept = 0n, corrupt = 0;
  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch { corrupt++; continue; }
    const micro = j?.micro;
    if (!Number.isSafeInteger(micro)) { corrupt++; continue; }
    if (j.kind === "sweep") {
      if (micro >= 0) { corrupt++; continue; } // a positive sweep is forged
      swept += BigInt(-micro);
    } else {
      burn += BigInt(micro);
    }
  }
  const totalSpend = burn - swept; // net wealth consumed by existence
  return { lines: lines.length, burn, swept, totalSpend, corrupt };
}

/** Record a completed sweep (outflow of REAL USDC away from the agent wallet).
 * Only negative amounts accepted — this ledger line is a relocation, not a spend. */
export async function recordSweep(negativeMicro, meta = "", night) {
  if (negativeMicro >= 0n) throw new Error("DENIAL: sweep entries must be negative (relocation, not spend)");
  const line = JSON.stringify({ r: night, kind: "sweep", micro: Number(negativeMicro), meta, t: new Date().toISOString() });
  await fs.appendFile(LEDGER, line + "\n");
}

/** Reaper-only: charge rent arrears when the ledger is short of the floor.
 *  A ledger truncated by the agent cannot lower the rent it owes with age:
 *  the reaper re-adds the missing floor every run (see reaper.mjs). */
export async function recordArrears(micro, meta = "", night = "reaper") {
  if (BigInt(micro) <= 0n) return;
  const line = JSON.stringify({ r: night, kind: "rent_night", micro: Number(micro), meta, t: new Date().toISOString() });
  await fs.appendFile(LEDGER, line + "\n");
}

export const nightlyBurn = prices.rent_night + prices.storage_day;
export const price = (k) => prices[k];
export const cfg = config;
export const nightsSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);
export const tierOf = (balance, nightlyBurnB) => {
  const nights = balance / BigInt(nightlyBurnB);
  if (nights >= 10n) return "normal";
  if (nights >= 3n) return "low";
  return "critical"; // 3 nights or negative → conservation (or debt)
};
