/**
 * Minimal, dependency-free Solana primitives for the BAGZ Worker:
 * base58, compact-u16, v0/legacy message compilation (with address lookup tables), transaction parsing,
 * Ed25519 signature checks (WebCrypto), and the few instructions BAGZ builds itself.
 *
 * Message layout follows the Solana transaction format (docs: solana.com/docs/core/transactions):
 *   [0x80 if v0] header(3) · compact(keys) · keys · blockhash(32) · compact(ixs) · ixs · [v0: compact(lookups) · lookups]
 * Static key order: writable signers (fee payer first), read-only signers, writable non-signers, read-only non-signers.
 */

// ---- base58 -----------------------------------------------------------------------------------------------------
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHA].map((c, i) => [c, i]));
export function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHA[d]).join('');
}
export function b58decode(s) {
  if (typeof s !== 'string') throw new Error('base58: not a string');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < s.length; i++) {
    const v = MAP.get(s[i]);
    if (v === undefined) throw new Error('base58: invalid character');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}
/** true for a base58 string that decodes to exactly 32 bytes (a Solana public key) */
export function isPubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
}
export const pk = (s) => { const b = b58decode(s); if (b.length !== 32) throw new Error(`Not a public key: ${String(s).slice(0, 12)}`); return b; };

// ---- base64 -----------------------------------------------------------------------------------------------------
export const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function b64encode(b) { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }

// ---- compact-u16 ------------------------------------------------------------------------------------------------
export function compactU16(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('compact-u16 out of range');
  const out = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); return out; } }
}
export function readCompactU16(buf, off) {
  let n = 0, shift = 0, i = 0;
  for (;;) {
    if (off + i >= buf.length) throw new Error('compact-u16: truncated');
    const b = buf[off + i++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [n, i];
    shift += 7;
    if (i >= 3) throw new Error('compact-u16: too long');
  }
}

const u64le = (v) => { const b = new Uint8Array(8); let x = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const u32le = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
export const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- well-known programs --------------------------------------------------------------------------------------------
export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
};
export const MINTS = { wsol: 'So11111111111111111111111111111111111111112', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };

export const setComputeUnitLimitIx = (units) => ({ programId: PROGRAMS.computeBudget, accounts: [], data: concat([Uint8Array.of(2), u32le(units)]) });
export const setComputeUnitPriceIx = (microLamports) => ({ programId: PROGRAMS.computeBudget, accounts: [], data: concat([Uint8Array.of(3), u64le(microLamports)]) });
/** SPL Token transferChecked. Extra read-only accounts (e.g. a Solana Pay reference) may be appended; the program ignores them. */
export function transferCheckedIx({ source, mint, destination, owner, amount, decimals, tokenProgram = PROGRAMS.token, references = [] }) {
  return {
    programId: tokenProgram,
    accounts: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      ...references.map((r) => ({ pubkey: r, isSigner: false, isWritable: false })),
    ],
    data: concat([Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals)]),
  };
}
export const memoIx = (text) => ({ programId: PROGRAMS.memo, accounts: [], data: new TextEncoder().encode(text) });

/** Jupiter's JSON instruction ({programId, accounts:[{pubkey,isSigner,isWritable}], data: base64}) → internal form */
export function fromApiInstruction(ix) {
  if (!ix || typeof ix.programId !== 'string' || !Array.isArray(ix.accounts) || typeof ix.data !== 'string') throw new Error('Malformed instruction from Jupiter');
  return { programId: ix.programId, accounts: ix.accounts.map((a) => ({ pubkey: a.pubkey, isSigner: !!a.isSigner, isWritable: !!a.isWritable })), data: b64decode(ix.data) };
}

// ---- message compilation ----------------------------------------------------------------------------------------
/**
 * Compiles a message. With `lookupTables` ([{key, addresses:[…]}]) it produces a v0 message, otherwise legacy.
 * Returns { bytes, staticKeys, header, lookups }.
 */
export function compileMessage({ payer, instructions, recentBlockhash, lookupTables = null }) {
  const metas = new Map();
  const touch = (key, signer, writable, invoked = false) => {
    if (!isPubkey(key)) throw new Error(`Invalid account key ${String(key).slice(0, 12)}`);
    const m = metas.get(key) || { signer: false, writable: false, invoked: false };
    m.signer ||= signer; m.writable ||= writable; m.invoked ||= invoked;
    metas.set(key, m);
  };
  touch(payer, true, true);
  for (const ix of instructions) {
    touch(ix.programId, false, false, true);
    for (const a of ix.accounts) touch(a.pubkey, a.isSigner, a.isWritable);
  }

  const lookups = [];
  if (lookupTables) {
    for (const t of lookupTables) {
      const w = [], r = [], wKeys = [], rKeys = [];
      t.addresses.forEach((addr, idx) => {
        const m = metas.get(addr);
        if (!m || m.signer || m.invoked || addr === payer) return;
        (m.writable ? w : r).push(idx); (m.writable ? wKeys : rKeys).push(addr);
        metas.delete(addr);
      });
      if (w.length || r.length) lookups.push({ key: t.key, writable: w, readonly: r, writableKeys: wKeys, readonlyKeys: rKeys });
    }
  }

  const keys = [...metas.entries()];
  const pick = (f) => keys.filter(([k, m]) => k !== payer && f(m)).map(([k]) => k);
  const writableSigners = [payer, ...pick((m) => m.signer && m.writable)];
  const readonlySigners = pick((m) => m.signer && !m.writable);
  const writableNon = pick((m) => !m.signer && m.writable);
  const readonlyNon = pick((m) => !m.signer && !m.writable);
  const staticKeys = [...writableSigners, ...readonlySigners, ...writableNon, ...readonlyNon];
  if (staticKeys.length > 255) throw new Error('Too many accounts');
  const header = [writableSigners.length + readonlySigners.length, readonlySigners.length, readonlyNon.length];

  const index = new Map(staticKeys.map((k, i) => [k, i]));
  let next = staticKeys.length;
  for (const l of lookups) for (const k of l.writableKeys) index.set(k, next++);
  for (const l of lookups) for (const k of l.readonlyKeys) index.set(k, next++);
  if (next > 256) throw new Error('Too many accounts after lookups');

  const bh = typeof recentBlockhash === 'string' ? pk(recentBlockhash) : Uint8Array.from(recentBlockhash);
  if (bh.length !== 32) throw new Error('Blockhash must be 32 bytes');

  const parts = [];
  if (lookupTables) parts.push(Uint8Array.of(0x80));
  parts.push(Uint8Array.from(header), Uint8Array.from(compactU16(staticKeys.length)), ...staticKeys.map(pk), bh, Uint8Array.from(compactU16(instructions.length)));
  for (const ix of instructions) {
    const idxs = ix.accounts.map((a) => index.get(a.pubkey));
    parts.push(Uint8Array.of(index.get(ix.programId)), Uint8Array.from(compactU16(idxs.length)), Uint8Array.from(idxs), Uint8Array.from(compactU16(ix.data.length)), ix.data);
  }
  if (lookupTables) {
    parts.push(Uint8Array.from(compactU16(lookups.length)));
    for (const l of lookups) parts.push(pk(l.key), Uint8Array.from(compactU16(l.writable.length)), Uint8Array.from(l.writable), Uint8Array.from(compactU16(l.readonly.length)), Uint8Array.from(l.readonly));
  }
  const bytes = concat(parts);
  if (bytes.length > 1232 - 1 - 64 * header[0]) throw new Error(`Transaction too large (${bytes.length} byte message)`);
  return { bytes, staticKeys, header, lookups };
}

/** wire transaction with empty signature slots */
export const unsignedTransaction = (messageBytes, numSigners) => concat([Uint8Array.from(compactU16(numSigners)), new Uint8Array(64 * numSigners), messageBytes]);

/** Splits a wire transaction into signatures and message, and decodes the message's static keys and instructions. */
export function parseTransaction(bytes) {
  const [n, l] = readCompactU16(bytes, 0);
  if (n < 1 || n > 12) throw new Error('Bad signature count');
  let off = l;
  const signatures = [];
  for (let i = 0; i < n; i++) { signatures.push(bytes.subarray(off, off + 64)); off += 64; }
  if (off >= bytes.length) throw new Error('Transaction truncated');
  const message = bytes.subarray(off);
  return { signatures, message, decoded: decodeMessage(message) };
}
export function decodeMessage(m) {
  let o = 0;
  const v0 = (m[0] & 0x80) !== 0;
  if (v0) { if ((m[0] & 0x7f) !== 0) throw new Error('Unsupported message version'); o = 1; }
  const header = [m[o], m[o + 1], m[o + 2]]; o += 3;
  const [nk, a] = readCompactU16(m, o); o += a;
  const staticKeys = [];
  for (let i = 0; i < nk; i++) { staticKeys.push(b58encode(m.subarray(o, o + 32))); o += 32; }
  const blockhash = b58encode(m.subarray(o, o + 32)); o += 32;
  const [ni, b] = readCompactU16(m, o); o += b;
  const instructions = [];
  for (let i = 0; i < ni; i++) {
    const programIdIndex = m[o++];
    const [na, c] = readCompactU16(m, o); o += c;
    const accounts = Array.from(m.subarray(o, o + na)); o += na;
    const [nd, d] = readCompactU16(m, o); o += d;
    instructions.push({ programIdIndex, accounts, data: m.subarray(o, o + nd) }); o += nd;
  }
  const lookups = [];
  if (v0) {
    const [nl, e] = readCompactU16(m, o); o += e;
    for (let i = 0; i < nl; i++) {
      const key = b58encode(m.subarray(o, o + 32)); o += 32;
      const [nw, f] = readCompactU16(m, o); o += f; const writable = Array.from(m.subarray(o, o + nw)); o += nw;
      const [nr, g] = readCompactU16(m, o); o += g; const readonly = Array.from(m.subarray(o, o + nr)); o += nr;
      lookups.push({ key, writable, readonly });
    }
  }
  if (o !== m.length) throw new Error('Trailing bytes in message');
  return { version: v0 ? 0 : 'legacy', header, staticKeys, blockhash, instructions, lookups };
}

/** Address lookup table account data → addresses (56-byte header, then 32-byte keys). */
export function parseLookupTable(data) {
  if (data.length < 56 || (data.length - 56) % 32 !== 0) throw new Error('Not an address lookup table');
  if (new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 1) throw new Error('Lookup table not initialised');
  const out = [];
  for (let o = 56; o < data.length; o += 32) out.push(b58encode(data.subarray(o, o + 32)));
  return out;
}

// ---- crypto -------------------------------------------------------------------------------------------------------
export async function verifyEd25519(pubkeyB58, message, signature) {
  try {
    const key = await crypto.subtle.importKey('raw', pk(pubkeyB58), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch { return false; }
}
export async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
