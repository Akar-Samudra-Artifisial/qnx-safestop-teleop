# teleopd

Teleop daemon (QNX 8.0, aarch64le). Design and protocol: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

- **Net thread** (`SCHED_RR` prio 10): own RFC 6455 WebSocket server (`../common/ws.c`),
  parses JSON `hb` / `cmd` / `arm` / `estop` (`../common/json.c`) and wakes the control
  thread via coalesced `MsgSendPulse`. Sends `state` at 20 Hz and `event` immediately.
- **Control thread** (`SCHED_FIFO` prio 50): `timer_create` + `SIGEV_PULSE` at 100 Hz.
  Heartbeat deadline 150 ms → `SAFE_STOP` (ramp to 0, latched until `arm`); `estop` → v,w = 0 at once.
- Talks to `simplant` with `MsgSend` (5 ms `TimerTimeout`); keeps running without it.
- Pairing: clients connect to `ws://host:8080/?t=<token>`; the token is printed at start.
  401 wrong token, 403 foreign Origin (allowed: none, `-o`, or same-host `http://<IP>:8080`
  as sent by iOS), 409 while another client is ARMED.
  Meant for a trusted LAN only (plain ws://) — see ARCHITECTURE "Pairing & threat model".

```sh
teleopd [-p 8080] [-d 150] [-t token] [-o origin] [-v]
#        port, hb deadline ms, fixed pairing token (default: random 6 digits),
#        allowed browser Origin (e.g. http://localhost:8081), also log to stdout
```

Build (from the repo root): `tools/sdp/run.sh make -C qnx` (SDP env sourced by run.sh). Run: the QEMU image starts it at boot (`tools/qemu/README.md`); after rebuilding, update the running VM with `TELEOP_TOKEN=123456 tools/qemu/deploy.sh`.
Test: `tools/wsclient/wsclient.py --token 123456 --trials 20`. Logs: `slog2info` on the target.
