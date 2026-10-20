/**
 * Test doubles for the /v1 API:
 *  - D1: Cloudflare D1's prepare/bind/first/all/run/batch API on top of node:sqlite, with the real migration applied.
 *  - Chain: a fake Solana RPC + Jupiter + DexScreener that keeps state (accounts, lookup tables, sent transactions).
 *  - Wallet: real Ed25519 keys (WebCrypto), signing the exact bytes BAGZ returns, like a wallet would.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
// @ts-ignore plain JS
import * as sol from '../worker/solana.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class D1 {
  db = new DatabaseSync(':memory:');
  constructor() {
    // D1 enforces foreign keys; mirror that, then apply every migration in order like `wrangler d1 migrations apply`
    this.db.exec('PRAGMA foreign_keys = ON');
    for (const f of readdirSync(resolve(root, 'worker/migrations')).filter((x) => x.endsWith('.sql')).sort()) this.db.exec(readFileSync(resolve(root, 'worker/migrations', f), 'utf8'));
  }
  prepare(sql: string) {
    const db = this.db;
    const mk = (args: unknown[]) => {
      const a = args.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));
      return {
        bind: (...more: unknown[]) => mk(more),
        first: async (col?: string) => { const r = db.prepare(sql).get(...(a as any[])) as any; return r === undefined ? null : col ? r[col] : { ...r }; },
        all: async () => ({ results: (db.prepare(sql).all(...(a as any[])) as any[]).map((r) => ({ ...r })) }),
        run: async () => { const r = db.prepare(sql).run(...(a as any[])); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
        _exec: () => { const r = db.prepare(sql).run(...(a as any[])); return { meta: { changes: Number(r.changes) } }; },
      };
    };
    return mk([]);
  }
  async batch(stmts: any[]) {
    this.db.exec('BEGIN');
    try { const out = stmts.map((s) => s._exec()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

export const rnd = () => sol.b58encode(crypto.getRandomValues(new Uint8Array(32)));

export interface Kp { address: string; sign: (m: Uint8Array) => Promise<Uint8Array> }
export async function keypair(): Promise<Kp> {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const address = sol.b58encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  return { address, sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, m)) };
}
/** what a wallet does: put its signature in its slot of the unsigned transaction */
export async function walletSign(kp: Kp, txB64: string): Promise<string> {
  const bytes = sol.b64decode(txB64);
  const p = sol.parseTransaction(bytes);
  const idx = p.decoded.staticKeys.indexOf(kp.address);
  if (idx < 0 || idx >= p.decoded.header[0]) throw new Error('wallet is not a signer');
  const out = bytes.slice();
  out.set(await kp.sign(p.message), 1 + 64 * idx);
  return sol.b64encode(out);
}

export const JUP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const ALT_OWNER = 'AddressLookupTab1e1111111111111111111111111';

type Acct = { owner: string; parsed?: any; raw?: Uint8Array; lamports?: number };
export interface ChainOpts {
  buildOverride?: (q: URLSearchParams, def: any) => any;
  simulate?: (tx: Uint8Array) => any;
  sendError?: { message: string } | 'network';
  /** called after a transaction is accepted (e.g. to land it on the fake chain) */
  onSend?: (bytes: Uint8Array, signature: string) => void;
}

export class Chain {
  accounts = new Map<string, Acct>();
  tokenAccountsByOwner = new Map<string, { pubkey: string; mint: string; amount: string; program?: string }[]>();
  sent: { bytes: Uint8Array; signature: string }[] = [];
  statuses = new Map<string, any>();
  txs = new Map<string, any>();
  signaturesFor = new Map<string, { signature: string; err: null }[]>();
  height = 1000;
  calls: { url: string; method?: string; rpc?: string; body?: any; headers: Headers }[] = [];
  tokens = new Map<string, { symbol: string; name: string; icon?: string }>();
  dsTokens = new Map<string, any>();
  opts: ChainOpts = {};
  lastBuild: any = null;
  altKey = rnd();
  altAddresses: string[] = [];

  addMint(mint: string, decimals = 6, program = sol.PROGRAMS.token) { this.accounts.set(mint, { owner: program, parsed: { type: 'mint', info: { decimals, supply: '1000000000000', isInitialized: true } } }); }
  addTokenAccount(pubkey: string, mint: string, owner: string, amount = '0', program = sol.PROGRAMS.token, state = 'initialized') {
    this.accounts.set(pubkey, { owner: program, parsed: { type: 'account', info: { mint, owner, state, tokenAmount: { amount, decimals: mint === sol.MINTS.usdc ? 6 : 9 } } } });
    const l = this.tokenAccountsByOwner.get(owner) || []; l.push({ pubkey, mint, amount, program }); this.tokenAccountsByOwner.set(owner, l);
  }
  addLookupTable(key: string, addresses: string[]) {
    const data = new Uint8Array(56 + 32 * addresses.length);
    new DataView(data.buffer).setUint32(0, 1, true);
    addresses.forEach((a, i) => data.set(sol.b58decode(a), 56 + 32 * i));
    this.accounts.set(key, { owner: ALT_OWNER, raw: data });
  }

  /** a realistic /build answer for the query */
  defaultBuild(q: URLSearchParams) {
    const taker = q.get('taker')!, feeAccount = q.get('feeAccount');
    const pool = rnd(), vault1 = rnd(), vault2 = rnd(), userIn = rnd(), userOut = rnd();
    this.altAddresses = [pool, vault1, vault2, rnd()];
    this.addLookupTable(this.altKey, this.altAddresses);
    const ix = (programId: string, accounts: any[], data: number[]) => ({ programId, accounts, data: sol.b64encode(Uint8Array.from(data)) });
    const out = Math.floor(Number(q.get('amount')) * 1234.5).toString();
    return {
      inputMint: q.get('inputMint'), outputMint: q.get('outputMint'), inAmount: q.get('amount'), outAmount: out,
      otherAmountThreshold: Math.floor(Number(out) * (1 - Number(q.get('slippageBps') || 50) / 10000)).toString(), swapMode: 'ExactIn',
      slippageBps: Number(q.get('slippageBps') || 50), priceImpactPct: '0.0042',
      routePlan: [{ swapInfo: { ammKey: pool, label: 'Raydium CPMM', inputMint: q.get('inputMint'), outputMint: q.get('outputMint'), inAmount: q.get('amount'), outAmount: out }, percent: 100, bps: 10000 }],
      computeBudgetInstructions: [ix(sol.PROGRAMS.computeBudget, [], [3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0])], // 1,000,000 µlamports
      setupInstructions: [ix(ATA_PROGRAM, [{ pubkey: taker, isSigner: true, isWritable: true }, { pubkey: userOut, isSigner: false, isWritable: true }, { pubkey: taker, isSigner: false, isWritable: false }, { pubkey: q.get('outputMint'), isSigner: false, isWritable: false }, { pubkey: sol.PROGRAMS.system, isSigner: false, isWritable: false }, { pubkey: sol.PROGRAMS.token, isSigner: false, isWritable: false }], [1])],
      swapInstruction: ix(JUP_PROGRAM, [
        { pubkey: sol.PROGRAMS.token, isSigner: false, isWritable: false },
        { pubkey: taker, isSigner: true, isWritable: false },
        { pubkey: userIn, isSigner: false, isWritable: true },
        { pubkey: userOut, isSigner: false, isWritable: true },
        ...(feeAccount ? [{ pubkey: feeAccount, isSigner: false, isWritable: true }] : []),
        { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: vault1, isSigner: false, isWritable: true }, { pubkey: vault2, isSigner: false, isWritable: true },
      ], [0xe5, 0x17, 0xcb, 0x97, 1, 2, 3, 4]),
      cleanupInstruction: null, otherInstructions: [], tipInstruction: null,
      addressesByLookupTableAddress: { [this.altKey]: this.altAddresses },
      transactionVersion: 0,
      blockhashWithMetadata: { blockhash: Array.from(crypto.getRandomValues(new Uint8Array(32))), lastValidBlockHeight: this.height + 150, fetchedAt: { secs_since_epoch: 1, nanos_since_epoch: 0 } },
    };
  }

  /** confirm a sent transaction on the fake chain with token balance changes */
  land(signature: string, o: { err?: any; feeAccount?: string; feeMint?: string; feeDelta?: string; keys?: string[]; instructions?: any[]; blockTime?: number; postTokenBalances?: any[]; preTokenBalances?: any[] } = {}) {
    this.statuses.set(signature, { confirmationStatus: 'confirmed', err: o.err ?? null, slot: 5 });
    const keys = o.keys || [];
    const pre: any[] = o.preTokenBalances || [], post: any[] = o.postTokenBalances || [];
    if (o.feeAccount) {
      let i = keys.indexOf(o.feeAccount); if (i < 0) { keys.push(o.feeAccount); i = keys.length - 1; }
      pre.push({ accountIndex: i, mint: o.feeMint, uiTokenAmount: { amount: '1000' } });
      post.push({ accountIndex: i, mint: o.feeMint, uiTokenAmount: { amount: String(1000n + BigInt(o.feeDelta || '0')) } });
    }
    this.txs.set(signature, { slot: 5, blockTime: o.blockTime ?? Math.floor(Date.now() / 1000), meta: { err: o.err ?? null, preTokenBalances: pre, postTokenBalances: post, innerInstructions: [] }, transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })), instructions: o.instructions || [] } } });
  }

  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (u.host === 'api.jup.ag' && u.pathname === '/swap/v2/build') {
      this.calls.push({ url, headers });
      const def = this.defaultBuild(u.searchParams);
      const out = this.opts.buildOverride ? this.opts.buildOverride(u.searchParams, def) : def;
      if (out instanceof Response) return out;
      this.lastBuild = out;
      return json(out);
    }
    if (u.host === 'api.jup.ag' && u.pathname === '/tokens/v2/search') {
      this.calls.push({ url, headers });
      const t = this.tokens.get(u.searchParams.get('query')!);
      return json(t ? [{ id: u.searchParams.get('query'), ...t }] : []);
    }
    if (u.host === 'api.dexscreener.com') {
      this.calls.push({ url, headers });
      const mint = u.pathname.split('/').pop()!;
      return json(this.dsTokens.get(mint) || []);
    }
    // RPC (any other host)
    const body = JSON.parse(String(init.body || '{}'));
    this.calls.push({ url, rpc: body.method, body, headers });
    const r = (result: any) => json({ jsonrpc: '2.0', id: body.id, result });
    const p = body.params || [];
    switch (body.method) {
      case 'getAccountInfo': {
        const a = this.accounts.get(p[0]);
        if (!a) return r({ context: { slot: 1 }, value: null });
        return r({ context: { slot: 1 }, value: { owner: a.owner, lamports: a.lamports ?? 2039280, executable: false, data: a.parsed ? { program: 'spl-token', parsed: a.parsed, space: 165 } : [sol.b64encode(a.raw || new Uint8Array()), 'base64'] } });
      }
      case 'getMultipleAccounts': return r({ context: { slot: 1 }, value: p[0].map((k: string) => { const a = this.accounts.get(k); return a ? { owner: a.owner, lamports: 1, executable: false, data: [sol.b64encode(a.raw || new Uint8Array()), 'base64'] } : null; }) });
      case 'simulateTransaction': {
        const bytes = sol.b64decode(p[0]);
        const v = this.opts.simulate ? this.opts.simulate(bytes) : { err: null, logs: ['Program log: ok'], unitsConsumed: 150_000 };
        return r({ context: { slot: 1 }, value: v });
      }
      case 'sendTransaction': {
        if (this.opts.sendError === 'network') throw new TypeError('fetch failed');
        if (this.opts.sendError) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32002, message: this.opts.sendError.message } });
        const bytes = sol.b64decode(p[0]);
        const sig = sol.b58encode(sol.parseTransaction(bytes).signatures[0]);
        this.sent.push({ bytes, signature: sig });
        this.opts.onSend?.(bytes, sig);
        return r(sig);
      }
      case 'getSignatureStatuses': return r({ context: { slot: 1 }, value: p[0].map((s: string) => this.statuses.get(s) || null) });
      case 'getTransaction': return r(this.txs.get(p[0]) || null);
      case 'getBlockHeight': return r(this.height);
      case 'getBalance': return r({ context: { slot: 1 }, value: 2_500_000_000 });
      case 'getLatestBlockhash': return r({ context: { slot: 1 }, value: { blockhash: rnd(), lastValidBlockHeight: this.height + 150 } });
      case 'getSignaturesForAddress': return r(this.signaturesFor.get(p[0]) || []);
      case 'getTokenAccountsByOwner': {
        const list = (this.tokenAccountsByOwner.get(p[0]) || []).filter((x) => (p[1].mint ? x.mint === p[1].mint : (x.program || sol.PROGRAMS.token) === p[1].programId));
        return r({ context: { slot: 1 }, value: list.map((x) => ({ pubkey: x.pubkey, account: { owner: x.program || sol.PROGRAMS.token, data: { parsed: { type: 'account', info: { mint: x.mint, owner: p[0], state: 'initialized', tokenAmount: { amount: x.amount, decimals: x.mint === sol.MINTS.usdc ? 6 : 9 } } } } } })) });
      }
      default: return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    }
  };
}
