/**
 * Exact token-unit formatting. Raw amounts are integer strings; they are split into whole and fractional parts with
 * BigInt, so amounts far above Number.MAX_SAFE_INTEGER stay exact. Shortening is display-only and labelled as such.
 */

/** the exact decimal value of `raw` with `decimals` places, e.g. ("123456789", 6) -> "123.456789" */
export function exactUnits(raw: string, decimals: number): string {
  const v = BigInt(raw);
  if (decimals <= 0) return v.toString();
  const base = 10n ** BigInt(decimals);
  const whole = v / base, frac = v % base;
  const f = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return f ? `${whole}.${f}` : whole.toString();
}

const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Readable amount: thousands separators and at most `maxFrac` fractional digits, TRUNCATED (never rounded up),
 * with a flag saying whether anything was cut. Large values are kept whole (no K/M/B) so nothing is hidden.
 */
export function readableUnits(raw: string, decimals: number, maxFrac = 4): { text: string; truncated: boolean } {
  const exact = exactUnits(raw, decimals);
  const [w, f = ''] = exact.split('.');
  let keep = f.slice(0, maxFrac);
  // tiny amounts: show enough digits to reach the first significant one (up to the token's precision)
  if (w === '0' && f && !/[1-9]/.test(keep)) { const first = f.search(/[1-9]/); keep = f.slice(0, Math.min(f.length, first + 2)); }
  keep = keep.replace(/0+$/, '');
  return { text: group(w) + (keep ? `.${keep}` : ''), truncated: keep.length < f.length };
}

/** compact for tight spaces (bubbles): 1.23B, 45.6M, 7.89K — display only */
export function compactUnits(raw: string, decimals: number): string {
  const whole = BigInt(raw) / 10n ** BigInt(Math.max(0, decimals));
  const steps: [bigint, string][] = [[10n ** 12n, 'T'], [10n ** 9n, 'B'], [10n ** 6n, 'M'], [10n ** 3n, 'K']];
  for (const [n, s] of steps) {
    if (whole >= n) { const x = (whole * 100n) / n; return `${x / 100n}.${(x % 100n).toString().padStart(2, '0')}${s}`; }
  }
  return readableUnits(raw, decimals, 2).text;
}

/** percent string from the server ("12.3456") for display, e.g. "12.35%"; below-display amounts show "<0.0001%" */
export function pctText(p: string | null, below = false, digits = 2): string {
  if (p === null) return 'n/a';
  if (below) return '<0.0001%';
  const [w, f = ''] = p.split('.');
  if (w === '0' && /^0+$/.test(f.slice(0, digits)) && /[1-9]/.test(f)) return `<${(1 / 10 ** digits).toFixed(digits)}%`;
  return `${w}.${(f + '0000').slice(0, digits)}%`;
}

/** share of total as a percent string with 4 decimals, truncated, integers only (client-side cross-check) */
export function percentOf(amount: string, total: string): string | null {
  const a = BigInt(amount), t = BigInt(total);
  if (t <= 0n) return null;
  const q = (a * 1_000_000n) / t;
  return `${q / 10_000n}.${(q % 10_000n).toString().padStart(4, '0')}`;
}

export const shortAddr = (a: string, n = 4) => (a.length > n * 2 + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a);

/** 1-based instruction label as explorers show it: outer 3 / inner 1 (0-based) -> "#4.2" */
export const ixLabel = (outer: number, inner: number | null) => `#${outer + 1}${inner === null ? '' : `.${inner + 1}`}`;
