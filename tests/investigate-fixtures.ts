/**
 * Fixtures for the Investigate tests: a scripted Solana JSON-RPC (jsonParsed shapes as documented for getTokenLargestAccounts,
 * getMultipleAccounts, getAccountInfo, getSignaturesForAddress and getTransaction). Test code only; nothing here ships.
 */
// @ts-ignore plain JS
import { b58encode } from '../worker/solana.js';

export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SYSTEM = '11111111111111111111111111111111';
export const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

/** deterministic valid 32-byte addresses (curve membership not controlled: use ON/OFF below when it matters) */
export const addr = (n: number, salt = 7) => b58encode(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * salt + 1) & 255));
export const sig = (n: number) => b58encode(Uint8Array.from({ length: 64 }, (_, i) => (n * 17 + i * 3 + 9) & 255));

/** cross-checked against an independent RFC 8032 decoder (see the report): on-curve and off-curve addresses */
export const ON = ['GXVkrGKKSXXpjrHQtvRiNf8Gf8VMpKKwgaaCGB1ynv8M', 'DkUU9fydHAhKvRksLKzuTq9HKmqsWGLBQe45N4b2YK1q', 'CqaUm8pLLoa983PnP2hsaQNNXAfKhWoN3LvN6WN98WjB'];
export const OFF = ['BNRY47RY84KMeXMMaxKLMYMnmVF7vVXkqzsiEANGEKG5', '5SbjcEZLvHKxjMoKbHPpX1UqWTSHbBxtiZ4RtnbCUA3b', '7nmjC3sdxCSxWq25BoMYohpiDucdeEKq5G58orPnfAXm'];

export const MINT = addr(200);
export const OTHER_MINT = addr(201);

export const tokenAcct = (mint: string, owner: string, amount: string, o: { program?: string; state?: string; decimals?: number } = {}) => ({
  owner: o.program || TOKEN, lamports: 2039280, executable: false,
  data: { program: o.program === TOKEN22 ? 'spl-token-2022' : 'spl-token', space: 165, parsed: { type: 'account', info: { mint, owner, state: o.state || 'initialized', isNative: false, tokenAmount: { amount, decimals: o.decimals ?? 6, uiAmountString: '' } } } },
});
export const mintAcct = (supply: string, decimals = 6, o: { program?: string; extensions?: string[] } = {}) => ({
  owner: o.program || TOKEN, lamports: 1461600, executable: false,
  data: { program: 'spl-token', space: 82, parsed: { type: 'mint', info: { supply, decimals, isInitialized: true, mintAuthority: null, freezeAuthority: null, ...(o.extensions ? { extensions: o.extensions.map((e) => ({ extension: e, state: {} })) } : {}) } } },
});

export type Handler = (params: any[], n: number) => any;
export interface RpcScript { [method: string]: Handler }
/** fake fetch for the RPC: routes by JSON-RPC method; a handler may return a Response, throw, or return a result */
export function rpcFetch(script: RpcScript) {
  const calls: { url: string; method: string; params: any[] }[] = [];
  const f = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body || '{}'));
    calls.push({ url, method: body.method, params: body.params });
    const h = script[body.method];
    if (!h) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }), { status: 200 });
    const r = await h(body.params, calls.filter((c) => c.method === body.method).length);
    if (r instanceof Response) return r;
    if (r && r.__rpcError) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: r.__rpcError }), { status: 200 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: r }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { f, calls };
}

/** a standard holder world: 4 token accounts, owner A holds two of them, one account of another mint, one closed */
export function holderWorld(o: { supply?: string; changed?: boolean } = {}) {
  const A = ON[0], B = OFF[0], C = ON[1];
  const acc = [addr(1), addr(2), addr(3), addr(4), addr(5), addr(6)];
  const big = '18446744073709551615'; // u64::MAX, far above Number.MAX_SAFE_INTEGER
  const largest = [
    { address: acc[0], amount: big, decimals: 6, uiAmountString: '' },
    { address: acc[1], amount: '9007199254740993', decimals: 6 },
    { address: acc[2], amount: o.changed ? '5000' : '4000', decimals: 6 },
    { address: acc[3], amount: '3000', decimals: 6 },
    { address: acc[4], amount: '2000', decimals: 6 },
    { address: acc[5], amount: '1000', decimals: 6 },
  ];
  const accounts = [
    tokenAcct(MINT, A, big),
    tokenAcct(MINT, B, '9007199254740993'),
    tokenAcct(MINT, A, '4000'),
    tokenAcct(OTHER_MINT, C, '3000'), // wrong mint
    null, // closed between reads
    tokenAcct(MINT, C, '1000', { program: TOKEN22 }),
  ];
  const supply = o.supply ?? '36893488147419103230';
  const script: RpcScript = {
    getTokenLargestAccounts: () => ({ context: { slot: 1000 }, value: largest }),
    getMultipleAccounts: (p) => {
      if (p[1]?.encoding === 'base64') {
        // owner accounts: A is a system wallet, B (off-curve) is owned by a program, C has no account
        return { context: { slot: 1002 }, value: p[0].map((k: string) => (k === A ? { owner: SYSTEM, executable: false, lamports: 5, data: ['', 'base64'] } : k === B ? { owner: RAYDIUM, executable: false, lamports: 5, data: ['', 'base64'] } : null)) };
      }
      return { context: { slot: 1001 }, value: [mintAcct(supply), ...accounts] };
    },
  };
  return { A, B, C, acc, big, largest, script, supply };
}

/** a jsonParsed transaction with the given instructions and token balances */
export function parsedTx(o: { slot?: number; blockTime?: number | null; err?: unknown; keys: string[]; outer: any[]; inner?: { index: number; instructions: any[] }[]; pre?: any[]; post?: any[] }) {
  return {
    slot: o.slot ?? 500, blockTime: o.blockTime === undefined ? 1_800_000_000 : o.blockTime, version: 0,
    meta: { err: o.err === undefined ? null : o.err, fee: 5000, innerInstructions: o.inner || [], preTokenBalances: o.pre || [], postTokenBalances: o.post || [], logMessages: [] },
    transaction: { signatures: ['x'], message: { accountKeys: o.keys.map((k, i) => ({ pubkey: k, signer: i === 0, writable: true, source: 'transaction' })), instructions: o.outer, recentBlockhash: SYSTEM } },
  };
}
export const tb = (accountIndex: number, mint: string, owner: string | undefined, amount: string) => ({ accountIndex, mint, ...(owner ? { owner } : {}), programId: TOKEN, uiTokenAmount: { amount, decimals: 6, uiAmountString: '' } });
export const xfer = (type: 'transfer' | 'transferChecked' | 'transferCheckedWithFee', info: Record<string, unknown>, o: { program?: string; stackHeight?: number } = {}) => ({ program: 'spl-token', programId: o.program || TOKEN, parsed: { type, info }, ...(o.stackHeight ? { stackHeight: o.stackHeight } : {}) });
export const opaque = (programId: string, stackHeight?: number) => ({ programId, accounts: [], data: '3Bxs', ...(stackHeight ? { stackHeight } : {}) });
