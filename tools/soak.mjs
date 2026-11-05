#!/usr/bin/env node
/**
 * soak.mjs — run the REAL brain/reaper through a compressed life against a
 * verifying mock of Base (tools/mock-rpc.mjs), for ~N minutes of wall clock.
 *
 * The mock chain re-derives every transaction's digest and RECOVERS its signer;
 * only correctly signed transfers move balances, and every movement is recorded.
 * So the soak tests the real signing, banking, death, estate and resurrection
 * paths without spending real money.
 *
 * Timeline (virtual day = cycle):
 *   1–3    broke birth, juvenile allowance work
 *   4      first tip $2.00  → banks $1.00 (50%, real minSweep = $1)
 *   5…     life: burn outpaces the un-banked half
 *   D      starvation death → estate sweep of the remaining $1.00
 *   D+1    dead rest (no brain)
 *   D+2    revival tip $5.00 → resurrection + banking $1.50
 *   D+3    second-epoch work night
 *
 * D is discovered at runtime, not hardcoded: burn per night depends on whether
 * live data fetches succeed (an artifact failure costs less), so the harness
 * schedules the revival exactly two cycles after it OBSERVES a death.
 *
 * Usage: node tools/soak.mjs --minutes 90 [--cycles 36] [--cycle-ms N]
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startMockChain } from "./mock-rpc.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TMP = process.env.OPENCODE_TMP ?? path.join(os.tmpdir(), "opencode");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MINUTES = Number(arg("--minutes", "90"));
const CYCLES = Number(arg("--cycles", "36"));
const CYCLE_MS = Number(arg("--cycle-ms", "0")) || Math.max(2000, Math.round((MINUTES * 60_000) / CYCLES));

const FIRST_TIP = { usdc: 2_000_000n, eth: 500_000_000_000_000n, label: "first tip $2.00" };
const REVIVAL_TIP = { usdc: 5_000_000n, eth: 500_000_000_000_000n, label: "revival tip $5.00" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (p) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; } };

/* ── sandbox: a fresh agent, real code, no real keys ── */
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const SANDBOX = path.join(TMP, `automaton-soak-${stamp}`);
await fs.mkdir(path.join(SANDBOX, "economy"), { recursive: true });
await fs.mkdir(path.join(SANDBOX, "artifacts"), { recursive: true });
for (const f of ["brain.mjs", "reaper.mjs", "topics.json", "package.json"])
  await fs.copyFile(path.join(ROOT, f), path.join(SANDBOX, f));
for (const f of ["config.json", "prices.json"])
  await fs.copyFile(path.join(ROOT, "economy", f), path.join(SANDBOX, "economy", f));
const libDst = path.join(SANDBOX, "lib");
await fs.mkdir(libDst);
for (const f of await fs.readdir(path.join(ROOT, "lib")))
  if (f.endsWith(".mjs")) await fs.copyFile(path.join(ROOT, "lib", f), path.join(libDst, f));

/* fingerprint exactly the files that will run — evidence, not a promise */
const fp = crypto.createHash("sha256");
for (const f of ["brain.mjs", "reaper.mjs"]) fp.update(f).update(await fs.readFile(path.join(SANDBOX, f)));
for (const f of (await fs.readdir(libDst)).sort()) fp.update(f).update(await fs.readFile(path.join(libDst, f)));
const CODE_FP = fp.digest("hex").slice(0, 16);

console.log(`[soak] sandbox ${SANDBOX}`);
console.log(`[soak] code ${CODE_FP}`);
console.log(`[soak] ${CYCLES} cycles × ${Math.round(CYCLE_MS / 1000)}s ≈ ${(CYCLES * CYCLE_MS / 60000).toFixed(0)} min`);

const chain = await startMockChain();
const CHILD_ENV = {
  BASE_RPC: chain.url,
  AUTOMATON_AGENT_KEY: "",     // never inherit real secrets
  WEB_CMD_SESSION: "",
  AUTOMATON_BRAIN: "",
  AUTOMATON_GRACE_OVERRIDE: "",
  CI: "",
};

function runNode(file, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { cwd: SANDBOX, env: { ...process.env, ...CHILD_ENV }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const killer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err }); });
  });
}

async function ageWallet(day) {
  const wp = path.join(SANDBOX, "economy", "wallet.json");
  const w = await readJson(wp);
  if (!w) return; // pre-birth
  w.birth = new Date(Date.now() - day * 86_400_000).toISOString();
  await fs.writeFile(wp, JSON.stringify(w, null, 2));
}

async function books() {
  const raw = await fs.readFile(path.join(SANDBOX, "economy", "ledger.jsonl"), "utf8").catch(() => "");
  let burn = 0n, swept = 0n, sweeps = 0;
  for (const line of raw.split("\n").filter(Boolean)) {
    const j = JSON.parse(line);
    if (j.kind === "sweep") { swept += BigInt(-j.micro); sweeps++; }
    else burn += BigInt(j.micro);
  }
  return { burn, swept, sweeps };
}

/* ── the compressed life ── */
const started = Date.now();
const rows = [];
let agentAddr = null, vaultAddr = null;
let deathCycle = null, revivalCycle = null;

for (let c = 1; c <= CYCLES; c++) {
  const cycleStart = Date.now();
  // first tip is fixed; the revival is scheduled only after a death is OBSERVED
  const tip = c === 4 ? FIRST_TIP : c === revivalCycle ? REVIVAL_TIP : null;
  if (tip && agentAddr) {
    chain.tip(agentAddr, tip.usdc);
    chain.giveEth(agentAddr, tip.eth);
  }
  await ageWallet(c);

  const reaper = await runNode("reaper.mjs");
  if (deathCycle == null && reaper.code === 3) { deathCycle = c; revivalCycle = c + 2; }
  let state = await readJson(path.join(SANDBOX, "economy", "state.json"));
  let brain = null;
  if (reaper.code !== 3 && state?.status !== "dead") brain = await runNode("brain.mjs");

  const wallet = await readJson(path.join(SANDBOX, "economy", "wallet.json"));
  const treasury = await readJson(path.join(SANDBOX, "economy", "treasury.json"));
  if (wallet?.address) agentAddr = wallet.address;
  if (treasury?.address) vaultAddr = treasury.address;

  const b = await books();
  const onchain = agentAddr ? chain.usdcOf(agentAddr) : 0n;
  const vault = vaultAddr ? chain.usdcOf(vaultAddr) : 0n;
  const net = b.burn - b.swept;
  rows.push({
    cycle: c, day: c, reaperExit: reaper.code, brainRan: !!brain, brainExit: brain?.code ?? null,
    agent: agentAddr, vault: vaultAddr,
    onchain: onchain.toString(), vaultBalance: vault.toString(), tips: (onchain + vault).toString(),
    burn: b.burn.toString(), swept: b.swept.toString(), net: net.toString(),
    balance: (onchain - net).toString(), sweepCount: b.sweeps, note: tip?.label ?? "",
  });

  console.log(`[soak ${String(c).padStart(2)}/${CYCLES}] day ${String(c).padStart(2)} · reaper=${reaper.code} brain=${brain ? brain.code : "—"} · ` +
    `agent $${(Number(onchain) / 1e6).toFixed(2)} vault $${(Number(vault) / 1e6).toFixed(2)} burn $${(Number(b.burn) / 1e6).toFixed(3)}` +
    `${tip ? " · " + tip.label : ""}`);
  if (brain && brain.code !== 0) console.log("   brain stderr:", brain.err.split("\n").slice(-4).join(" | ").slice(0, 400));
  if (reaper.code !== 0 && reaper.code !== 3) console.log("   reaper stderr:", reaper.err.split("\n").slice(-4).join(" | ").slice(0, 400));

  if (c < CYCLES) await sleep(Math.max(0, CYCLE_MS - (Date.now() - cycleStart)));
}

const elapsedMin = ((Date.now() - started) / 60000).toFixed(1);

/* ── assertions ── */
const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail });
const rowAt = (n) => rows.find((r) => r.cycle === n);

const deathRow = rows.find((r) => r.reaperExit === 3);
const postDeathRow = deathRow ? rowAt(deathRow.cycle + 1) : null;
const finalState = await readJson(path.join(SANDBOX, "economy", "state.json"));
const finalWallet = await readJson(path.join(SANDBOX, "economy", "wallet.json"));
const finalBooks = await books();
const obits = await fs.readdir(path.join(SANDBOX, "obituaries")).catch(() => []);
const obitText = obits.length ? await fs.readFile(path.join(SANDBOX, "obituaries", obits[0]), "utf8") : "";

check("birth happened, address stable", !!rows[0].agent && rows.every((r) => !r.agent || r.agent === rows[0].agent), rows[0].agent ?? "no wallet");
check("no banking before the first tip", rowAt(3)?.sweepCount === 0, `sweeps after cycle 3: ${rowAt(3)?.sweepCount}`);
check("first sweep = exactly 50% of $2.00 (minSweep met)", rowAt(4)?.swept === "1000000", `swept: ${rowAt(4)?.swept}`);
check("conservation: tips = on-chain + banked, every cycle",
  rows.every((r) => BigInt(r.tips) === BigInt(r.onchain) + BigInt(r.swept)),
  `checked ${rows.length} rows`);
check("starvation death happened", !!deathRow, deathRow ? `cycle ${deathRow.cycle}, age ${deathRow.day}n` : "never died");
check("estate sweep emptied the agent wallet at death",
  deathRow ? deathRow.onchain === "0" && deathRow.vaultBalance === "2000000" : false,
  deathRow ? `agent $${Number(deathRow.onchain) / 1e6} · vault $${Number(deathRow.vaultBalance) / 1e6}` : "—");
check("obituary records the estate", obitText.includes("Estate:") && obitText.includes("Savings vault"), obits[0] ?? "no obituary");
check("dead nights do not run the brain", postDeathRow ? postDeathRow.brainRan === false : false, postDeathRow ? `cycle ${postDeathRow.cycle} brainRan=${postDeathRow.brainRan}` : "—");
check("resurrection happened (epoch 2)", (finalState?.resurrects ?? 0) >= 1 && finalState?.status === "alive", `resurrects=${finalState?.resurrects} status=${finalState?.status}`);
check("banking after revival = 50% of all $7.00 tipped", finalBooks.swept === 3_500_000n, `swept $${Number(finalBooks.swept) / 1e6}`);
check("ledger snapshot matches audit (burn − banked)", Number(finalWallet?.totalSpend ?? -1) === Number(finalBooks.burn - finalBooks.swept), `wallet ${finalWallet?.totalSpend} vs ${finalBooks.burn - finalBooks.swept}`);
check("mock chain: every verified transfer went agent → vault",
  chain.transfers.length > 0 && chain.transfers.every((t) => t.to.toLowerCase() === (vaultAddr ?? "").toLowerCase() && t.from.toLowerCase() === (agentAddr ?? "").toLowerCase()),
  `${chain.transfers.length} transfers verified by signer recovery`);
const plannedMin = (CYCLES * CYCLE_MS) / 60_000;
check("soak ran for the planned window", Number(elapsedMin) >= Math.max(0.05, plannedMin * 0.8), `${elapsedMin} min of ${plannedMin.toFixed(1)} planned`);

/* ── write the report into the real repo ── */
const OUT = path.join(ROOT, "soak");
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, "cycles.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
await fs.copyFile(path.join(SANDBOX, "economy", "ledger.jsonl"), path.join(OUT, "ledger.jsonl")).catch(() => {});
for (const f of ["earnings.md", "report.md", "storefront.md"])
  await fs.copyFile(path.join(SANDBOX, f), path.join(OUT, `final-${f}`)).catch(() => {});
if (obits[0]) await fs.copyFile(path.join(SANDBOX, "obituaries", obits[0]), path.join(OUT, `obituary-${obits[0]}`)).catch(() => {});

const pass = checks.filter((c) => c.ok).length;
const report = [
  "# Soak test — compressed life of the real agent", "",
  `- **Duration:** ${elapsedMin} min wall clock · ${CYCLES} simulated days`,
  `- **Code:** \`${CODE_FP}\` (sha256 of brain.mjs + reaper.mjs + lib/*.mjs, truncated)`,
  `- **Chain:** local mock of Base that re-derives every tx digest and recovers its signer`,
  `- **Result:** ${pass}/${checks.length} checks passed`,
  `- **Life events:** death at cycle ${deathCycle ?? "—"} · revival at cycle ${revivalCycle ?? "—"}`,
  `- **Sandbox:** \`${SANDBOX}\``, "",
  "## Checks", "",
  "| # | check | result | detail |", "|---|---|---|---|",
  ...checks.map((c, i) => `| ${i + 1} | ${c.name} | ${c.ok ? "✅ PASS" : "❌ FAIL"} | ${c.detail} |`), "",
  "## Timeline", "",
  "| day | reaper | brain | agent | vault | tips | burn | banked | balance | event |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.day} | ${r.reaperExit} | ${r.brainRan ? r.brainExit : "—"} | $${(Number(r.onchain) / 1e6).toFixed(2)} | $${(Number(r.vaultBalance) / 1e6).toFixed(2)} | $${(Number(r.tips) / 1e6).toFixed(2)} | $${(Number(r.burn) / 1e6).toFixed(3)} | $${(Number(r.swept) / 1e6).toFixed(2)} | $${(Number(r.balance) / 1e6).toFixed(3)} | ${r.note} |`), "",
  "> The mock verifies signatures — only transactions that recover to the agent's",
  "> own address can move funds, and the recipient is enforced to be the vault.",
  "> Prices/grace/minSweep are the real shipped config.",
].join("\n");
await fs.writeFile(path.join(OUT, "REPORT.md"), report);

console.log(`\n[soak] done in ${elapsedMin} min — ${pass}/${checks.length} checks passed`);
for (const c of checks) console.log(`  ${c.ok ? "✅" : "❌"} ${c.name}${c.detail ? " — " + c.detail : ""}`);
console.log(`[soak] report: ${path.join(OUT, "REPORT.md")}`);
await chain.close();
process.exitCode = pass === checks.length ? 0 : 1;
