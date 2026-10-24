/**
 * TEST COPY ONLY (built with BAGZ_DEMO=1). Runs the real BAGZ Worker code (worker/index.js → social.js) inside the
 * page, on SQLite compiled to WebAssembly (sql.js, MIT), behind the same API as Cloudflare D1. Everything is saved in
 * this browser (IndexedDB) and nothing is sent anywhere, so accounts made here exist only on this device.
 * Market data still comes from the real providers, straight from the browser.
 */
// @ts-ignore plain JS
import { handle } from '../../worker/index.js';
// @ts-ignore CommonJS
import initSqlJs from './vendor/sql-wasm.cjs';
// @ts-ignore binary loader
import wasm from './vendor/sql-wasm.wasm';
// @ts-ignore text loader
import m1 from '../../worker/migrations/0001_swap_boost.sql';
// @ts-ignore text loader
import m2 from '../../worker/migrations/0002_social.sql';
// @ts-ignore sql text
import m3 from '../../worker/migrations/0003_vault.sql';
// @ts-ignore sql text
import m4 from '../../worker/migrations/0004_admin_controls.sql';
// @ts-ignore sql text
import m5 from '../../worker/migrations/0005_wallets.sql';

export const DEMO_BASE = 'https://test-copy.bagz';
const DB_NAME = 'bagz-test-copy', STORE = 'db', KEY = 'sqlite';

function idb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try { const r = indexedDB.open(DB_NAME, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); }
  });
}
async function loadBytes(): Promise<Uint8Array | null> {
  const d = await idb(); if (!d) return null;
  return new Promise((res) => { try { const g = d.transaction(STORE).objectStore(STORE).get(KEY); g.onsuccess = () => res(g.result ? new Uint8Array(g.result) : null); g.onerror = () => res(null); } catch { res(null); } });
}
async function saveBytes(b: Uint8Array) {
  const d = await idb(); if (!d) return;
  try { d.transaction(STORE, 'readwrite').objectStore(STORE).put(b, KEY); } catch { /* storage full or blocked */ }
}
export async function resetTestCopy() {
  const d = await idb();
  if (d) await new Promise<void>((res) => { const t = d.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(KEY); t.oncomplete = () => res(); t.onerror = () => res(); });
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('bagz.session') || k.startsWith('bagz.social')) localStorage.removeItem(k); } catch { /* ignore */ }
}

/** Cloudflare D1's prepare/bind/first/all/run/batch on top of sql.js */
class BrowserD1 {
  dirty = false;
  constructor(public db: any) {}
  private exec(sql: string, args: unknown[], mode: 'first' | 'all' | 'run') {
    const st = this.db.prepare(sql);
    try {
      st.bind(args.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x)));
      if (mode === 'run') {
        st.step();
        const changes = this.db.getRowsModified();
        const id = this.db.exec('SELECT last_insert_rowid() AS id')[0]?.values?.[0]?.[0];
        if (changes) this.dirty = true;
        return { meta: { changes, last_row_id: id } };
      }
      const rows: any[] = [];
      while (st.step()) { rows.push(st.getAsObject()); if (mode === 'first') break; }
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) this.dirty = true;
      return mode === 'first' ? rows[0] ?? null : { results: rows };
    } finally { st.free(); }
  }
  prepare(sql: string) {
    const make = (args: unknown[]): any => ({
      bind: (...a: unknown[]) => make(a),
      first: async (col?: string) => { const r = this.exec(sql, args, 'first') as any; return r && col ? r[col] : r; },
      all: async () => this.exec(sql, args, 'all'),
      run: async () => this.exec(sql, args, 'run'),
      _run: () => this.exec(sql, args, 'run'),
    });
    return make([]);
  }
  async batch(stmts: any[]) {
    this.db.exec('BEGIN');
    try { const out = stmts.map((s) => s._run()); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

let ready: Promise<{ d1: BrowserD1; env: any }> | null = null;
function start() {
  if (!ready) ready = (async () => {
    const SQL = await (initSqlJs as any)({ wasmBinary: wasm });
    const saved = await loadBytes();
    const db = saved ? new SQL.Database(saved) : new SQL.Database();
    db.exec('PRAGMA foreign_keys = ON');
    if (!saved) { db.exec(m1); db.exec(m2); }
    db.exec(m3); // IF NOT EXISTS: also upgrades test copies saved before the Vault
    db.exec(m4); // same for the admin controls tables
    db.exec(m5); // and the synced paper wallets
    const d1 = new BrowserD1(db);
    // save after writes, at most once a second, and when the page is hidden
    setInterval(() => { if (d1.dirty) { d1.dirty = false; saveBytes(db.export()); } }, 1000);
    document.addEventListener('visibilitychange', () => { if (document.hidden && d1.dirty) { d1.dirty = false; saveBytes(db.export()); } });
    const env = { Db: d1, TEST_COPY: '1', ENABLE_LIVE_BOOST_PAYMENTS: 'true', PROBE_TOKEN: 'test-copy', ALLOWED_ORIGINS: DEMO_BASE, PASSWORD_ITERATIONS: '100000', RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', RATE_WALLET_PER_MIN: '100000', ADMIN_SESSION_SECRET: 'test-copy-only-'.padEnd(40, 'x') };
    return { d1, env };
  })();
  return ready;
}

/** what the app's API client calls instead of the network in the test copy */
export async function demoFetch(url: string, init: RequestInit): Promise<Response> {
  const { env } = await start();
  const h = new Headers(init.headers);
  h.set('x-bagz-probe', 'test-copy'); // browsers won't let pages set Origin; the probe token stands in for it
  h.set('cf-connecting-ip', 'this-device');
  return handle(new Request(url, { method: init.method, headers: h, body: init.body as any }), env, undefined, { fetch: (u: string, i: RequestInit) => fetch(u, i), cache: null });
}

/** profile pictures as object URLs (an <img> can't reach the in-page server) */
const pics = new Map<string, string | null>();
const picSubs = new Set<() => void>();
let picVer = 0;
export const subscribePics = (f: () => void) => { picSubs.add(f); return () => { picSubs.delete(f); }; };
export const picVersion = () => picVer;
export function demoAvatar(id: string, ver: number): string | null {
  const k = `${id}:${ver}`;
  if (pics.has(k)) return pics.get(k)!;
  pics.set(k, null);
  demoFetch(`${DEMO_BASE}/v1/avatars/${id}`, { method: 'GET' }).then(async (r) => {
    if (!r.ok) return;
    pics.set(k, URL.createObjectURL(await r.blob()));
    picVer++; picSubs.forEach((f) => f());
  }, () => {});
  return null;
}
