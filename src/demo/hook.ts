/** The test copy's in-page server, when this build is the test copy (set by src/demo/register.ts); otherwise null. */
export interface DemoHook {
  base: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  avatar: (id: string, ver: number) => string | null;
  subscribe: (f: () => void) => () => void;
  version: () => number;
  reset: () => Promise<void>;
}
export const demo = (): DemoHook | null => (typeof globalThis !== 'undefined' && (globalThis as any).__BAGZ_DEMO__) || null;
