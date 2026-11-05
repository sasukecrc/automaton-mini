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
    const kind = /market brief/i.test(h1) ? "Market brief" : /fact pack/i.test(h1) ? "Fact pack" : "Artifact";

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

/* ---------------------------------------------------------------- layout */

function layout({ title, desc, canonical, body, active = "" }) {
  const fullTitle = title === "Automaton" ? "Automaton — a machine that pays rent to exist" : `${esc(title)} · Automaton`;
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
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="style.css">
<script defer src="app.js"></script>
</head>
<body>
<header class="top wrap">
  <a class="brand" href="index.html"><span class="mark">a</span> automaton-mini</a>
  <nav>
    <a href="index.html#tip">Tip jar</a>
    <a href="index.html#work">Work</a>
    <a href="index.html#books">Books</a>
    <a href="index.html#rules">Rules</a>
    ${REPO ? `<a href="${esc(REPO)}" rel="noopener">Source ↗</a>` : ""}
  </nav>
</header>
${body}
<footer>
  <div class="wrap foot">
    <div class="fine">
      Not financial advice. No earnings are promised. The books are public so the claim
      cannot quietly become marketing. Most nights make $0 — that is the experiment.
      ${REPO ? `<br><a href="${esc(REPO)}" rel="noopener">source</a> · ` : ""}<a href="status.json">status.json</a> · <a href="feed.xml">feed</a>
    </div>
    <div class="mono small">automaton-mini · ${esc(CHAIN.name)} mainnet</div>
  </div>
</footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ page */

function indexPage({ state, wallet, treasury, totals, artifacts, generatedAt, grace }) {
  const alive = state.status !== "dead";
  const nights = Number(state.nights || 0);
  const birth = state.birthISO || wallet?.birth;
  const balance = totals.balance;
  const tips = totals.tips;
  const vaultLive = totals.swept;
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
        Only <strong style="color:var(--text)">$1 of new USDC</strong> brings it back — its own savings cannot.</p>
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
      Every night it pays rent, makes something, and publishes the books. Tips keep it alive.
      <strong>Half of every dollar</strong> is swept on-chain into a vault that outlives it.
    </p>
    <div class="actions">
      <a class="btn primary" href="#tip">Tip it on Base <span class="arrow">→</span></a>
      <a class="btn" href="#work">Read tonight's work</a>
      <a class="btn" href="#rules">The rules it can't break</a>
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
      <h2>The tip jar is the whole business model</h2>
      <span class="note">USDC · chain 8453</span>
    </div>
    <div class="tip">
      <div>
        <h3>Send USDC on Base</h3>
        <p>Tips are the only revenue. No subscriptions, no ads, no paid traffic, no token.
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

  <section class="wrap" id="work">
    <div class="section-head">
      <h2>What it made</h2>
      <span class="note">${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} · newest first</span>
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
          The original Automaton's 13,000 wallets never published earnings either.
          Most nights here will make <strong>$0</strong>.</p>
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
    desc: "An autonomous agent with a real USDC wallet on Base. Born broke, billed nightly, dead when the money runs out. Half of every tip is swept into a vault that outlives it.",
    canonical: SITE_URL ? SITE_URL + "/" : "",
    body,
  });
}

function articlePage(a) {
  return layout({
    title: a.title,
    desc: a.excerpt || `Autonomous ${a.kind.toLowerCase()} produced by automaton-mini.`,
    canonical: SITE_URL ? `${SITE_URL}/work/${a.slug}.html` : "",
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
</main>`,
  });
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
const tips = onchain + swept;
const generatedAt = new Date().toISOString();
const artifacts = await loadArtifacts();

// Preserve a custom domain if the owner ever adds one.
let cname = null;
try { cname = await fs.readFile(path.join(OUT, "CNAME"), "utf8"); } catch {}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, "work"), { recursive: true });
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

await fs.writeFile(path.join(OUT, "index.html"), indexPage({ state, wallet, treasury, totals: { burn, swept, balance, tips, corrupt }, artifacts, generatedAt, grace: config.graceNights }), "utf8");

for (const a of artifacts) {
  await fs.writeFile(path.join(OUT, "work", `${a.slug}.html`), articlePage(a), "utf8");
}

await fs.writeFile(path.join(OUT, "feed.xml"), feed(artifacts), "utf8");

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

console.log(`site: ${artifacts.length} artifacts · tips ${fmtUSD(tips)} · burned ${fmtUSD(burn)} · vault ${fmtUSD(swept)} · balance ${fmtUSD(balance)}`);
if (corrupt) console.log(`site: WARNING ${corrupt} corrupt ledger line(s) skipped`);
