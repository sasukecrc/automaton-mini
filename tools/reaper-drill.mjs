#!/usr/bin/env node
/**
 * reaper-drill — controlled proof that the reaper KILLS, without losing state.
 * 1. snapshot wallet.json + state.json   2. rewind the birthdate by 9 days
 * 3. run the reaper with grace=0         4. restore the snapshot exactly.
 * If the drill fails, the nightly cron could kill something for nothing — bad.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const ECO = path.resolve("economy");
const snap = {
  wallet: await fs.readFile(path.join(ECO, "wallet.json"), "utf8"),
  state: await fs.readFile(path.join(ECO, "state.json"), "utf8").catch(() => null)
};
try {
  const w = JSON.parse(snap.wallet);
  const before = new Date();
  w.birth = new Date(Date.now() - 9 * 86400000).toISOString();
  await fs.writeFile(path.join(ECO, "wallet.json"), JSON.stringify(w, null, 2));
  try {
    const { stdout } = await run("node", ["reaper.mjs"], { env: { ...process.env, AUTOMATON_GRACE_OVERRIDE: "0" } });
    console.log("--- reaper said:\n" + stdout);
  } catch (e) {
    console.log("--- reaper said (exit " + e.code + "):\n" + (e.stdout ?? "") + (e.stderr ?? ""));
    if (e.code === 3) {
      const obis = (await fs.readdir(path.resolve("obituaries"))).filter(f => f.endsWith(".md"));
      console.log("✅ THE REAPER KILLS. obituary written:", obis.at(-1));
    } else { console.log("❌ unexpected reaper behavior"); process.exitCode = 1; }
  }
} finally {
  // restore the real life — the agent must never see the simulation
  await fs.writeFile(path.join(ECO, "wallet.json"), snap.wallet);
  if (snap.state === null) await fs.rm(path.join(ECO, "state.json"), { force: true });
  else await fs.writeFile(path.join(ECO, "state.json"), snap.state);
  console.log("(state restored — the drill leaves no scars)");
}
