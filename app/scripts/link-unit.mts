// Unit test for TeleopLink safety logic using a fake WebSocket + fake clock.
// Usage: npm run test:link
import { parseServerMessage } from '../src/protocol';
import { parseStatsFrame, statsFromSamples } from '../src/net/stats';
import {
  CONNECT_TIMEOUT_MS,
  createSessionClock,
  rejectReasonFromMessage,
  STALE_MS,
  TeleopLink,
  W_MAX,
} from '../src/net/teleopLink';

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
check(link.getSnapshot().rejectReason === 'unknown', 'no status exposed → reason unknown');

// Handshake status from the native error message (iOS SocketRocket / Android OkHttp).
check(rejectReasonFromMessage('Received bad response code from server: 403.') === 'forbidden', 'iOS 403 → forbidden');
check(rejectReasonFromMessage("Expected HTTP 101 response but was '401 Unauthorized'") === 'unauthorized', 'Android 401 → unauthorized');
check(rejectReasonFromMessage('... 409 ...') === 'conflict', '409 → conflict');
check(rejectReasonFromMessage(undefined) === 'unknown', 'no message → unknown');
link.connect();
ws = FakeWS.last!;
(ws.onerror as unknown as (e: object) => void)?.({ message: 'Received bad response code from server: 403.' });
ws.onclose?.();
check(link.getSnapshot().rejectReason === 'forbidden', 'onerror 403 then close → forbidden kept');

// 5 s connect timeout → rejected 'timeout' and socket closed.
const realSetTimeout = globalThis.setTimeout;
let pending = null as { fn: () => void; ms: number } | null;
(globalThis as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number) => {
  pending = { fn, ms };
  return 1;
};
link.connect();
ws = FakeWS.last!;
(globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
check(pending?.ms === CONNECT_TIMEOUT_MS && link.getSnapshot().status === 'connecting', 'connect arms 5 s timer');
pending!.fn();
check(
  link.getSnapshot().status === 'rejected' && link.getSnapshot().rejectReason === 'timeout' && ws.readyState === 3,
  'not open after 5 s → rejected timeout, socket closed',
);

check(parseServerMessage(JSON.stringify({ ...state('ARMED'), pose: { x: 'a', y: 0, theta: 0 } })) === null, 'invalid pose ignored');
check(parseServerMessage(JSON.stringify({ ...state('ARMED'), vel: { v: 1 } })) === null, 'missing vel.w ignored');
check(parseServerMessage(JSON.stringify(state('FLYING'))) === null, 'unknown mode ignored');
check(parseServerMessage('{"type":"state","pose":{"x":1e999,"y":0,"theta":0}}') === null, 'non-finite pose ignored');

// Latency stats: server frame, local fallback, request.
{
  const l2 = new TeleopLink('ws://x:8080/?t=1', { now: () => t });
  l2.connect();
  const w2 = FakeWS.last!;
  w2.open();
  check(l2.requestStats() && w2.sent.at(-1)?.type === 'stats_req', 'requestStats sends stats_req');
  w2.rx({ type: 'event', event: 'SAFE_STOP', reason: 'hb_timeout', detect_us: 156000 });
  w2.rx({ type: 'event', event: 'SAFE_STOP', reason: 'estop', detect_us: 80 });
  check(l2.getSnapshot().hbTimeoutUs.join() === '156000', 'only hb_timeout kept as local sample');
  w2.rx({ type: 'stats', n: 3, p50_us: 155000, p99_us: 161000, max_us: 161000, buckets: [{ le_us: 160000, count: 2 }, { le_us: null, count: 1 }] });
  const ss = l2.getSnapshot().serverStats;
  check(ss?.source === 'server' && ss.n === 3 && ss.buckets[1].leUs === Infinity, 'stats frame parsed (null = inf)');
  check(l2.getSnapshot().events.length === 2, 'stats frame not treated as event');
  check(parseStatsFrame('{"type":"stats","n":1,"buckets":[{"le_us":"x","count":1}]}') === null, 'invalid stats ignored');
  const loc = statsFromSamples([151000, 156000, 158000, 175000]);
  const counts = loc.buckets.map((b) => b.count).join(',');
  check(
    loc.n === 4 && loc.maxUs === 175000 && loc.p50Us === 156000 && counts === '0,1,0,1,1,0,0,1',
    'local fallback histogram',
    counts,
  );
  l2.disconnect();
}

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
