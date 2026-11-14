/** Milliseconds with an Indonesian decimal comma, e.g. 156.04 → "156,0". */
export function fmtMs(ms: number, digits = 1): string {
  return ms.toFixed(digits).replace('.', ',');
}

/** µs → ms string; sub-millisecond values get 2 decimals ("0,08"). */
export function fmtUsAsMs(us: number): string {
  const ms = us / 1000;
  return fmtMs(ms, Math.abs(ms) < 10 ? 2 : 1);
}
