/**
 * worker/solana.js against fixed vectors and against an independent implementation (Solana Kit 8.5.0, test-only bundle).
 * Messages compiled by BAGZ are decoded by Kit's own decoder and compared account-by-account, role-by-role.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import * as sol from '../worker/solana.js';
// @ts-ignore vendored reference
import * as kit from './vendor/solana-kit-ref.mjs';

const rnd = () => sol.b58encode(crypto.getRandomValues(new Uint8Array(32)));

test('base58 vectors and round trips', () => {
  assert.equal(sol.b58encode(new TextEncoder().encode('hello world')), 'StV1DL6CwTryKyV');
  assert.deepEqual([...sol.b58decode('11111111111111111111111111111111')], new Array(32).fill(0));
  assert.equal(sol.b58encode(new Uint8Array([0, 0, 1])), '112');
  for (let i = 0; i < 200; i++) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    if (i % 10 === 0) b[0] = 0;
    const s = sol.b58encode(b);
    assert.deepEqual([...sol.b58decode(s)], [...b]);
    // same as Kit's address codec
    assert.equal(kit.getAddressDecoder().decode(b), s);
  }
  assert.equal(sol.isPubkey(sol.MINTS.usdc), true);
  assert.equal(sol.isPubkey('0OIl' + 'x'.repeat(40)), false);
  assert.equal(sol.isPubkey('abc'), false);
  assert.throws(() => sol.b58decode('0abc'));
});

test('compact-u16', () => {
  const cases: [number, number[]][] = [[0, [0]], [127, [0x7f]], [128, [0x80, 0x01]], [255, [0xff, 0x01]], [16383, [0xff, 0x7f]], [16384, [0x80, 0x80, 0x01]], [65535, [0xff, 0xff, 0x03]]];
  for (const [n, bytes] of cases) {
    assert.deepEqual(sol.compactU16(n), bytes);
    assert.deepEqual(sol.readCompactU16(Uint8Array.from(bytes), 0), [n, bytes.length]);
  }
  assert.throws(() => sol.compactU16(65536));
});

// Resolve a compiled message (Kit's decoded form) into [{program, accounts:[{address, signer, writable}], data}]
function resolveKit(c: any) {
  const keys: string[] = c.staticAccounts;
  const { numSignerAccounts: ns, numReadonlySignerAccounts: nrs, numReadonlyNonSignerAccounts: nrn } = c.header;
  const role = (i: number) => {
    if (i < keys.length) {
      const signer = i < ns;
      const writable = signer ? i < ns - nrs : i < keys.length - nrn;
      return { address: keys[i], signer, writable };
    }
    return null;
  };
  return { keys, role, lookups: c.addressTableLookups || [] };
}

function semantic(bytes: Uint8Array, tables: Record<string, string[]>) {
  const c = kit.getCompiledTransactionMessageDecoder().decode(bytes);
  const { keys, role, lookups } = resolveKit(c);
  const lw: string[] = [], lr: string[] = [];
  for (const l of lookups) for (const i of l.writableIndexes ?? l.writableIndices) lw.push(tables[l.lookupTableAddress][i]);
  for (const l of lookups) for (const i of l.readonlyIndexes ?? l.readonlyIndices) lr.push(tables[l.lookupTableAddress][i]);
  const at = (i: number) => role(i) || (i - keys.length < lw.length ? { address: lw[i - keys.length], signer: false, writable: true } : { address: lr[i - keys.length - lw.length], signer: false, writable: false });
  return {
    feePayer: keys[0],
    blockhash: c.lifetimeToken,
    version: c.version,
    instructions: c.instructions.map((ix: any) => ({ program: at(ix.programAddressIndex).address, accounts: (ix.accountIndices || []).map(at), data: [...(ix.data || [])] })),
  };
}

function mkIxs(payer: string, extra: { feeAcct: string; altAccounts: string[] }) {
  const prog = rnd(), ata = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  const r1 = rnd(), r2 = rnd();
  return [
    sol.setComputeUnitLimitIx(200_000),
    sol.setComputeUnitPriceIx(12345),
    { programId: ata, accounts: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: r1, isSigner: false, isWritable: true }, { pubkey: sol.PROGRAMS.system, isSigner: false, isWritable: false }], data: new Uint8Array([1]) },
    { programId: prog, accounts: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: extra.feeAcct, isSigner: false, isWritable: true },
      { pubkey: r1, isSigner: false, isWritable: true },
      { pubkey: r2, isSigner: false, isWritable: false },
      ...extra.altAccounts.map((a, i) => ({ pubkey: a, isSigner: false, isWritable: i % 2 === 0 })),
      { pubkey: sol.PROGRAMS.token, isSigner: false, isWritable: false },
    ], data: crypto.getRandomValues(new Uint8Array(40)) },
  ];
}

const expected = (ixs: any[]) => ixs.map((ix) => ({ program: ix.programId, data: [...ix.data], accounts: ix.accounts.map((a: any) => a.pubkey) }));
// effective role per address = OR over all instructions (that is what the runtime enforces)
function roles(ixs: any[], payer: string) {
  const m = new Map<string, { signer: boolean; writable: boolean }>([[payer, { signer: true, writable: true }]]);
  for (const ix of ixs) for (const a of ix.accounts) { const r = m.get(a.pubkey) || { signer: false, writable: false }; r.signer ||= a.isSigner; r.writable ||= a.isWritable; m.set(a.pubkey, r); }
  return m;
}

test('legacy message: Kit decodes BAGZ bytes to the same instructions and roles', () => {
  const payer = rnd(), bh = rnd();
  const ixs = mkIxs(payer, { feeAcct: rnd(), altAccounts: [rnd(), rnd()] });
  const msg = sol.compileMessage({ payer, instructions: ixs, recentBlockhash: bh });
  const s = semantic(msg.bytes, {});
  assert.equal(s.version, 'legacy');
  assert.equal(s.feePayer, payer);
  assert.equal(s.blockhash, bh);
  const want = expected(ixs), r = roles(ixs, payer);
  assert.equal(s.instructions.length, want.length);
  s.instructions.forEach((ix: any, i: number) => {
    assert.equal(ix.program, want[i].program);
    assert.deepEqual(ix.data, want[i].data);
    assert.deepEqual(ix.accounts.map((a: any) => a.address), want[i].accounts);
    for (const a of ix.accounts) assert.deepEqual({ signer: a.signer, writable: a.writable }, r.get(a.address), `role of ${a.address}`);
  });
  // our own decoder agrees
  const d = sol.decodeMessage(msg.bytes);
  assert.equal(d.staticKeys[0], payer);
  assert.equal(d.blockhash, bh);
});

test('v0 message with lookup tables: Kit decodes BAGZ bytes to the same instructions and roles', () => {
  for (let round = 0; round < 25; round++) {
    const payer = rnd(), bh = rnd();
    const alt = Array.from({ length: 6 }, rnd), alt2 = Array.from({ length: 4 }, rnd);
    const feeAcct = rnd();
    const ixs = mkIxs(payer, { feeAcct, altAccounts: [...alt.slice(0, 4), ...alt2.slice(1, 3)] });
    // tables also contain unrelated addresses, the payer, a program id and the fee account (must not move the signer/program)
    const tA = [rnd(), ...alt, payer, sol.PROGRAMS.token];
    const tB = [rnd(), ...alt2, feeAcct];
    const tables = { [rnd()]: tA, [rnd()]: tB };
    const msg = sol.compileMessage({ payer, instructions: ixs, recentBlockhash: bh, lookupTables: Object.entries(tables).map(([key, addresses]) => ({ key, addresses })) });
    const s = semantic(msg.bytes, tables);
    assert.equal(s.version, 0);
    assert.equal(s.feePayer, payer);
    assert.equal(s.blockhash, bh);
    const want = expected(ixs), r = roles(ixs, payer);
    s.instructions.forEach((ix: any, i: number) => {
      assert.equal(ix.program, want[i].program);
      assert.deepEqual(ix.data, want[i].data);
      assert.deepEqual(ix.accounts.map((a: any) => a.address), want[i].accounts);
      for (const a of ix.accounts) assert.deepEqual({ signer: a.signer, writable: a.writable }, r.get(a.address), `role of ${a.address}`);
    });
    // the signer and every invoked program never come from a lookup table (a program passed only as a read-only
    // account, like the token program here, may)
    assert.equal(msg.staticKeys[0], payer);
    for (const ix of ixs) assert.ok(msg.staticKeys.includes(ix.programId), `invoked program ${ix.programId} is static`);
    assert.ok(msg.lookups.length >= 1);
    // the fee account sits in table B and is writable, so it must be loaded as writable
    assert.ok(msg.lookups.some((l: any) => l.writableKeys.includes(feeAcct)));
  }
});

test('Kit compiles the same instructions into an equivalent message', () => {
  const payer = rnd(), bh = rnd();
  const ixs = mkIxs(payer, { feeAcct: rnd(), altAccounts: [rnd(), rnd(), rnd()] });
  const toKit = (ix: any) => ({ programAddress: ix.programId, data: ix.data, accounts: ix.accounts.map((a: any) => ({ address: a.pubkey, role: a.isSigner ? (a.isWritable ? kit.AccountRole.WRITABLE_SIGNER : kit.AccountRole.READONLY_SIGNER) : (a.isWritable ? kit.AccountRole.WRITABLE : kit.AccountRole.READONLY) })) });
  const m = kit.pipe(kit.createTransactionMessage({ version: 0 }), (x: any) => kit.setTransactionMessageFeePayer(payer, x), (x: any) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh, lastValidBlockHeight: 100n }, x), (x: any) => kit.appendTransactionMessageInstructions(ixs.map(toKit), x));
  const kitBytes = new Uint8Array(kit.getCompiledTransactionMessageEncoder().encode(kit.compileTransactionMessage(m)));
  const ours = sol.compileMessage({ payer, instructions: ixs, recentBlockhash: bh, lookupTables: [] });
  assert.deepEqual(semantic(ours.bytes, {}), semantic(kitBytes, {}));
  // header counts are identical (same number of signers / read-only accounts)
  assert.deepEqual([...ours.bytes.slice(1, 4)], [...kitBytes.slice(1, 4)]);
  assert.equal(ours.bytes.length, kitBytes.length);
});

test('transaction wire format: Kit decodes BAGZ transactions, signatures verify', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const payer = sol.b58encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const msg = sol.compileMessage({ payer, recentBlockhash: rnd(), instructions: [sol.transferCheckedIx({ source: rnd(), mint: sol.MINTS.usdc, destination: rnd(), owner: payer, amount: 10_000_000n, decimals: 6, references: [rnd()] }), sol.memoIx('BAGZ-BOOST:abc')] });
  const unsigned = sol.unsignedTransaction(msg.bytes, 1);
  const kt = kit.getTransactionDecoder().decode(unsigned);
  assert.deepEqual(Object.keys(kt.signatures), [payer]);
  assert.deepEqual([...new Uint8Array(kt.messageBytes)], [...msg.bytes]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, msg.bytes));
  const signed = unsigned.slice(); signed.set(sig, 1);
  const p = sol.parseTransaction(signed);
  assert.equal(await sol.verifyEd25519(payer, p.message, p.signatures[0]), true);
  const tampered = signed.slice(); tampered[tampered.length - 1] ^= 1;
  const q = sol.parseTransaction(tampered);
  assert.equal(await sol.verifyEd25519(payer, q.message, q.signatures[0]), false);
  // transferChecked layout: [12, amount u64 LE, decimals]
  const d = sol.decodeMessage(msg.bytes);
  assert.deepEqual([...d.instructions[0].data], [12, 0x80, 0x96, 0x98, 0, 0, 0, 0, 0, 6]);
  assert.equal(d.instructions[0].accounts.length, 5);
});

test('lookup table account parsing', () => {
  const addrs = [rnd(), rnd(), rnd()];
  const data = new Uint8Array(56 + 32 * 3);
  new DataView(data.buffer).setUint32(0, 1, true);
  addrs.forEach((a, i) => data.set(sol.b58decode(a), 56 + 32 * i));
  assert.deepEqual(sol.parseLookupTable(data), addrs);
  assert.throws(() => sol.parseLookupTable(new Uint8Array(57)));
});

test('oversized transactions are refused', () => {
  const payer = rnd();
  const ix = { programId: rnd(), accounts: Array.from({ length: 40 }, () => ({ pubkey: rnd(), isSigner: false, isWritable: true })), data: new Uint8Array(10) };
  assert.throws(() => sol.compileMessage({ payer, instructions: [ix], recentBlockhash: rnd() }), /too large/);
});
