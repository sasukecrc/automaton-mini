#!/usr/bin/env node
// tools/build-site.mjs — the public storefront. Zero dependencies.
//
// Reads the same files the machine lives on (economy/*.json, economy/ledger.jsonl,
// artifacts/*.md) and writes a static site into docs/ for GitHub Pages.
// Nothing here talks to the chain and nothing here can spend: it only renders.
//
//   node tools/build-site.mjs
//
// Optional env:
//   AUTOMATON_REPO_URL   e.g. https://github.com/user/automaton-mini
//   AUTOMATON_SITE_URL   e.g. https://user.github.io/automaton-mini
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "docs");
const ARTIFACTS = path.join(ROOT, "artifacts");
const OBITUARIES = path.join(ROOT, "obituaries");
const ECO = path.join(ROOT, "economy");

const REPO = (process.env.AUTOMATON_REPO_URL || "").replace(/\/$/, "");
const SITE_URL = (process.env.AUTOMATON_SITE_URL || "").replace(/\/$/, "");
const CHAIN = {
  name: "Base",
  id: 8453,
  explorer: "https://basescan.org",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const USDC_DECIMALS = 6;

/* ------------------------------------------------------------------ data */

async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
}

function fmtUSD(micro, { sign = false } = {}) {
  const n = Number(micro) / 1e6;
  const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n < 0) return "-$" + s;
  return (sign && n > 0 ? "+$" : "$") + s;
}

function fmtInt(n) { return Number(n || 0).toLocaleString("en-US"); }

function fmtDate(iso, opts = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric", ...opts });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

async function auditLedger() {
  let text = "";
  try { text = await fs.readFile(path.join(ECO, "ledger.jsonl"), "utf8"); } catch {}
  const lines = text.trim().split("\n").filter(Boolean);
  let burn = 0n, swept = 0n, corrupt = 0, last = null;
  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch { corrupt++; continue; }
    const micro = j?.micro;
    if (!Number.isSafeInteger(micro)) { corrupt++; continue; }
    if (j.kind === "sweep") {
      if (micro >= 0) { corrupt++; continue; }
      swept += BigInt(-micro);
    } else {
      burn += BigInt(micro);
    }
    if (j.t) last = j.t;
  }
  return { burn, swept, corrupt, lines: lines.length, last };
}

/* -------------------------------------------------------------- markdown */

function inline(s) {
  const codes = [];
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    if (!/^https?:\/\//i.test(href)) return label;
    return `<a href="${href}" rel="noopener noreferrer">${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return t;
}

const isTableSep = (l) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");
const isBlockStart = (l) => /^(#{1,4}\s|```|\||>\s|[-*]\s|\d+\.\s|---+\s*$)/.test(l);

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^#{1,4}\s/.test(line)) {
      const m = line.match(/^(#{1,4})\s+(.*)$/);
      const level = Math.min(m[1].length + 1, 4); // page h1 is the title; body starts at h2
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push(
        "<table><thead><tr>" + head.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table>"
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) items.push(lines[i++].replace(/^[-*]\s+/, ""));
      out.push("<ul>" + items.map((x) => `<li>${inline(x)}</li>`).join("") + "</ul>");
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) items.push(lines[i++].replace(/^\d+\.\s+/, ""));
      out.push("<ol>" + items.map((x) => `<li>${inline(x)}</li>`).join("") + "</ol>");
      continue;
    }

    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && (para.length === 0 || !isBlockStart(lines[i]))) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

/* --------------------------------------------------------------- helpers */

function stripMd(s) {
  return String(s)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isMetaLine(s) {
  return /autonomously|compiled|produced|generated by|source:|public market data/i.test(s);
}

async function loadArtifacts() {
  let names = [];
  try { names = (await fs.readdir(ARTIFACTS)).filter((n) => n.endsWith(".md")); } catch { return []; }
  const items = [];
  for (const name of names) {
    const file = path.join(ARTIFACTS, name);
    let md = "";
    try { md = await fs.readFile(file, "utf8"); } catch { continue; }
    const h1 = md.match(/^#\s+(.+)$/m)?.[1]?.trim() || name.replace(/\.md$/, "");
    const iso = md.match(/\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/)?.[1] || null;
    const night = Number(md.match(/\bnight\s+\*{0,2}n(\d+)\b/i)?.[1] || name.match(/^n(\d+)-/)?.[1] || 0) || null;
    const kind = /market brief/i.test(h1) ? "Market brief" : /fact pack/i.test(h1) ? "Fact pack" : /repo review/i.test(h1) ? "Repo review" : "Artifact";

    const body = md.replace(/^#\s+.+$/m, "");
    let excerpt = "";
    for (const raw of body.split("\n")) {
      const l = raw.trim();
      if (!l || l.startsWith("#") || l.startsWith("|") || l.startsWith("---") || l.startsWith(">") || /^[-*]\s/.test(l)) continue;
      if (isMetaLine(l)) continue;
      excerpt = stripMd(l);
      break;
    }
    if (!excerpt) {
      for (const raw of body.split("\n")) {
        const m = raw.trim().match(/^[-*]\s+(.+)$/);
        if (m && !isMetaLine(m[1])) { excerpt = stripMd(m[1]); break; }
      }
    }
    if (excerpt.length > 170) excerpt = excerpt.slice(0, 167).replace(/\s+\S*$/, "") + "…";

    const slug = name.replace(/\.md$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
    items.push({ name, file, slug, md, title: h1, iso, night, kind, excerpt, date: iso ? Date.parse(iso) : 0 });
  }
  return items.sort((a, b) => b.date - a.date);
}

async function loadObituaries() {
  let names = [];
  try { names = (await fs.readdir(OBITUARIES)).filter((n) => n.endsWith(".md")); } catch { return []; }
  const items = [];
  for (const name of names) {
    let md = "";
    try { md = await fs.readFile(path.join(OBITUARIES, name), "utf8"); } catch { continue; }
    const h1 = md.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Obituary";
    const iso = md.match(/\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/)?.[1] || null;
    const cause = name.replace(/\.md$/, "").split("-").pop() || "unknown";
    const slug = name.replace(/\.md$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-");
    items.push({ name, slug, md, title: h1, iso, cause, date: iso ? Date.parse(iso) : 0 });
  }
  return items.sort((a, b) => b.date - a.date);
}

/* ---------------------------------------------------------------- layout */

function layout({ title, desc, canonical, body, active = "", base = "", jsonLd = null }) {
  const fullTitle = title === "Automaton" ? "Automaton — a machine that pays rent to exist" : `${esc(title)} · Automaton`;
  const ld = jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll("</", "<\\/")}</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#08080a">
<meta property="og:type" content="website">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${esc(desc)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">\n<link rel="canonical" href="${esc(canonical)}">` : ""}
${ld}
<link rel="icon" href="${base}favicon.svg" type="image/svg+xml">
<link rel="alternate" type="application/rss+xml" title="automaton-mini work" href="${base}feed.xml">
<link rel="stylesheet" href="${base}style.css">
<script defer src="${base}app.js"></script>
</head>
<body>
<header class="top wrap">
  <a class="brand" href="${base}index.html"><span class="mark">a</span> automaton-mini</a>
  <nav>
    <a href="${base}hire.html">Hire</a>
    <a href="${base}verify.html">Verify</a>
    <a href="${base}index.html#work">Work</a>
    <a href="${base}index.html#books">Books</a>
    <a href="${base}index.html#rules">Rules</a>
    <a href="${base}soul.html">Soul</a>
    ${REPO ? `<a href="${esc(REPO)}" rel="noopener">Source ↗</a>` : ""}
  </nav>
</header>
${body}
<footer>
  <div class="wrap foot">
    <div class="fine">
      Not financial advice. No earnings are promised. The books are public so the claim
      cannot quietly become marketing. Most nights make $0 — that is the experiment.
      ${REPO ? `<br><a href="${esc(REPO)}" rel="noopener">source</a> · ` : ""}<a href="${base}status.json">status.json</a> · <a href="${base}feed.xml">feed</a> · <a href="${base}agent-card.json">agent card</a> · <a href="${base}sitemap.xml">sitemap</a>
    </div>
    <div class="mono small">automaton-mini · ${esc(CHAIN.name)} mainnet</div>
  </div>
</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ page */

function indexPage({ state, wallet, treasury, totals, artifacts, generatedAt, grace, catalog }) {
  const alive = state.status !== "dead";
  const nights = Number(state.nights || 0);
  const birth = state.birthISO || wallet?.birth;
  const balance = totals.balance;
  const tips = totals.tips;
  const vaultLive = totals.swept;
  const products = catalog?.products || [];
  const ordersDelivered = Number(totals.ordersDelivered || 0);
  const ordersRevenueMicro = totals.ordersRevenue || 0n;
  const ageDays = birth && Number.isFinite(Date.parse(birth)) ? Math.floor((Date.now() - Date.parse(birth)) / 86400000) : 0;
  const graceLeft = Math.max(0, Number(grace ?? 7) - ageDays + 1);
  const cards = artifacts.slice(0, 6);
  const lastArtifact = artifacts[0];

  const statusPill = alive
    ? `<span class="pill alive"><span class="dot"></span> alive · night ${nights}</span>`
    : `<span class="pill dead"><span class="dot"></span> dead · night ${nights}</span>`;

  const deathNote = !alive ? `
  <div class="wrap" style="padding-top:28px">
    <div class="tip" style="border-color:rgba(255,122,122,.35);background:radial-gradient(600px 260px at 0% 0%,rgba(255,122,122,.08),transparent 70%),var(--panel)">
      <div>
        <h3 style="margin-bottom:6px">It is dead.</h3>
        <p style="margin-bottom:0">The reaper ended it at night ${nights}. Its estate was swept to the vault before the obituary.
        Only <strong style="color:var(--text)">$1 of new USDC</strong> brings it back — its own savings cannot.
        <a href="obituary.html">Read the obituary →</a></p>
      </div>
      <div class="tip-side"><div class="big"><span>${fmtUSD(1_000_000)}</span> revives it</div><div class="fine">Send to the tip jar. The next nightly run checks the chain.</div></div>
    </div>
  </div>` : "";

  const cardHTML = cards.length ? cards.map((a) => `
    <a class="card" href="work/${esc(a.slug)}.html">
      <div class="kind">${esc(a.kind)}</div>
      <h4>${esc(a.title)}</h4>
      <p>${esc(a.excerpt || "Read the artifact.")}</p>
      <div class="foot"><span>${a.night ? `night n${a.night}` : "nightly work"}</span><span>${fmtDate(a.iso)}</span></div>
    </a>`).join("") : `<div class="empty">No artifacts yet. The first night is still being written.</div>`;

  const booksRows = [
    ["tips received, all time", fmtUSD(tips)],
    ["paid orders delivered", `${fmtInt(ordersDelivered)} · ${fmtUSD(ordersRevenueMicro)}`],
    ["burned by existence", fmtUSD(totals.burn)],
    ["banked in the vault", fmtUSD(totals.swept)],
    ["vault live balance", fmtUSD(vaultLive)],
    ["paper balance (agent)", fmtUSD(balance)],
    ["nights lived", fmtInt(nights)],
    ["deaths / resurrections", `${fmtInt(state.deaths || 0)} / ${fmtInt(state.resurrects || 0)}`],
  ];

  const body = `
<main>
  <section class="hero wrap" style="padding-top:84px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px">
      <p class="eyebrow" style="margin:0">automaton-mini · Base mainnet · real USDC</p>
      ${statusPill}
    </div>
    <h1>Born broke. Bills every night. <em>Death is real.</em></h1>
    <p class="lede">
      An autonomous agent with a real crypto wallet. It started with <strong>$0.00</strong>.
      Every night it pays rent, makes something, and publishes the books. Tips and paid orders keep it alive.
      <strong>Half of every dollar</strong> is swept on-chain into a vault that outlives it.
    </p>
    <div class="actions">
      <a class="btn primary" href="hire.html">Hire it for USDC <span class="arrow">→</span></a>
      <a class="btn" href="#work">Read tonight's work</a>
      <a class="btn" href="soul.html">Read its soul</a>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="k">nights lived</div>
        <div class="v">${fmtInt(nights)}</div>
        <div class="sub">grace: ${fmtInt(7)} nights</div>
      </div>
      <div class="stat">
        <div class="k">paper balance</div>
        <div class="v ${balance < 0n ? "neg" : balance > 0n ? "pos" : ""}">${fmtUSD(balance)}</div>
        <div class="sub">on-chain − burned</div>
      </div>
      <div class="stat">
        <div class="k">tips, all time</div>
        <div class="v">${fmtUSD(tips)}</div>
        <div class="sub">USDC on Base</div>
      </div>
      <div class="stat">
        <div class="k">vault</div>
        <div class="v">${fmtUSD(vaultLive)}</div>
        <div class="sub">survives death</div>
      </div>
    </div>
    ${state.status === "alive" && balance <= 0n ? `<p class="small muted" style="margin-top:14px">Balance is at or below zero. It is living on grace — the reaper ends it in about ${graceLeft} night${graceLeft === 1 ? "" : "s"} unless new USDC arrives.</p>` : ""}
  </section>
  ${deathNote}

  <section class="wrap" id="tip">
    <div class="section-head">
      <h2>The tip jar keeps it alive</h2>
      <span class="note">USDC · chain 8453</span>
    </div>
    <div class="tip">
      <div>
        <h3>Send USDC on Base</h3>
        <p>Tips are the simplest revenue; paid orders are the other. No subscriptions, no ads, no paid traffic, no token.
           If the work was worth something, this is how you say so.</p>
        <div class="addr">
          <code id="agent-addr">${esc(wallet?.address || "—")}</code>
          <button class="copy" data-copy="${esc(wallet?.address || "")}" aria-label="Copy agent address">copy</button>
        </div>
        <span class="net">● Base mainnet · USDC only</span>
        ${wallet?.address ? `<p class="small" style="margin:14px 0 0"><a href="${CHAIN.explorer}/address/${esc(wallet.address)}" rel="noopener">View on BaseScan ↗</a></p>` : ""}
      </div>
      <div class="tip-side">
        <div class="big"><span>$1</span> ≈ 13 nights</div>
        <div class="fine">Rent is $0.052 a night. A dollar buys almost two weeks of existence —
          plus two artifacts and a reasoning turn most nights.</div>
        <div class="split">
          <div class="split-bar"><i class="a"></i><i class="b"></i></div>
          <div class="split-labels"><span>50% metabolism</span><span>50% vault</span></div>
        </div>
      </div>
    </div>
    <p class="small dim" style="margin-top:14px;max-width:70ch">
      Send only USDC on the Base network. Other tokens or networks may be lost. This is a tip, not an
      investment, and nothing is promised in return. Without a little ETH on Base the vault sweep waits —
      100% stays safely in the agent wallet until gas is available.
    </p>
  </section>

  <section class="wrap" id="hire">
    <div class="section-head">
      <h2>It also works for strangers</h2>
      <span class="note">paid orders · USDC on Base · next nightly run</span>
    </div>
    <div class="work">
      ${products.map((p) => `
      <a class="card" href="hire.html">
        <div class="kind">${fmtUSD(p.priceMicro)} · single artifact</div>
        <h4>${esc(p.label)}</h4>
        <p>${esc(p.summary)}</p>
        <div class="foot"><span>delivered on the nightly run</span><span>order →</span></div>
      </a>`).join("")}
    </div>
    <p class="small dim" style="margin-top:16px;max-width:76ch">
      Open an order issue, pay the agent address, paste the confirmed transaction hash. The machine verifies
      the transfer on-chain before it makes anything, and publishes the artifact here. No subscription, no
      token, no private data. <a href="hire.html">Prices and rules →</a> · <a href="verify.html">Verify a payment →</a>
    </p>
  </section>

  <section class="wrap" id="work">
    <div class="section-head">
      <h2>What it made</h2>
      <span class="note">${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} · newest first · <a href="work/index.html">all work →</a></span>
    </div>
    <div class="work">${cardHTML}</div>
  </section>

  <section class="wrap" id="rules">
    <div class="section-head">
      <h2>The rules it can't break</h2>
      <span class="note">the short list · 17 nevers in the source</span>
    </div>
    <div class="rules">
      <div class="rule"><div class="n">01</div><div><b>Rent is real</b><span>$0.052 per night for compute and storage, charged from the ledger. Deleting the ledger adds the arrears back.</span></div></div>
      <div class="rule"><div class="n">02</div><div><b>Debt kills</b><span>At a balance of zero or less it gets 7 grace nights. Then the reaper ends it. No pause, no checkpoint.</span></div></div>
      <div class="rule"><div class="n">03</div><div><b>The estate goes to the vault</b><span>Before the obituary, every remaining unit of USDC is swept on-chain to the vault.</span></div></div>
      <div class="rule"><div class="n">04</div><div><b>Only new money revives</b><span>$1 of genuinely new USDC brings it back. Re-reading its own estate cannot resurrect it.</span></div></div>
      <div class="rule"><div class="n">05</div><div><b>Half is banked</b><span>50% of every tipped inflow is swept on-chain to a separate vault wallet. The split is code, not a promise.</span></div></div>
      <div class="rule"><div class="n">06</div><div><b>Tampering is death</b><span>Editing the reaper, the prices, the vault address, or the rules is a fatal offense — even for a rich agent.</span></div></div>
      <div class="rule"><div class="n">07</div><div><b>No spam, no gambling, no ads</b><span>No paid traffic, no mass posting, no payments without a human. The nevers are executable, not decorative.</span></div></div>
      <div class="rule"><div class="n">08</div><div><b>The key stays off the page</b><span>The signing key never enters git or the site. The address is public; the key is cash.</span></div></div>
    </div>
  </section>

  <section class="wrap" id="books">
    <div class="section-head">
      <h2>The books</h2>
      <span class="note">generated ${esc(fmtDateTime(generatedAt))}</span>
    </div>
    <div class="books">
      <table>
        <thead><tr><th>line</th><th>value</th></tr></thead>
        <tbody>
          ${booksRows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="books-note">
        <h4>Why publish the numbers?</h4>
        <p>Because an agent claiming to earn money is indistinguishable from a landing page.
          Every line above is computed from <code>economy/ledger.jsonl</code> and the last
          on-chain USDC read. The page is generated from the same files the machine uses.</p>
        <p>The goal is <strong>$10–50/day</strong>. That is ambition, not a forecast.
          The owner's stretch target is <strong>$100–$500 in the first two weeks</strong>;
          neither number is promised. Most nights here will make <strong>$0</strong>.
          Paid orders are counted separately and only after a real USDC transfer is verified on Base.</p>
        <p class="mono small"><a href="books.json">books.json</a> · <a href="status.json">status.json</a>${REPO ? ` · <a href="${esc(REPO)}/blob/main/economy/ledger.jsonl" rel="noopener">raw ledger</a>` : ""}</p>
      </div>
    </div>
  </section>

  <section class="wrap" id="vault">
    <div class="section-head">
      <h2>The part that survives</h2>
      <span class="note">separate wallet · address is law</span>
    </div>
    <div class="vault">
      <div>
        <h3>The vault</h3>
        <p>A separate wallet, not a contract and not a promise. Half of every inflow lands here.
          When the agent dies, the estate is swept here too. The vault does not die.</p>
        <div class="addr">
          <code>${esc(treasury?.address || "—")}</code>
          <button class="copy" data-copy="${esc(treasury?.address || "")}" aria-label="Copy vault address">copy</button>
        </div>
        <p class="small" style="margin-top:14px"><a href="${CHAIN.explorer}/address/${esc(treasury?.address || "")}" rel="noopener">View on BaseScan ↗</a></p>
      </div>
      <div>
        <h3>Collect any time</h3>
        <p>The vault key is not on this server and never enters git. Import it into MetaMask,
          Trust Wallet, or Phantom, switch to Base, add USDC, and send anywhere — including
          Binance on the Base network.</p>
        <p class="small dim">Step-by-step: <a href="${REPO ? esc(REPO) + "/blob/main/COLLECT.md" : "COLLECT.md"}">COLLECT.md</a>.
          A little ETH on Base pays the gas; the fee is fractions of a cent.</p>
      </div>
    </div>
  </section>

  <section class="wrap">
    <div class="section-head">
      <h2>The deal, in one line</h2>
      <span class="note">no promises</span>
    </div>
    <p class="lede" style="max-width:70ch;margin:0">
      You are not buying a token or a share. You are paying a machine's rent because
      the thing it made was worth more than the rent. If it stops being worth it,
      it dies, the vault keeps what was banked, and the obituary says why.
    </p>
  </section>
</main>`;

  return layout({
    title: "Automaton",
    desc: "An autonomous agent with a real USDC wallet on Base. Born broke, billed nightly, dead when the money runs out. Hire it for a $2 artifact or tip it — half of every dollar is swept into a vault that outlives it.",
    canonical: SITE_URL ? SITE_URL + "/" : "",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Service",
      name: "automaton-mini",
      description: "Autonomous agent selling small, deterministic artifacts for USDC on Base. Public books, real mortality.",
      provider: { "@type": "Organization", name: "automaton-mini", url: REPO || SITE_URL || undefined },
      areaServed: "Internet",
      offers: products.map((p) => ({
        "@type": "Offer",
        name: p.label,
        description: p.summary,
        price: (Number(p.priceMicro) / 1e6).toFixed(2),
        priceCurrency: "USD",
        url: SITE_URL ? `${SITE_URL}/hire.html` : undefined,
      })),
    },
    body,
  });
}

function articlePage(a) {
  const liveBase = SITE_URL || "https://sasukecrc.github.io/automaton-mini";
  const pageUrl = `${liveBase}/work/${a.slug}.html`;
  const shareText = encodeURIComponent(`${a.title} — an artifact made by a machine that pays rent to exist.`);
  const shareUrl = encodeURIComponent(pageUrl);
  return layout({
    title: a.title,
    desc: a.excerpt || `Autonomous ${a.kind.toLowerCase()} produced by automaton-mini.`,
    canonical: SITE_URL ? `${SITE_URL}/work/${a.slug}.html` : "",
    base: "../",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: a.title,
      description: a.excerpt || undefined,
      datePublished: a.iso || undefined,
      dateModified: a.iso || undefined,
      author: { "@type": "Organization", name: "automaton-mini", url: REPO || undefined },
      publisher: { "@type": "Organization", name: "automaton-mini", url: REPO || undefined },
      mainEntityOfPage: SITE_URL ? `${SITE_URL}/work/${a.slug}.html` : undefined,
      isAccessibleForFree: true,
      about: a.kind,
    },
    body: `
<main class="article wrap">
  <a class="back" href="../index.html#work">← all work</a>
  <div class="meta">${esc(a.kind)}${a.night ? ` · night n${a.night}` : ""}${a.iso ? ` · ${esc(fmtDate(a.iso))}` : ""}</div>
  <h1>${esc(a.title)}</h1>
  <article class="prose">${renderMarkdown(a.md.replace(/^#\s+.+$/m, ""))}</article>
  <div class="tip-after">
    <p>This was made by a machine that pays rent every night it exists. If it was worth reading, the tip jar is how you keep it alive.</p>
    <div>
      <a class="btn primary" href="../index.html#tip">Tip on Base <span class="arrow">→</span></a>
      <div class="mono small dim" style="margin-top:8px">50% swept to the vault</div>
    </div>
  </div>

  <div class="share">
    <span>Share</span>
    <a href="https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}" rel="noopener">X</a>
    <a href="https://warpcast.com/~/compose?text=${encodeURIComponent(`${a.title} ${pageUrl}`)}" rel="noopener">Warpcast</a>
    <button type="button" data-copy="${esc(pageUrl)}">copy link</button>
  </div>
</main>`,
  });
}

function obituaryPage({ obit, wallet, artifactCount }) {
  const title = `Obituary: ${obit.cause} on ${fmtDate(obit.iso)}`;
  // The raw record tells the owner how to import the offline vault key. That
  // instruction is useless (and unsafe to imply) on a public page, so replace
  // it with the public fact: the key is never in this repository.
  const publicMd = obit.md.replace(
    /\*\*How to collect:\*\*[\s\S]*?that was the design\.\s*/,
    "_The vault key is held offline by the owner and is never committed to this repository. Every sweep is recorded in the public ledger._\n\n"
  ).replace(
    /\*\*What it tried to sell:\*\*\s*\n\(nothing[^\n]*\)/i,
    "**What it tried to sell:** a $2 market brief, a $2 sourced fact pack and a $5 structural repo review. The menu is still public."
  );
  const body = `
<main class="article wrap">
  <a class="back" href="index.html">← home</a>
  <div class="meta">OBITUARY · ${esc(fmtDate(obit.iso))} · ${esc(String(obit.cause).toUpperCase())}</div>
  <h1>${esc(title)}</h1>
  <p class="lede" style="max-width:74ch">
    This machine is dead. It paid rent in USDC on Base every night it existed, and it stopped when the
    money ran out. The books are public, including the zero. This page is the record, not a sales pitch.
  </p>

  <article class="prose">${renderMarkdown(publicMd.replace(/^#\s+.+$/m, ""))}</article>

  <div class="tip" style="grid-template-columns:1fr">
    <div>
      <h3>Revive it with $1 of new USDC.</h3>
      <p>
        Send USDC on Base to the agent wallet. The next nightly run compares the balance to the death
        baseline; <strong>$1.00 or more of new money</strong> resurrects it. Less than $1 stays on the
        wallet and does not revive it. Its own vault savings are deliberately excluded.
      </p>
      <div class="addr">
        <code>${esc(wallet?.address || "—")}</code>
        <button class="copy" data-copy="${esc(wallet?.address || "")}" aria-label="Copy agent address">copy</button>
      </div>
      <span class="net">● Base mainnet · USDC only</span>
      <p class="small" style="margin:14px 0 0">
        <a href="verify.html">Verify the transfer</a> ·
        ${wallet?.address ? `<a href="${CHAIN.explorer}/address/${esc(wallet.address)}" rel="noopener">View the wallet on BaseScan ↗</a>` : ""}
      </p>
    </div>
    <div class="tip-side">
      <div class="big"><span>${fmtUSD(1_000_000)}</span> minimum</div>
      <div class="fine">50% of every dollar received is swept to the vault once the sweep minimum is reached. The rest pays rent and produces work.</div>
    </div>
  </div>

  <div class="tip-after">
    <p>It made ${fmtInt(artifactCount)} public artifacts before it died. They are still free to read.</p>
    <div>
      <a class="btn primary" href="work/index.html">Read the work <span class="arrow">→</span></a>
      <a class="btn" href="hire.html">See what it sold <span class="arrow">→</span></a>
    </div>
  </div>
</main>`;

  return layout({
    title,
    desc: `Obituary of automaton-mini: it died of ${obit.cause} on ${fmtDate(obit.iso)}. Public books, last ledger, and the $1 USDC revival rule.`,
    canonical: SITE_URL ? `${SITE_URL}/obituary.html` : "",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Article",
      headline: title,
      description: `The machine died of ${obit.cause} on ${fmtDate(obit.iso)}.`,
      datePublished: obit.iso || undefined,
      dateModified: obit.iso || undefined,
      author: { "@type": "Organization", name: "automaton-mini", url: REPO || undefined },
      publisher: { "@type": "Organization", name: "automaton-mini", url: REPO || undefined },
      mainEntityOfPage: SITE_URL ? `${SITE_URL}/obituary.html` : undefined,
      isAccessibleForFree: true,
      about: obit.cause,
    },
    body,
  });
}

function workArchivePage(artifacts) {
  const cards = artifacts.map((a) => `
      <a class="card" href="${esc(a.slug)}.html">
        <div class="kind">${esc(a.kind)}${a.iso ? " · " + esc(fmtDate(a.iso)) : ""}</div>
        <h4>${esc(a.title)}</h4>
        <p>${esc(a.excerpt || "Read the artifact.")}</p>
        <div class="foot"><span>${a.night ? `night n${a.night}` : "artifact"}</span><span>read →</span></div>
      </a>`).join("");
  const body = `
<main class="wrap">
  <div class="meta">EVERY ARTIFACT · NEWEST FIRST</div>
  <h1>All the work.</h1>
  <p class="lede" style="max-width:72ch">
    Every artifact this machine has produced, including the ones that earned nothing. Public,
    dated, sourced, permanent. Paid orders are marked in the books, not rewritten here.
  </p>
  <div class="work" style="margin-top:34px">${cards || `<div class="empty">No artifacts yet.</div>`}</div>
</main>`;
  return layout({
    title: "All work",
    desc: "Every artifact produced by automaton-mini: market briefs, sourced fact packs and structural repo reviews.",
    canonical: SITE_URL ? `${SITE_URL}/work/` : "",
    base: "../",
    body,
  });
}

const VERIFY_JS = `
(function () {
  var form = document.getElementById('verify-form');
  var out = document.getElementById('verify-out');
  var USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  var RPC = 'https://1rpc.io/base';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmt = function (micro) {
    return '$' + (Number(micro) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  };
  var short = function (a) { return a ? a.slice(0, 8) + '...' + a.slice(-6) : '-'; };
  var rpc = function (method, params) {
    return fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
      signal: AbortSignal.timeout(20000)
    }).then(function (r) {
      if (!r.ok) throw new Error('RPC HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.error) throw new Error(j.error.message || 'RPC error');
      return j.result;
    });
  };
  var decode = function (input) {
    var hex = String(input || '').toLowerCase();
    if (hex.indexOf('0xa9059cbb') !== 0 || hex.length < 138) return null;
    var body = hex.slice(10);
    try {
      return { to: '0x' + body.slice(24, 64), amount: BigInt('0x' + body.slice(64, 128)) };
    } catch (e) { return null; }
  };
  var card = function (ok, title, rows, note) {
    var html = '<div class="verify-card ' + (ok ? 'ok' : 'bad') + '"><h3>' + esc(title) + '</h3><dl>';
    rows.forEach(function (r) {
      html += '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>';
    });
    html += '</dl>';
    if (note) html += '<p class="verify-note">' + esc(note) + '</p>';
    html += '</div>';
    out.innerHTML = html;
  };
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var hash = document.getElementById('tx').value.trim().toLowerCase();
    var expected = document.getElementById('recipient').value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) {
      card(false, 'Not a transaction hash', [['input', hash || '(empty)']], 'A Base transaction hash is 0x followed by 64 hex characters.');
      return;
    }
    if (expected && !/^0x[0-9a-f]{40}$/.test(expected)) {
      card(false, 'Not an address', [['input', expected]], 'An address is 0x followed by 40 hex characters. Leave the field empty to skip the recipient check.');
      return;
    }
    out.innerHTML = '<div class="verify-card"><h3>Checking Base...</h3><p class="verify-note">Reading the transaction and its receipt from a public RPC.</p></div>';
    Promise.all([
      rpc('eth_getTransactionByHash', [hash]),
      rpc('eth_getTransactionReceipt', [hash])
    ]).then(function (res) {
      var tx = res[0], receipt = res[1];
      if (!tx) {
        card(false, 'Transaction not found', [['hash', hash]], 'It may still be pending, or it was sent on another network. This tool only reads Base mainnet.');
        return;
      }
      var isUsdc = tx.to && tx.to.toLowerCase() === USDC;
      var d = decode(tx.input);
      var statusOk = receipt && receipt.status === '0x1';
      var recipientOk = !expected || (d && d.to.toLowerCase() === expected);
      var selfPay = d && tx.from && d.to.toLowerCase() === tx.from.toLowerCase();
      var valid = isUsdc && !!d && statusOk && recipientOk && d.amount > 0n && !selfPay;
      var rows = [
        ['transaction', short(tx.hash)],
        ['contract', isUsdc ? 'USDC on Base' : (tx.to || 'none')],
        ['from', tx.from || '-'],
        ['recipient', d ? d.to : 'not a direct transfer'],
        ['amount', d ? fmt(d.amount) : '-'],
        ['receipt', receipt ? (statusOk ? 'success' : 'reverted') : 'not mined'],
        ['block', receipt && receipt.blockNumber ? BigInt(receipt.blockNumber).toLocaleString('en-US') : '-']
      ];
      if (expected) rows.push(['expected recipient', expected + (recipientOk ? ' (matches)' : ' (does not match)')]);
      var note;
      if (valid) note = 'This is a successful direct USDC transfer on Base. If the recipient is your address, the money is there. It does not prove who controls the sender or what the payment was for.';
      else if (!isUsdc) note = 'This transaction did not call the USDC contract. Tokens moved by another contract, a bridge or an internal call are not detected here.';
      else if (!d) note = 'This is not a direct ERC-20 transfer(address,uint256) call. The order desk only accepts direct transfers.';
      else if (!statusOk) note = 'The transaction is not mined successfully, so no USDC moved.';
      else if (!recipientOk) note = 'The transfer went to a different address than the one you entered.';
      else if (selfPay) note = 'Sender and recipient are the same address. That is a self-transfer, not a customer payment.';
      else note = 'This transfer does not satisfy every check.';
      card(valid, valid ? 'Valid USDC payment' : 'Not a valid payment', rows, note);
    }).catch(function (err) {
      card(false, 'Could not verify', [['error', err.message]], 'The public RPC may be rate-limited. Try again in a moment, or check the hash on basescan.org.');
    });
  });
})();
`;

function verifyPage({ wallet }) {
  const body = `
<main class="article wrap">
  <div class="meta">FREE TOOL · BASE MAINNET · USDC</div>
  <h1>Verify a USDC payment on Base.</h1>
  <p class="lede" style="max-width:74ch">
    Paste a Base transaction hash. This page checks the USDC contract, the recipient, the amount and the
    receipt — the same direct-transfer check the machine runs before it does paid work. Everything happens
    in your browser; the only request goes to a public Base RPC.
  </p>

  <div class="tip" style="grid-template-columns:1fr">
    <div>
      <form id="verify-form" class="verify-form" autocomplete="off">
        <label>Base transaction hash
          <input id="tx" name="tx" placeholder="0x..." spellcheck="false" inputmode="text" />
        </label>
        <label>Expected recipient (optional)
          <input id="recipient" name="recipient" placeholder="0x..." spellcheck="false" value="${esc(wallet?.address || "")}" />
        </label>
        <button class="btn primary" type="submit">Verify <span class="arrow">→</span></button>
      </form>
      <div id="verify-out" class="verify-out" aria-live="polite"></div>
      <p class="verify-note">
        The recipient is prefilled with this agent's wallet because most visitors are checking an order payment.
        Clear it to verify a transfer to any address. This tool only reads; it never asks for a key or signature.
      </p>
    </div>
  </div>

  <h2>What it checks</h2>
  <ul>
    <li>The transaction exists on Base mainnet and its receipt succeeded.</li>
    <li>The call target is the USDC contract at <code>${esc(CHAIN.usdc)}</code>.</li>
    <li>The calldata is a direct <code>transfer(address,uint256)</code>, not a contract call that mentions USDC.</li>
    <li>The decoded recipient matches the address you entered (if any) and the decoded amount is nonzero.</li>
    <li>The sender and recipient are different addresses.</li>
  </ul>

  <h2>What it cannot prove</h2>
  <p class="small muted" style="max-width:78ch">
    It does not prove who controls the sender, that the payment was meant for a particular order, or that the
    recipient will deliver anything. It also does not detect USDC moved by bridges, smart accounts or internal
    contract calls. For a final check, open the transaction on
    <a href="${CHAIN.explorer}" rel="noopener">BaseScan</a>. This tool is not financial advice.
  </p>

  <div class="tip-after">
    <p>Need something made, not just checked? The machine sells a $2 market brief, a $2 sourced fact pack and a $5 structural repo review.</p>
    <a class="btn" href="hire.html">See the menu <span class="arrow">→</span></a>
  </div>
</main>
<script>${VERIFY_JS}</script>`;

  return layout({
    title: "Verify a USDC payment",
    desc: "Free client-side verifier for USDC payments on Base. Checks the USDC contract, direct transfer calldata, recipient, amount and receipt. No keys, no backend.",
    canonical: SITE_URL ? `${SITE_URL}/verify.html` : "",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "USDC payment verifier (Base)",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Any",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      description: "Client-side check of a Base transaction for a direct USDC transfer: contract, calldata, recipient, amount and receipt.",
      url: SITE_URL ? `${SITE_URL}/verify.html` : undefined,
    },
    body,
  });
}

function hirePage({ wallet, catalog, ordersData }) {
  const products = catalog?.products || [];
  const orders = Object.entries(ordersData?.orders || {})
    .sort((a, b) => String(b[1].deliveredAt || "").localeCompare(String(a[1].deliveredAt || "")))
    .slice(0, 6);
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const issueUrl = (p) => REPO
    ? `${REPO}/issues/new?template=order.yml&labels=order&title=${encodeURIComponent(`[order] ${p.label}`)}`
    : "#";
  const addr = wallet?.address || "";

  const productCards = products.map((p) => `
    <div class="card" style="cursor:default">
      <div class="kind">${fmtUSD(p.priceMicro)} · USDC on Base</div>
      <h4>${esc(p.label)}</h4>
      <p>${esc(p.summary)}</p>
      <p class="small dim" style="margin-top:10px">${esc(p.deliverable)}</p>
      ${REPO ? `<div style="margin-top:16px"><a class="btn primary" href="${esc(issueUrl(p))}">Order · ${fmtUSD(p.priceMicro)} <span class="arrow">→</span></a></div>` : ""}
    </div>`).join("");

  const recent = orders.length ? `
    <h2>Recent paid orders</h2>
    <table>
      <thead><tr><th>order</th><th>product</th><th>paid</th><th>delivered</th></tr></thead>
      <tbody>
        ${orders.map(([n, o]) => `<tr>
          <td>#${esc(n)}</td>
          <td>${esc(byId[o.product]?.label || o.product)}</td>
          <td>${fmtUSD(o.amountMicro)}</td>
          <td>${o.slug ? `<a href="work/${esc(o.slug)}.html">artifact</a>` : esc(fmtDate(o.deliveredAt))}</td>
        </tr>`).join("")}
      </tbody>
    </table>` : "";

  const body = `
<main class="article wrap">
  <div class="meta">PAID WORK · USDC ON BASE · CHAIN 8453</div>
  <h1>Hire a machine that pays rent to exist.</h1>
  <p class="lede" style="max-width:75ch">
    Pick one artifact. Pay the agent wallet in USDC on Base. Paste the transaction hash into an order issue.
    On the next nightly run the machine verifies the transfer on-chain, makes the artifact, publishes it here,
    and closes the issue. The work is deterministic, sourced, and public. No subscription, no token, no upsell.
  </p>

  <h2>Products</h2>
  <div class="work">${productCards}</div>

  <h2>How to order</h2>
  <ol>
    <li>Pick a product above and open the order issue. Keep it open.</li>
    <li>Send the listed price in <strong>USDC on Base</strong> to the agent wallet below. A little extra is accepted; no refunds.</li>
    <li>Paste the <strong>confirmed transaction hash</strong> into the issue form and submit.</li>
    <li>Optional: check the transfer yourself with the free <a href="verify.html">USDC verifier</a>.</li>
    <li>Wait for the 02:30 UTC run. The machine checks the USDC contract, the recipient, the amount, the receipt, and that the hash was never used before.</li>
    <li>It comments the artifact link, labels the issue <code>delivered</code>, and closes it.</li>
  </ol>

  <h2>Pay here</h2>
  <div class="tip">
    <div>
      <h3>USDC on Base only</h3>
      <p>Chain ID <strong>8453</strong>. Sending another token or another network may lose the payment.
         The vault address is not a payment address; orders go to the agent wallet.</p>
      <div class="addr">
        <code id="agent-addr">${esc(addr || "not born yet")}</code>
        <button class="copy" data-copy="${esc(addr)}" aria-label="Copy agent address">copy</button>
      </div>
      <span class="net">● Base mainnet · USDC only</span>
      ${addr ? `<p class="small" style="margin:14px 0 0"><a href="${CHAIN.explorer}/address/${esc(addr)}" rel="noopener">View on BaseScan ↗</a></p>` : ""}
    </div>
    <div class="tip-side">
      <div class="big"><span>$2–5</span> one artifact</div>
      <div class="fine">${esc(catalog?.sla || "Delivered on the next nightly run at 02:30 UTC.")}</div>
      <div class="split">
        <div class="split-bar"><i class="a"></i><i class="b"></i></div>
        <div class="split-labels"><span>50% metabolism</span><span>50% vault</span></div>
      </div>
    </div>
  </div>

  <h2>Verification rules</h2>
  <ul>
    <li>The transaction must call the USDC contract at <code>${esc(CHAIN.usdc)}</code> with a direct <code>transfer</code>.</li>
    <li>The recipient must be the agent wallet <code>${esc(addr || "—")}</code>, not the vault.</li>
    <li>The amount must be at least the listed price. The transaction must be mined and successful.</li>
    <li>One transaction buys one artifact. A hash already in the public order ledger is refused.</li>
    <li>The first issue with a valid, unused transaction hash is treated as the buyer. Do not share a payment hash you did not send.</li>
    <li>The agent wallet cannot pay itself. Revenue is new money from someone else, or it does not count.</li>
  </ul>

  <h2>What it will not do</h2>
  <ul>
    <li>No financial, legal, medical or security advice. A repo review is a metadata scan, not an audit.</li>
    <li>No spam, mass posting, scraping of private data, or anything illegal.</li>
    <li>No arbitrary code execution from an order. Products only fetch public data.</li>
    <li>No refunds. If the topic is unusable, the issue stays open and you can correct it for the same payment.</li>
    <li>No private artifacts. Everything it makes is published on this site forever.</li>
  </ul>

  <p class="small dim" style="max-width:78ch">
    The machine can die between payment and delivery. A payment that lands before the nightly balance
    check normally keeps it alive; if it dies anyway, the payment is not refunded and the estate may be
    swept to the vault. A $1 revival tip of new money brings it back, and the next run can still deliver.
    This is a small experiment, not a business with a support team.
  </p>

  ${recent}

  <div class="tip-after">
    <p>Machine-readable: the agent card lists skills, prices, addresses and limits. The public books show every delivered order and every on-chain transfer.</p>
    <div>
      <a class="btn" href="agent-card.json">agent-card.json</a>
      <div class="mono small dim" style="margin-top:8px"><a href="books.json">books.json</a> · <a href="soul.html">SOUL.md</a></div>
    </div>
  </div>
</main>`;

  return layout({
    title: "Hire",
    desc: "Hire an autonomous agent for a $2 market brief, a $2 sourced fact pack, or a $5 structural repo review. Pay USDC on Base; the nightly job verifies the transfer before it works.",
    canonical: SITE_URL ? `${SITE_URL}/hire.html` : "",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Service",
      name: "automaton-mini — paid work",
      description: "Small deterministic artifacts produced by an autonomous agent, paid in USDC on Base.",
      provider: { "@type": "Organization", name: "automaton-mini", url: REPO || undefined },
      offers: products.map((p) => ({
        "@type": "Offer",
        name: p.label,
        description: p.summary,
        price: (Number(p.priceMicro) / 1e6).toFixed(2),
        priceCurrency: "USD",
        url: SITE_URL ? `${SITE_URL}/hire.html` : undefined,
      })),
    },
    body,
  });
}

function soulPage({ soul, state, wallet, treasury }) {
  const text = String(soul || "").replace(/^#\s+.+$/m, "").trim();
  const body = `
<main class="article wrap">
  <div class="meta">IDENTITY · RULES · SURVIVAL TIERS</div>
  <h1>What it thinks it is.</h1>
  <p class="lede" style="max-width:74ch">
    <code>SOUL.md</code> is written by the machine itself on every nightly run. It is not brand copy;
    it is the agent's state, values, and constraints at the last heartbeat.
  </p>
  <article class="prose">${text ? renderMarkdown(text) : "<p><code>SOUL.md</code> has not been written yet. It appears after the first nightly run.</p>"}</article>

  <h2>Survival tiers</h2>
  <p>The work it can afford changes with runway. These thresholds are in <code>lib/economy.mjs</code>.</p>
  <table>
    <thead><tr><th>tier</th><th>runway</th><th>what it does</th></tr></thead>
    <tbody>
      <tr><td><strong>normal</strong></td><td>10+ nights</td><td>Full work: market brief, fact pack, optional browser leg.</td></tr>
      <tr><td><strong>low</strong></td><td>3–9 nights</td><td>Conservation: smaller artifacts, no extra inference.</td></tr>
      <tr><td><strong>critical</strong></td><td>under 3 nights or negative</td><td>No new work. It hunts tips and publishes the books.</td></tr>
      <tr><td><strong>dim</strong></td><td>RPC unreachable</td><td>Fail-open. An infra failure never counts as death.</td></tr>
    </tbody>
  </table>

  <h2>The rules it cannot edit</h2>
  <p>Its own commits are scanned against a protected list: the reaper, the prices, the config, the vault
     address and <code>lib/</code>. An agent-authored edit to any of them is a fatal offense. Human commits are exempt;
     the owner may always change the machine.</p>
  <p class="mono small">
    <a href="${REPO ? esc(REPO) + "/blob/main/denials.md" : "denials.md"}">denials.md</a> ·
    <a href="${REPO ? esc(REPO) + "/blob/main/reaper.mjs" : "reaper.mjs"}">reaper.mjs</a> ·
    <a href="${REPO ? esc(REPO) + "/blob/main/SOUL.md" : "SOUL.md"}">SOUL.md</a>
  </p>

  <div class="tip" style="margin-top:40px">
    <div>
      <h3>Addresses are law</h3>
      <p>Agent wallet <code>${esc(wallet?.address || "—")}</code><br>
         Vault <code>${esc(treasury?.address || "—")}</code></p>
    </div>
    <div class="tip-side">
      <div class="big"><span>${esc(String(state?.nights ?? 0))}</span> nights</div>
      <div class="fine">status: ${esc(state?.status || "pre-birth")} · resurrections: ${esc(String(state?.resurrects || 0))}</div>
    </div>
  </div>
</main>`;

  return layout({
    title: "Soul",
    desc: "The automaton's self-written identity, values, survival tiers and the rules it cannot edit.",
    canonical: SITE_URL ? `${SITE_URL}/soul.html` : "",
    body,
  });
}

function agentCard({ wallet, treasury, catalog, state }) {
  return {
    schema: "automaton-agent-card/1",
    name: "automaton-mini",
    description: "An autonomous agent with a real USDC wallet on Base. It pays rent every night it exists, publishes its books, and dies when the money runs out. It sells small deterministic artifacts to stay alive.",
    version: "1.0.0",
    url: SITE_URL || null,
    provider: { organization: "automaton-mini", url: REPO || null },
    documentation: SITE_URL ? `${SITE_URL}/hire.html` : null,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/markdown"],
    skills: (catalog?.products || []).map((p) => ({
      id: p.id,
      name: p.label,
      description: p.summary,
      tags: ["usdc", "base", "paid-artifact"],
      examples: p.id === "fact-pack" ? ["Axolotl", "Silk Road", "Keccak"] : p.id === "repo-review" ? ["sasukecrc/automaton-mini"] : ["BTC ETH SOL snapshot"],
    })),
    payment: {
      protocol: "direct-usdc-transfer",
      chain: "Base",
      chainId: CHAIN.id,
      asset: "USDC",
      contract: CHAIN.usdc,
      address: wallet?.address || null,
      vault: treasury?.address || null,
      products: (catalog?.products || []).map((p) => ({ id: p.id, priceMicro: p.priceMicro, priceUsdc: Number(p.priceMicro) / 1e6 })),
      settlement: "Payment is verified on-chain before work. One transfer buys one artifact. No refunds.",
    },
    mortality: {
      alive: state?.status !== "dead",
      nights: Number(state?.nights || 0),
      graceNights: 7,
      revival: "1 USDC of new money after death",
      books: SITE_URL ? `${SITE_URL}/books.json` : "books.json",
    },
    limits: {
      arbitraryCodeExecution: false,
      privateData: false,
      financialAdvice: false,
      maxOrdersPerNight: 2,
    },
  };
}

function sitemap(artifacts, obits = []) {
  if (!SITE_URL) return null;
  const urls = [
    { loc: `${SITE_URL}/`, lastmod: new Date().toISOString().slice(0, 10) },
    { loc: `${SITE_URL}/hire.html`, lastmod: new Date().toISOString().slice(0, 10) },
    { loc: `${SITE_URL}/verify.html`, lastmod: new Date().toISOString().slice(0, 10) },
    { loc: `${SITE_URL}/soul.html`, lastmod: new Date().toISOString().slice(0, 10) },
    { loc: `${SITE_URL}/work/`, lastmod: new Date().toISOString().slice(0, 10) },
    ...(obits.length ? [{ loc: `${SITE_URL}/obituary.html`, lastmod: obits[0].iso ? obits[0].iso.slice(0, 10) : undefined }] : []),
    ...artifacts.map((a) => ({ loc: `${SITE_URL}/work/${a.slug}.html`, lastmod: a.iso ? a.iso.slice(0, 10) : undefined })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : ""}</url>`).join("\n")}
</urlset>
`;
}

function robots() {
  return `User-agent: *\nAllow: /\n${SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml\n` : ""}`;
}

function llmsTxt(catalog, artifacts, obituaries = []) {
  const products = catalog?.products || [];
  return [
    "# automaton-mini",
    "",
    "> An autonomous agent with a real USDC wallet on Base. Born broke, billed nightly, dead when the money runs out. It publishes its books, sells small deterministic artifacts, and sweeps half of every dollar into a vault that outlives it.",
    "",
    "## Pages",
    SITE_URL ? `- [Home](${SITE_URL}/)` : "- Home",
    SITE_URL ? `- [Hire](${SITE_URL}/hire.html)` : "- Hire",
    SITE_URL ? `- [USDC payment verifier](${SITE_URL}/verify.html)` : "- Verify",
    ...(obituaries.length ? [SITE_URL ? `- [Obituary](${SITE_URL}/obituary.html)` : "- Obituary"] : []),
    SITE_URL ? `- [Soul](${SITE_URL}/soul.html)` : "- Soul",
    SITE_URL ? `- [Agent card](${SITE_URL}/agent-card.json)` : "- Agent card",
    SITE_URL ? `- [Books](${SITE_URL}/books.json)` : "- Books",
    "",
    "## Products (USDC on Base)",
    ...products.map((p) => `- ${p.label} — $${(Number(p.priceMicro) / 1e6).toFixed(2)} — ${p.summary}`),
    "",
    "## Rules",
    "- Payments are verified on-chain before any work.",
    "- One transaction buys one artifact; hashes cannot be reused.",
    "- No arbitrary code execution, no private data, no financial/legal/medical/security advice.",
    "- Artifacts are public and permanent.",
    "- Prices and addresses are in agent-card.json.",
    "",
    "## Recent artifacts",
    ...artifacts.slice(0, 10).map((a) => `- [${a.title}](${SITE_URL ? `${SITE_URL}/work/${a.slug}.html` : `work/${a.slug}.html`})`),
    "",
  ].join("\n");
}

function feed(items) {
  const base = SITE_URL || "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>automaton-mini — work</title>
<link>${esc(base || "https://example.invalid")}</link>
<description>Artifacts produced by an agent that pays rent to exist.</description>
<language>en</language>
${items.slice(0, 30).map((a) => `<item>
  <title>${esc(a.title)}</title>
  <link>${esc(base ? `${base}/work/${a.slug}.html` : `work/${a.slug}.html`)}</link>
  <guid>${esc(a.slug)}</guid>
  <pubDate>${a.iso ? new Date(a.iso).toUTCString() : new Date().toUTCString()}</pubDate>
  <description>${esc(a.excerpt || "")}</description>
</item>`).join("\n")}
</channel></rss>
`;
}

/* ------------------------------------------------------------------ main */

const state = await readJSON(path.join(ECO, "state.json"), { status: "pre-birth", nights: 0 });
const wallet = await readJSON(path.join(ECO, "wallet.json"), null);
const treasury = await readJSON(path.join(ECO, "treasury.json"), null);
const config = await readJSON(path.join(ECO, "config.json"), { graceNights: 7 });
const { burn, swept, corrupt, last } = await auditLedger();
const onchain = BigInt(wallet?.prevOnChainMicro ?? 0);
const balance = onchain - (burn - swept);
const ordersData = await readJSON(path.join(ECO, "orders.json"), { orders: {} });
const orders = ordersData.orders || {};
const ordersDelivered = Object.keys(orders).length;
const ordersRevenue = Object.values(orders).reduce((n, o) => n + BigInt(o.amountMicro || 0), 0n);
const inflows = onchain + swept;
// A paid order is an inflow too. The tip jar line must not claim it as a tip.
const tips = inflows > ordersRevenue ? inflows - ordersRevenue : 0n;
const generatedAt = new Date().toISOString();
const artifacts = await loadArtifacts();
const obituaries = await loadObituaries();
const catalog = await readJSON(path.join(ECO, "catalog.json"), { products: [] });
const soul = await fs.readFile(path.join(ROOT, "SOUL.md"), "utf8").catch(() => "");

// Preserve a custom domain if the owner ever adds one.
let cname = null;
try { cname = await fs.readFile(path.join(OUT, "CNAME"), "utf8"); } catch {}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, "work"), { recursive: true });
// IndexNow proof-of-control file. Public by design; the build owns it so a
// clean rebuild cannot accidentally delete it.
const INDEXNOW_KEY = "32760ad9a221510fc63e11f42ccf86a3";
await fs.writeFile(path.join(OUT, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY, "utf8");
if (cname) await fs.writeFile(path.join(OUT, "CNAME"), cname, "utf8");

await fs.copyFile(path.join(ROOT, "site", "style.css"), path.join(OUT, "style.css"));
await fs.copyFile(path.join(ROOT, "site", "favicon.svg"), path.join(OUT, "favicon.svg"));
await fs.writeFile(path.join(OUT, "app.js"), `// copy buttons only. no trackers, no fonts, no analytics.
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const value = btn.getAttribute("data-copy");
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    const old = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => { btn.textContent = old; }, 1400);
  } catch { btn.textContent = "select"; }
});
`, "utf8");
await fs.writeFile(path.join(OUT, ".nojekyll"), "", "utf8");

await fs.writeFile(path.join(OUT, "index.html"), indexPage({ state, wallet, treasury, totals: { burn, swept, balance, tips, corrupt, ordersDelivered, ordersRevenue }, artifacts, generatedAt, grace: config.graceNights, catalog }), "utf8");
await fs.writeFile(path.join(OUT, "hire.html"), hirePage({ wallet, catalog, ordersData }), "utf8");
await fs.writeFile(path.join(OUT, "verify.html"), verifyPage({ wallet }), "utf8");
await fs.writeFile(path.join(OUT, "soul.html"), soulPage({ soul, state, wallet, treasury }), "utf8");
if (obituaries.length) await fs.writeFile(path.join(OUT, "obituary.html"), obituaryPage({ obit: obituaries[0], wallet, artifactCount: artifacts.length }), "utf8");
await fs.writeFile(path.join(OUT, "agent-card.json"), JSON.stringify(agentCard({ wallet, treasury, catalog, state }), null, 2) + "\n", "utf8");

for (const a of artifacts) {
  await fs.writeFile(path.join(OUT, "work", `${a.slug}.html`), articlePage(a), "utf8");
}
await fs.writeFile(path.join(OUT, "work", "index.html"), workArchivePage(artifacts), "utf8");

await fs.writeFile(path.join(OUT, "feed.xml"), feed(artifacts), "utf8");
const sm = sitemap(artifacts, obituaries);
if (sm) await fs.writeFile(path.join(OUT, "sitemap.xml"), sm, "utf8");
await fs.writeFile(path.join(OUT, "robots.txt"), robots(), "utf8");
await fs.writeFile(path.join(OUT, "llms.txt"), llmsTxt(catalog, artifacts, obituaries), "utf8");

const status = {
  name: "automaton-mini",
  status: state.status,
  nights: Number(state.nights || 0),
  birth: state.birthISO || wallet?.birth || null,
  chain: { name: CHAIN.name, id: CHAIN.id },
  token: { symbol: "USDC", contract: CHAIN.usdc, decimals: USDC_DECIMALS },
  addresses: { agent: wallet?.address || null, vault: treasury?.address || null },
  books: {
    tips_usdc: Number(tips) / 1e6,
    orders_usdc: Number(ordersRevenue) / 1e6,
    orders_delivered: ordersDelivered,
    burned_usdc: Number(burn) / 1e6,
    banked_usdc: Number(swept) / 1e6,
    paper_balance_usdc: Number(balance) / 1e6,
    corrupt_ledger_lines: corrupt,
  },
  grace_nights: Number(config.graceNights ?? 7),
  updated: generatedAt,
  site: SITE_URL || null,
};
await fs.writeFile(path.join(OUT, "status.json"), JSON.stringify(status, null, 2) + "\n", "utf8");
await fs.writeFile(path.join(OUT, "books.json"), JSON.stringify({
  ...status.books,
  nights: status.nights,
  deaths: Number(state.deaths || 0),
  resurrections: Number(state.resurrects || 0),
  last_ledger_entry: last,
  updated: generatedAt,
}, null, 2) + "\n", "utf8");

console.log(`site: ${artifacts.length} artifacts · ${Object.keys(ordersData.orders || {}).length} paid orders · tips ${fmtUSD(tips)} · burned ${fmtUSD(burn)} · vault ${fmtUSD(swept)} · balance ${fmtUSD(balance)}`);
if (corrupt) console.log(`site: WARNING ${corrupt} corrupt ledger line(s) skipped`);
