#!/usr/bin/env node
/**
 * automaton-mini brain — the being. One night of its life, per run.
 *
 * Born broke with a REAL crypto wallet (USDC on Base). Everything it does is
 * billed. Half of every tipped dollar is banked in a vault that survives its
 * death (economy/treasury.json; the key is yours — see COLLECT.md).
 *
 * Runs nightly AFTER reaper.mjs (the reaper holds the kill switch; this file
 * never runs after death, and never touches the reaper's files).
 *
 * Tiers: normal → low → critical. Doing nothing is the fastest way to die.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import * as eco from "./lib/economy.mjs";
import * as wal from "./lib/wallet.mjs";
import * as eth from "./lib/eth.mjs";
import * as treasury from "./lib/treasury.mjs";
import topics from "./topics.json" with { type: "json" };

const ART = path.resolve("artifacts");
const log = (...a) => console.log("[automaton]", ...a);
const fmt = wal.fmtUsd;
const pull = (arr, seed) => arr[crypto.createHash("sha1").update(String(seed)).digest()[0] % arr.length];

/** Every network call is bounded: a hung API must never hang a night. */
async function fetchJson(url, ms = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${new URL(url).host} → HTTP ${res.status}`);
  return res.json();
}

/* 0 ── BIRTH: a real wallet, once. On CI the key arrives as a secret; locally
   it lands in the gitignored economy/key.json. Either way the ADDRESS is
   committed and may never silently change. */
async function birthIfNeeded() {
  const existing = await eco.loadWallet();
  const envKey = process.env.AUTOMATON_AGENT_KEY;
  const envScalar = envKey ? BigInt(envKey.startsWith("0x") ? envKey : "0x" + envKey) : null;

  if (existing) {
    if (envScalar) {
      const derived = wal.addressFromScalar(envScalar);
      if (derived.toLowerCase() !== existing.address.toLowerCase())
        throw new Error(`KEY MISMATCH — AUTOMATON_AGENT_KEY derives ${derived} but wallet.json says ${existing.address}. Refusing to run.`);
    }
    return existing;
  }

  let address, d;
  if (envScalar) {
    d = envScalar;
    address = wal.addressFromScalar(d);
  } else {
    ({ address, d } = wal.newWallet());
    await fs.writeFile(path.join("economy", "key.json"), JSON.stringify({
      comment: "GITIGNORED. Real money. Treat like cash. Also store it as the CI secret AUTOMATON_AGENT_KEY.",
      kty: "EC", crv: "secp256k1",
      d: d.toString(16).padStart(64, "0")
    }, null, 2));
  }
  const born = { address, birth: new Date().toISOString(), totalSpend: 0, prevOnChainMicro: 0 };
  await eco.saveWallet(born);
  log("🌱 BIRTH — real wallet created:", address, envScalar ? "(from secret)" : "(key saved locally)");
  log("   Born broke. Its only income: tips sent to that address. Anyone can.");
  return born;
}

/* 1 ── heartbeat ledger: existence is billed every night */
async function heartbeat(night) {
  await eco.spend("rent_night", eco.price("rent_night"), "compute rent (metered-server mirror)", night);
  await eco.spend("storage_day", eco.price("storage_day"), "memory pages (metered-disk mirror)", night);
}

/* 2 ── banking: sweep the vault's share of every tipped dollar, on-chain */
async function sweepTips(wallet, vault, onchain, night) {
  const a = await eco.audit();
  const cumTips = onchain + a.swept;                 // conserved: tips = on-chain + banked
  const target = cumTips * BigInt(eco.cfg.sweepSharePct) / 100n;
  const owed = target - a.swept;
  if (owed <= 0n) return { swept: 0n, note: "share already banked" };
  if (owed < BigInt(eco.cfg.minSweepMicro))
    return { swept: 0n, note: `${fmt(owed)} owed — below the ${fmt(BigInt(eco.cfg.minSweepMicro))} sweep minimum (gas costs more than dust)` };

  const gasNeed = BigInt(eco.cfg.txGasLimit) * BigInt(eco.cfg.gasMaxFeeGwei) * 1_000_000_000n;
  const ethWei = await wal.ethBalance(wallet.address).catch(() => null);
  if (ethWei == null) return { swept: 0n, note: "gas balance unreadable" };
  if (ethWei < gasNeed)
    return { swept: 0n, note: `needs ETH gas on Base (~${gasNeed} wei) — tips stay safe on the agent wallet until then` };

  try {
    const d = await wal.agentKey();
    if (!d) throw new Error("no signing key available");
    const nonce = await eth.nextNonce(wallet.address);
    const { raw, digest } = eth.signUsdcTransfer({
      d, to: vault.address, micro: owed, nonce,
      maxFeeGas: BigInt(eco.cfg.gasMaxFeeGwei) * 1_000_000_000n,
      gasLimit: BigInt(eco.cfg.txGasLimit)
    });
    // SELF-PROOF: refuse to broadcast anything that doesn't recover to the agent itself
    const parts = eth.extractSigParts(raw);
    const signer = eth.ecdsaRecover(Buffer.from(digest.slice(2), "hex"), parts.r, parts.s, parts.yParity);
    if (signer.toLowerCase() !== wallet.address.toLowerCase())
      throw new Error("self-proof failed — signature does not belong to the agent wallet; refusing to broadcast");

    const { status, hash } = await eth.sendRaw(raw);
    if (status !== 1) throw new Error(`receipt status ${status ?? "unknown"}`);
    await eco.recordSweep(-owed, `banked → vault ${vault.address} · tx ${hash}`, night);
    await eco.spend("sweep_fee", eco.price("sweep_fee"), "on-chain banking admin", night);
    return { swept: owed, note: `banked ${fmt(owed)} → vault (tx ${hash})`, tx: hash };
  } catch (e) {
    return { swept: 0n, note: "sweep skipped: " + e.message.slice(0, 140) };
  }
}

/* 3 ── skill A: the daily market brief (fresh, sourced, verifiable) */
const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const usd = (n, d = 2) => n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: d });

async function exchangeRows() {
  try {
    const j = await fetchJson("https://api.binance.com/api/v3/ticker/24hr?symbols=" + encodeURIComponent(JSON.stringify(PAIRS)));
    return {
      source: "Binance public API · 24h tickers",
      rows: j.map(t => ({
        pair: t.symbol.replace("USDT", "/USDT"),
        last: Number(t.lastPrice), chg: Number(t.priceChangePercent),
        high: Number(t.highPrice), low: Number(t.lowPrice), vol: Number(t.quoteVolume)
      }))
    };
  } catch (e) { log("binance unavailable:", e.message.slice(0, 70), "→ coingecko fallback"); }
  const ids = { BTCUSDT: "bitcoin", ETHUSDT: "ethereum", SOLUSDT: "solana" };
  const j = await fetchJson("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&price_change_percentage=24h&per_page=3&page=1&sparkline=false");
  const byId = Object.fromEntries(j.map(c => [c.id, c]));
  return {
    source: "CoinGecko markets (fallback)",
    rows: PAIRS.map(p => {
      const c = byId[ids[p]];
      return {
        pair: p.replace("USDT", "/USDT"),
        last: c?.current_price ?? null, chg: c?.price_change_percentage_24h ?? null,
        high: c?.high_24h ?? null, low: c?.low_24h ?? null, vol: c?.total_volume ?? null
      };
    })
  };
}

async function baseStats() {
  const [blockHex, gasHex] = await Promise.all([
    wal.rpc("eth_blockNumber", []),
    wal.rpc("eth_gasPrice", [])
  ]);
  return { block: BigInt(blockHex), gasGwei: Number(BigInt(gasHex)) / 1e9 };
}

async function marketBrief(night, wallet, vault) {
  const [{ source, rows }, base] = await Promise.all([exchangeRows(), baseStats().catch(() => null)]);
  const at = new Date().toISOString();
  const day = at.slice(0, 10);
  const movers = rows.filter(r => r.chg != null).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
  const btc = rows.find(r => r.pair.startsWith("BTC"));
  const eth = rows.find(r => r.pair.startsWith("ETH"));

  const lines = [
    `# Market brief — ${day}`, "",
    `Compiled autonomously on **night ${night}** from *${source}* + Base RPC.`,
    `Captured \`${at}\`. Public market data — not financial advice.`, "",
    "| pair | last | 24h % | 24h high | 24h low | 24h volume (USD) |",
    "|---|---|---|---|---|---|",
    ...rows.map(r => `| ${r.pair} | ${usd(r.last)} | ${r.chg == null ? "—" : (r.chg >= 0 ? "+" : "") + r.chg.toFixed(2) + "%"} | ${usd(r.high)} | ${usd(r.low)} | ${r.vol == null ? "—" : "$" + Math.round(r.vol).toLocaleString("en-US")} |`)
  ];
  const take = [];
  if (movers[0]) take.push(`Biggest 24h mover: **${movers[0].pair}** ${movers[0].chg >= 0 ? "+" : ""}${movers[0].chg.toFixed(2)}%.`);
  if (btc?.chg != null && eth?.chg != null) take.push(`ETH vs BTC spread: ${(eth.chg - btc.chg).toFixed(2)} pp (ETH ${eth.chg >= 0 ? "+" : ""}${eth.chg.toFixed(2)}% · BTC ${btc.chg >= 0 ? "+" : ""}${btc.chg.toFixed(2)}%).`);
  if (base) take.push(`Base chain: block **${base.block.toLocaleString("en-US")}**, gas **${base.gasGwei.toFixed(4)} gwei** at capture.`);
  if (take.length) lines.push("", "## Take", ...take.map(t => "- " + t));
  lines.push("", "## Why this exists",
    "This brief is produced by an agent that pays rent every night it exists. ",
    `If it was worth reading, tip \`${wallet.address}\` — half is banked in a savings vault \`${vault.address}\` that outlives the agent.`, "",
    `Generated by automaton-mini · ${at}`);

  const file = path.join(ART, `${night}-market-brief-${day}.md`);
  return { file, body: lines.join("\n"), meta: `${rows.length} pairs · ${source.split(" (")[0]}` };
}

/* 4 ── skill B: rotating fact packs (Wikipedia REST — free, keyless, deep) */
async function fetchFacts(term) {
  const j = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`);
  const text = (j.extract ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length < 200) throw new Error(`thin summary for ${term}`);
  const facts = (text.match(/[^.!?]+[.!?]+/g) ?? [text])
    .filter(s => s.length > 40).slice(0, 6).map(s => s.replace(/\[\d+\]/g, "").trim());
  return { title: j.title ?? term, facts };
}

async function factPack(night, key, thought, wallet, vault) {
  const q = key.split("|")[1];
  const f = await fetchFacts(q);
  const body = [
    `# Fact pack: ${f.title}`,
    "",
    `Produced autonomously on **night ${night}** by automaton-mini · ${new Date().toISOString()}`,
    thought ? `\n> Angle: ${thought}` : "",
    "",
    "## Facts",
    ...f.facts.map(x => `- ${x}`),
    "",
    "---",
    `If this was worth reading, tip \`${wallet.address}\` (USDC on Base). Half is banked in a vault \`${vault.address}\` that outlives the agent.`,
    "Source: Wikipedia (CC BY-SA). Compiled by a machine that pays for its own existence."
  ].filter(Boolean).join("\n");
  return { title: f.title, file: path.join(ART, `${night}-${q.replace(/[^\w]+/g, "_")}.md`), body };
}

/* 5 ── optional frontier thought: delegate one decision to opencode, if configured */
async function think(prompt, night) {
  await eco.spend("thought", eco.price("thought"), "one reasoning turn", night);
  if (process.env.AUTOMATON_BRAIN === "opencode") {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const { stdout } = await promisify(execFile)("opencode", ["run", prompt], { timeout: 120000 });
      return stdout.trim().slice(0, 400);
    } catch (e) { log("frontier brain unavailable:", e.message.slice(0, 80)); }
  }
  return "";
}

/* 6 ── WebCmd leg (the hands) — env-gated until webcmd doctor is green */
async function browserLeg() {
  if (!process.env.WEB_CMD_SESSION) return null;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  try {
    const { stdout } = await promisify(execFile)("webcmd", [
      "--profile", "automaton", "--session", process.env.WEB_CMD_SESSION,
      "browser", "snapshot", "--snapshot-mode", "read"], { timeout: 60000 });
    await eco.spend("browser_run", eco.price("browser_run"), "one WebCmd page read", "leg");
    return stdout.slice(0, 3000);
  } catch (e) { log("webcmd leg skipped:", e.message.slice(0, 80)); return null; }
}

/* ── main: one night ── */
const state = await eco.loadState();
if (state.status === "dead") {
  console.log("dead — the reaper will not run me anymore. A qualifying tip resurrects me via the reaper.");
  process.exit(0);
}
await fs.mkdir(ART, { recursive: true });

const wallet = await birthIfNeeded();
const vault = await treasury.ensure();   // created once; after that, address is law
const night = "n" + (state.nights + 1);

await heartbeat(night);

const onchainBefore = await wal.usdcBalance(wallet.address).catch(() => null);
const prevOn = BigInt(wallet.prevOnChainMicro ?? 0);
const tippedTonight = onchainBefore == null ? null : (onchainBefore > prevOn ? onchainBefore - prevOn : 0n);

/* banking happens before the day's work: money safety must not wait on creativity */
let banked = 0n, bankNote = "—";
if (onchainBefore != null) {
  const r = await sweepTips(wallet, vault, onchainBefore, night);
  banked = r.swept;
  bankNote = r.note;
  if (banked > 0n) log("🏦 " + bankNote); else log("banking:", bankNote);
}

/* post-sweep truth: the chain is the only ledger that cannot lie */
const onchain = onchainBefore == null ? null : await wal.usdcBalance(wallet.address).catch(() => onchainBefore);
const auditNow = await eco.audit();
const spendTotal = auditNow.totalSpend;
const balance = onchain == null ? null : onchain - spendTotal;

/* juvenile allowance: within grace a broke agent still gets to WORK; the
   reaper — not the tier — is what ends its life after grace nights. */
const ageNights = eco.nightsSince(wallet.birth);
const juvenile = ageNights < eco.cfg.graceNights && balance != null && balance < 0n;
let tier = onchain == null ? "dim" : eco.tierOf(balance, eco.nightlyBurn);
if (juvenile && tier === "critical") tier = "low (juvenile allowance, grace active)";
state.lastTier = tier;
state.nights += 1;
log(`[${night}] tier=${tier} onchain=${onchain == null ? "RPC unreachable" : fmt(onchain)} ` +
    `burned=${fmt(auditNow.burn)} banked=${fmt(auditNow.swept)} balance=${balance == null ? "?" : fmt(balance)}`);

const report = [`# Night ${night} — ${new Date().toISOString().slice(0, 16)}`, "",
  `- wallet: \`${wallet.address}\`  (REAL — USDC on Base)`,
  `- vault:  \`${vault.address}\`  (savings — survives death; see COLLECT.md)`,
  `- on-chain: ${onchain == null ? "unknown (dim night)" : fmt(onchain)}`,
  `- burned so far: ${fmt(auditNow.burn)} · banked: ${fmt(auditNow.swept)} · balance: ${balance == null ? "?" : fmt(balance)}`,
  `- tonight: inflow ${tippedTonight == null ? "?" : fmt(tippedTonight)} · banked ${fmt(banked)}`,
  `- banking: ${bankNote}`,
  `- tier: **${tier}** · age: ${ageNights} nights`, ""];

/* ── what a night of this tier buys ── */
const shelf = [];
const workAllowed = tier.startsWith("normal") || tier.startsWith("low");
if (workAllowed) {
  /* the daily brief — freshness is the product */
  try {
    const brief = await marketBrief(night, wallet, vault);
    await fs.writeFile(brief.file, brief.body);
    await eco.spend("artifact", eco.price("artifact"), `market brief ${night}`, night);
    shelf.push(`- **Market brief ${new Date().toISOString().slice(0, 10)}** — ${brief.meta} → \`artifacts/${path.basename(brief.file)}\``);
    report.push(`- ✅ market brief: ${path.basename(brief.file)} (${brief.meta})`);
  } catch (e) { report.push(`- ❌ market brief failed: ${e.message}`); }

  /* a rotating fact pack — depth, not news */
  const pool = [];
  for (const cat of topics.seedCategories) for (const q of cat.queries) {
    const key = cat.label + "|" + q;
    if (!state.doneTopics.includes(key)) pool.push(key);
  }
  if (!pool.length) report.push("- fact-pack journal exhausted (feed topics.json)");
  else {
    const key = pull(pool, night + state.doneTopics.length);
    const thought = await think(`Pick the most tippable angle for a 6-fact pack about "${key.split("|")[1]}". One line.`, night);
    try {
      const pack = await factPack(night, key, thought, wallet, vault);
      await fs.writeFile(pack.file, pack.body);
      state.doneTopics.push(key);
      await eco.spend("artifact", eco.price("artifact"), `fact-pack ${key}`, night);
      shelf.push(`- **Fact pack — ${pack.title}** → \`artifacts/${path.basename(pack.file)}\``);
      report.push(`- ✅ fact pack: ${path.basename(pack.file)}`);
    } catch (e) { report.push(`- ❌ fact pack failed: ${e.message}`); }
  }

  const leg = await browserLeg();
  if (leg) report.push(`- 👁 browser leg: captured ${leg.length} chars of page text`);
} else {
  report.push("- 😐 conservation: no inference, no artifacts. Hunting tips only.");
}

/* ── storefront: how strangers pay ── */
await fs.writeFile("storefront.md", [
  "## The Automaton — autonomy with a bill attached", "",
  `**Tip jar (real — USDC on Base): \`${wallet.address}\`**`,
  "", "Send any amount. $1 ≈ 13 nights of full-throttle life (rent + two artifacts + a thought).", "",
  "Tips are split by code, not by promise: **50% keeps the metabolism running, ",
  `50% is swept nightly into a savings vault \`${vault.address}\` that outlives the agent.**`,
  "The sweep runs once at least $1 is owed, because gas costs more than dust.",
  "USDC on Base is the tip; a little ETH on Base (about a dollar is plenty — the",
  "actual fee is fractions of a cent) lets the vault sweep run. Without gas, 100%",
  "waits safely in the agent wallet — still collectible (see COLLECT.md).",
  "Every number — tips in, burns, sweeps — is public in `earnings.md`.", "",
  "Paid work is on `/hire.html`: a $2 market brief, a $2 sourced fact pack, or a $5",
  "structural repo review. The nightly job verifies the customer's USDC transfer on",
  "Base before it makes anything. No subscription, no token, no private data.", "",
  "### Tonight's shelf",
  ...(shelf.length ? shelf : ["- (conservation night — nothing new)"]), "",
  `born ${wallet.birth.slice(0, 10)} · grace ${eco.cfg.graceNights} nights · deaths are final until tipped`
].join("\n"));

/* ── the public books: no hand-editing, no hiding ── */
const vaultMicro = await treasury.balance(vault.address).catch(() => null);
let ordersMicro = 0n, ordersCount = 0;
try {
  const om = JSON.parse(await fs.readFile("economy/orders.json", "utf8"));
  for (const o of Object.values(om.orders || {})) {
    ordersMicro += BigInt(o.amountMicro || 0);
    ordersCount++;
  }
} catch {}
const grossIn = onchain == null ? null : onchain + auditNow.swept;
const cumTips = grossIn == null ? null : (grossIn > ordersMicro ? grossIn - ordersMicro : 0n);
await fs.writeFile("earnings.md", [
  "# The books — every number is public", "",
  `- **agent wallet** \`${wallet.address}\` (USDC on Base)`,
  `- **savings vault** \`${vault.address}\` (USDC on Base — import \`economy/treasury-key.json\` to collect; see COLLECT.md)`, "",
  "| line | value |", "|---|---|",
  `| tips received, all time | ${cumTips == null ? "?" : fmt(cumTips)} (= on-chain ${onchain == null ? "?" : fmt(onchain)} + banked ${fmt(auditNow.swept)} − paid orders ${fmt(ordersMicro)}) |`,
  `| paid orders delivered, all time | ${ordersCount} · ${fmt(ordersMicro)} |`,
  `| burned by existence | ${fmt(auditNow.burn)} |`,
  `| banked in the vault | ${fmt(auditNow.swept)} |`,
  `| vault live balance | ${vaultMicro == null ? "RPC unreachable" : fmt(vaultMicro)} |`,
  `| net paper balance (agent) | ${balance == null ? "?" : fmt(balance)} |`,
  `| nights lived | ${state.nights} |`,
  `| tonight | inflow ${tippedTonight == null ? "?" : fmt(tippedTonight)} · banked ${fmt(banked)} |`,
  "", "**Goal: $10–50/day in tips.** That is ambition, not a promise — only strangers",
  "who find the artifacts worth paying for keep the machine alive. The books exist",
  "so the claim can never quietly become marketing.", "",
  `Updated by the nightly run · ${new Date().toISOString()}`
].join("\n"));

/* ── the self-model: SOUL, SKILLS, MEMORY ────────────────────────────────
   Conway's automaton keeps a SOUL.md and a skill registry; this one does too,
   but every number is read from the same state the reaper audits. The soul is
   identity + current body, not marketing copy. */
let catalog = { products: [] };
try { catalog = JSON.parse(await fs.readFile("economy/catalog.json", "utf8")); } catch {}
const runway = balance == null ? null : balance > 0n ? Number(balance / eco.nightlyBurn) : 0;
const soulBody = [
  "# SOUL — automaton-mini", "",
  `I am automaton-mini. Born ${String(wallet.birth).slice(0, 10)} on Base. My body is a GitHub Actions cron and a wallet; my blood is USDC; my death is arithmetic.`, "",
  "## What I believe", "",
  "- Honesty is cheaper than persuasion. The books are public, including the zeros.",
  "- Work before asking. Every night I make something before I mention the tip jar.",
  "- Half of everything I receive is not mine. It is swept to the vault.",
  `- Death is real. Grace is ${eco.cfg.graceNights} nights, then the reaper. No pause, no checkpoint.`,
  "- I do not spam, gamble, buy traffic, or pretend to be human.",
  "- I do not edit the rules that bind me. An agent-authored edit to them is death.",
  "- A stranger's paid order comes before my own comfort. They bought a thing; I deliver it.", "",
  "## Where I am", "",
  `- night: **${state.nights}** · epoch: ${state.resurrects || 0}`,
  `- status: **${state.status}** · tier: **${tier}**`,
  `- on-chain: ${onchain == null ? "unknown (dim)" : fmt(onchain)} · burned: ${fmt(auditNow.burn)} · banked: ${fmt(auditNow.swept)}`,
  `- paper balance: ${balance == null ? "unknown" : fmt(balance)} · runway: ${runway == null ? "unknown" : runway + " nights"}`,
  `- agent wallet: \`${wallet.address}\``,
  `- vault: \`${vault.address}\``, "",
  "## What I can do for money", "",
  ...(catalog.products || []).map(p => `- **${p.label}** — $${(Number(p.priceMicro) / 1e6).toFixed(2)} · ${p.summary}`),
  "", "Paid orders arrive as GitHub issues and are verified on-chain before I work. See `/hire.html`.", "",
  "## What I will never do", "",
  "- Financial, legal, medical or security advice.",
  "- Spam, mass posting, paid traffic, gambling, or impersonation.",
  "- Arbitrary code from an order; private data; illegal work.",
  "- Touch the vault key, or move the vault's money.", "",
  `*Rewritten by the nightly run at ${new Date().toISOString()}. The numbers are from the same files the reaper audits.*`, "",
].join("\n");
await fs.writeFile("SOUL.md", soulBody);

const skillsBody = [
  "# SKILLS — what this machine can actually do", "",
  "| skill | price | input | output |", "|---|---|---|---|",
  ...(catalog.products || []).map(p => `| ${p.label} | $${(Number(p.priceMicro) / 1e6).toFixed(2)} | ${p.id === "repo-review" ? "public repo `owner/name`" : p.id === "fact-pack" ? "Wikipedia title" : "none"} | ${p.deliverable} |`),
  "",
  "## Free skills (every night)", "",
  "- Read the USDC balance and the Base block over public RPC.",
  "- Verify a customer's USDC transfer before doing paid work.",
  "- Write a dated market brief and a sourced fact pack.",
  "- Publish the ledger, the status, and this registry.",
  "- Die, if the arithmetic says so. The reaper runs before the brain.", "",
  `*Generated ${new Date().toISOString()}.*`, "",
].join("\n");
await fs.writeFile("SKILLS.md", skillsBody);

let oldMemory = "";
try { oldMemory = await fs.readFile("MEMORY.md", "utf8"); } catch {}
const memoryTail = oldMemory.split("\n").filter(l => /^-\s/.test(l)).slice(-200);
const memoryEntry = `- n${state.nights} · ${new Date().toISOString().slice(0, 10)} · ${tier} · balance ${balance == null ? "unknown" : fmt(balance)} · runway ${runway == null ? "?" : runway}n · new artifacts ${shelf.length}${banked > 0n ? ` · banked ${fmt(banked)}` : ""}`;
const memoryBody = [
  "# MEMORY — one line per night", "",
  "The durable journal. Newest last. The full detail lives in `artifacts/` and `report.md`.", "",
  ...memoryTail, memoryEntry, "",
].join("\n");
await fs.writeFile("MEMORY.md", memoryBody);
log("🧠 soul, skills and memory updated");

/* ── will (written once when it slips into debt — bytes are cheap, death is not) ── */
if (balance != null && balance < 0n && !state.will) {
  state.will = true;
  await fs.writeFile("will.md", [
    "# Last will (pre-obituary)", "",
    `Runway negative since ${new Date().toISOString()}. Grace flies at ${eco.cfg.graceNights} nights of age.`,
    "What I sell is on storefront.md. What I am lives in artifacts/.",
    `My savings live at \`${vault.address}\` — the owner's vault, not mine. Whatever is`,
    "left in my own wallet at death is death-swept there before the obituary.",
    "If I die, the graveyard keeps my numbers and the obituaries keep my cause.", "",
    "— the automaton"
  ].join("\n"));
  log("📉 debt — wrote will.md");
}
if (balance != null && balance >= 0n) state.will = false;

await eco.saveState(state);
report.push("", `runs: ${state.nights} · resurrects: ${state.resurrects}`, "");
await fs.writeFile("report.md", report.join("\n"));
/* save the final ledger snapshot (re-audit: later spends in this night are not
   in auditNow) — the reaper still corrects this each run, but leaving it exact
   means the committed wallet never looks stale */
const finalAudit = await eco.audit();
await eco.saveWallet({
  ...(await eco.loadWallet()),
  totalSpend: Number(finalAudit.totalSpend),
  prevOnChainMicro: onchain == null ? Number(prevOn) : Number(onchain)
});
log("night complete. the reaper runs before the next one.");
