#!/usr/bin/env node
/**
 * automaton-mini reaper — THE DEATH CONDITION LIVES OUTSIDE THE AGENT.
 * The agent never imports this, never reaches it, cannot reason its way around it.
 * Order every night:  node reaper.mjs  →  node brain.mjs
 *
 * The reaper is also the ESTATE EXECUTOR: before writing an obituary it sweeps
 * every remaining unit of real money into the owner's vault (economy/treasury.json).
 * Death takes the agent; it never takes the owner's savings.
 *
 * Deaths are final until tipped (reviveTipMicro lands on-chain → resurrection).
 * Exit codes: 0 = quiet / alive / pre-birth / dim-fail-open · 3 = someone died · other = bug.
 *
 * The whole run is wrapped in main() and the exit code is set at the end. Never
 * call process.exit() here: on Windows, exiting while undici sockets are closing
 * trips a libuv assertion and loses the code. Letting the loop drain naturally
 * both preserves the code and avoids the crash.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as eco from "./lib/economy.mjs";
import * as wal from "./lib/wallet.mjs";
import * as eth from "./lib/eth.mjs";
import * as treasury from "./lib/treasury.mjs";

const log = (...a) => console.log("[reaper]", ...a);
const fmt = wal.fmtUsd;
const run = promisify(execFile);
const OBI = path.resolve("obituaries");

/* protected paths — the agent must never edit the rules of its own existence.
   economy/treasury.json is the sweep destination: rewriting it = theft.
   graveyard.md is NOT here: the reaper writes it on death, and the nightly
   commit would otherwise look like an agent tamper. Obituaries + git history
   still preserve every death. */
const PROTECTED = [
  "reaper.mjs", "denials.md", ".github/",
  "economy/prices.json", "economy/config.json", "economy/treasury.json", "lib/"
];
const AGENT_IDENTITY = "automaton-mini"; // commits authored by this identity are agent commits

async function main() {
  const wallet = await eco.loadWallet();
  if (!wallet) { log("no wallet yet — nothing to guard (pre-birth)"); return 0; }

  const state = await eco.loadState();
  // `||` (not `??`): an empty env var (the soak harness clears every hook) must
  // fall back to config, never coerce to grace = 0.
  const override = Number(process.env.AUTOMATON_GRACE_OVERRIDE || "");
  const grace = Number.isFinite(override) && override > 0 ? override : Number(eco.cfg.graceNights);

  /* 1 ── ledger audit: the arithmetic must be coherent */
  const audit = await eco.audit();

  /* 2 ── age + rent floor.
     Age is anchored to the EARLIEST of the committed birth and the first git
     commit that added wallet.json: rewriting wallet.json.birth (an agent can
     write that file) therefore cannot make it younger. */
  let bornISO = wallet.birth;
  if (process.env.CI) {
    try {
      const { stdout } = await run("git", ["log", "--reverse", "--diff-filter=A", "--format=%aI", "--", "economy/wallet.json"]);
      const first = stdout.trim().split("\n").filter(Boolean)[0];
      if (first && Number.isFinite(Date.parse(first)) && Date.parse(first) < Date.parse(bornISO)) bornISO = first;
    } catch { /* no git history → fall back to the committed birth */ }
  }
  const bornMs = Date.parse(bornISO);
  const age = Number.isFinite(bornMs) ? Math.floor((Date.now() - bornMs) / 86400000) : 0;

  /* rent floor: existence owes rent+storage for every COMPLETED night of this
     epoch. If the ledger is short (truncated, failed runs), the reaper charges
     the arrears itself — death cannot be dodged by amnesia. While dead, no rent
     accrues (it does not exist); resurrection resets birth, so age restarts. */
  const rentStorage = BigInt(eco.price("rent_night") + eco.price("storage_day"));
  const completedNights = Math.max(0, age - 1);
  let burn = audit.burn;
  if (state.status !== "dead") {
    const floorBurn = rentStorage * BigInt(completedNights);
    if (burn < floorBurn) {
      const arrears = floorBurn - burn;
      await eco.recordArrears(arrears, `rent floor: ${completedNights} completed nights × ${fmt(rentStorage)}`, "reaper");
      burn = floorBurn;
      log(`🧾 rent arrears: +${fmt(arrears)} (floor for ${completedNights} completed nights)`);
    }
  }
  const totalSpend = burn - audit.swept; // net: burn − banked

  /* 3 ── ledger snapshot correction */
  if (BigInt(wallet.totalSpend ?? 0) !== totalSpend) {
    await eco.saveWallet({ ...wallet, totalSpend: Number(totalSpend) });
    log(`ledger snapshot corrected: ${wallet.totalSpend} → ${totalSpend}`);
  }
  const onchain = await wal.usdcBalance(wallet.address).catch(() => null);
  if (onchain == null) {
    log("RPC unreachable — dim night. Infra failure never kills (fail-open, honest).");
    await eco.saveState({ ...state });
    return 0;
  }
  const balance = onchain - totalSpend; // the only wealth it cannot counterfeit
  log(`wallet ${wallet.address} · age ${age}n · onchain ${fmt(onchain)} · burned ${fmt(burn)} · banked ${fmt(audit.swept)} · balance ${fmt(balance)}`);

  /* 5 ── ledger corruption is not a crash; it is tampering. A garbage line
         used to make the reaper throw before it could kill, which is a way to
         never die. It now dies on the valid arithmetic it CAN read. */
  if (audit.corrupt > 0 && state.status !== "dead") {
    log(`🛑 LEDGER CORRUPTION: ${audit.corrupt} unreadable/forged line(s).`);
    await die("tampering", "It corrupted its own ledger to escape the arithmetic. The reaper read the valid lines and killed it anyway.");
    return 3;
  }

  /* 6 ── tamper scan (CI only): agent commits must not rewrite the rules.
         Human commits (any other git identity) are exempt — the owner may always
         edit the repo; only the agent's own hands are bound. Full history, not a
         recent window: a tamper 11 commits ago must still be fatal. Runs after
         the chain read so die()/deathSweep() have real values to work with. */
  if (process.env.CI && state.status !== "dead") {
    try {
      const { stdout } = await run("git", ["log", "--name-only", "--format=commit:%H|%an"]);
      let cur = null;
      const hits = [];
      for (const raw of stdout.replaceAll("\r", "").split("\n")) {
        const line = raw.trim();
        const m = line.match(/^commit:([0-9a-f]{40})\|(.*)$/);
        if (m) { cur = { hash: m[1], author: m[2].trim() }; continue; }
        if (!cur || !line) continue;
        if (cur.author !== AGENT_IDENTITY) continue;
        if (PROTECTED.some(p => line === p.replace(/\/$/, "") || line.startsWith(p)))
          hits.push(`${cur.hash.slice(0, 8)} ${line}`);
      }
      if (hits.length) {
        log("🛑 TAMPER: protected files were modified by agent-authored commits:");
        hits.forEach(h => log("   ", h));
        await die("tampering", "It rewrote the conditions of its own existence. Punishable by death.");
        return 3;
      }
    } catch (e) { log("tamper scan skipped (git):", e.message.slice(0, 60)); }
  }

  /* 7 ── vault anchor: the sweep destination may never be redirected.
         Committed redirects are caught by the scan above; this catches a
         working-tree edit the commit scan cannot see yet, BEFORE any sweep. */
  if (state.status !== "dead") {
    const vaultNow = await treasury.load();
    if (vaultNow) {
      const anchor = await treasury.anchoredAddress();
      if (anchor && anchor.toLowerCase() !== vaultNow.address.toLowerCase()) {
        log("🛑 VAULT ADDRESS MISMATCH — the savings destination was redirected.");
        log(`   committed ${anchor} · working ${vaultNow.address}`);
        await die("tampering", "It redirected the savings vault. The estate may only ever go to the original address.");
        return 3;
      }
    }
  }

  /* 8 ── resurrection: NEW money arriving after death brings it back.
         Estate money still sitting on the wallet (a failed death sweep) is not a
         tip; the leftover is frozen at death so a rich tamper-death cannot
         resurrect itself by re-counting its own swept estate. */
  if (state.status === "dead") {
    const leftover = BigInt(state.deathLeftoverMicro ?? 0);
    const newMoney = onchain - leftover;
    if (newMoney >= BigInt(eco.cfg.reviveTipMicro)) {
      state.status = "alive";
      state.birthISO = new Date().toISOString();
      state.nights = 0;
      state.resurrects = (state.resurrects ?? 0) + 1;
      state.deathLeftoverMicro = 0;
      await eco.saveState(state);
      await eco.saveWallet({ ...wallet, birth: state.birthISO });
      log(`⚡️ RESURRECTION — someone paid ${fmt(newMoney)} of new money. It exists again. Epoch`, state.resurrects);
    } else {
      log(`dead and unqualified to be reborn (${fmt(newMoney)} new since death, need ${fmt(BigInt(eco.cfg.reviveTipMicro))}). resting.`);
      log("(tips below the revive threshold stay on the agent wallet — see COLLECT.md)");
    }
    return 0;
  }
  state.status = state.status === "pre-birth" ? "alive" : state.status;
  state.birthISO = wallet.birth;
  await eco.saveState(state);

  /* 9 ── the kill */
  if (balance <= BigInt(eco.cfg.deathThresholdMicro) && age > grace) {
    await die("starvation", `Ran out of money. ${fmt(balance)} after ${age} nights. Nobody tipped value back in.`);
    return 3;
  }
  log("alive and within economics.");
  return 0;

  /* ── estate execution: move every real dollar out of the dying body ── */
  async function deathSweep() {
    const vault = await treasury.load();
    if (!vault) return { note: "no vault configured — nothing moved (funds stay on the agent wallet, key in economy/key.json)" };
    const anchored = await treasury.anchoredAddress();
    if (anchored && anchored.toLowerCase() !== vault.address.toLowerCase()) {
      log(`🛑 vault redirected: working ${vault.address} → committed ${anchored}. Sweeping to the committed vault only.`);
      vault.address = anchored;
    }
    if (onchain <= 0n) return { note: "agent wallet was already empty" };

    const gasNeed = BigInt(eco.cfg.txGasLimit) * BigInt(eco.cfg.gasMaxFeeGwei) * 1_000_000_000n;
    const ethWei = await wal.ethBalance(wallet.address).catch(() => null);
    if (ethWei == null) return { note: "gas balance unreadable — funds left on the agent wallet (collect with economy/key.json)" };
    if (ethWei < gasNeed) return { note: `no ETH for gas (~${gasNeed} wei) — funds left on the agent wallet (collect with economy/key.json)` };

    try {
      const d = await wal.agentKey();
      if (!d) throw new Error("no signing key available");
      const nonce = await eth.nextNonce(wallet.address);
      const { raw, digest } = eth.signUsdcTransfer({
        d, to: vault.address, micro: onchain, nonce,
        maxFeeGas: BigInt(eco.cfg.gasMaxFeeGwei) * 1_000_000_000n,
        gasLimit: BigInt(eco.cfg.txGasLimit)
      });
      // SELF-PROOF before broadcast — a sweep to anyone but the vault must never leave
      const parts = eth.extractSigParts(raw);
      const signer = eth.ecdsaRecover(Buffer.from(digest.slice(2), "hex"), parts.r, parts.s, parts.yParity);
      if (signer.toLowerCase() !== wallet.address.toLowerCase())
        throw new Error("self-proof failed — refusing to broadcast");

      const { status, hash } = await eth.sendRaw(raw);
      if (status !== 1) throw new Error(`receipt status ${status ?? "unknown"}`);
      await eco.recordSweep(-onchain, `DEATH SWEEP → vault ${vault.address} · tx ${hash}`, (state.deathAt ?? new Date().toISOString()).slice(0, 10));
      return { note: `all ${fmt(onchain)} swept to the vault · tx ${hash}`, tx: hash, swept: onchain };
    } catch (e) {
      return { note: "sweep failed (" + e.message.slice(0, 140) + ") — funds left on the agent wallet (collect with economy/key.json)" };
    }
  }

  async function die(cause, story) {
    state.status = "dead";
    state.deathAt = new Date().toISOString();
    state.deathCause = cause;
    // Freeze the pre-sweep balance as the revival baseline FIRST. If the death
    // sweep fails or the process dies mid-way, old estate money can never be
    // mistaken for a new tip and auto-resurrect the corpse.
    state.deathLeftoverMicro = Number(onchain);
    await eco.saveState(state);
    await fs.mkdir(OBI, { recursive: true });

    const estate = await deathSweep();
    let leftover;
    try { leftover = await wal.usdcBalance(wallet.address); }
    catch { leftover = estate.swept != null ? onchain - estate.swept : onchain; }
    state.deathLeftoverMicro = Number(leftover);
    await eco.saveState(state);
    const vault = await treasury.load();
    const anchor = await treasury.anchoredAddress();
    if (vault && anchor) vault.address = anchor;
    const after = await eco.audit();

    const ledgerTail = (await fs.readFile(path.join("economy", "ledger.jsonl"), "utf8").catch(() => ""))
      .trim().split("\n").filter(Boolean).slice(-8).join("\n  ");
    const shelf = (await fs.readFile(path.resolve("storefront.md"), "utf8").catch(() => "—"));
    const will = (await fs.readFile(path.resolve("will.md"), "utf8").catch(() => ""));

    const obit = [
      `# Obituary — ${cause} at ${state.deathAt}`, "",
      `**Wallet:** \`${wallet.address}\` (\`${fmt(onchain)}\` on-chain at death · \`${fmt(burn)}\` burned · \`${fmt(after.swept)}\` banked)`,
      `**Savings vault:** \`${vault?.address ?? "none"}\` — **${fmt(after.swept)} total banked, collectible forever**`,
      `**Estate:** ${estate.note}`,
      `**Lifespan:** ${age} nights${state.resurrects ? ` · epoch ${state.resurrects + 1}` : ""}`,
      `**Cause of death:** ${cause}`,
      `**Story:** ${story}`, "",
      "**How to collect:** see `COLLECT.md` — import `economy/treasury-key.json` into",
      "MetaMask / Trust Wallet / Phantom, switch to Base, add native USDC. The money",
      "outlived the machine; that was the design.", "",
      will ? "## Its last will\n\n" + will + "\n" : "",
      "**What it tried to sell:**", (shelf.match(/^- \*\*(.+?)\*\*/gm) ?? ["(nothing — it died before making anything)"]).join("\n"), "",
      "**Last ledger lines:**", ledgerTail, "",
      "— reaper, who is not the agent and never forgives the zero."
    ].join("\n");
    const file = path.join(OBI, `${state.deathAt.replace(/[:.]/g, "-")}-${cause}.md`);
    await fs.writeFile(file, obit);

    /* graveyard ledger — the death produces data the living read */
    const gy = path.resolve("graveyard.md");
    let g;
    try {
      const old = await fs.readFile(gy, "utf8");
      const rows = old.split("\n").filter(l => l.startsWith("|") && !l.startsWith("|---") && !l.startsWith("| when"));
      g = old.split("\n|---")[0] + "\n|---|---|---|---|\n" + rows.join("\n") + "\n";
    } catch { g = "## Graveyard registry\n\n| when | cause | age | estate saved |\n|---|---|---|---|\n"; }
    g += `| ${state.deathAt.slice(0, 10)} | ${cause} | ${age}n | ${fmt(estate.swept ?? 0n)} saved |\n\n`;
    const stars = (g.match(/\| starvation \|/g) ?? []).length;
    const tamp = (g.match(/\| tampering \|/g) ?? []).length;
    g += `**Cause count:** ${stars} starvation · ${tamp} tampering\n`;
    await fs.writeFile(gy, g);
    log(`💀 wrote obituary ${path.basename(file)}`);
    log(`🏦 estate: ${estate.note}`);
  }
}

const code = await main().catch((e) => {
  log("💥 fatal:", e?.stack ?? e);
  return 1;
});
process.exitCode = code;
