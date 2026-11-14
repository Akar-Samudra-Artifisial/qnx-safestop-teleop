#!/usr/bin/env node
// Dev-only mock of teleopd: same JSON protocol (see docs/ARCHITECTURE.md),
// differential-drive kinematics, 150 ms heartbeat deadline, arm / estop.
// Same pairing contract as teleopd: ws://host:port/?t=<token> (env TELEOP_TOKEN, default
// 123456) else 401; a non-empty, non-"null" Origin is refused with 403 unless it equals
// --origin or http(s)://<Host> (Host = IPv4 literal/localhost); a second client while ARMED is refused with 409.
// Usage: node scripts/mock-server.mjs [--port 8080] [--origin http://localhost:8081] [--quiet]
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(argVal('--port', process.env.PORT ?? 8080));
const QUIET = args.includes('--quiet');
const TOKEN = process.env.TELEOP_TOKEN ?? '123456';
const ALLOWED_ORIGIN = argVal('--origin', '');
// --dev-plant: accept {type:'dev_plant', ok:boolean} to simulate simplant death/restart (test only).
const DEV_PLANT = args.includes('--dev-plant');

const DEADLINE_MS = 150;
const CONTROL_HZ = 100;
const PLANT_HZ = 200;
const STATE_HZ = 20;
const V_MAX = 1.0;
const W_MAX = 2.0; // same clamp as teleopd
const RAMP = 3.0; // m/s² and rad/s² toward setpoint / zero
const HALF = 5; // map is 10×10 m centred on origin

const log = (...a) => !QUIET && console.log(new Date().toISOString().slice(11, 23), ...a);
const nowUs = () => Number(process.hrtime.bigint() / 1000n);

const robot = {
  mode: 'DISARMED',
  pose: { x: 0, y: 0, theta: Math.PI / 2 },
  vel: { v: 0, w: 0 },
  sp: { v: 0, w: 0 },
  lastHbUs: 0,
  seqAck: 0,
  plantOk: true,
};

// hb_timeout detect_us history and `stats` reply, same shape/buckets as teleopd.
const STATS_RING = 1024;
const STATS_LE_US = [150000, 152000, 154000, 156000, 158000, 160000, 165000, 170000, null];
const detectRing = [];

function statsMsg() {
  const v = [...detectRing].sort((a, b) => a - b);
  const pct = (p) => (v.length ? v[Math.max(1, Math.ceil(p * v.length)) - 1] : -1);
  const buckets = STATS_LE_US.map((le_us) => ({ le_us, count: 0 }));
  for (const x of v) buckets.find((b) => b.le_us === null || x <= b.le_us).count += 1;
  return {
    type: 'stats',
    n: v.length,
    p50_us: pct(0.5),
    p99_us: pct(0.99),
    max_us: v.length ? v[v.length - 1] : -1,
    buckets,
  };
}

function safeStop(reason, detectUs) {
  if (robot.mode === 'SAFE_STOP') return;
  robot.mode = 'SAFE_STOP';
  robot.sp = { v: 0, w: 0 };
  // Like teleopd: estop zeroes velocity at once, other reasons ramp down.
  if (reason === 'estop') robot.vel = { v: 0, w: 0 };
  if (reason === 'hb_timeout') {
    detectRing.push(detectUs);
    if (detectRing.length > STATS_RING) detectRing.shift();
  }
  log(`SAFE_STOP reason=${reason} detect_us=${detectUs}`);
  broadcast({ type: 'event', event: 'SAFE_STOP', reason, detect_us: detectUs });
}

const tokenOk = (got) => {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Same rule as teleopd origin_ok(): Host must be an IPv4 literal or localhost (optional
// :port) for the same-host case, so a DNS-rebinding name cannot pass.
const HOST_LITERAL_RE = /^(localhost|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/i;
const originOk = (origin, host) => {
  if (!origin || origin === 'null') return true;
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) return true;
  const m = /^https?:\/\/(.*)$/i.exec(origin);
  return !!m && !!host && HOST_LITERAL_RE.test(host) && m[1].toLowerCase() === host.toLowerCase();
};

function verifyClient({ req }, done) {
  const origin = req.headers.origin;
  if (!originOk(origin, req.headers.host)) {
    log('handshake refused: 403', `origin=${origin} host=${req.headers.host}`);
    return done(false, 403, 'Forbidden');
  }
  const t = new URL(req.url ?? '/', 'http://mock').searchParams.get('t');
  if (!tokenOk(t)) return done(false, 401, 'Unauthorized');
  if (wss.clients.size > 0 && robot.mode === 'ARMED') return done(false, 409, 'Conflict');
  done(true);
}

const wss = new WebSocketServer({ port: PORT, verifyClient });
const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};

wss.on('connection', (ws, req) => {
  // Single operator: a new (authorised, not-ARMED) client replaces the previous one.
  // --dev-plant control sockets (?dev=1) neither replace nor get replaced.
  ws.dev = DEV_PLANT && new URL(req.url ?? '/', 'http://x').searchParams.get('dev') === '1';
  if (!ws.dev) {
    for (const c of wss.clients) if (c !== ws && !c.dev) c.terminate();
    // Per-operator link state: a new client's seq restarts at 0, so a stale seq_ack from the
    // previous session would never match (RTT stays null). Same for heartbeat age.
    robot.seqAck = 0;
    robot.lastHbUs = 0;
  }
  log('client connected', req.socket.remoteAddress);
  ws.on('message', (data) => {
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    const t = nowUs();
    switch (m?.type) {
      case 'hb':
        robot.lastHbUs = t;
        if (Number.isFinite(m.seq)) robot.seqAck = Math.max(robot.seqAck, m.seq);
        break;
      case 'cmd':
        if (Number.isFinite(m.seq)) robot.seqAck = Math.max(robot.seqAck, m.seq);
        if (robot.mode === 'ARMED' && Number.isFinite(m.v) && Number.isFinite(m.w)) {
          robot.sp = {
            v: Math.max(-V_MAX, Math.min(V_MAX, m.v)),
            w: Math.max(-W_MAX, Math.min(W_MAX, m.w)),
          };
        }
        break;
      case 'dev_plant':
        if (ws.dev && typeof m.ok === 'boolean') {
          robot.plantOk = m.ok;
          log(`plant ${m.ok ? 'up' : 'down'} (dev)`);
          // Same as teleopd: plant lost while ARMED -> SAFE_STOP, detect_us -1.
          if (!m.ok && robot.mode === 'ARMED') safeStop('plant_lost', -1);
        }
        break;
      case 'arm':
        if (!robot.plantOk) {
          log('arm rejected: plant down');
        } else if (t - robot.lastHbUs <= DEADLINE_MS * 1000) {
          robot.mode = 'ARMED';
          robot.sp = { v: 0, w: 0 };
          log('ARMED');
        } else {
          log('arm rejected: heartbeat stale');
        }
        break;
      case 'estop':
        safeStop('estop', 0);
        break;
      case 'stats_req':
        if (ws.readyState === 1) ws.send(JSON.stringify(statsMsg()));
        break;
    }
  });
  ws.on('close', () => {
    log('client disconnected');
    if (![...wss.clients].some((c) => !c.dev) && robot.mode === 'ARMED') safeStop('client_lost', 0);
  });
});

// Control loop: heartbeat deadline check.
setInterval(() => {
  if (robot.mode !== 'ARMED') return;
  // detect_us = last hb received -> detection, same as teleopd.
  const age = nowUs() - robot.lastHbUs;
  if (age > DEADLINE_MS * 1000) safeStop('hb_timeout', age);
}, 1000 / CONTROL_HZ);

// Plant: ramp velocity toward setpoint and integrate pose.
const dt = 1 / PLANT_HZ;
const approach = (cur, target, step) =>
  cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
setInterval(() => {
  const target = robot.mode === 'ARMED' ? robot.sp : { v: 0, w: 0 };
  robot.vel.v = approach(robot.vel.v, target.v, RAMP * dt);
  robot.vel.w = approach(robot.vel.w, target.w, RAMP * dt);
  const p = robot.pose;
  p.theta = Math.atan2(Math.sin(p.theta + robot.vel.w * dt), Math.cos(p.theta + robot.vel.w * dt));
  p.x = Math.max(-HALF, Math.min(HALF, p.x + robot.vel.v * Math.cos(p.theta) * dt));
  p.y = Math.max(-HALF, Math.min(HALF, p.y + robot.vel.v * Math.sin(p.theta) * dt));
}, 1000 / PLANT_HZ);

// State broadcast.
setInterval(() => {
  const age = robot.lastHbUs ? (nowUs() - robot.lastHbUs) / 1000 : -1;
  broadcast({
    type: 'state',
    seq_ack: robot.seqAck,
    pose: { ...robot.pose },
    vel: { ...robot.vel },
    mode: robot.mode,
    hb_age_ms: Math.round(age),
    rtt: -1,
    plant_ok: robot.plantOk,
  });
}, 1000 / STATE_HZ);

wss.on('listening', () => log(`mock teleopd listening on ws://0.0.0.0:${PORT}`));
