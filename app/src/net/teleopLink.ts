// Framework-free teleop link: WebSocket + 20 Hz hb/cmd loop + RTT.
// Kept free of React/RN imports so it can be smoke-tested from Node.
import {
  HEARTBEAT_HZ,
  parseServerMessage,
  V_MAX,
  W_MAX,
  type ClientMessage,
  type Pose,
  type SafeStopEvent,
  type StateMsg,
} from '../protocol';
import { parseStatsFrame, type LatencyStats } from './stats';

export { V_MAX, W_MAX };
/** Local hb_timeout detect_us samples kept for the latency fallback. */
const MAX_LOCAL_SAMPLES = 500;
/** No `state` frame for this long while open → data considered stale. */
export const STALE_MS = 1000;

const TICK_MS = Math.round(1000 / HEARTBEAT_HZ);
const MAX_EVENTS = 8;
const MAX_TRAIL = 600;
const TRAIL_MIN_STEP_M = 0.03;
const SENT_WINDOW = 256;

/** `rejected`: socket failed/closed before it ever opened (bad token, robot in use, unreachable). */
export type LinkStatus = 'connecting' | 'open' | 'closed' | 'error' | 'rejected';

export interface LinkEvent {
  id: number;
  reason: string;
  detectMs: number;
  /** Client receive time (session clock), ms. */
  at: number;
}

export interface TrailPoint {
  x: number;
  y: number;
}

/** Not opened within this long → closed with rejectReason 'timeout'. */
export const CONNECT_TIMEOUT_MS = 5000;

/**
 * Why a handshake never opened. HTTP status is parsed from the native error message when
 * RN exposes it (iOS: "...bad response code from server: 403", Android OkHttp: "...was
 * '403 Forbidden'"); otherwise 'unknown'.
 */
export type RejectReason = 'unauthorized' | 'forbidden' | 'conflict' | 'timeout' | 'unknown';

const REJECT_BY_STATUS: Record<string, RejectReason> = {
  '401': 'unauthorized',
  '403': 'forbidden',
  '409': 'conflict',
};

export function rejectReasonFromMessage(msg: unknown): RejectReason {
  const m = typeof msg === 'string' ? /\b(401|403|409)\b/.exec(msg) : null;
  return m ? REJECT_BY_STATUS[m[1]] : 'unknown';
}

export interface LinkSnapshot {
  url: string;
  status: LinkStatus;
  /** Set with status 'rejected'; null otherwise. */
  rejectReason: RejectReason | null;
  state: StateMsg | null;
  /** Server-measured ping RTT when available, else client-measured seq→seq_ack, ms. */
  rttMs: number | null;
  linkLossSim: boolean;
  stale: boolean;
  events: LinkEvent[];
  trail: TrailPoint[];
  /** Last `stats` reply from teleopd; null until the server answers `stats_req`. */
  serverStats: LatencyStats | null;
  /** detect_us of every hb_timeout SAFE_STOP received this session (fallback histogram). */
  hbTimeoutUs: number[];
}

export interface TeleopLinkOptions {
  onSafeStop?: (e: SafeStopEvent) => void;
  /** Clock in ms; must be monotonic. Defaults to {@link createSessionClock}. */
  now?: () => number;
}

/**
 * Monotonic session clock: wall-clock epoch captured once at session start plus
 * `performance.now()` elapsed. Phone clock adjustments cannot make it go backwards.
 */
export function createSessionClock(): () => number {
  const perf = globalThis.performance;
  if (!perf || typeof perf.now !== 'function') {
    let last = 0;
    return () => (last = Math.max(last, Date.now()));
  }
  const offset = Date.now() - perf.now();
  return () => offset + perf.now();
}

/** teleopd pairing URL: `ws://host:port/?t=<6-digit token>`. */
export function buildLinkUrl(address: string, token: string): string {
  return `ws://${address}/?t=${encodeURIComponent(token)}`;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const finiteOr0 = (x: number) => (Number.isFinite(x) ? x : 0);

export class TeleopLink {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private seq = 0;
  private sentAt = new Map<number, number>();
  private lastAck = -1;
  private lastRxAt = 0;
  private eventId = 0;
  private v = 0;
  private w = 0;
  /**
   * Set by estop / SAFE_STOP event; blocks motion until the server reports a
   * non-ARMED mode (closes the gap before the next `state` frame arrives).
   */
  private inhibit = false;
  private snap: LinkSnapshot;
  private readonly now: () => number;

  constructor(
    url: string,
    private readonly opts: TeleopLinkOptions = {},
  ) {
    this.now = opts.now ?? createSessionClock();
    this.snap = {
      url,
      status: 'closed',
      rejectReason: null,
      state: null,
      rttMs: null,
      linkLossSim: false,
      stale: false,
      events: [],
      trail: [],
      serverStats: null,
      hbTimeoutUs: [],
    };
  }

  // --- store API (useSyncExternalStore) ---
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): LinkSnapshot => this.snap;

  /** Last command seq sent (diagnostics/tests). */
  getSentSeq(): number {
    return this.seq;
  }

  /** Current velocity setpoint that the next `cmd` will carry (m/s, rad/s). */
  getAxis(): { v: number; w: number } {
    return { v: this.v, w: this.w };
  }

  private update(patch: Partial<LinkSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((fn) => fn());
  }

  /** Motion is only allowed while open, fresh and ARMED. */
  private canDrive(): boolean {
    const s = this.snap;
    return !this.inhibit && s.status === 'open' && !s.stale && s.state?.mode === 'ARMED';
  }

  private zeroAxis() {
    this.v = 0;
    this.w = 0;
  }

  // --- lifecycle ---
  connect() {
    this.teardown();
    this.zeroAxis();
    this.inhibit = false;
    this.lastAck = -1;
    this.lastRxAt = 0;
    this.sentAt.clear();
    this.update({ status: 'connecting', rejectReason: null, state: null, rttMs: null, stale: false });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.snap.url);
    } catch {
      this.update({ status: 'rejected', rejectReason: 'unknown' });
      return;
    }
    let opened = false;
    // First specific reason wins (onerror carries the message, onclose follows it).
    let reason: RejectReason = 'unknown';
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws || opened) return;
      this.teardown();
      this.zeroAxis();
      this.update({ status: 'rejected', rejectReason: 'timeout' });
    }, CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.clearConnectTimer();
      this.lastRxAt = this.now();
      this.update({ status: 'open' });
      this.timer = setInterval(this.tick, TICK_MS);
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return;
      this.stopTimer();
      this.clearConnectTimer();
      this.zeroAxis();
      if (!opened) {
        if (reason === 'unknown') reason = rejectReasonFromMessage((e as { reason?: unknown } | undefined)?.reason);
        this.update({ status: 'rejected', rejectReason: reason });
        return;
      }
      this.update({ status: this.snap.status === 'error' ? 'error' : 'closed' });
    };
    ws.onerror = (e: Event) => {
      if (this.ws !== ws) return;
      this.zeroAxis();
      if (opened) {
        this.update({ status: 'error' });
        return;
      }
      this.clearConnectTimer();
      if (reason === 'unknown') reason = rejectReasonFromMessage((e as { message?: unknown } | undefined)?.message);
      this.update({ status: 'rejected', rejectReason: reason });
    };
    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws || typeof e.data !== 'string') return;
      this.handleFrame(e.data);
    };
  }

  disconnect() {
    this.teardown();
    this.zeroAxis();
    this.update({ status: 'closed' });
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private teardown() {
    this.stopTimer();
    this.clearConnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws.close();
    }
  }

  // --- inputs ---
  /**
   * Normalized joystick axes in [-1, 1]; scaled to V_MAX / W_MAX.
   * Ignored (forced to 0) unless the link is open, fresh and ARMED.
   */
  setAxis(nv: number, nw: number) {
    if (!this.canDrive()) {
      this.zeroAxis();
      return;
    }
    this.v = clamp(finiteOr0(nv), -1, 1) * V_MAX;
    this.w = clamp(finiteOr0(nw), -1, 1) * W_MAX;
  }

  /** Stops hb + cmd while keeping the socket open (exercises server deadline). */
  setLinkLossSim(on: boolean) {
    this.update({ linkLossSim: on });
  }

  arm() {
    this.send({ type: 'arm' });
  }

  /** Always sent, even while link loss is simulated. Zeroes the setpoint first. */
  estop() {
    this.inhibit = true;
    this.zeroAxis();
    this.send({ type: 'estop' });
  }

  /** Ask teleopd for its hb_timeout latency histogram (reply: `stats`). */
  requestStats(): boolean {
    return this.send({ type: 'stats_req' });
  }

  // --- internals ---
  private send(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  private nextSeq(ts: number): number {
    this.seq += 1;
    this.sentAt.set(this.seq, ts);
    this.sentAt.delete(this.seq - SENT_WINDOW);
    return this.seq;
  }

  private tick = () => {
    const now = this.now();
    const stale = this.lastRxAt > 0 && now - this.lastRxAt > STALE_MS;
    if (stale !== this.snap.stale) this.update({ stale });
    if (!this.canDrive()) this.zeroAxis();
    if (this.snap.linkLossSim) return;

    this.send({ type: 'hb', seq: this.nextSeq(now), ts: now });
    this.send({ type: 'cmd', seq: this.nextSeq(now), v: this.v, w: this.w, ts: now });
  };

  private handleFrame(raw: string) {
    const stats = parseStatsFrame(raw);
    if (stats) {
      this.lastRxAt = this.now();
      this.update({ serverStats: stats });
      return;
    }
    const msg = parseServerMessage(raw);
    if (!msg) return;
    const now = this.now();
    this.lastRxAt = now;

    if (msg.type === 'state') {
      let rttMs = this.snap.rttMs;
      if (msg.rtt >= 0) {
        rttMs = msg.rtt;
      } else if (msg.seq_ack !== this.lastAck) {
        const sent = this.sentAt.get(msg.seq_ack);
        if (sent !== undefined) rttMs = now - sent;
      }
      this.lastAck = msg.seq_ack;
      if (msg.mode !== 'ARMED') {
        this.inhibit = false; // server-side latch now governs
        this.zeroAxis();
      }
      this.update({
        state: msg,
        rttMs,
        stale: false,
        trail: appendTrail(this.snap.trail, msg.pose),
      });
      return;
    }
    if (msg.type !== 'event') return;

    this.inhibit = true;
    this.zeroAxis();
    this.eventId += 1;
    const ev: LinkEvent = {
      id: this.eventId,
      reason: msg.reason,
      detectMs: msg.detect_us / 1000,
      at: now,
    };
    const hbTimeoutUs =
      msg.reason === 'hb_timeout'
        ? [...this.snap.hbTimeoutUs, msg.detect_us].slice(-MAX_LOCAL_SAMPLES)
        : this.snap.hbTimeoutUs;
    this.update({ events: [ev, ...this.snap.events].slice(0, MAX_EVENTS), hbTimeoutUs });
    this.opts.onSafeStop?.(msg);
  }
}

function appendTrail(trail: TrailPoint[], pose: Pose): TrailPoint[] {
  const last = trail[trail.length - 1];
  if (last && Math.hypot(pose.x - last.x, pose.y - last.y) < TRAIL_MIN_STEP_M) return trail;
  const next = [...trail, { x: pose.x, y: pose.y }];
  return next.length > MAX_TRAIL ? next.slice(next.length - MAX_TRAIL) : next;
}
