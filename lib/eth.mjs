// lib/eth.mjs — REAL EIP-1559 transaction signing on Base, from scratch. $0 deps.
// rlp + secp256k1 ECDSA (RFC6979 deterministic k) + signer recovery + send.
// Proven in `selftest`: sign → parse raw → recover the sender → must equal the
// signer's real address. Nothing is trusted that can't recover itself.
import crypto from "node:crypto";
import { keccak256 } from "./keccak.mjs";

/* ── secp256k1 ── */
export const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
export const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const G = [
  0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n
];
const O = [0n, 0n];
const mod = (a, m = P) => ((a % m) + m) % m;
export function modPow(a, e, m) { let r = 1n; a %= m; while (e > 0n) { if (e & 1n) r = r * a % m; a = a * a % m; e >>= 1n; } return r; }
export const modInv = (a, m) => modPow(((a % m) + m) % m, m - 2n, m);
function padd(A, B) {
  if (A === O) return B;
  if (B === O) return A;
  const [x1, y1] = A, [x2, y2] = B;
  if (x1 === x2) {
    if (mod(y1 + y2) === 0n) return O;
    const s = mod(3n * x1 * x1 * modInv(2n * mod(y1), P));
    const x3 = mod(s * s - 2n * x1);
    return [x3, mod(s * (x1 - x3) - y1)];
  }
  const s = mod((y2 - y1) * modInv(mod(x2 - x1), P));
  const x3 = mod(s * s - x1 - x2);
  return [x3, mod(s * (x1 - x3) - y1)];
}
export function pmul(k, A) { let R = O, B = A; while (k > 0n) { if (k & 1n) R = padd(R, B); B = padd(B, B); k >>= 1n; } return R; }

/* ── RLP ── */
function rlpUint(v) {
  if (v === 0n) return Buffer.alloc(0);
  let hex = v.toString(16); if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex"); // minimal BE
}
function rlpItem(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  if (b.length <= 55) return Buffer.concat([Buffer.from([0x80 + b.length]), b]);
  const len = rlpUint(BigInt(b.length));
  return Buffer.concat([Buffer.from([0xb7 + len.length]), len, b]);
}
export function rlp(arr) {
  const body = Buffer.concat(arr.map(x => x instanceof Buffer ? rlpItem(x) : rlp(x)));
  if (body.length <= 55) return Buffer.concat([Buffer.from([0xc0 + body.length]), body]);
  const len = rlpUint(BigInt(body.length));
  return Buffer.concat([Buffer.from([0xf7 + len.length]), len, body]);
}

/* ── RFC6979 deterministic k ── */
function rfc6979K(d, hash) {
  const x = Buffer.from(d.toString(16).padStart(64, "0"), "hex");
  let k = Buffer.alloc(32, 0x01), v = Buffer.alloc(32, 0x00);
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  k = hmac(k, Buffer.concat([v, Buffer.from([0x00]), x, hash]));
  v = hmac(k, v);
  k = hmac(k, Buffer.concat([v, Buffer.from([0x01]), x, hash]));
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const cand = BigInt("0x" + v.toString("hex"));
    if (cand > 0n && cand < N) return cand;
    k = hmac(k, Buffer.concat([v, Buffer.from([0x00])]));
    v = hmac(k, v);
  }
}

/** ECDSA sign (EIP-2 low-s normalized). Returns { r, s, yParity } */
export function ecdsaSign(d, hash) {
  const h = BigInt("0x" + hash.toString("hex")); // hash may arrive as bytes
  const k = rfc6979K(d, hash);
  const R = pmul(k, G);
  const r = mod(R[0], N);
  let s = mod(modInv(k, N) * (mod(h, N) + r * mod(d, N)), N);
  let yParity = (R[1] & 1n) === 1n ? 1n : 0n;
  if (s > N / 2n) { s = N - s; yParity ^= 1n; } // s = -s ⇒ R = -R ⇒ parity flips (EIP-2)
  return { r, s, yParity };
}

/** Recover the signer address from a digest + signature. */
export function ecdsaRecover(hash, r, s, yParity) {
  const h = BigInt("0x" + hash.toString("hex")); // hash may arrive as bytes
  const y2 = mod(r * r * r + 7n);
  let y = modPow(y2, (P + 1n) / 4n, P); // p ≡ 3 mod 4
  if (((y & 1n) === 1n) !== (yParity === 1n)) y = P - y;
  // SEC1 4.1.6 recovery: Q = r⁻¹·(s·R − e·G)  ⇔  Q = uR·R + uG·G
  const uR = mod(s * modInv(r, N), N);
  const uG = mod(N - mod(h * modInv(r, N), N), N); // −e·r⁻¹ mod N
  const Q = padd(pmul(uR, [r, y]), pmul(uG, G));
  const xy = Buffer.concat([Buffer.from(Q[0].toString(16).padStart(64, "0"), "hex"),
    Buffer.from(Q[1].toString(16).padStart(64, "0"), "hex")]);
  return "0x" + keccak256(xy).subarray(12).toString("hex");
}

/* ── EIP-1559 (type-2) tx ── */
function b32(v) { return Buffer.from(v.toString(16).padStart(64, "0"), "hex"); }
function addrBytes(a) { return Buffer.from(a.replace(/^0x/, "").toLowerCase(), "hex"); }
export function usdcTransferData(to, micro) {
  return Buffer.concat([Buffer.from("a9059cbb", "hex"), Buffer.alloc(12, 0), addrBytes(to), b32(micro)]);
}

/** Build + sign an ERC-20 USDC transfer on Base. d = BigInt private key. */
export function signUsdcTransfer({ d, to, micro, chainId = 8453n, nonce, maxFeeGas, maxPriorityGas = 10_000_000n, gasLimit = 80_000n }) {
  const data = usdcTransferData(to, micro);
  const head = [rlpUint(chainId), rlpUint(nonce), rlpUint(maxPriorityGas), rlpUint(maxFeeGas),
    rlpUint(gasLimit), addrBytes(to), rlpUint(0n), data, Buffer.from("c0", "hex")];
  const digest = keccak256(Buffer.concat([Buffer.from([0x02]), rlp(head)]));
  const { r, s, yParity } = ecdsaSign(d, digest);
  const raw = "0x02" + rlp([...head, Buffer.from([Number(yParity)]), b32(r), b32(s)]).toString("hex");
  return { raw, digest: "0x" + digest.toString("hex") };
}

/** Send signed raw tx, poll for the receipt. Returns {hash, status} */
export async function sendRaw(raw, rpc = process.env.BASE_RPC ?? "https://mainnet.base.org") {
  const j = await (await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] })
  })).json();
  if (j.error) throw new Error("broadcast: " + JSON.stringify(j.error).slice(0, 200));
  const hash = j.result;
  for (let i = 0; i < 45; i++) {          // Base blocks ~2s
    await new Promise(ok => setTimeout(ok, 2000));
    const q = await (await fetch(rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] })
    }).catch(() => ({ json: () => null }))).json();
    if (q?.result) return { hash, status: Number(BigInt(q.result.status)) };
  }
  return { hash, status: null };
}

/** Next usable account nonce (pending pool aware). */
export async function nextNonce(address, rpc = process.env.BASE_RPC ?? "https://mainnet.base.org") {
  const j = await (await fetch(rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [address, "pending"] })
  })).json();
  if (j.error) throw new Error("nonce: " + JSON.stringify(j.error).slice(0, 120));
  return BigInt(j.result ?? "0x0");
}

/** Parse r, s, yParity back out of a signed type-2 raw (RLP walk). */
const hexN = (b) => b.length ? Number(BigInt("0x" + b.toString("hex"))) : 0;
export function extractSigParts(raw) {
  const buf = Buffer.from(raw.replace(/^0x02/, ""), "hex");
  const c0 = buf[0];
  let payload;
  if (c0 <= 0xf7) payload = buf.subarray(1, 1 + (c0 - 0xc0));
  else {
    const n = c0 - 0xf7;
    const len = hexN(buf.subarray(1, 1 + n));
    payload = buf.subarray(1 + n, 1 + n + len);
  }
  const fields = [];
  let off = 0;
  while (off < payload.length && fields.length < 13) {
    const c = payload[off];
    if (c < 0x80) { fields.push(payload.subarray(off, off + 1)); off += 1; }
    else if (c <= 0xb7) { const len = c - 0x80; fields.push(payload.subarray(off + 1, off + 1 + len)); off += 1 + len; }
    else if (c <= 0xbf) { const nb = c - 0xb7; const len = hexN(payload.subarray(off + 1, off + 1 + nb)); const s = off + 1 + nb; fields.push(payload.subarray(s, s + len)); off = s + len; }
    else if (c <= 0xf7) { const len = c - 0xc0; fields.push(payload.subarray(off + 1, off + 1 + len)); off += 1 + len; }
    else { const n = c - 0xf7; const len = hexN(payload.subarray(off + 1, off + 1 + n)); const s = off + 1 + n; fields.push(payload.subarray(s, s + len)); off = s + len; }
  }
  const readBig = (b) => b.length === 0 ? 0n : BigInt("0x" + b.toString("hex"));
  return { yParity: readBig(fields[9]), r: readBig(fields[10]), s: readBig(fields[11]) };
}

/* ── selftest: sign → parse → recover, three random wallets, plus k-stability ── */
if (process.argv[2] === "selftest") {
  const { newWallet } = await import("./wallet.mjs");
  let ok = true;

  for (let trial = 0; trial < 3; trial++) {
    const { address, d } = newWallet();
    const to = "0x" + Buffer.from(crypto.randomBytes(20)).toString("hex");
    const micro = BigInt(trial + 1) * 1_000_000n, nonce = BigInt(trial * 7 + 3);
    const maxPriorityGas = 10_000_000n, maxFeeGas = 2_000_000_000n;
    const data = usdcTransferData(to, micro);
    const unsignedHead = [rlpUint(8453n), rlpUint(nonce), rlpUint(maxPriorityGas), rlpUint(maxFeeGas),
      rlpUint(80_000n), addrBytes(to), rlpUint(0n), data, Buffer.from("c0", "hex")];
    const digest = keccak256(Buffer.concat([Buffer.from([0x02]), rlp(unsignedHead)]));
    const { raw } = signUsdcTransfer({ d, to, micro, chainId: 8453n, nonce, maxFeeGas, maxPriorityGas });
    const parts = extractSigParts(raw);
    const recovered = ecdsaRecover(digest, parts.r, parts.s, parts.yParity);
    const pass = recovered === address && raw.startsWith("0x02");
    console.log(`sign→recover ${trial}:`, pass ? "✅ signer recovered from the raw tx" : `❌ ${recovered} ≠ ${address}`);
    ok &&= pass;
  }

  // RFC6979 determinism: same (key, hash) → same signature, always
  const { d } = newWallet();
  const H = Buffer.from("daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53", "hex");
  const a1 = ecdsaSign(d, H), a2 = ecdsaSign(d, H);
  const stable = a1.r === a2.r && a1.s === a2.s && a1.r > 0n && a1.s > 0n;
  console.log("RFC6979 stable  =", stable ? "✅" : "❌");
  ok &&= stable;

  console.log(ok ? "ETH SELFTEST PASS — the agent can really sign and sweep." : "ETH SELFTEST FAIL — sweeps stay disabled.");
  process.exitCode = ok ? 0 : 1;
}
