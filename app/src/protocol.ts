// Wire protocol between the companion app and teleopd (JSON over WebSocket).
// Keep in sync with docs/ARCHITECTURE.md and qnx/common.

/** Client → server heartbeat, sent at 20 Hz. */
export interface HeartbeatMsg {
  type: 'hb';
  seq: number;
  /** Client timestamp, ms: session-start epoch + monotonic elapsed (never goes backwards). */
  ts: number;
}

/** Client → server velocity command. */
export interface CommandMsg {
  type: 'cmd';
  seq: number;
  /** Linear velocity, m/s. */
  v: number;
  /** Angular velocity, rad/s. */
  w: number;
  ts: number;
}

export interface ArmMsg {
  type: 'arm';
}

export interface EstopMsg {
  type: 'estop';
}

export type ClientMessage = HeartbeatMsg | CommandMsg | ArmMsg | EstopMsg;

export type Mode = 'DISARMED' | 'ARMED' | 'SAFE_STOP';

export interface Pose {
  x: number;
  y: number;
  theta: number;
}

export interface Velocity {
  v: number;
  w: number;
}

/** Server → client periodic state. */
export interface StateMsg {
  type: 'state';
  seq_ack: number;
  pose: Pose;
  vel: Velocity;
  mode: Mode;
  /** ms since the last hb was received; -1 before the first hb. */
  hb_age_ms: number;
  /** Server-measured WebSocket ping RTT, ms; -1 until measured. */
  rtt: number;
  /** teleopd extension: simulated plant (simplant) reachable. */
  plant_ok?: boolean;
}

/** Server → client event. */
export interface SafeStopEvent {
  type: 'event';
  event: 'SAFE_STOP';
  /** 'hb_timeout' (heartbeat deadline missed) or 'estop'. */
  reason: string;
  /** µs: last hb received → SAFE_STOP detected (hb_timeout), or estop received → handled. */
  detect_us: number;
}

export type ServerMessage = StateMsg | SafeStopEvent;

export const HEARTBEAT_HZ = 20;
export const HEARTBEAT_DEADLINE_MS = 150;

/** Command limits, matched to teleopd clamps. */
export const V_MAX = 1.0; // m/s
export const W_MAX = 2.0; // rad/s

const MODES: readonly Mode[] = ['DISARMED', 'ARMED', 'SAFE_STOP'];

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const numOr = (x: unknown, fallback: number) => (isNum(x) ? x : fallback);

function parseState(d: Record<string, unknown>): StateMsg | null {
  const { pose, vel, mode, seq_ack } = d;
  if (!isObject(pose) || !isObject(vel)) return null;
  if (!isNum(pose.x) || !isNum(pose.y) || !isNum(pose.theta)) return null;
  if (!isNum(vel.v) || !isNum(vel.w)) return null;
  if (typeof mode !== 'string' || !MODES.includes(mode as Mode)) return null;
  if (!isNum(seq_ack)) return null;
  return {
    type: 'state',
    seq_ack,
    pose: { x: pose.x, y: pose.y, theta: pose.theta },
    vel: { v: vel.v, w: vel.w },
    mode: mode as Mode,
    hb_age_ms: numOr(d.hb_age_ms, -1),
    rtt: numOr(d.rtt, -1),
    plant_ok: typeof d.plant_ok === 'boolean' ? d.plant_ok : undefined,
  };
}

/** Parse a server frame; returns null for malformed or unknown messages. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data)) return null;
  if (data.type === 'state') return parseState(data);
  if (data.type === 'event' && data.event === 'SAFE_STOP') {
    return {
      type: 'event',
      event: 'SAFE_STOP',
      reason: typeof data.reason === 'string' ? data.reason : 'unknown',
      detect_us: numOr(data.detect_us, 0),
    };
  }
  return null;
}
