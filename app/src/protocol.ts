// Wire protocol between the companion app and teleopd (JSON over WebSocket).
// Keep in sync with docs/ARCHITECTURE.md and qnx/common.

/** Client → server heartbeat, sent at 20 Hz. */
export interface HeartbeatMsg {
  type: 'hb';
  seq: number;
  /** Client timestamp, ms since epoch. */
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
  hb_age_ms: number;
  rtt: number;
}

/** Server → client event. */
export interface SafeStopEvent {
  type: 'event';
  event: 'SAFE_STOP';
  reason: string;
  /** Time from deadline miss to SAFE_STOP, µs. */
  detect_us: number;
}

export type ServerMessage = StateMsg | SafeStopEvent;

export const HEARTBEAT_HZ = 20;
export const HEARTBEAT_DEADLINE_MS = 150;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
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
  if (data.type === 'state' && typeof data.mode === 'string') return data as unknown as StateMsg;
  if (data.type === 'event' && data.event === 'SAFE_STOP') return data as unknown as SafeStopEvent;
  return null;
}
