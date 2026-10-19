import { __setDeps, __reset } from '../src/providers/http';
import { __setProxy } from '../src/providers/config';

export interface Call { url: string; init: RequestInit }
export type Responder = (url: string, init: RequestInit, n: number) => Response | Promise<Response> | Error;
export const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake clock + fake fetch. `advance` moves time forward; sleeps resolve immediately and advance the clock. */
export function harness(responder: Responder, opts: { autoAdvance?: boolean } = {}) {
  let t = 1_800_000_000_000;
  const calls: Call[] = [];
  __reset();
  __setProxy(null);
  Date.now = () => t; // engine code reads Date.now(); keep it on the same fake clock (each test file is its own process)
  __setDeps({
    now: () => t,
    sleep: async (ms) => { t += ms; },
    random: () => 0.5,
    // with autoAdvance the limiter's waits move the fake clock forward, so long flows run instantly
    timer: (fn, ms) => setTimeout(() => { if (opts.autoAdvance) t += ms; fn(); }, 0),
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responder(url, init, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return { calls, advance: (ms: number) => { t += ms; }, now: () => t };
}
