# Architecture

Target: **QNX 8.0 aarch64le** running in QEMU (`virt` machine), app on a phone.

```
 Phone (Expo app)                QNX 8.0 (QEMU aarch64)
 ┌──────────────┐  WebSocket   ┌───────────────────────────────────────────┐
 │ joystick     │──hb 20 Hz───▶│ teleopd                                   │
 │ arm / e-stop │──cmd───────▶ │  net thread (prio 10)                     │
 │ status, RTT  │◀─state/event─│    └─MsgSendPulse─▶ control channel       │
 └──────────────┘              │  control thread (SCHED_FIFO prio 50)      │
                               │    timer_create + SIGEV_PULSE @ 100 Hz    │
                               │    hb deadline 150 ms → SAFE_STOP         │
                               │    └─MsgSend─▶ simplant (200 Hz, HAM)     │
                               └───────────────────────────────────────────┘
```

## Processes

### teleopd
- Threads: net (`10r`), control (`50f`), resmgr (`10r`, see *`/dev/teleop`*).
- **Net thread**, `SCHED_RR` priority 10: own minimal RFC 6455 WebSocket server
  (`qnx/common/ws.c`, one operator; see *Pairing & threat model*). Decodes JSON,
  stores the payload in an inbox guarded by a `PTHREAD_PRIO_INHERIT` mutex and wakes
  the control thread with `MsgSendPulse` (never blocks on the control loop). Pulses are
  coalesced: `cmd`/`arm`/`estop` set a pending bit (C11 atomic) and a pulse is sent only
  when that bit was clear; `hb` sends no pulse (the tick reads its age). `estop` pulses at
  prio 50, all others at 10. Per-message logs are rate-limited to 1/s.
- **arm vs. estop ordering**: the net thread stamps `arm_rx_ns`/`estop_rx_ns`
  (`CLOCK_MONOTONIC`) on receipt; `arm` is refused when `arm_rx_ns <= estop_rx_ns`, so an
  `estop` received after an `arm` always wins regardless of pulse handling order.
- **Sockets**: the HTTP upgrade is read non-blocking with a 2 s total deadline (max 4
  handshakes in flight, extra connects are closed); after the upgrade `SO_SNDTIMEO`
  = 200 ms, and any failed send drops the client. Frames with RSV bits, fragmented or
  > 125-byte control frames are closed with 1002.
- **Control thread**, `SCHED_FIFO` priority 50: periodic `timer_create` +
  `SIGEV_PULSE` at 100 Hz (10 ms) on a `_NTO_CHF_FIXED_PRIORITY` channel. Each tick
  checks heartbeat age, ramps velocity (2 m/s², 4 rad/s²) and exchanges
  velocity/pose with simplant (`MsgSend` bounded by `TimerTimeout` 5 ms).
- **Safe-stop**: no `hb` for > 150 ms (`-d`) → mode `SAFE_STOP`: velocity ramped to 0 and
  latched; only an explicit `arm` (accepted only with a fresh `hb`) re-enables motion.
  Losing the client while `ARMED` (`client_lost`, or `client_replaced` in a race) is a
  safe-stop too, with the same ramp.
- **estop vs. hb_timeout**: `estop` forces `SAFE_STOP` and zeroes `v`,`w` at once (no
  ramp) and pushes the zero setpoint to simplant in the same pulse handler. Rationale:
  estop is a deliberate operator command, so the expected behaviour is "stop now"; a
  ramp would keep the robot moving for up to 0.5 s (1 m/s ÷ 2 m/s²). A heartbeat or link
  loss is ambiguous (Wi‑Fi hiccup) and the robot is still under its own control, so it
  decelerates with the bounded ramp (2 m/s², 4 rad/s²) to avoid an abrupt stop / load
  shift; simplant's own 200 ms setpoint watchdog is the backstop if teleopd dies.
- **cmd validation**: only in `ARMED`; `seq` must be an integer with |seq| < 2^53 and
  increase (per connection); `ts` must be finite, ≥ 0 and < 2^53; `v`,`w` finite —
  otherwise the message is dropped (same for `hb.seq`). `ts` lag > 300 ms relative to the
  best client/server clock offset seen is stale; no fresh cmd for 500 ms → target 0.
  Clamp |v| ≤ 1 m/s, |w| ≤ 2 rad/s (server `W_MAX` = 2.0; the mock uses the same).
- **simplant reply**: `MsgReply` status = `sizeof(plant_pose_t)`; teleopd checks the
  `MsgSend` return value and that every pose field is finite before using it, so a
  short/garbled reply or NaN never reaches the JSON `snprintf`.

### Pairing & threat model
- teleopd prints a 6-digit pairing token at start (from `/dev/urandom`, or fixed with
  `-t <token>`) to stdout only (never to slog2, which any local user can read). The client must connect to `ws://host:8080/?t=<token>`;
  a wrong/missing token → HTTP 401 (constant-time compare).
- A non-empty `Origin` other than `null` → 403 (blocks drive-by pages in a browser on the
  same LAN), except: the `-o` origin (e.g. a web dev build, `-o http://localhost:8081`) and
  **same-host** `Origin == http(s)://<Host header>` — RN on iOS (SocketRocket) sends
  `Origin: http://<ip>:8080`, RN on Android sends none. Same-host is only accepted when `Host`
  is an IPv4 literal or `localhost` (optional `:port`): a DNS-rebinding page uses its own
  name as Host/Origin and is still refused. Refusals are logged (1/s) with status, Origin
  and Host; the request path is never logged because it carries the token.
- One operator: while a session is `ARMED`, a second client gets 409; when not `ARMED` a
  new authenticated client replaces the old one.
- Scope: the token protects against casual access on a **trusted LAN** (demo Wi‑Fi). It is
  not designed for the public internet: plain `ws://` (no TLS, token visible to anyone
  sniffing the LAN), 6 digits (~10^6) with no lockout. Do not port-forward 8080. SSH
  (port 2222, root) is forwarded on `127.0.0.1` only by default.

### simplant
Simulated differential-drive robot (10×10 m area, clamped) integrated at 200 Hz;
`name_attach("simplant")`, receives velocity setpoints via `MsgSend` and replies with
pose; own watchdog zeroes velocity after 200 ms without a setpoint. teleopd keeps
running without it (`plant_ok=false`, reconnect every 500 ms). **HAM** restart: M3.

### /dev/teleop (resource manager in teleopd)
- **resmgr thread**, `SCHED_RR` 10: `resmgr_attach("/dev/teleop")` with the default
  `iofunc_*` handlers plus own `read` and `devctl`; node `S_IFCHR 0640 root:root`. It is
  optional: if the attach fails teleopd logs it and keeps running (the safe-stop does not
  depend on it).
- `read` (`cat /dev/teleop`, `teleopctl status`): `key=value` lines — `mode`, `hb_age_ms`,
  `deadline_ms`, `pose_x/y/theta`, `plant_ok`, `events`, `hb_timeouts`, `detect_n`,
  `detect_p50_us/p99_us/max_us`.
- `devctl` (needs the node open for writing): `DCMD_TELEOP_SET_DEADLINE` (`int32_t` ms,
  50–1000, validated in teleopd → `EINVAL`; `g_deadline_ns` is a C11 atomic read by the
  control tick) and `DCMD_TELEOP_ESTOP` (stamps `estop_rx_ns` and sends the prio-50 estop
  pulse, exactly like a WebSocket `estop`). Codes in `qnx/common/teleop_dcmd.h`, private
  class 0xE0. Client: `qnx/teleopctl`.
- **Safety note:** `SET_DEADLINE` can raise the heartbeat deadline up to 1000 ms, which
  weakens the safe-stop guarantee to at most 1 s. Only root can do it (node mode 0640
  root:root, devctl needs write access), every change logs a WARNING to slog2, and the
  default stays 150 ms at each teleopd start.

### Fault injection & bench
- `qnx/latbench` CPU hog (`pthread_setschedparam`, one busy thread per CPU) driven by
  `tools/fault/cpu-hog.sh`; `wsclient.py --bench N` runs N hb-loss trials → CSV;
  `tools/fault/slay-plant.sh` kills simplant and times the recovery. Results:
  [BENCH.md](BENCH.md).

## Protocol (JSON over WebSocket)

Client → server:

| type | fields | rate |
|---|---|---|
| `hb` | `seq`, `ts` | 20 Hz |
| `cmd` | `seq`, `v`, `w`, `ts` | on input |
| `arm` | — | on demand |
| `estop` | — | on demand |
| `stats_req` | — | on demand (app polls) |

Server → client:

| type | fields |
|---|---|
| `state` | `seq_ack`, `pose`, `vel`, `mode`, `hb_age_ms`, `rtt`, `plant_ok` |
| `event` | `SAFE_STOP`, `reason`, `detect_us` |
| `stats` | `n`, `p50_us`, `p99_us`, `max_us`, `buckets: [{le_us, count}]` (reply to `stats_req`) |

- `stats` = histogram of `detect_us` of the last ≤ 1024 `hb_timeout` events kept by teleopd
  (ring buffer, since teleopd start). Fixed buckets `le_us` = 150, 152, 154, 156, 158, 160,
  165, 170 ms and `null` (+inf); a sample counts in the first bucket with `detect_us ≤ le_us`.
  Percentiles are nearest-rank; `p50_us`/`p99_us`/`max_us` = −1 when `n` = 0. The mock
  server answers with the same shape.

- `state` at 20 Hz. `seq_ack` = last `hb.seq`; `hb_age_ms` = −1 before the first `hb`;
  `rtt` (ms) from a WebSocket ping/pong every 1 s, −1 until measured; `vel` = ramped
  command sent to the plant; `plant_ok` (extra field) = simplant reachable.
- `event.reason`: `hb_timeout` (`detect_us` = last `hb` received → detection, i.e.
  ≈ 150 ms + ≤ 1 tick), `estop` (`detect_us` = `estop` received → handled),
  `client_lost` / `client_replaced` (`detect_us` = 0).
- Connect URL: `ws://host:8080/?t=<token>`; handshake refusals: 401 token, 403 Origin,
  409 another client is `ARMED`.

TypeScript definitions: [app/src/protocol.ts](../app/src/protocol.ts).
