/** Milliseconds with an Indonesian decimal comma, e.g. 156.04 → "156,0". */
export function fmtMs(ms: number, digits = 1): string {
  return ms.toFixed(digits).replace('.', ',');
}

/** µs → ms string; sub-millisecond values get 2 decimals ("0,08"). */
export function fmtUsAsMs(us: number): string {
  const ms = us / 1000;
  return fmtMs(ms, Math.abs(ms) < 10 ? 2 : 1);
}

/**
 * hb_timeout: detect_us = last hb → SAFE_STOP detected ("deteksi").
 * estop/others: detect_us = command received → handled ("proses").
 * plant_lost (or any negative/non-finite value): no latency, reason label only.
 */
export function eventLatencyLabel(reason: string, detectMs: number): string {
  if (reason === 'plant_lost') return 'plant hilang';
  if (!Number.isFinite(detectMs) || detectMs < 0) return 'tanpa latensi';
  const kind = reason === 'hb_timeout' ? 'deteksi' : 'proses';
  return `${kind} ${fmtMs(detectMs, detectMs < 10 ? 2 : 1)} ms`;
}
