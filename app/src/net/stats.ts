// Latency statistics for SAFE_STOP hb_timeout detection.
// Wire types (`stats_req` / `stats`) live in protocol.ts.

export type { StatsBucket, StatsMsg } from '../protocol';

export interface LatencyStats {
  n: number;
  p50Us: number;
  p99Us: number;
  maxUs: number;
  /** le_us = Infinity for the open-ended bucket. */
  buckets: { leUs: number; count: number }[];
  source: 'server' | 'local';
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Parse a `stats` frame; null if not a (valid) stats message. */
export function parseStatsFrame(raw: string): LatencyStats | null {
  if (!raw.includes('"stats"')) return null;
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(d) || d.type !== 'stats') return null;
  if (!isNum(d.n) || !Array.isArray(d.buckets)) return null;
  const buckets: LatencyStats['buckets'] = [];
  for (const b of d.buckets) {
    if (!isObj(b) || !isNum(b.count)) return null;
    const le = b.le_us;
    // Accept null, "inf", or a huge/non-finite number as the open bucket.
    const leUs = isNum(le) ? le : le === null || le === 'inf' || le === 'Infinity' ? Infinity : NaN;
    if (Number.isNaN(leUs)) return null;
    buckets.push({ leUs, count: b.count });
  }
  return {
    n: d.n,
    p50Us: isNum(d.p50_us) ? d.p50_us : 0,
    p99Us: isNum(d.p99_us) ? d.p99_us : 0,
    maxUs: isNum(d.max_us) ? d.max_us : 0,
    buckets,
    source: 'server',
  };
}

/** Default bucket edges for the local fallback, µs (150..170 ms + inf). */
export const LOCAL_BUCKETS_US = [150_000, 152_500, 155_000, 157_500, 160_000, 165_000, 170_000, Infinity];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

/** Fallback when the server lacks `stats`: histogram from locally received hb_timeout events. */
export function statsFromSamples(samplesUs: number[], edges = LOCAL_BUCKETS_US): LatencyStats {
  const sorted = [...samplesUs].sort((a, b) => a - b);
  const buckets = edges.map((leUs) => ({ leUs, count: 0 }));
  for (const s of sorted) {
    const b = buckets.find((x) => s <= x.leUs) ?? buckets[buckets.length - 1];
    b.count += 1;
  }
  return {
    n: sorted.length,
    p50Us: percentile(sorted, 50),
    p99Us: percentile(sorted, 99),
    maxUs: sorted.length ? sorted[sorted.length - 1] : 0,
    buckets,
    source: 'local',
  };
}
