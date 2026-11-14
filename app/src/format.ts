/** Milliseconds with a decimal point (English UI), e.g. 156.04 → "156.0". */
export function fmtMs(ms: number, digits = 1): string {
  return ms.toFixed(digits);
}

/** µs → ms string; sub-10 ms values get 2 decimals ("0.08"). */
export function fmtUsAsMs(us: number): string {
  const ms = us / 1000;
  return fmtMs(ms, Math.abs(ms) < 10 ? 2 : 1);
}

/** Plain-English sentence for a SAFE_STOP reason code. */
export function reasonText(reason: string): string {
  switch (reason) {
    case 'hb_timeout':
      return 'Heartbeat missed — link lost';
    case 'estop':
      return 'E-STOP pressed';
    case 'client_lost':
      return 'Operator disconnected';
    case 'plant_lost':
      return 'Robot process lost';
    default:
      return reason.replace(/_/g, ' ');
  }
}

/**
 * hb_timeout: detect_us = last hb → SAFE_STOP detected ("detected in").
 * estop/others: detect_us = command received → handled ("handled in").
 * plant_lost (or any negative/non-finite value): no latency, reason label only.
 */
export function eventLatencyLabel(reason: string, detectMs: number): string {
  if (reason === 'plant_lost') return 'plant lost';
  if (!Number.isFinite(detectMs) || detectMs < 0) return 'no latency';
  const kind = reason === 'hb_timeout' ? 'detected in' : 'handled in';
  return `${kind} ${fmtMs(detectMs, detectMs < 10 ? 2 : 1)} ms`;
}
