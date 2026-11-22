/**
 * Sec-MS-GEC v2 token generation — a faithful TypeScript port of the
 * DRM code in rany2/edge-tts (src/edge_tts/drm.py, release 7.3.0+).
 *
 * Why this file exists: since ~Nov 2025 Microsoft's Edge TTS endpoint
 * rejects the v1 token (plain SHA-256 hex, `Sec-MS-GEC-Version: 1-...`)
 * with 403. The v2 token (release 7.3.0, commit ba61d94) changed TWO
 * things, not one:
 *
 *  1. `Sec-MS-GEC-Version` is now `2-<Chromium version>` (was `1-...`).
 *  2. The token VALUE is now `<16 hex>-<64 hex>`: a CS64 checksum
 *     plus a *custom* SHA-256-variant digest of the same input string
 *     (`"<Windows file-time ticks floored to 5 min><TrustedClientToken>"`).
 *     The SHA-256 variant tweaks the initial state, one round constant
 *     and the sigma functions, so Node's plain `crypto.createHash('sha256')`
 *     produces a DIFFERENT digest and still 403s. Only this ported
 *     algorithm produces the token Microsoft accepts.
 *
 * The hash INPUT is unchanged from v1 (same ticks string + same public
 * TrustedClientToken constant). What changed is the hash FUNCTION.
 *
 * Verified against the real Python implementation (edge-tts 7.3.1,
 * installed in ~/workspace/movie-recap-demo/venv): for fixed Unix
 * timestamps this module returns byte-identical tokens, e.g.
 *   0          -> 52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6
 *   1700000000 -> 2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2
 *   1763790000 -> 4C2495C997677154-2B34E071CBD7EBBE7D186A20F03EBC024F5FD0E3315F75B8E34BBE47C99ADDB5
 *
 * All arithmetic is unsigned 32-bit. JS bitwise ops are int32, so every
 * value is normalised with `>>> 0` and every 32-bit multiplication uses
 * Math.imul (a plain `a * b` would lose low bits above 2^53).
 */

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
// NOTE: NOT a private key — the public constant shipped in the Edge
// browser itself and in every edge-tts client. No secret is used.

const WIN_EPOCH = 11_644_473_600n; // seconds between 1601-01-01 and 1970-01-01

// --- Custom SHA-256 constants (drm.py) ------------------------------------
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab,
  0xfeb0a7e4, 0x03effbd2,
];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491,
  0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33,
  0xd258b060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;

const CS64_COEFFICIENTS: Array<[number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

// --- u32 helpers ------------------------------------------------------------
const u32 = (n: number): number => n >>> 0;
const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;
const rol16 = (v: number): number => (((v & 0xffffffff) << 16) | ((v & 0xffffffff) >>> 16)) >>> 0;

function wordsLe4Even(data: Buffer): number[] {
  const paddedLen = data.length + ((-data.length) % 4 + 4) % 4;
  const padded = Buffer.alloc(paddedLen);
  data.copy(padded);
  const words: number[] = [];
  for (let i = 0; i < paddedLen; i += 4) words.push(padded.readUInt32LE(i));
  if (words.length % 2 === 1) words.push(0);
  return words;
}

const sigma0 = (x: number): number => u32(rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3));
const sigma1 = (x: number): number => u32(rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10));
const bigSigma0 = (x: number): number => u32(rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22));
const bigSigma1 = (x: number): number => u32(rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25));
const ch = (x: number, y: number, z: number): number => u32((x & y) ^ (~x & z));
const maj = (x: number, y: number, z: number): number =>
  u32((x & y) ^ (x & z) ^ (y & z));

/**
 * SHA-256 compression rounds. drm.py's version is an 8-round-unrolled
 * optimisation of the standard round function (its `rot_e = e * 2**32+1`
 * trick is just ROTR expressed with big-int shifts); this plain loop
 * performs the identical rounds, starting at `firstRound`, with the
 * block constants (round 14 replaced) when firstRound is 14.
 */
function sha256Rounds(state: number[], words: number[], firstRound = 0): number[] {
  const K = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = firstRound; i < 64; i++) {
    const t1 = u32(h + bigSigma1(e) + ch(e, f, g) + K[i] + words[i]);
    const t2 = u32(bigSigma0(a) + maj(a, b, c));
    h = g;
    g = f;
    f = e;
    e = u32(d + t1);
    d = c;
    c = b;
    b = a;
    a = u32(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSha256Schedule(words: number[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i++) {
    const x = words[i - 2];
    const y = words[i - 15];
    const s1 = sigma1(x);
    const s0 = sigma0(y);
    words.push(u32(s1 + words[i - 7] + s0 + words[i - 16]));
  }
}

/** Initial SHA-256 state for the token data (first 7 bytes). */
function sha256Init(data: Buffer): number[] {
  const words: number[] = new Array<number>(14).fill(0);
  words.push(((data[0] << 16) | (data[1] << 8) | data[2]) >>> 0);
  words.push(
    ((data[3] << 24) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0,
  );
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      value += i === 16 ? u32(sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) : sigma1(words[i - 2]);
    }
    if (i - 7 >= 14) value += words[i - 7];
    if (i - 15 >= 14) {
      value += i === 29 ? u32(sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) : sigma0(words[i - 15]);
    }
    words.push(u32(value));
  }
  words.push(
    u32(
      sigma1(words[28]) +
        words[23] +
        sigma0(words[15]) +
        words[14] +
        SHA256_ADJUSTMENT -
        SHA256_ROUND_CONSTANTS[14],
    ),
  );
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => u32(x + working[i]));
}

/** The custom SHA-256-variant digest for token data. */
function sha256Digest(data: Buffer): Buffer {
  if (data.length < 7) throw new Error('Token salt must contain at least seven bytes');
  const length = 57 + data.length;
  const zeroPad = (((55 - length) % 64) + 64) % 64;
  const bitLen = Buffer.alloc(8);
  bitLen.writeBigUInt64BE(BigInt(length) * 8n);
  const padded = Buffer.concat([
    data.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc(zeroPad),
    bitLen,
  ]);
  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words: number[] = [];
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(off + i * 4));
    expandSha256Schedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((x, i) => u32(x + working[i]));
  }
  const out = Buffer.alloc(32);
  state.forEach((w, i) => out.writeUInt32BE(w, i * 4));
  return out;
}

/** CS64 checksum words for the token data. */
function cs64Digest(data: Buffer, digest: Buffer): [number, number] {
  let keyA = digest.readUInt32LE(0) | 1;
  let keyB = digest.readUInt32LE(4) | 1;
  keyA = u32(keyA);
  keyB = u32(keyB);
  const factors = [u32(Math.imul(keyA, CS64_FACTOR)), u32(Math.imul(keyB, CS64_FACTOR))];
  const terms: number[] = CS64_COEFFICIENTS.map(([coeff], i) =>
    u32(Math.imul(coeff, factors[i % 2])),
  );
  const offsets: number[] = CS64_COEFFICIENTS.map(([, off]) => off);
  const prefixed = Buffer.concat([Buffer.from([0]), data]);
  for (const [index, word] of wordsLe4Even(prefixed).entries()) {
    let term = u32(Math.imul(word, index % 2 === 0 ? keyA : keyB));
    let offset = u32(Math.imul(rol16(word), index % 2 === 0 ? 0xef0569fb : 0xc31713db));
    if (index === 0) {
      term = u32(term + Math.imul(CS64_ADJUSTMENT0, factors[0]));
      offset = u32(offset + CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  }
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16(u32(offsets[i] + x));
    let q = u32(Math.imul(t, 0x76f50f34));
    swapAcc = u32(swapAcc + u32(Math.imul(rol16(q), 0xc3efea97) + q));
    t = rol16(u32(offsets[i + 1] + y));
    q = u32(Math.imul(t, 0x1881ce3c));
    swapLast = u32(Math.imul(rol16(q), 0x35bd1ec9) + q);
    swapAcc = u32(swapAcc + swapLast);

    state = u32(Math.imul(state, keyA) + x);
    state = u32(Math.imul(rol16(state), 0xcf98b111));
    state = u32(Math.imul(rol16(state), 0x87085b9f));
    state = u32(Math.imul(rol16(state), 0x12ceb96d));
    state = u32(Math.imul(rol16(state), 0x257e1d83));
    acc = u32(acc + state);
    t = u32(Math.imul(state, keyB) + y);
    t = u32(Math.imul(rol16(t), 0xa27416f5));
    t = u32(Math.imul(rol16(t), 0xd38396ff));
    state = u32(Math.imul(rol16(u32(Math.imul(rol16(t), 0x7c932b89))), 0xbfa49f69));
    acc = u32(acc + state);
  }
  return [u32(swapLast ^ state), u32(swapAcc ^ acc)];
}

function tokenHash(data: Buffer): [string, string] {
  const digest = sha256Digest(data);
  const [w0, w1] = cs64Digest(data, digest);
  const cs64Buf = Buffer.alloc(8);
  cs64Buf.writeUInt32LE(w0, 0);
  cs64Buf.writeUInt32LE(w1, 4);
  return [cs64Buf.toString('hex').toUpperCase(), digest.toString('hex').toUpperCase()];
}

/**
 * Sec-MS-GEC v2 token: "<CS64>-<SHA256>" for the current time.
 * Pass an explicit Unix timestamp (seconds, may be fractional) only for
 * testing against the Python implementation.
 * Ticks exceed Number.MAX_SAFE_INTEGER, so BigInt is used — float math
 * would silently lose precision on the ~1.3e17 tick value.
 */
export function generateSecMsGecV2(unixSeconds?: number): string {
  const unix = BigInt(Math.floor(unixSeconds ?? Date.now() / 1000));
  const winSeconds = unix + WIN_EPOCH;
  const floored = winSeconds - (winSeconds % 300n);
  const ticks = floored * 10_000_000n; // seconds -> 100ns intervals
  const strToHash = `${ticks.toString()}${TRUSTED_TOKEN}`;
  const [cs64, sha256] = tokenHash(Buffer.from(strToHash, 'ascii'));
  return `${cs64}-${sha256}`;
}
