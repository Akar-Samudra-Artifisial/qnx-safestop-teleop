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
- **Net thread**, priority 10: WebSocket server via libwebsockets (fallback: own
  minimal RFC 6455 server). Decodes JSON and forwards each message to the control
  channel with `MsgSendPulse` (never blocks the net thread on the control loop).
- **Control thread**, `SCHED_FIFO` priority 50: periodic `timer_create` +
  `SIGEV_PULSE` at 100 Hz (10 ms). Each tick checks heartbeat age.
- **Safe-stop**: no `hb` for > 150 ms → mode `SAFE_STOP`: velocity ramped to 0 and
  latched; only an explicit `arm` re-enables motion. `estop` forces `SAFE_STOP`.

### simplant
Simulated differential-drive robot integrated at 200 Hz; receives velocity
setpoints via `MsgSend` and replies with pose. Monitored by **HAM** (restart on death).

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
| `state` | `seq_ack`, `pose`, `vel`, `mode`, `hb_age_ms`, `rtt` |
| `event` | `SAFE_STOP`, `reason`, `detect_us` |

TypeScript definitions: [app/src/protocol.ts](../app/src/protocol.ts).
