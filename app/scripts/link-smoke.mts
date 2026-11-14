// End-to-end smoke test of the app link logic (src/net/teleopLink.ts) against
// a running teleopd or scripts/mock-server.mjs.
// Usage: TELEOP_TOKEN=123456 npm run smoke -- [ws://localhost:8080]
//        (or TELEOP_URL=ws://... ; the pairing token defaults to 123456 like the mock)
import { buildLinkUrl, TeleopLink } from '../src/net/teleopLink';

const target = process.argv[2] ?? process.env.TELEOP_URL ?? 'ws://localhost:8080';
const token = process.env.TELEOP_TOKEN ?? '123456';
const address = target.replace(/^ws:\/\//, '').replace(/\/.*$/, '');
const url = buildLinkUrl(address, token);
console.log(`target ws://${address}/ (token from TELEOP_TOKEN)`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const waitFor = async (pred: () => boolean, timeoutMs: number) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
};

// Wrong token: the handshake is refused (401) and the link reports 'rejected'.
const wrong = new TeleopLink(buildLinkUrl(address, token === '000000' ? '111111' : '000000'));
wrong.connect();
await waitFor(() => wrong.getSnapshot().status === 'rejected', 1500);
check(wrong.getSnapshot().status === 'rejected', 'wrong token rejected', wrong.getSnapshot().status);
wrong.disconnect();

const link = new TeleopLink(url);
link.connect();
await sleep(600);
let s = link.getSnapshot();
check(s.status === 'open', 'socket open', s.status);
check(s.state !== null, 'state frames received', s.state?.mode);
check(s.rttMs !== null, 'RTT measured', `${s.rttMs} ms`);

// setAxis is ignored until the server reports ARMED, so arm first.
link.arm();
const armed = await waitFor(() => link.getSnapshot().state?.mode === 'ARMED', 1000);
check(armed, 'armed after arm', link.getSnapshot().state?.mode);
link.setAxis(1, 0.3);
await sleep(1500);
s = link.getSnapshot();
const p = s.state?.pose;
check(!!p && Math.hypot(p.x, p.y) > 0.3, 'robot moved under cmd', p ? `x=${p.x.toFixed(2)} y=${p.y.toFixed(2)}` : '');
check(s.trail.length > 5, 'trail recorded', `${s.trail.length} pts`);

link.setLinkLossSim(true);
await sleep(400);
s = link.getSnapshot();
check(s.status === 'open', 'socket still open during simulated loss', s.status);
check(s.state?.mode === 'SAFE_STOP', 'SAFE_STOP on hb deadline', s.state?.mode);
const ev = s.events[0];
check(ev?.reason === 'hb_timeout', 'SAFE_STOP event received', ev ? `${ev.reason} detect ${ev.detectMs.toFixed(2)} ms` : 'none');

link.setLinkLossSim(false);
link.setAxis(0, 0);
await sleep(200);
link.arm();
const rearmed = await waitFor(() => link.getSnapshot().state?.mode === 'ARMED', 1000);
check(rearmed, 're-arm after link restored', link.getSnapshot().state?.mode);

link.estop();
await sleep(200);
s = link.getSnapshot();
check(s.state?.mode === 'SAFE_STOP' && s.events[0]?.reason === 'estop', 'E-STOP forces SAFE_STOP', s.events[0]?.reason);

link.disconnect();
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
