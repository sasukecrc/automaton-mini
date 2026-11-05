#!/usr/bin/env node
/**
 * tools/indexnow.mjs — tell search engines about changed pages.
 *
 * IndexNow is a public, key-based protocol supported by Bing, Yandex, Seznam,
 * Naver and others. It is not paid traffic and it is not a link scheme: it only
 * says "these URLs changed" to crawlers that already opted in. Google does not
 * participate; there is no autonomous Google submission without an account.
 *
 * Only URLs whose bytes changed since the last accepted submission are sent, so
 * a quiet night sends nothing. The key is public by design — it is hosted at
 * /<key>.txt and proves control of the host, not identity.
 *
 *   node tools/indexnow.mjs            # submit changed URLs
 *   node tools/indexnow.mjs --dry      # print, do not call the API
 *
 * Env: AUTOMATON_SITE_URL (defaults to the live Pages URL)
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const DOCS = path.join(ROOT, "docs");
const SITE = (process.env.AUTOMATON_SITE_URL || "https://sasukecrc.github.io/automaton-mini").replace(/\/$/, "");
const HOST = new URL(SITE).host;
const KEY = "32760ad9a221510fc63e11f42ccf86a3";
const KEY_FILE = path.join(DOCS, `${KEY}.txt`);
const STATE = path.join(ROOT, "economy", "indexnow.json");
const ENDPOINT = "https://api.indexnow.org/indexnow";
const DRY = process.argv.includes("--dry");
const log = (...a) => console.log("[indexnow]", ...a);

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
}

function fileFor(url) {
  if (url === `${SITE}/` || url === SITE) return path.join(DOCS, "index.html");
  if (!url.startsWith(SITE + "/")) return null;
  const rel = url.slice(SITE.length + 1);
  const clean = rel.replace(/\/$/, "/index.html");
  return path.join(DOCS, clean);
}

async function main() {
  // The key file is the proof of control. Keep it next to the site.
  await fs.writeFile(KEY_FILE, KEY, "utf8");

  let sitemap = "";
  try { sitemap = await fs.readFile(path.join(DOCS, "sitemap.xml"), "utf8"); }
  catch { log("no sitemap.xml — build the site first"); return; }

  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const uniq = [...new Set(urls)];
  const state = await readJSON(STATE, { submitted: {} });
  state.submitted = state.submitted && typeof state.submitted === "object" ? state.submitted : {};

  const changed = [];
  for (const url of uniq) {
    const file = fileFor(url);
    if (!file) { log(`skip (off-site): ${url}`); continue; }
    let hash;
    try { hash = sha(await fs.readFile(file)); }
    catch { log(`skip (missing): ${url}`); continue; }
    if (state.submitted[url] !== hash) changed.push({ url, hash });
  }

  if (!changed.length) { log("nothing changed — no submission"); return; }

  log(`${changed.length} changed URL(s):`);
  for (const c of changed) log("  " + c.url);

  if (DRY) { log("dry run — API not called"); return; }

  const body = {
    host: HOST,
    key: KEY,
    keyLocation: `${SITE}/${KEY}.txt`,
    urlList: changed.map((c) => c.url),
  };
  let res, text;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    text = (await res.text()).slice(0, 300);
  } catch (e) {
    log(`submission failed: ${e.message.slice(0, 160)} — will retry next run`);
    return;
  }
  if (res.status !== 200 && res.status !== 202) {
    log(`submission rejected: HTTP ${res.status} ${text}`);
    return;
  }
  for (const c of changed) state.submitted[c.url] = c.hash;
  state.lastAccepted = new Date().toISOString();
  state.endpointStatus = res.status;
  await fs.writeFile(STATE, JSON.stringify(state, null, 2) + "\n", "utf8");
  log(`accepted (HTTP ${res.status}) — ${changed.length} URL(s) submitted`);
}

main().catch((e) => {
  console.error("[indexnow] FATAL", e.stack || e.message);
  process.exitCode = 1;
});
