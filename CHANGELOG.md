# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial monorepo skeleton: `qnx/` (teleopd, simplant, latbench, common) with
  `qcc` Makefile stubs, Expo TypeScript app with protocol types and Connect screen,
  QEMU run script skeleton, docs (architecture, bench, QNX evidence, codelab).
- Linux amd64 SDP container (`tools/sdp/`) with unattended QNX Software Center + SDP 8.0
  install script and `make-image.sh` building a QNX 8.0 aarch64le QEMU image
  (project-only SSH key).
- `tools/hello/hello.c` cross-build smoke test for the aarch64le target.
- App Teleop screen: virtual joystick, 10×10 m top-down map with trail, status strip
  (mode, RTT, heartbeat age vs 150 ms deadline), E-STOP, hold-to-re-arm, simulate-link-loss
  toggle, haptics and recent SAFE_STOP events; `TeleopLink` with 20 Hz hb/cmd loop,
  dev mock server (`npm run mock`) and link smoke test (`npm run smoke`).
- `teleopd` on QNX: WebSocket server on port 8080 (own RFC 6455 implementation), 100 Hz
  control loop that enters SAFE_STOP when heartbeats stop for more than 150 ms
  (configurable with `-d`) or on `estop`, ramps velocity to 0 and stays latched until
  `arm`; stale or out-of-order `cmd` messages are rejected. `state` also reports
  `plant_ok`.
- `simplant` on QNX: simulated differential-drive robot (200 Hz, 10×10 m area) driven by
  teleopd over QNX message passing; teleopd keeps running and reconnects if it dies.
- `make -C qnx` builds all QNX packages; `tools/qemu/deploy.sh` copies and starts them
  on the QEMU target; `tools/wsclient/wsclient.py` measures SAFE_STOP detection latency
  and checks estop / re-arm behaviour.

### Changed
- `tools/qemu/run-qemu.sh` boots the mkqnximage output (ifs.bin + virtio disk) on the Mac
  with ssh on port 2222 and teleopd on 8080, reachable from the LAN; TCG by default
  because HVF currently fails in QNX startup (GICv3 assert).
- `event.detect_us` documented as time from the last heartbeat (or `estop`) to detection.
- App and mock server use the teleopd SAFE_STOP reason `hb_timeout` (was `hb_deadline`);
  the mock now reports `hb_age_ms` -1 before the first heartbeat, like teleopd.
- App status strip shows plant status (OK/DOWN) when the server reports `plant_ok`, and
  no longer shows a negative heartbeat age before the first heartbeat.
- `npm run smoke` also accepts the target URL from `TELEOP_URL`.
- App Connect screen asks for the 6-digit pairing token and connects to `ws://host:port/?t=<token>`;
  a handshake that never opens returns to Connect with "Token salah atau robot sedang dipakai".
- App zeroes v/w on E-STOP, SAFE_STOP event, non-ARMED mode, (re)connect and stale data, and the
  joystick recentres and locks in those states; E-STOP fires on press-in with haptics.
- App sends `ts` from a monotonic session clock, validates `state`/`event` frames (finite
  pose/vel, known mode), shows server-measured RTT when present, and uses W_MAX 2.0 rad/s
  (`V_MAX`/`W_MAX` now in `protocol.ts`); `npm run test:link` unit-tests the link safety logic.
- `tools/sdp/run.sh` sources `qnxsdp-env.sh` (when installed) before the command, so
  `tools/sdp/run.sh make -C qnx` works without a manual source.
- `wsclient.py --max-detect-ms` defaults to 170 ms (deadline 150 + tick 10 + 10 ms TCG
  jitter margin); teleopd's 150 ms deadline is unchanged.
- teleopd `estop` zeroes velocity immediately (no ramp); heartbeat/link loss still ramps down.
  Losing the client while ARMED triggers SAFE_STOP (`client_lost` / `client_replaced`).
- teleopd coalesces control pulses (pending bits, no pulse per `hb`), uses
  `PTHREAD_PRIO_INHERIT` mutexes and rate-limits per-message logs.
- simplant replies with status = reply length; teleopd checks it and rejects non-finite poses.
- Mock server follows the teleopd pairing contract (token, Origin, 409), W_MAX 2.0 and
  immediate estop stop; `npm run smoke` uses `TELEOP_TOKEN` and arms before steering.
- `tools/wsclient/wsclient.py` takes `--token`/`TELEOP_TOKEN` and also checks 401/403/409,
  NaN rejection, immediate estop and the arm+estop race; `deploy.sh` passes `TELEOP_TOKEN` as `-t`.

### Security
- teleopd requires a 6-digit pairing token (`ws://host:8080/?t=<token>`, random at start or
  `-t`), compared in constant time (401); refuses browser `Origin`s except `-o` (403) and a
  second client while ARMED (409). LAN-only threat model documented in ARCHITECTURE.
- `estop` received after an `arm` always wins (receive timestamps), whatever the pulse order.
- WebSocket handshake has a 2 s total deadline (non-blocking, ≤ 4 in flight), sends time out
  after 200 ms and drop the client; RSV bits and oversized/fragmented control frames are refused.
- `seq` must be an integer below 2^53 and `ts` finite; otherwise the message is dropped.
- simplant rejects messages shorter than their type (`EBADMSG`).
- `run-qemu.sh` forwards SSH (2222) on 127.0.0.1 only by default (`QEMU_SSH_FWD_ADDR`);
  teleopd 8080 stays on 0.0.0.0 (`QEMU_HOSTFWD_ADDR`).

### Removed
- Expo template leftovers `app/AGENTS.md` and `app/.claude/`.
