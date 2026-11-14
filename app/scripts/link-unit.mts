// Unit test for TeleopLink safety logic using a fake WebSocket + fake clock.
// Usage: npm run test:link
import { parseServerMessage } from '../src/protocol';
import { createSessionClock, STALE_MS, TeleopLink, W_MAX } from '../src/net/teleopLink';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

class FakeWS {
  static last: FakeWS | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  rx(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;
const realSetInterval = globalThis.setInterval;
(globalThis as unknown as { setInterval: unknown }).setInterval = () => 0; // drive ticks manually

let t = 1_000_000;
const link = new TeleopLink('ws://x:8080/?t=123456', { now: () => t });
const tick = () => (link as unknown as { tick: () => void }).tick();
const state = (mode: string, extra: object = {}) => ({
  type: 'state',
  seq_ack: link.getSentSeq(),
  pose: { x: 0, y: 0, theta: 0 },
  vel: { v: 0, w: 0 },
  mode,
  hb_age_ms: 10,
  rtt: -1,
  ...extra,
});
const axis = () => link.getAxis();
const lastCmd = (ws: FakeWS) => [...ws.sent].reverse().find((m) => m.type === 'cmd');

link.connect();
let ws = FakeWS.last!;
ws.open();
ws.rx(state('DISARMED'));
link.setAxis(1, 1);
check(axis().v === 0 && axis().w === 0, 'setAxis ignored while DISARMED');

ws.rx(state('ARMED'));
link.setAxis(1, 1);
check(axis().v === 1 && axis().w === W_MAX, 'setAxis applies when ARMED', `w=${axis().w}`);
tick();
check(lastCmd(ws)?.v === 1, 'cmd carries setpoint');

ws.rx({ type: 'event', event: 'SAFE_STOP', reason: 'hb_timeout', detect_us: 151000 });
check(axis().v === 0 && axis().w === 0, 'SAFE_STOP event zeroes v/w');
link.setAxis(1, 1);
check(axis().v === 0, 'setAxis blocked after event even before state update');
tick();
check(lastCmd(ws)?.v === 0 && lastCmd(ws)?.w === 0, 'cmd after event is zero');

ws.rx(state('SAFE_STOP'));
link.setAxis(1, 0);
check(axis().v === 0, 'setAxis ignored in SAFE_STOP');
ws.rx(state('ARMED'));
link.setAxis(0.5, 0);
check(axis().v === 0.5, 're-armed → drive allowed again');

link.estop();
check(axis().v === 0 && ws.sent.at(-1)?.type === 'estop', 'estop zeroes v/w and sends estop');
ws.rx(state('SAFE_STOP'));
ws.rx(state('ARMED'));
link.setAxis(0.5, 0);
t += STALE_MS + 50;
tick();
check(link.getSnapshot().stale && axis().v === 0, 'stale zeroes v/w');
link.setAxis(1, 0);
check(axis().v === 0, 'setAxis ignored while stale');

ws.rx(state('ARMED', { rtt: 12.5 }));
check(link.getSnapshot().rttMs === 12.5, 'server rtt preferred', `${link.getSnapshot().rttMs}`);
link.setAxis(1, 0);
link.connect();
check(axis().v === 0, 'connect zeroes v/w');
ws = FakeWS.last!;
ws.onclose?.();
check(link.getSnapshot().status === 'rejected', 'close before open → rejected');

check(parseServerMessage(JSON.stringify({ ...state('ARMED'), pose: { x: 'a', y: 0, theta: 0 } })) === null, 'invalid pose ignored');
check(parseServerMessage(JSON.stringify({ ...state('ARMED'), vel: { v: 1 } })) === null, 'missing vel.w ignored');
check(parseServerMessage(JSON.stringify(state('FLYING'))) === null, 'unknown mode ignored');
check(parseServerMessage('{"type":"state","pose":{"x":1e999,"y":0,"theta":0}}') === null, 'non-finite pose ignored');

// Monotonic session clock survives wall clock going backwards.
const realNow = Date.now;
const clock = createSessionClock();
const a = clock();
Date.now = () => realNow() - 3_600_000;
const b = clock();
Date.now = realNow;
check(b >= a && Number.isFinite(b), 'session clock monotonic when wall clock jumps back');

globalThis.setInterval = realSetInterval;
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
