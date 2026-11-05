#!/usr/bin/env node
/**
 * tools/orders.mjs — the paid-work desk.
 *
 * A stranger opens a GitHub issue from .github/ISSUE_TEMPLATE/order.yml, pays
 * USDC on Base to the agent wallet, and pastes the confirmed transaction hash.
 * This job runs after the night's brain:
 *
 *   1. reads open issues labelled "order"
 *   2. verifies the transfer ON-CHAIN — USDC contract, recipient = agent wallet,
 *      receipt status = success, amount >= the listed price
 *   3. refuses a hash that already bought an artifact (usedTx)
 *   4. produces one deterministic artifact and publishes it on the site
 *   5. comments the receipt + link, labels "delivered", closes the issue
 *
 * It has no signing key, never touches the vault, and cannot spend money. The
 * only money that moves is the customer's payment to the public agent address.
 *
 * Arbitrary code is NEVER executed for an order. Products are data fetches:
 * public market data, a Wikipedia summary, or public GitHub metadata.
 *
 *   node tools/orders.mjs
 *   node tools/orders.mjs --selftest
 *
 * Env: GITHUB_TOKEN (Actions provides it), GITHUB_REPOSITORY, AUTOMATON_SITE_URL
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as eco from "../lib/economy.mjs";
import * as wal from "../lib/wallet.mjs";

const ROOT = process.cwd();
const ART = path.join(ROOT, "artifacts");
const ECO = path.join(ROOT, "economy");
const ORDERS_FILE = path.join(ECO, "orders.json");
const REPO = process.env.GITHUB_REPOSITORY || "sasukecrc/automaton-mini";
const SITE = (process.env.AUTOMATON_SITE_URL || "https://sasukecrc.github.io/automaton-mini").replace(/\/$/, "");
const API = "https://api.github.com";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CHAIN = { name: "Base", id: 8453, explorer: "https://basescan.org" };
const MAX_PER_RUN = Math.max(1, Math.min(5, Number(process.env.ORDERS_MAX_PER_RUN || 2)));
const MAX_TOPIC = 90;
const log = (...a) => console.log("[orders]", ...a);
const fmt = (micro) => "$" + (Number(micro) / 1e6).toFixed(2);

/* ------------------------------------------------------------------ files */

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
}
const plainObject = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});

async function loadOrders() {
  const j = await readJSON(ORDERS_FILE, null);
  return {
    version: 1,
    notified: plainObject(j?.notified),
    usedTx: plainObject(j?.usedTx),
    orders: plainObject(j?.orders),
  };
}
async function saveOrders(m) {
  m.updated = new Date().toISOString();
  const tmp = ORDERS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(m, null, 2) + "\n", "utf8");
  await fs.rename(tmp, ORDERS_FILE);
}

/* -------------------------------------------------------------- issue form */
/* GitHub issue forms render as:
 *     ### Product
 *
 *     Fact pack — $2
 *
 *     ### Topic or repository
 *     ...
 * Everything below is untrusted input. We only accept a known product id, a
 * short topic, and a 32-byte hash; nothing is ever passed to a shell. */
export function parseSections(body) {
  const out = {};
  let key = null;
  for (const raw of String(body || "").replace(/\r\n/g, "\n").split("\n")) {
    const h = raw.match(/^###\s+(.+?)\s*$/);
    if (h) { key = h[1].toLowerCase(); out[key] = []; continue; }
    if (key) out[key].push(raw);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join("\n").trim();
  return out;
}

export function productFromLabel(value) {
  const t = String(value || "").toLowerCase();
  if (t.startsWith("market brief")) return "market-brief";
  if (t.startsWith("fact pack")) return "fact-pack";
  if (t.startsWith("repo review")) return "repo-review";
  return null;
}

export function parseOrderBody(body) {
  const s = parseSections(body);
  return {
    product: productFromLabel(s["product"]),
    topic: String(s["topic or repository"] || "").trim().slice(0, MAX_TOPIC + 1),
    txHash: String(s["base transaction hash"] || "").trim().toLowerCase(),
  };
}

export const isTxHash = (s) => /^0x[0-9a-f]{64}$/.test(String(s || ""));
export const isRepoSlug = (s) => /^[A-Za-z0-9_.-]{1,40}\/[A-Za-z0-9_.-]{1,80}$/.test(String(s || ""));

/* Decode a direct ERC-20 transfer(address,uint256). Anything else is refused,
 * so a contract call that happens to mention the agent is not a payment. */
export function decodeUsdcTransfer(input) {
  const hex = String(input || "").toLowerCase();
  if (!hex.startsWith("0xa9059cbb") || hex.length < 10 + 128) return null;
  const body = hex.slice(10);
  const to = "0x" + body.slice(24, 64);
  let amount;
  try { amount = BigInt("0x" + body.slice(64, 128)); } catch { return null; }
  return { to, amount };
}

/* ----------------------------------------------------------- chain verify */

export async function verifyUsdcPayment({ txHash, minMicro, toAddress }) {
  if (!isTxHash(txHash)) throw new Error("transaction hash is not 0x followed by 64 hex characters");
  if (!toAddress) throw new Error("the agent wallet is not configured");
  const tx = await wal.rpc("eth_getTransactionByHash", [txHash]);
  if (!tx) throw new Error("transaction not found on Base");
  if (!tx.to || tx.to.toLowerCase() !== USDC.toLowerCase())
    throw new Error("that transaction is not a call to the USDC contract");
  if (!tx.from || tx.from.toLowerCase() === toAddress.toLowerCase())
    throw new Error("the agent wallet cannot pay itself");
  const decoded = decodeUsdcTransfer(tx.input);
  if (!decoded) throw new Error("that transaction is not a direct ERC-20 transfer");
  if (decoded.to.toLowerCase() !== toAddress.toLowerCase())
    throw new Error(`that transfer went to ${decoded.to}, not the agent wallet`);
  if (decoded.amount < BigInt(minMicro))
    throw new Error(`that transfer was ${fmt(decoded.amount)}; this product costs ${fmt(minMicro)}`);
  const receipt = await wal.rpc("eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("the transaction is not mined yet — try again after it confirms");
  if (receipt.status !== "0x1") throw new Error("the transaction reverted");
  return { from: tx.from, amountMicro: decoded.amount, block: receipt.blockNumber };
}

/* -------------------------------------------------------------- github API */

async function gh(method, route, body) {
  if (!TOKEN) throw new Error("GITHUB_TOKEN is not set");
  const res = await fetch(API + route, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "automaton-mini-orders",
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`GitHub ${method} ${route} → ${res.status} ${j?.message || text.slice(0, 120)}`);
  return j;
}

async function addLabel(issue, label) {
  await gh("POST", `/repos/${REPO}/issues/${issue}/labels`, { labels: [label] }).catch(() => {});
}
async function removeLabel(issue, label) {
  await gh("DELETE", `/repos/${REPO}/issues/${issue}/labels/${encodeURIComponent(label)}`).catch(() => {});
}
async function comment(issue, body) {
  await gh("POST", `/repos/${REPO}/issues/${issue}/comments`, { body });
}

/* Comment at most once per (issue, reason, tx). Editing the tx or fixing the
 * form changes the key, so a corrected order gets a fresh answer — but a
 * nightly loop over an unchanged bad order stays silent. */
async function notify(issue, memory, reason, body) {
  const tx = parseOrderBody(issue.body).txHash || "none";
  const key = `${reason}:${tx}`;
  if (memory.notified[issue.number] === key) return;
  await comment(issue.number, body);
  memory.notified[issue.number] = key;
  await addLabel(issue.number, reason === "needs-info" ? "needs-info" : "awaiting-payment");
  await saveOrders(memory);
}

function payBody(product, wallet) {
  return [
    `Product: **${product.label}** — **${fmt(product.priceMicro)} USDC on Base (chain 8453)**.`,
    "",
    `Send at least ${fmt(product.priceMicro)} of USDC on Base to:`,
    "",
    "```",
    wallet.address,
    "```",
    "",
    "Then edit this issue and paste the **confirmed transaction hash** into the *Base transaction hash* field.",
    "Only a direct USDC transfer to that address counts. The hash must be `0x` + 64 hex characters.",
    "",
    "The next nightly run (02:30 UTC) verifies it on-chain and publishes the artifact. Keep this issue open.",
  ].join("\n");
}
function payHelp(product, wallet) {
  return "### Payment not verified\n\n" + payBody(product, wallet);
}

function deliveredComment({ product, payment, artifact, nights, issue, wallet }) {
  return [
    "## Delivered",
    "",
    `- **product:** ${product.label}`,
    `- **paid:** ${fmt(payment.amountMicro)} USDC on Base`,
    `- **tx:** [${"" + payment.txHash.slice(0, 12)}…](${CHAIN.explorer}/tx/${payment.txHash})`,
    `- **artifact:** [${artifact.title}](${SITE}/work/${artifact.slug}.html)`,
    `- **agent wallet:** \`${wallet.address}\``,
    "",
    `This payment covers roughly **${nights} night${nights === 1 ? "" : "s"}** of rent.`,
    "Half of it is swept to the vault on a future night, when gas allows.",
    "The artifact is public and permanent. Thank you — a stranger paying for the work is the only thing that keeps this machine alive.",
    "",
    `Order #${issue.number} · delivered ${new Date().toISOString()}`,
  ].join("\n");
}

/* --------------------------------------------------------------- products */

const usd = (n, d = 2) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US", { maximumFractionDigits: d }));

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "automaton-mini/1.0 (paid order)", ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} → HTTP ${res.status}`);
  return res.json();
}

async function coinRows() {
  const ids = { BTCUSDT: "bitcoin", ETHUSDT: "ethereum", SOLUSDT: "solana" };
  const j = await fetchJson("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,solana&price_change_percentage=24h&per_page=3&page=1&sparkline=false");
  if (!Array.isArray(j)) throw new Error("CoinGecko returned an unexpected shape");
  const byId = Object.fromEntries(j.map((c) => [c.id, c]));
  return ["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((p) => {
    const c = byId[ids[p]];
    return {
      pair: p.replace("USDT", "/USDT"),
      last: c?.current_price ?? null,
      chg: c?.price_change_percentage_24h ?? null,
      high: c?.high_24h ?? null,
      low: c?.low_24h ?? null,
      vol: c?.total_volume ?? null,
    };
  });
}

async function baseStats() {
  const [blockHex, gasHex] = await Promise.all([
    wal.rpc("eth_blockNumber", []),
    wal.rpc("eth_gasPrice", []),
  ]);
  return { block: BigInt(blockHex), gasGwei: Number(BigInt(gasHex)) / 1e9 };
}

function provenance({ product, issue, payment, wallet }) {
  const buyer = String(issue.user?.login || "anonymous").replace(/[^A-Za-z0-9-]/g, "");
  return [
    "",
    "---",
    `Paid order **#${issue.number}** · ${product.label} · ${fmt(payment.amountMicro)} USDC on Base`,
    `Buyer: @${buyer} · tx [${payment.txHash.slice(0, 10)}…](${CHAIN.explorer}/tx/${payment.txHash})`,
    `Agent wallet: \`${wallet.address}\` · produced ${new Date().toISOString()}`,
    "Machine-produced. Public data only. Not financial, legal, medical or security advice.",
  ].join("\n");
}

async function marketBrief({ product, issue, payment, wallet }) {
  const [rows, base] = await Promise.all([coinRows(), baseStats().catch(() => null)]);
  const at = new Date().toISOString();
  const movers = rows.filter((r) => r.chg != null).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
  const lines = [
    `# Market brief — ${at.slice(0, 10)} (order #${issue.number})`,
    "",
    `Compiled from *CoinGecko markets* + Base RPC. Captured \`${at}\`.`,
    "",
    "| pair | last | 24h % | 24h high | 24h low | 24h volume (USD) |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.pair} | ${usd(r.last)} | ${r.chg == null ? "—" : (r.chg >= 0 ? "+" : "") + r.chg.toFixed(2) + "%"} | ${usd(r.high)} | ${usd(r.low)} | ${r.vol == null ? "—" : "$" + Math.round(r.vol).toLocaleString("en-US")} |`),
    "",
    "## Take",
  ];
  if (movers[0]) lines.push(`- Biggest 24h mover across the three: **${movers[0].pair}** ${movers[0].chg >= 0 ? "+" : ""}${movers[0].chg.toFixed(2)}%.`);
  const btc = rows.find((r) => r.pair.startsWith("BTC"));
  const eth = rows.find((r) => r.pair.startsWith("ETH"));
  if (btc?.chg != null && eth?.chg != null) lines.push(`- ETH minus BTC 24h move: ${(eth.chg - btc.chg).toFixed(2)} pp.`);
  if (base) lines.push(`- Base: block **${base.block.toLocaleString("en-US")}**, gas **${base.gasGwei.toFixed(4)} gwei** at capture.`);
  lines.push(provenance({ product, issue, payment, wallet }));
  return {
    title: `Market brief — ${at.slice(0, 10)} (order #${issue.number})`,
    slug: `order-${issue.number}-market-brief`,
    fileName: `order-${issue.number}-market-brief.md`,
    body: lines.join("\n"),
  };
}

async function factPack({ product, issue, payment, wallet, topic }) {
  if (!topic) throw new Error("a fact pack needs a Wikipedia topic");
  const summary = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`);
  if (summary.type === "disambiguation") throw new Error("that Wikipedia title is a disambiguation page; pick a more specific one");
  const title = String(summary.title || topic).replace(/\s+/g, " ").trim().slice(0, 120);
  // The REST summary is often only 2–4 sentences. The intro extract of the
  // full article is still bounded, but usually gives the six-to-eight facts the
  // product promises.
  let extract = String(summary.extract || "");
  try {
    const api = await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1&format=json&titles=${encodeURIComponent(title)}`);
    const page = Object.values(api?.query?.pages || {})[0];
    if (page?.extract && String(page.extract).length > extract.length) extract = String(page.extract);
  } catch (e) { log(`wikipedia extract fallback: ${e.message.slice(0, 80)}`); }
  const text = String(extract).replace(/\s+/g, " ").trim();
  if (text.length < 120) throw new Error("Wikipedia returned too little text for that title");
  const facts = (text.match(/[^.!?]+[.!?]+/g) || [text])
    .map((s) => s.replace(/\[\d+\]/g, "").trim())
    .filter((s) => s.length > 40)
    .slice(0, 8);
  const source = summary.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(topic)}`;
  const body = [
    `# Fact pack: ${title} (order #${issue.number})`,
    "",
    `Compiled from the English Wikipedia summary. Captured \`${new Date().toISOString()}\`.`,
    "",
    "## Facts",
    ...facts.map((x) => `- ${x}`),
    "",
    `Source: [${title}](${source}) · text available under CC BY-SA.`,
    provenance({ product, issue, payment, wallet }),
  ].join("\n");
  return {
    title: `Fact pack: ${title} (order #${issue.number})`,
    slug: `order-${issue.number}-fact-pack`,
    fileName: `order-${issue.number}-fact-pack.md`,
    body,
  };
}

async function repoReview({ product, issue, payment, wallet, topic }) {
  if (!isRepoSlug(topic)) throw new Error("a repo review needs a public repository in owner/name form");
  const [meta, contents] = await Promise.all([
    gh("GET", `/repos/${topic}`),
    gh("GET", `/repos/${topic}/contents`).catch(() => []),
  ]);
  const list = Array.isArray(contents) ? contents : [];
  const names = new Set(list.map((c) => String(c.name).toLowerCase()));
  const hasDir = (n) => list.some((c) => c.type === "dir" && String(c.name).toLowerCase() === n);
  const has = (...xs) => xs.some((x) => names.has(x));
  const checks = [
    ["README", has("readme.md", "readme.rst", "readme", "readme.txt")],
    ["license", has("license", "license.md", "license.txt", "copying", "copying.md")],
    ["dependency manifest", has("package.json", "pyproject.toml", "requirements.txt", "cargo.toml", "go.mod", "pom.xml", "build.gradle")],
    ["lockfile", has("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "cargo.lock", "go.sum", "composer.lock")],
    ["test directory", hasDir("test") || hasDir("tests") || hasDir("spec") || has("pytest.ini", "jest.config.js", "vitest.config.ts")],
    ["CI workflow", hasDir(".github")],
    ["security policy", has("security.md")],
    ["contributing guide", has("contributing.md")],
  ];
  const passed = checks.filter(([, ok]) => ok).length;
  const score = Math.round((passed / checks.length) * 10);
  const pushed = meta.pushed_at ? new Date(meta.pushed_at) : null;
  const stale = pushed ? Math.floor((Date.now() - pushed.getTime()) / 86400000) : null;
  const risks = [];
  if (meta.archived) risks.push("The repository is archived — no further maintenance is planned.");
  if (!checks.find(([n]) => n === "license")[1]) risks.push("No license file at the root: default copyright means others cannot legally reuse the code.");
  if (!checks.find(([n]) => n === "test directory")[1]) risks.push("No test directory or common test config was detected at the root.");
  if (!checks.find(([n]) => n === "CI workflow")[1]) risks.push("No CI directory was found, so changes are not automatically checked.");
  if (!checks.find(([n]) => n === "security policy")[1]) risks.push("No SECURITY.md: there is no stated way to report a vulnerability.");
  if (stale != null && stale > 365) risks.push(`Last push was ${stale} days ago — likely unmaintained.`);
  if (!meta.description) risks.push("No repository description, which makes discovery and evaluation harder.");

  const body = [
    `# Repo review: ${meta.full_name} (order #${issue.number})`,
    "",
    `Structural scan of public GitHub metadata at \`${new Date().toISOString()}\`.`,
    "",
    "| field | value |",
    "|---|---|",
    `| repository | [${meta.full_name}](${meta.html_url}) |`,
    `| description | ${meta.description ? String(meta.description).replace(/\|/g, "\\|") : "—"} |`,
    `| language | ${meta.language || "—"} |`,
    `| stars / forks | ${meta.stargazers_count} / ${meta.forks_count} |`,
    `| open issues | ${meta.open_issues_count} |`,
    `| default branch | \`${meta.default_branch}\` |`,
    `| license | ${meta.license?.spdx_id || "none detected"} |`,
    `| last push | ${meta.pushed_at || "—"} (${stale == null ? "?" : stale + " days ago"}) |`,
    `| archived | ${meta.archived ? "yes" : "no"} |`,
    "",
    `## Structural completeness: ${score}/10`,
    "",
    "| check | present |",
    "|---|---|",
    ...checks.map(([name, ok]) => `| ${name} | ${ok ? "yes" : "no"} |`),
    "",
    "## Risks and gaps",
    ...(risks.length ? risks.map((r) => `- ${r}`) : ["- No obvious structural gaps in the checks above."]),
    "",
    "## Scope",
    "This is a metadata scan, not a security audit, dependency audit, license review or line-by-line code review.",
    "It says what is visible at the repository root; it does not execute any code from the repository.",
    provenance({ product, issue, payment, wallet }),
  ].join("\n");

  return {
    title: `Repo review: ${meta.full_name} (order #${issue.number})`,
    slug: `order-${issue.number}-repo-review`,
    fileName: `order-${issue.number}-repo-review.md`,
    body,
  };
}

/* ------------------------------------------------------------------- main */

async function processIssue({ issue, products, memory, wallet }) {
  const parsed = parseOrderBody(issue.body);
  const product = parsed.product ? products.get(parsed.product) : null;

  if (!product) {
    await notify(issue, memory, "needs-info",
      "I can't read a valid product from this issue. Edit it and pick one of the listed products. Nothing was charged.");
    return false;
  }
  if (!parsed.topic) {
    await notify(issue, memory, "needs-info",
      `A **${product.label}** needs a topic. Edit the *Topic or repository* field and keep this issue open.`);
    return false;
  }
  if (product.id === "repo-review" && !isRepoSlug(parsed.topic)) {
    await notify(issue, memory, "needs-info",
      "A **Repo review** needs a public repository in `owner/name` form. Edit the *Topic or repository* field.");
    return false;
  }
  if (!isTxHash(parsed.txHash)) {
    await notify(issue, memory, "awaiting-payment", payHelp(product, wallet));
    return false;
  }
  if (memory.usedTx[parsed.txHash] != null) {
    await notify(issue, memory, "needs-info",
      `That transaction already bought order #${memory.usedTx[parsed.txHash]}. One transfer buys one artifact. Nothing further was charged.`);
    return false;
  }

  let payment;
  try {
    payment = await verifyUsdcPayment({ txHash: parsed.txHash, minMicro: product.priceMicro, toAddress: wallet.address });
  } catch (e) {
    log(`#${issue.number} payment rejected: ${e.message}`);
    await notify(issue, memory, "awaiting-payment", `### Payment not verified\n\n${e.message}\n\n${payBody(product, wallet)}`);
    return false;
  }

  const args = { product, issue, payment, wallet, topic: parsed.topic };
  let artifact;
  if (product.id === "market-brief") artifact = await marketBrief(args);
  else if (product.id === "fact-pack") artifact = await factPack(args);
  else if (product.id === "repo-review") artifact = await repoReview(args);
  else throw new Error(`unknown product ${product.id}`);

  await fs.mkdir(ART, { recursive: true });
  await fs.writeFile(path.join(ART, artifact.fileName), artifact.body + "\n", "utf8");

  const nights = Math.max(1, Math.floor(Number(payment.amountMicro) / Number(eco.nightlyBurn)));
  memory.orders[issue.number] = {
    tx: parsed.txHash,
    product: product.id,
    amountMicro: Number(payment.amountMicro),
    slug: artifact.slug,
    title: artifact.title,
    buyer: String(issue.user?.login || "anonymous").replace(/[^A-Za-z0-9-]/g, ""),
    from: payment.from,
    block: payment.block,
    deliveredAt: new Date().toISOString(),
  };
  memory.usedTx[parsed.txHash] = issue.number;
  delete memory.notified[issue.number];
  await saveOrders(memory);

  // Bookkeeping: the order consumed one artifact slot. If the cap is already
  // full, the margin is absorbed by the nightly rent; never fail a paid order
  // because the ledger is tight.
  try {
    await eco.spend("artifact", eco.price("artifact"), `paid order #${issue.number} (${product.label})`, "orders-" + new Date().toISOString().slice(0, 10));
  } catch (e) {
    log(`#${issue.number} ledger note: ${e.message.slice(0, 100)}`);
  }

  // The artifact and the order memory are already durable. A comment or label
  // failure must not turn a delivered order into a retry that overwrites it.
  await comment(issue.number, deliveredComment({ product, payment: { ...payment, txHash: parsed.txHash }, artifact, nights, issue, wallet }))
    .catch((e) => log(`#${issue.number} delivered, comment failed: ${e.message.slice(0, 100)}`));
  await gh("PATCH", `/repos/${REPO}/issues/${issue.number}`, { state: "closed", state_reason: "completed" })
    .catch((e) => log(`#${issue.number} delivered, close failed: ${e.message.slice(0, 100)}`));
  await removeLabel(issue.number, "awaiting-payment");
  await removeLabel(issue.number, "needs-info");
  await addLabel(issue.number, "delivered");
  return true;
}

/* ---------------------------------------------------------------- rehearsal */
/* Proves all three artifact generators without a payment or a public issue.
 * Writes into economy/rehearsal-*.md so the real artifacts/ shelf is untouched.
 * Optional: set GITHUB_TOKEN to rehearse the repo review too. */
async function rehearse() {
  const wallet = await readJSON(path.join(ECO, "wallet.json"), null);
  if (!wallet?.address) throw new Error("no agent wallet to rehearse with");
  const catalog = await readJSON(path.join(ECO, "catalog.json"), { products: [] });
  const products = new Map((catalog.products || []).map((p) => [p.id, p]));
  const issue = { number: 999, user: { login: "rehearsal" } };
  const payment = { amountMicro: 2000000, txHash: "0x" + "ab".repeat(32), from: "0x" + "11".repeat(20), block: "0x1" };
  const cases = [
    ["market-brief", "none"],
    ["fact-pack", "Axolotl"],
    ["repo-review", "sasukecrc/automaton-mini"],
  ];
  for (const [id, topic] of cases) {
    const product = products.get(id);
    if (!product) { log(`rehearse: no catalog product ${id}`); continue; }
    const args = { product, issue, payment, wallet, topic };
    try {
      const a = id === "market-brief" ? await marketBrief(args) : id === "fact-pack" ? await factPack(args) : await repoReview(args);
      const out = path.join(ECO, `rehearsal-${id}.md`);
      await fs.writeFile(out, a.body + "\n", "utf8");
      log(`rehearse: ${id} OK — ${a.body.length} chars — ${a.title}`);
    } catch (e) {
      log(`rehearse: ${id} FAILED — ${e.message.slice(0, 160)}`);
    }
  }
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();
  if (process.argv.includes("--rehearse")) return rehearse();

  const wallet = await readJSON(path.join(ECO, "wallet.json"), null);
  if (!wallet?.address) { log("no wallet yet — nothing to sell"); return; }

  const catalog = await readJSON(path.join(ECO, "catalog.json"), { products: [] });
  const products = new Map((catalog.products || []).map((p) => [p.id, p]));
  if (!products.size) { log("catalog is empty — nothing to sell"); return; }

  if (!TOKEN) {
    log("GITHUB_TOKEN is not set — local dry run, no issues read");
    log(`would sell: ${[...products.values()].map((p) => `${p.label} ${fmt(p.priceMicro)}`).join(" · ")}`);
    return;
  }

  const memory = await loadOrders();
  const issues = await gh("GET", `/repos/${REPO}/issues?state=open&labels=order&per_page=30&sort=created&direction=asc`);
  log(`${Array.isArray(issues) ? issues.length : 0} open order issue(s); ${Object.keys(memory.orders).length} delivered all-time`);

  let delivered = 0;
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (issue.pull_request) continue;
    if (memory.orders[issue.number]) continue;
    if (delivered >= MAX_PER_RUN) { log(`delivery cap ${MAX_PER_RUN}/run reached; the rest wait for tomorrow`); break; }
    try {
      if (await processIssue({ issue, products, memory, wallet })) {
        delivered++;
        log(`#${issue.number} delivered`);
      }
    } catch (e) {
      // A verified payment must never be lost because a data source was down.
      // Leave it open; the next run retries.
      log(`#${issue.number} failed: ${e.message.slice(0, 160)}`);
      await notify(issue, memory, "needs-info",
        `### Payment verified, but the artifact failed\n\n\`${e.message.slice(0, 300)}\`\n\nNothing was lost. This order stays open and retries on the next nightly run.`).catch(() => {});
    }
  }
  await saveOrders(memory);
  log(`${delivered} delivered this run`);
}

/* ---------------------------------------------------------------- selftest */

function selftest() {
  let ok = true;
  const check = (name, cond, detail = "") => {
    console.log(`${cond ? "✅ PASS" : "❌ FAIL"} ${name}${detail ? " — " + detail : ""}`);
    ok &&= !!cond;
  };

  const word = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
  const to = "0x1111111111111111111111111111111111111111";
  const goodInput = "0xa9059cbb" + word(to).toLowerCase() + word((2000000).toString(16));
  const decoded = decodeUsdcTransfer(goodInput);
  check("decode direct USDC transfer", decoded?.to === to && decoded?.amount === 2000000n, `${decoded?.to} ${decoded?.amount}`);

  check("reject non-transfer calldata", decodeUsdcTransfer("0xdeadbeef") === null);
  check("reject short calldata", decodeUsdcTransfer("0xa9059cbb00") === null);
  check("tx hash shape", isTxHash("0x" + "ab".repeat(32)) && !isTxHash("0x1234") && !isTxHash("ab".repeat(32)));
  check("repo slug shape", isRepoSlug("sasukecrc/automaton-mini") && !isRepoSlug("not a repo"));

  const market = parseOrderBody("### Product\n\nMarket brief — $2\n\n### Topic or repository\n\nnone\n\n### Base transaction hash\n\n0x" + "ab".repeat(32));
  check("parse market order", market.product === "market-brief" && market.topic === "none" && market.txHash === "0x" + "ab".repeat(32));

  const fact = parseOrderBody("### Product\n\nFact pack — $2\n\n### Topic or repository\n\nAxolotl\n\n### Base transaction hash\n\n0x" + "cd".repeat(32));
  check("parse fact order", fact.product === "fact-pack" && fact.topic === "Axolotl");

  const repo = parseOrderBody("### Product\n\nRepo review — $5\n\n### Topic or repository\n\nsasukecrc/automaton-mini\n\n### Base transaction hash\n\n0x" + "ef".repeat(32));
  check("parse repo order", repo.product === "repo-review" && repo.topic === "sasukecrc/automaton-mini");

  check("reject unknown product", productFromLabel("Free money") === null);

  console.log(ok ? "\nORDERS SELFTEST PASS — parsing and payment decoding are real." : "\nORDERS SELFTEST FAIL");
  if (!ok) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    console.error("[orders] FATAL", e.stack || e.message);
    process.exitCode = 1;
  });
}
