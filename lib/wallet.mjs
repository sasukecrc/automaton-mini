// lib/wallet.mjs — REAL Ethereum address derivation + live on-chain balance reads.
// $0 deps: pure BigInt secp256k1 (from scratch). No node JWK tricks, no ethers.
import crypto from "node:crypto";
import { keccak256 } from "./keccak.mjs";

/* ── secp256k1 ── */
const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const G = [
  0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n
];
const O = [0n, 0n]; // point at infinity
const INV = (a, m) => { let r = 1n, b = a % m, e = m - 2n; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
const mod = (a) => ((a % P) + P) % P;

function padd(A, B) {
  if (A === O) return B;
  if (B === O) return A;
  const [x1, y1] = A, [x2, y2] = B;
  if (x1 === x2) {
    if (mod(y1 + y2) === 0n) return O;
    const s = mod(3n * x1 * x1 * INV(2n * mod(y1), P));
    const x3 = mod(s * s - 2n * x1);
    return [x3, mod(s * (x1 - x3) - y1)];
  }
  const s = mod((y2 - y1) * INV(mod(x2 - x1), P));
  const x3 = mod(s * s - x1 - x2);
  return [x3, mod(s * (x1 - x3) - y1)];
}
function pmul(k, A) {
  let R = O, B = A;
  while (k > 0n) { if (k & 1n) R = padd(R, B); B = padd(B, B); k >>= 1n; }
  return R;
}

/** public key (x,y) for private scalar d */
export function publicPoint(d) { return pmul(mod(d), G); }

/** REAL Ethereum address from a private scalar (BigInt). */
export function addressFromScalar(d) {
  const [x, y] = publicPoint(d);
  const buf = Buffer.concat([Buffer.from(x.toString(16).padStart(64, "0"), "hex"),
                             Buffer.from(y.toString(16).padStart(64, "0"), "hex")]);
  return "0x" + keccak256(buf).subarray(12).toString("hex");
}

/** Generate a REAL wallet: key (gitignored) + address (public). */
export function newWallet() {
  let d;
  do { d = BigInt("0x" + crypto.randomBytes(32).toString("hex")); } while (d === 0n || d >= N);
  return { address: addressFromScalar(d), d };
}

/* ── the agent's private scalar ── */
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The agent's signing key, in priority order:
 *   1. AUTOMATON_AGENT_KEY (CI secret — GitHub Actions has no gitignored files)
 *   2. economy/key.json (local dev, gitignored)
 * Returns null when neither exists (the agent can read the chain but not sign).
 */
export async function agentKey() {
  const env = process.env.AUTOMATON_AGENT_KEY;
  if (env) return BigInt(env.startsWith("0x") ? env : "0x" + env);
  try {
    const j = JSON.parse(await fs.readFile(path.resolve("economy", "key.json"), "utf8"));
    const hex = String(j.d ?? "").replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("malformed key file");
    return BigInt("0x" + hex);
  } catch { return null; }
}

/* ── on-chain reads (free public RPC, no key) ── */
export async function rpc(method, params, url = process.env.BASE_RPC ?? "https://mainnet.base.org") {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(15000) // a hung RPC must never hang a night
      });
      if (!res.ok) throw new Error(`RPC ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error("RPC error: " + JSON.stringify(j.error));
      return j.result;
    } catch (e) { if (attempt === 1) throw e; }
  }
}

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
const balanceOf = (addr) => "0x70a08231" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** Real USDC balance in base units (6 decimals) → BigInt micro-USDC. */
export async function usdcBalance(address) {
  return BigInt(await rpc("eth_call", [{ to: USDC_BASE, data: balanceOf(address) }, "latest"]));
}
/** Real ETH balance in wei → BigInt (future gas money). */
export async function ethBalance(address) {
  return BigInt(await rpc("eth_getBalance", [address, "latest"]));
}

export const fmtUsd = (micro) =>
  (micro < 0n ? "-$" : "$") + (Number(micro < 0n ? -micro : micro) / 1e6).toFixed(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".00");

/** powmod that never explodes BigInt (squaring 256-bit with huge exponent would). */
const modPow = (a, e, m) => { let r = 1n; a %= m; while (e > 0n) { if (e & 1n) r = r * a % m; a = a * a % m; e >>= 1n; } return r; };

/* ── selftest: prove the math against authoritative sources ── */
async function selftest() {
  let ok = true;

  // V1/V1b — Ethereum constants that appear in every chain spec:
  //   EMPTY_TRIE_ROOT  = keccak256(rlp("") = 0x80)
  //   EMPTY_UNCLE_HASH = keccak256(rlp([]) = 0xc0)
  const v1 = keccak256(Buffer.from("80", "hex")).toString("hex");
  const e1 = "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";
  console.log("keccak(0x80)    =", v1, v1 === e1 ? "✅ EMPTY_TRIE_ROOT" : "❌");
  ok &&= v1 === e1;
  const v1b = keccak256(Buffer.from("c0", "hex")).toString("hex");
  const e1b = "1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";
  console.log("keccak(0xc0)    =", v1b, v1b === e1b ? "✅ EMPTY_UNCLE_HASH" : "❌");
  ok &&= v1b === e1b;

  // V1c — published Keccak-256 vectors + padding-boundary regressions.
  // (The 135/136/5000-byte values were generated once with a reference
  // implementation and are now frozen here — no dependency at test time.)
  for (const [name, bytes, expected] of [
    ["empty", Buffer.alloc(0), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    ["abc", Buffer.from("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
    ["hello", Buffer.from("hello"), "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8"],
    ["fox", Buffer.from("The quick brown fox jumps over the lazy dog"), "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15"],
    ["a135", Buffer.alloc(135, 0x61), "34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446"],
    ["a136", Buffer.alloc(136, 0x61), "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e"],
    ["a5000", Buffer.alloc(5000, 0x61), "0cc854aed53cf0515b8b526168f364066fd2a3cf03ef62a0b4900f906202ecc5"]
  ]) {
    const mine = keccak256(bytes).toString("hex");
    console.log(`keccak(${name.padEnd(7)}) =`, mine === expected ? "✅ vector" : `❌ ${mine}`);
    ok &&= mine === expected;
  }

  // V2 — EIP-155 example (eips.ethereum.org/EIPS/eip-155): private key 32×0x46,
  // official signing hash + (r,s). Verifying it proves the curve math
  // (P, N, G, add, double, modular inverse) and, transitively, pubkey derivation.
  const d = 0x4646464646464646464646464646464646464646464646464646464646464646n;
  const h = 0xdaf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53n;
  const r = 18515461264373351373200002665853028612451056578545711640558177340181847433846n;
  const s = 46948507304638947509940763649030358759909902576025900602547168820602576006531n;
  // field identity check (curve is sound only if sqrt+recover coherent):
  let yR = modPow(mod(r * r * r + 7n), (P + 1n) / 4n, P); // p ≡ 3 mod 4
  if ((yR & 1n) !== 0n) yR = P - yR;
  const onCurve = mod(yR * yR) === mod(r * r * r + 7n);
  console.log("R on curve      =", onCurve ? "✅ sqrt(y²)=x³+7 mod p closed" : "❌");
  ok &&= onCurve;
  // recover R only as a cross-artifact; the signature verifies against Q = d·G
  const u1 = (h * modInv(s, N)) % N, u2 = (r * modInv(s, N)) % N;
  const Q = publicPoint(d); // known signer pubkey (this is what V3 derives)
  const X = padd(pmul(u1, G), pmul(u2, Q));
  const verified = X !== O && mod(X[0]) % N === r % N;
  console.log("EIP-155 ECDSA   =", verified ? "✅ official (r,s) verifies — curve math is REAL" : "❌ curve math wrong");
  ok &&= verified;

  // V3 — sender address of that example (exists live on etherscan/polygonscan).
  const a = addressFromScalar(d);
  const e3 = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
  console.log("addr(32×0x46)   =", a, a === e3 ? "✅ EIP-155 sender" : `❌ expected ${e3}`);
  ok &&= a === e3;

  console.log(ok ? "SELFTEST PASS — keccak + secp256k1 + addressing are REAL." : "SELFTEST FAIL — do not trust any balances until fixed.");
  process.exitCode = ok ? 0 : 1;
}

const modInv = (a, m) => { let r = 1n, b = ((a % m) + m) % m, e = m - 2n; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };

// selftest only when wallet.mjs itself is the entry file (imports must not re-trigger it)
if (process.argv[2] === "selftest" && /wallet\.mjs$/.test(process.argv[1] ?? "")) selftest();
