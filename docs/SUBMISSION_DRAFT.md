# Devpost submission draft — qnx-safestop-teleop

> DRAFT. Not part of the product docs. Every number is taken from `docs/BENCH.md` (CSV in
> `docs/bench/`) or `docs/QNX_EVIDENCE.md`; no placeholders remain.

Repo: https://github.com/Akar-Samudra-Artifisial/qnx-safestop-teleop (MIT)
Video: https://youtu.be/asHE8_aUXQs
Category: Robotics & Medical

## Tagline (≤200 chars)

A phone joystick for a robot on QNX 8.0, with a safe-stop whose latency is bounded by design: miss a 150 ms heartbeat and a SCHED_FIFO loop brings the robot to a halt.

(Count before pasting: ~160 characters.)

---

## Inspiration

Remote-assist robots — warehouse AMRs waiting for a human to clear an obstacle, tele-rehab
and medical robots, remote heavy equipment — all share one question: *what happens when the
link to the operator drops?* On Wi‑Fi or cellular, a hiccup is normal. If the robot only
stops when an app-level timeout fires on a busy general-purpose OS, the stop time depends on
whatever else is running.

We wanted to show a stop whose worst-case latency is a design parameter, not an accident:
a deadline on the heartbeat, evaluated by the highest-priority thread on a real-time OS.
For context only (this is **not** a certification claim): industrial safety standards such as
ISO 3691-4 (driverless industrial trucks) and ISO 13849 (safety-related control, incl. Safe
Torque Off) expect a defined, time-bounded safe state. This project is a demo of that way
of thinking, not a safety-rated product.

## What it does

- An **Expo / React Native app** is the operator console: virtual joystick, top-down map
  with trail, a hold-to-arm control, a big **E-STOP**, a **simulate link loss** toggle, a
  status strip (mode, RTT, heartbeat age against the 150 ms deadline) and a **latency panel**
  fed by the robot's own statistics.
- **`teleopd`** (C, QNX 8.0 aarch64le) is the robot-side daemon. The app sends a heartbeat at
  20 Hz. If no heartbeat arrives for more than 150 ms the control loop enters `SAFE_STOP`:
  velocity is ramped to zero and **latched** until an explicit `arm` is accepted with a fresh
  heartbeat. `estop` stops immediately (no ramp) and always wins over an `arm` that arrived
  earlier (receive timestamps). Losing the client while armed is also a safe-stop.
- **`simplant`** is a simulated differential-drive robot (200 Hz, 10×10 m) that talks to
  `teleopd` over QNX message passing.
- **`/dev/teleop`** is a resource manager: `cat /dev/teleop` shows live status and detection
  percentiles; `teleopctl set-deadline <ms>` changes the deadline at run time through
  `devctl`.
- Pairing: a 6-digit token and an `Origin` check. Scope is a trusted LAN demo (plain
  `ws://`, no TLS), as documented in `docs/ARCHITECTURE.md`.

## How we built it

- **Two priorities, one rule.** The net thread (WebSocket, `SCHED_RR` 10) never touches the
  control loop directly; it stores the message and sends a coalesced `MsgSendPulse`. The control
  thread (`SCHED_FIFO` 50) blocks in one `MsgReceive` on a `_NTO_CHF_FIXED_PRIORITY` channel
  and is woken by a 100 Hz `timer_create` + `SIGEV_PULSE` tick. The deadline is only checked on
  a tick, so the theoretical detection bound is 150 ms + 10 ms + jitter.
- **Own WebSocket (RFC 6455)** in `qnx/common/ws.c`: no third-party dependency on the target;
  non-blocking handshake with a 2 s deadline, send timeouts, RSV/oversize frames refused.
- **Message passing to the plant**: `name_attach` / `name_open` / `MsgSend` with `TimerTimeout`
  (5 ms) so a hung plant cannot stall the safety loop; simplant has its own 200 ms watchdog.
- **Resource manager** `/dev/teleop` with `devctl` for status/deadline/estop, and `slog2` logging.
- **Measure, don't claim**: `tools/wsclient/wsclient.py --bench N` runs N heartbeat-loss
  trials and writes CSV; `tools/fault/cpu-hog.sh` + `qnx/latbench` run the priority experiments.
- **Development setup on Apple Silicon**: QNX SDP 8.0 has no macOS host. We run the SDP in an
  x86-64 Linux container (colima), build the image with `mkqnximage`, and boot it in QEMU on
  the Mac (TCG, because HVF currently fails in QNX startup). Full recipe: `docs/codelab/`.
- **How AI was used**: we built this with Claude (Anthropic) running as a multi-agent setup in
  OpenCode. A planning agent drafted the architecture and schedule. Coding agents wrote most of
  the C (teleopd, simplant, the WebSocket server, resmgr, HAM registration) and the React Native
  app. Independent review and security agents then audited each milestone and found real bugs
  that we fixed before publishing: an estop/arm pulse-ordering race, NaN timestamps bypassing
  the stale-command check, a slowloris handshake stall, and the pairing token leaking into
  slog2. A verification agent re-checked every milestone against its acceptance criteria. The
  human side chose the idea after surveying existing entries, made the architecture and safety
  calls (e.g. latch SAFE_STOP on `plant_lost`), approved each milestone, and ran the
  physical-iPhone tests. Every number in this write-up comes from runs on the QEMU target or the
  iPhone, not from a model. Where measurement contradicted an AI prediction (a priority-50 CPU
  hog was expected to starve the watchdog on the 2-vCPU VM; it did not), we published the
  measured result.

## Challenges

- **No native QNX host on a Mac.** SDP in an amd64 container, QEMU/TCG for the target. TCG
  emulates CPU and timers, so absolute jitter is not representative of real hardware.
- **iOS refused to connect (403).** React Native on iOS sends `Origin: http://<ip>:8080`; our
  anti-drive-by Origin check rejected it. Fix: accept a same-host Origin only when `Host` is an
  IPv4 literal or `localhost`, so DNS-rebinding pages are still refused (see CHANGELOG, *Fixed*).
- **Priority is everything.** A watchdog is only as good as its priority relative to the rest.
  We tested it on purpose: a hog at priority 10 does not disturb the loop (p99 160.82 ms over
  1021 trials). Two hogs at the *same* priority (50) on both vCPUs hold the control thread `READY`
  until they end: detection 3001–3045 ms with 3 s hogs, 5004–5040 ms with 5 s hogs (`pidin`
  traces in `docs/BENCH.md`). One hog, or hogs at 49, leave detection at 152–176 ms. The codelab
  sample first seemed to disagree, but its own heartbeat thread starved too, so it measured
  nothing during the hog.
- **Ordering races.** `arm` and `estop` arrive on different pulses; we stamp receive times on
  the net thread so `estop` always wins.
- **HAM.** The HAM package was not installed in our SDP at first; supervision/restart status
  after install: HAM restarts simplant, slay → `plant_ok=0` in 38–88 ms, `plant_ok=1` again in min 544 / median 571.5 / max 626 ms (n=10, QEMU TCG); while the plant is down an armed session gets `plant_lost` → SAFE_STOP, latched until a new `arm`.

## Accomplishments we're proud of

| Result | Value | Source |
|---|---|---|
| Heartbeat-loss detection, QEMU TCG, 20 and 25 trials | median 154.8 / 156.5 ms, max 159.4 / 160.4 ms (a later run peaked at 161.0 ms) | `docs/BENCH.md` |
| Detection with deadline changed to 200 ms via `devctl` | p50 202.9 ms, max 210.3 ms (20 trials) | `docs/QNX_EVIDENCE.md` |
| Baseline, 1000 trials (QEMU TCG) | p50 155.11 / p99 161.01 / max 174.05 ms (2 trials > 170 ms) | `docs/BENCH.md` §Safe-stop detection latency |
| CPU hog, 2 × `SCHED_RR` 10, 1021 trials | p50 155.11 / p99 160.82 / max 232.55 ms (3 trials > 170 ms) | `docs/BENCH.md` §Safe-stop detection latency |
| CPU hog, 2 × `SCHED_FIFO` 10 (1 trial) | 158.2 ms | `docs/BENCH.md` §Priority experiments |
| CPU hog, 2 × `SCHED_FIFO` 50 in teleopd (misconfiguration; 6 trials 3 s, 3 trials 5 s) | 3001–3045 ms / 5004–5040 ms (= hog duration); 1 hog: 152–158 ms | `docs/BENCH.md` §Priority-50 investigation |
| Physical iPhone: `hb_timeout` | 156.02 ms | `docs/BENCH.md` §Physical device test |
| Physical iPhone: E-STOP handled; RTT | 0.07–0.18 ms; 7–42 ms | `docs/BENCH.md` §Physical device test |
| Plant killed → `plant_ok=0`; HAM restart → `plant_ok=1` (n=10) | 38–88 ms; min 544 / median 571.5 / max 626 ms; `plant_lost` → SAFE_STOP latched | `docs/BENCH.md` §Plant failure |

Also: a standalone, compilable deadline-watchdog **codelab** (`docs/codelab/`) so others can
reproduce the pattern on QNX 8.0 under QEMU on Apple Silicon.

## What we learned

- A real-time loop is defined by *who can preempt it*. A hog at priority 10 leaves detection at
  p99 160.82 ms; two hogs at priority 50 delay it by exactly as long as they run (3 s → ~3.0 s,
  5 s → ~5.0 s), because `SCHED_FIFO` never time-slices between equal priorities.
- Check what a benchmark can see: our codelab sample "passed" with priority-50 hogs only because
  its heartbeat thread starved too, so it never measured a trial during the hog.
- `_NTO_CHF_FIXED_PRIORITY` on the control channel keeps the receiver at priority 50 even when
  a priority-10 thread sends it a pulse.
- Pulses are a good fit for "tell the real-time thread something happened without ever blocking
  the sender"; coalescing with pending bits keeps the pulse rate bounded.
- Different failures deserve different stops: `estop` is deliberate (stop now), a link loss is
  ambiguous (bounded ramp, to avoid shifting a load).
- Emulation tells you the logic is right and the bound is respected; it does not replace
  measurements on real hardware.

## What's next

- Guard against priority misconfiguration: refuse to arm (or log) when another CPU-bound thread
  runs at ≥ the control priority, and trace the pulse queue during such a stall (`pidin` showed
  control `READY`; the queue was not traced).
- Run on real QNX aarch64 hardware (QEMU HVF is blocked today by a GICv3 assert in startup).
- TLS and stronger pairing for anything beyond a trusted LAN.
- Real plant (motor controller / AMR) behind the same message interface.

## Built with

QNX SDP 8.0 (aarch64le), `qcc`, C, QNX message passing (channels, pulses, `name_attach`),
`timer_create`, resource manager (`resmgr`/`iofunc`/`devctl`), `slog2`, QEMU 11.1.3,
colima/Docker, `mkqnximage`, React Native, Expo, TypeScript, Python 3 (test client).

## Build instructions (required by Devpost)

- **QNX version / target**: QNX SDP 8.0, `aarch64le`, QEMU `virt` machine (cortex-a57, 2 vCPU, TCG).
- **Toolchain**: `qcc` from SDP 8.0 (`gcc_ntoaarch64le`), run in an amd64 Linux container.
- **Host**: macOS arm64, Homebrew `colima docker qemu`; free myQNX account and QNX Everywhere
  non-commercial license (see `docs/codelab/README.md`, §2–4).

```sh
tools/sdp/run.sh make -C qnx                           # teleopd, simplant, teleopctl, latbench
TELEOP_TOKEN=123456 tools/sdp/run.sh /work/tools/sdp/make-image.sh   # QNX 8.0 image, stack autostarts
QEMU_SERIAL=build/qnx-image/serial.log tools/qemu/run-qemu.sh &    # no deploy step needed
python3 tools/wsclient/wsclient.py --token 123456
cd app && npm install && npx expo start
```

## QNX evidence

Locations checked with grep against the current source (line numbers drift as files change;
use the function name). `docs/QNX_EVIDENCE.md` is the master list.

| File:function | QNX API | Purpose |
|---|---|---|
| `qnx/teleopd/teleopd.c:main` (ChannelCreate L1230) | `ChannelCreate(_NTO_CHF_FIXED_PRIORITY)` | Control channel keeps the prio-50 receiver at its priority |
| `qnx/teleopd/teleopd.c:set_sched` (L220; used L496, L1096, L1262) | `pthread_setschedparam`, `pthread_setname_np`; FIFO 50 / RR 10 | Threads `control 50f`, `net 10r`, `resmgr 10r` |
| `qnx/teleopd/teleopd.c:control_main` (L503–504) | `SIGEV_PULSE_INIT`, `timer_create(CLOCK_MONOTONIC)` | 100 Hz tick as a pulse |
| `qnx/teleopd/teleopd.c:control_main` (L511) | `MsgReceive` | Single wait point for tick/hb/cmd/arm/estop |
| `qnx/teleopd/teleopd.c:pulse_once` (L575–586) | `MsgSendPulse` | Net → control, non-blocking; estop at prio 50 |
| `qnx/teleopd/teleopd.c:now_ns`, `on_tick` (L161, L376) | `clock_gettime(CLOCK_MONOTONIC)` | Heartbeat age vs deadline; `stats_add` (L242) / `stats_get` (L267) |
| `qnx/teleopd/teleopd.c:plant_exchange` (L336–353) | `name_open`, `TimerTimeout`, `MsgSend`, `name_close` | Velocity ↔ pose with a 5 ms bound |
| `qnx/teleopd/teleopd.c:resmgr_main` (L1089–1135) | `dispatch_create_channel`, `iofunc_attr_init`, `resmgr_attach("/dev/teleop")` | Resource manager in its own thread |
| `qnx/teleopctl/teleopctl.c:do_devctl` (L43–58) | `devctl()` | `status`, `set-deadline`, `estop` |
| `qnx/simplant/simplant.c:main` (L109) | `name_attach` | Plant server (`name_attach("simplant")`) |
| `qnx/simplant/simplant.c:main` (L106, L119–120, L131) | `pthread_setschedparam(SCHED_FIFO)`, `SIGEV_PULSE_INIT`, `timer_create`, `MsgReceive` | 200 Hz tick and request loop |
| `qnx/latbench/latbench.c:hog` (L41, L47) | `pthread_setschedparam` | CPU hog for the priority experiments |
| `qnx/teleopd/teleopd.c:log_init`/`logf_` (L191–201, L143–150); `qnx/simplant/simplant.c` (L68–78, L47) | `slog2_register`, `vslog2f` | Logs via `slog2info` |

Runtime proof (QEMU TCG, 2026-11-14, from QNX_EVIDENCE.md): `pidin -p teleopd` → `net 10r`,
`control 50f`, `resmgr 10r`; `ls -l /dev/teleop` → `crw-r----- 1 root root`.

HAM (`qnx/hamreg/hamreg.c` L76–89: `ham_attach`, CONDDEATH, `ham_action_restart`): slay → `plant_ok=0` 38–88 ms; `plant_ok=1` again min 544 / median 571.5 / max 626 ms (n=10).

---

## 3-minute video script (target ≤ 2:50, public YouTube)

| Time | Segment | Narration | Shot list |
|---|---|---|---|
| 0:00–0:15 | Hook | "A robot loses its operator's connection. How fast does it stop, and can you prove it?" | Phone with joystick, robot dot moving on the map; cut to the link-loss toggle. |
| 0:15–0:35 | Problem and use cases | "Remote-assist AMRs, tele-rehab and medical robots, remote heavy equipment: they need a stop with a bounded latency, the idea behind ISO 3691-4 and ISO 13849 STO. This is a demo of that idea, not a certified product." | Three quick stock/diagram frames; text overlay "context, not certification". |
| 0:35–1:00 | Architecture | "The phone sends a heartbeat at 20 Hz over WebSocket. On QNX 8.0, teleopd's net thread at priority 10 hands messages to a SCHED_FIFO 50 control thread with MsgSendPulse. A 100 Hz timer pulse checks the deadline: 150 ms." | `docs/ARCHITECTURE.md` diagram, zoom on net thread → control thread → simplant. |
| 1:00–1:30 | Live demo (iPhone) | "Arm, drive, now I switch on simulated link loss. The status strip shows the heartbeat age reaching 150 ms, and the robot ramps to zero and stays latched until I re-arm." Then E-STOP: "estop stops at once." | Screen recording of the app + phone in hand; heartbeat-age bar, SAFE_STOP event, hold-to-re-arm. |
| 1:30–1:55 | Real QNX proof | "On the target: pidin shows control at 50f, net at 10r. `cat /dev/teleop` shows the live status. teleopctl set-deadline changes it to 200 ms through devctl." | Terminal over ssh into QEMU: `pidin -p teleopd`, `cat /dev/teleop`, `teleopctl set-deadline 200`; highlight the 202.9 ms p50 result from the docs. |
| 1:55–2:20 | Measurements | "Detection is 150 to 161 ms under QEMU TCG. On a physical iPhone, 156 ms, with E-STOP handled in under 0.2 ms. Over 1000 trials the median is 155 ms and p99 161 ms, and a CPU hog at priority 10 does not change that. The rule: the safety thread must sit strictly above every CPU-bound thread. Put two hogs at the same priority and detection waits for them: about 3 seconds with a 3-second hog, 5 seconds with a 5-second one, and pidin shows the control thread ready but never running." | Latency panel in the app; bench table; side-by-side bar (prio 10 vs prio 50). Optional: show the 1000-trial table from `docs/BENCH.md`. |
| 2:20–2:40 | How it was built, honestly | "QNX SDP has no Mac host, so we ran it in a Linux container and booted QEMU on Apple Silicon. We used AI assistants for drafting code and docs; we reviewed and measured everything ourselves. We also wrote a codelab so you can reproduce the pattern." | Terminal: `make -C qnx`; flash of `docs/codelab/`. |
| 2:40–2:50 | Close | "qnx-safestop-teleop: a bounded-latency stop for remote robots, open source under MIT." | Repo URL, tagline, logo. |

Recording notes: do not show the pairing token or any password; HAM restart may be shown
(`tools/fault/slay-plant.sh`); keep the video under 3:00 and public on YouTube.

---

## Submission checklist

- [x] No placeholders remain (bench and HAM numbers filled from BENCH.md).
- [x] iPhone and hog numbers are in `docs/BENCH.md`.
- [x] `docs/QNX_EVIDENCE.md` line numbers checked against the final source (ChannelCreate L1220).
- [ ] Tagline ≤ 200 characters (count it).
- [x] Video: public on YouTube, < 3:00, no secrets on screen; paste the URL.
- [x] Build instructions present: QNX 8.0, aarch64le, `qcc` in the SDP container.
- [ ] QNX evidence table pasted, each reference opens on GitHub.
- [ ] AI-use paragraph matches what the team actually did.
- [ ] Repo public, MIT `LICENSE` present, README quick start works from a clean clone.
- [ ] Category set to Robotics & Medical; all four criteria addressed (Technological Implementation, Design, Potential Impact, Innovation & AI Creativity).
- [ ] Not committed by this draft; commit after review.
