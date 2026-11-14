# teleopd

Teleop daemon (QNX 8.0, aarch64le).

- **Net thread** (prio 10): WebSocket server (libwebsockets; fallback: minimal RFC 6455
  server). Parses JSON `hb` / `cmd` / `arm` / `estop` and forwards them to the
  control channel via `MsgSendPulse`.
- **Control thread** (`SCHED_FIFO` prio 50): `timer_create` + `SIGEV_PULSE` at 100 Hz.
  Heartbeat deadline 150 ms → `SAFE_STOP` (ramp to 0, latched until `arm`).
- Talks to `simplant` with `MsgSend`.

Status: placeholder — no source yet.
