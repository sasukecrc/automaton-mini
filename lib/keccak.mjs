// lib/keccak.mjs — Keccak-256 (Ethereum flavor). From scratch, $0 deps.
// NOTE: Keccak padding is 0x01/0x80 — NOT NIST SHA3's 0x06. This is the
// one detail every "why doesn't my address match" bug comes from.

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

// Rotation offsets for lane index = x + 5y  (i.e., listed column-major).
// Verified against canonical table  r[x][y]:
//   x=0: 0,36, 3,41,18   x=1: 1,44,10,45, 2   x=2: 62, 6,43,15,61
//   x=3: 28,55,25,21,56  x=4: 27,20,39, 8,14
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14
];

const MASK = (1n << 64n) - 1n;
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(st) {
  for (let round = 0; round < 24; round++) {
    // θ
    const C = new Array(5);
    for (let x = 0; x < 5; x++)
      C[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
    const D = new Array(5);
    for (let x = 0; x < 5; x++)
      D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++)
        st[x + 5 * y] = (st[x + 5 * y] ^ D[x]) & MASK;
    // ρ + π
    const B = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) {
        const nx = y, ny = (2 * x + 3 * y) % 5;
        B[nx + 5 * ny] = rotl(st[x + 5 * y], ROT[x + 5 * y]);
      }
    // χ
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++)
        st[x + 5 * y] = (B[x + 5 * y] ^ (((~B[(x + 1) % 5 + 5 * y]) & MASK) & B[(x + 2) % 5 + 5 * y])) & MASK;
    // ι
    st[0] = (st[0] ^ RC[round]) & MASK;
  }
}

function keccak256(msg) {
  const rate = 136; // bytes (1088-bit rate, Keccak-256)
  const bytes = Buffer.from(msg);
  // pad: msg || 0x01 || 0x00... || last-byte |0x80
  const q = rate - (bytes.length % rate);
  const padded = Buffer.concat([bytes, Buffer.alloc(q)]);
  padded[bytes.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const st = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--)
        lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      st[i] ^= lane;
    }
    keccakF(st);
  }
  // first 32 bytes of the state, lane by lane, little-endian
  const out = Buffer.alloc(32);
  for (let l = 0; l < 4; l++) {
    let v = st[l];
    for (let b = 0; b < 8; b++) {
      out[l * 8 + b] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

export { keccak256 };
