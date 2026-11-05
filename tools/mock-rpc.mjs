// tools/mock-rpc.mjs — a local Base JSON-RPC that behaves like the chain for the
// subset this agent uses. It does NOT trust anything: every raw transaction is
// RLP-decoded, its digest rebuilt, and its signer recovered with secp256k1 — a
// badly signed or misdirected transfer is rejected by the mock, so the soak
// genuinely exercises lib/eth.mjs end to end.
import http from "node:http";
import { keccak256 } from "../lib/keccak.mjs";
import { ecdsaRecover, rlp } from "../lib/eth.mjs";

const GAS_PRICE = 100_000_000n; // 0.1 gwei
const GAS_USED = 60_000n;

const hexOf = (v) => "0x" + BigInt(v).toString(16);
const pad32 = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");

/* ── minimal RLP decode (just enough to read a signed type-2 tx) ── */
function item(buf, off) {
  const c = buf[off];
  if (c < 0x80) return { v: buf.subarray(off, off + 1), end: off + 1 };
  if (c <= 0xb7) { const L = c - 0x80; return { v: buf.subarray(off + 1, off + 1 + L), end: off + 1 + L }; }
  if (c <= 0xbf) {
    const n = c - 0xb7;
    const L = Number(BigInt("0x" + buf.subarray(off + 1, off + 1 + n).toString("hex")));
    return { v: buf.subarray(off + 1 + n, off + 1 + n + L), end: off + 1 + n + L };
  }
  if (c <= 0xf7) { const L = c - 0xc0; return { v: list(buf, off + 1, off + 1 + L), end: off + 1 + L }; }
  const n = c - 0xf7;
  const L = Number(BigInt("0x" + buf.subarray(off + 1, off + 1 + n).toString("hex")));
  return { v: list(buf, off + 1 + n, off + 1 + n + L), end: off + 1 + n + L };
}
function list(buf, s, e) { const out = []; let o = s; while (o < e) { const r = item(buf, o); out.push(r.v); o = r.end; } return out; }

const big = (b) => b.length ? BigInt("0x" + b.toString("hex")) : 0n;

export async function startMockChain() {
  const usdc = new Map();  // lower address → micro-USDC
  const eth = new Map();   // lower address → wei
  const nonce = new Map();
  const receipts = new Map();
  const transfers = [];    // verified movements, for the soak report

  const at = (a) => String(a).toLowerCase();

  function applySignedTx(raw) {
    if (!raw.startsWith("0x02")) throw new Error("only type-2 transactions are accepted");
    const buf = Buffer.from(raw.slice(4), "hex");
    const { v: f } = item(buf, 0);
    if (!Array.isArray(f) || f.length !== 12) throw new Error("malformed type-2 tx");
    const [chainId, nonceB, tipB, feeB, gasB, toB, valueB, dataB, accessList, yB, rB, sB] = f;
    const head = [chainId, nonceB, tipB, feeB, gasB, toB, valueB, dataB, accessList];
    const digest = keccak256(Buffer.concat([Buffer.from([0x02]), rlp(head)]));
    const from = ecdsaRecover(digest, big(rB), big(sB), big(yB));
    if (big(chainId) !== 8453n) throw new Error("wrong chain id");

    // ERC-20 transfer(to, amount)
    const selector = dataB.subarray(0, 4).toString("hex");
    if (selector !== "a9059cbb") throw new Error("only ERC-20 transfer is supported");
    const to = "0x" + dataB.subarray(4 + 12, 4 + 32).toString("hex");
    const micro = big(dataB.subarray(36, 68));

    const n = nonce.get(at(from)) ?? 0n;
    if (big(nonceB) !== n) throw new Error(`bad nonce: got ${big(nonceB)}, expected ${n}`);

    const bal = usdc.get(at(from)) ?? 0n;
    if (bal < micro) throw new Error("insufficient USDC balance");
    const gasCost = GAS_USED * GAS_PRICE;
    const e = eth.get(at(from)) ?? 0n;
    if (e < gasCost) throw new Error("insufficient ETH for gas");

    usdc.set(at(from), bal - micro);
    usdc.set(at(to), (usdc.get(at(to)) ?? 0n) + micro);
    eth.set(at(from), e - gasCost);
    nonce.set(at(from), n + 1n);

    const hash = "0x" + keccak256(Buffer.from(raw.slice(2), "hex")).toString("hex");
    receipts.set(hash, { status: "0x1", transactionHash: hash, blockNumber: "0x1", gasUsed: hexOf(GAS_USED) });
    transfers.push({ from, to, micro: micro.toString(), hash });
    return hash;
  }

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      try {
        const { id, method, params } = JSON.parse(body || "{}");
        let result = null;
        switch (method) {
          case "eth_blockNumber": result = hexOf(0x100n + BigInt(transfers.length)); break;
          case "eth_gasPrice": result = hexOf(GAS_PRICE); break;
          case "eth_getBalance": result = hexOf(eth.get(at(params[0])) ?? 0n); break;
          case "eth_getTransactionCount": result = hexOf(nonce.get(at(params[0])) ?? 0n); break;
          case "eth_call": {
            const data = params[0].data;
            if (!data.startsWith("0x70a08231")) throw new Error("unsupported eth_call");
            // calldata = 0x + selector(8) + 32-byte word; the address is the
            // final 40 hex chars of that word. (Deriving it by byte offsets is
            // off-by-prefix bait — this is the invariant that matters.)
            const addr = "0x" + data.slice(-40);
            result = pad32(usdc.get(at(addr)) ?? 0n);
            break;
          }
          case "eth_sendRawTransaction": result = applySignedTx(params[0]); break;
          case "eth_getTransactionReceipt": result = receipts.get(String(params[0]).toLowerCase()) ?? null; break;
          default: throw new Error(`unsupported method ${method}`);
        }
        send({ jsonrpc: "2.0", id, result });
      } catch (e) {
        send({ jsonrpc: "2.0", id: JSON.parse(body || "{}").id ?? null, error: { code: -32000, message: e.message } });
      }
    });
  });

  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((ok) => server.close(ok)),
    transfers,
    usdcOf: (a) => usdc.get(at(a)) ?? 0n,
    ethOf: (a) => eth.get(at(a)) ?? 0n,
    tip: (a, micro) => usdc.set(at(a), (usdc.get(at(a)) ?? 0n) + BigInt(micro)),
    giveEth: (a, wei) => eth.set(at(a), (eth.get(at(a)) ?? 0n) + BigInt(wei)),
  };
}
