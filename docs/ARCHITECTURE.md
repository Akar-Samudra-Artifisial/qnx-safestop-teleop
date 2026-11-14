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
  `-t <token>`) to stdout and slog2. The client must connect to `ws://host:8080/?t=<token>`;
  a wrong/missing token → HTTP 401 (constant-time compare).
- A non-empty `Origin` other than `null` → 403 (blocks drive-by pages in a browser on the
  same LAN). The RN app sends no `Origin`; a web dev build can be allowed with
  `-o http://localhost:8081`.
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

### Stretch
- Resource manager `/dev/teleop` (read state / write commands from the shell).
- `latbench`: p50/p99/max wake-up latency with a CPU hog → [BENCH.md](BENCH.md).

## Protocol (JSON over WebSocket)

Client → server:

| type | fields | rate |
|---|---|---|
| `hb` | `seq`, `ts` | 20 Hz |
| `cmd` | `seq`, `v`, `w`, `ts` | on input |
| `arm` | — | on demand |
| `estop` | — | on demand |

Server → client:

| type | fields |
|---|---|
| `state` | `seq_ack`, `pose`, `vel`, `mode`, `hb_age_ms`, `rtt`, `plant_ok` |
| `event` | `SAFE_STOP`, `reason`, `detect_us` |

- `state` at 20 Hz. `seq_ack` = last `hb.seq`; `hb_age_ms` = −1 before the first `hb`;
  `rtt` (ms) from a WebSocket ping/pong every 1 s, −1 until measured; `vel` = ramped
  command sent to the plant; `plant_ok` (extra field) = simplant reachable.
- `event.reason`: `hb_timeout` (`detect_us` = last `hb` received → detection, i.e.
  ≈ 150 ms + ≤ 1 tick), `estop` (`detect_us` = `estop` received → handled),
  `client_lost` / `client_replaced` (`detect_us` = 0).
- Connect URL: `ws://host:8080/?t=<token>`; handshake refusals: 401 token, 403 Origin,
  409 another client is `ARMED`.

TypeScript definitions: [app/src/protocol.ts](../app/src/protocol.ts).
