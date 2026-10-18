const SUB = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

/** Memecoin price notation: $0.0₅4017 means 0.000004017 (five zeros after the decimal point). */
export function price(p: number): string {
  if (!isFinite(p) || p <= 0) return '$0';
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return '$' + p.toFixed(p >= 100 ? 2 : 3);
  if (p >= 0.01) return '$' + p.toFixed(4);
  const s = p.toFixed(20);
  const decimals = s.split('.')[1];
  let zeros = 0;
  while (decimals[zeros] === '0') zeros++;
  const sig = decimals.slice(zeros, zeros + 4).replace(/0+$/, '') || '0';
  if (zeros < 4) return '$0.' + '0'.repeat(zeros) + sig;
  const sub = String(zeros).split('').map((d) => SUB[+d]).join('');
  return `$0.0${sub}${sig}`;
}

export function usd(n: number, digits = 2): string {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function compact(n: number, prefix = '$'): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${prefix}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}${prefix}${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}${prefix}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${prefix}${a.toFixed(a < 10 ? 2 : 0)}`;
}

export function pct(n: number, digits = 1): string {
  if (!isFinite(n)) return '0%';
  const sign = n > 0 ? '+' : '';
  if (Math.abs(n) >= 1000) return `${sign}${(n / 1000).toFixed(1)}K%`;
  return `${sign}${n.toFixed(digits)}%`;
}

export function signedUsd(n: number): string {
  return (n >= 0 ? '+' : '-') + compact(Math.abs(n));
}

export function qty(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function tone(n: number): 'up' | 'down' | 'flat' {
  return n > 0.0001 ? 'up' : n < -0.0001 ? 'down' : 'flat';
}
