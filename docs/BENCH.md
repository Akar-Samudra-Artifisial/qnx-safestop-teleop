# Benchmarks

Environment: QNX 8.0 aarch64le under **QEMU TCG emulation** (QEMU 11.1.3, accel TCG, cortex-a57,
2 vCPU), host macOS arm64 (2026-11-14). TCG emulates the CPU and timers in software. Absolute
numbers are not real-hardware numbers; the host's load (other apps, Spotlight) shows up as
outliers.

## Safe-stop detection latency (hb loss → SAFE_STOP), 1000+ trials

`tools/wsclient/wsclient.py --bench N --csv FILE` over localhost:8080. Per trial: arm with a
fresh heartbeat, stop sending `hb`, wait for the `hb_timeout` event, resume. `detect_us` is
reported by teleopd (last `hb` received → miss seen in the 100 Hz control tick). The `/dev/teleop`
ring was emptied before each run (`teleopctl reset-stats`), and the run's `stats` reply matched
the client's numbers.

| Run | Trials | min (ms) | p50 (ms) | p99 (ms) | max (ms) | > 170 ms |
|---|---|---|---|---|---|---|
| Baseline (no hog) | 1000 | 150.01 | 155.11 | 161.01 | 174.05 | 2 |
| CPU hog: 2 threads `SCHED_RR` 10 (`cpu-hog.sh 10 … rr`) | 1021 | 150.01 | 155.11 | 160.82 | 232.55 | 3 |

CSV (`trial,detect_us,client_ms,clock_skew`): `docs/bench/hb-loss-baseline-1000.csv`,
`docs/bench/hb-loss-hog-rr10-1021.csv` (hog run = 721 + 300 trials in two sessions).

Reading the numbers:
- p50 and p99 are the same with and without the prio-10 hog: the control thread (`SCHED_FIFO`
  50) preempts the hog. p99 ≤ 170 ms in both runs.
- Bound = deadline 150 ms + tick 10 ms + jitter. 99 % of trials are within 150–161 ms.
- The few outliers (2 and 3 trials above 170 ms) are attributed to the emulated environment, not
  to teleopd. In 3 of them `detect_us` is larger than the gap the client itself saw between its
  last `hb` and the event (`clock_skew=1`), which a correct server cannot produce unless the guest
  clock jumped ahead (TCG virtual-time catch-up). The others coincide with host load. Assumption,
  not proven: no outlier was reproduced with tracing.
- `client_ms` (host side) is larger and noisier than `detect_us` because it adds the WebSocket
  path through QEMU user networking.

Earlier attempts (not used above) stopped early or contained huge values for reasons outside
teleopd: macOS sleep during the run (304 s "detections" = the guest clock kept running while the
host slept), samples from the FIFO 50 demo left in the ring, and a wsclient bug where a stale
`ARMED` state skipped the next `arm` (fixed: the bench now waits for `SAFE_STOP` before the next
trial).

## Priority experiments (`qnx/latbench`, `tools/fault/cpu-hog.sh`)

latbench starts N busy-loop threads with `pthread_setschedparam` at a given policy/priority and
stops them after `-s` seconds. teleopd's threads: control `SCHED_FIFO` 50, net and resmgr
`SCHED_RR` 10.

| Hog | Trials | Detect | Note |
|---|---|---|---|
| 2 × `SCHED_RR` 10 | 1021 | p50 155.11 / p99 160.82 ms | Shares the CPUs with net (RR 10); control preempts it. |
| 2 × `SCHED_FIFO` 10 | 1 (session armed, hog 3 s) | 158.2 ms | net and sshd starve while it runs (FIFO 10 never yields to RR 10), but control still detects on time. |
| 2 × `SCHED_FIFO` 50 | 1 (session armed, hog 3 s) | **3011.9 ms** | **Misconfiguration example.** Same priority as control: FIFO does not preempt equal priority, so the check only runs when the hog ends. Anything at ≥ the control priority breaks the 150 ms guarantee. Reproduced below (6 + 3 trials). |

Rule: the safety thread must be strictly above every CPU-bound thread in the system.

### Priority-50 investigation with `pidin` (2026-11-15)

Same VM (QEMU TCG, 2 vCPU, `pidin info`: 2 × Cortex-A57). All teleopd and latbench threads have
runmask `0x3` (`pidin rmasks`), so any thread may run on either vCPU. Per trial (temporary
script on the wsclient `Session` class): connect and arm with heartbeats running, start
`on -p 60f sh cap.sh` on the target, which starts `latbench -p P -s S -n N` and, 1 s later, takes
`pidin` snapshots; the client stops `hb` 1 s after starting the hog and waits for the event.
With 2 hogs the net thread is starved from the hog's start, so the last `hb` teleopd received is
about the hog's start time. Raw output: `build/bench/prio50/captures.txt` (not in git).

| Hog (`latbench`) | Trials | `detect_us` (ms) | Event reached the client |
|---|---|---|---|
| 2 × FIFO 50, 3 s | 6 | 3001.2–3044.5 (median 3028.7) | when the hog ended (t+3.4 s) |
| 2 × FIFO 50, 5 s | 3 | 5004.5–5039.8 | when the hog ended (t+5.4–5.5 s) |
| 2 × FIFO 51, 3 s | 2 | 3002.2, 3022.5 | when the hog ended |
| 1 × FIFO 50, 3 s | 5 | 151.8–157.7 | at once (t+1.1 s, hb stopped at t+1.0 s) |
| 2 × FIFO 49, 3 s | 3 | 158.4–175.5 | when the hog ended (t+3.4 s) |

`pidin` 1 s into a 2 × FIFO 50 hog (truncated; the snapshot itself runs at 60f, so for that
instant it preempts one hog):

```
     pid tid name                         prio STATE          Blocked
  831511   1 ./teleopd                     10r READY                       <- net
  831511   2 ./teleopd                     50f READY                       <- control
  831511   3 ./teleopd                     10r RECEIVE        2            <- resmgr
162615298   2 data/latbench                 50f RUNNING
162615298   3 data/latbench                 50f READY
```

slog2info for that run: `SAFE_STOP reason=hb_timeout detect_us=3023637`, logged after the hog
ended. With 2 × FIFO 49 the snapshot shows the same `READY` net thread, and control still stops
on time.

Hypotheses checked:

| Hypothesis | Result |
|---|---|
| Equal-priority FIFO does not time-slice: control (50f) waits until a hog blocks or ends | **Confirmed.** Control is `READY` (not `RECEIVE`) during the hog; detection ≈ hog duration; prio 51 gives the same, prio 49 gives 158–175 ms. |
| The hog must cover both vCPUs | **Confirmed.** One FIFO 50 hog leaves a vCPU free: 151.8–157.7 ms. |
| The timer pulse is held back | **Rejected as the cause.** Control is `READY`, i.e. the tick pulse was delivered and unblocked it; the thread just gets no CPU. |
| net (10r) starvation explains the 3 s | **Rejected.** net is starved in the prio 49 runs too, yet control detects in ≤ 175.5 ms; starvation only delays the event to the client (and the client's view of it) until the hog ends. |
| 3011.9 ms = the 3 s hog duration | **Confirmed.** 3 s hogs → 3001–3045 ms, 5 s hogs → 5004–5040 ms. |

Why the codelab sample showed 150–162 ms with FIFO 50 hogs (section below): its heartbeat
thread runs at FIFO 30, so it starves too (`pidin` during `-H 50 -N 2`: watchdog 50f `READY`,
heartbeat 30f `READY`, hogs 50f `RUNNING`/`READY`), and no fresh heartbeat arms a trial during
the hog window. Measured: `watchdog -n 1 -H 50 -N 2 -T 8` finished trial 1 after 8870 ms wall
time (857 ms without hogs) and reported 165.22 ms, i.e. a trial taken after the hogs ended. The
discrepancy came from the sample's design, not from QNX or TCG. Assumption, not re-timed: the
earlier `-T 40` runs behaved the same way.

Not established: the exact pulse queue contents while control is `READY` (not traced), and
whether real hardware changes the numbers (only the VM was measured).

## Deadline change via `/dev/teleop`

`teleopctl set-deadline 200` (devctl `DCMD_TELEOP_SET_DEADLINE`), 20 trials: p50 202.9 ms,
max 210.3 ms (bound 200 + 10 + jitter); then `teleopctl set-deadline 150` restored the default.
Values outside 50–1000 ms are rejected with `EINVAL`.

## Plant failure (`tools/fault/slay-plant.sh`)

simplant runs under HAM (`qnx/hamreg`: `ham_attach` + CONDDEATH → waitfor 100 ms → restart).
`tools/fault/slay-plant.sh`, 10 runs 15 s apart (QEMU TCG emulation, target clock), raw output
in `build/bench/ham-slay.txt`:

| Step | Result |
|---|---|
| slay → `plant_ok=0` | 38–88 ms (MsgSend to the dead plant fails on the next ticks) |
| slay → `plant_ok=1` again (HAM restart + teleopd reconnect) | n=10: min 544 / median 571.5 / max 626 ms |

The total is roughly the 100 ms HAM delay + spawn + teleopd's 500 ms `name_open` retry
period; the split was not measured separately. Every run got a new simplant pid.

Safety while the plant is down: an ARMED session driving at v=0.3 m/s got event
`plant_lost` → SAFE_STOP; all `state` messages during the outage and after the restart were
SAFE_STOP with v=0, and only a new `arm` re-armed (one scripted run).

Restart limit: 6 deaths within 60 s → hamreg logged "restart limit exceeded", detached the
entity and exited. The restart already queued for that 6th death still ran; the next slay was
not restarted (`plant_ok=0` stays). Redeploy (`tools/qemu/deploy.sh`) to recover.

## Physical device test (iPhone)

Uji perangkat fisik: app on a physical iPhone over Wi-Fi to teleopd in QEMU on the Mac
(`ws://<host-ip>:8080`), reported by the user:

| Check | Result |
|---|---|
| Drive (joystick → pose on the map) | OK |
| E-STOP (event `detect_us`) | 0.07–0.18 ms |
| hb_timeout (link loss) | 156.02 ms |
| RTT (server-measured ping) | 7–42 ms |

## Codelab watchdog sample (`docs/codelab/watchdog`)

Run on the same target: no hog 152.81–159.56 ms (10 trials); hogs FIFO 10: 150.70–158.96 ms
(10 trials). Hogs FIFO 50, rerun with the hogs covering all 20 trials (`-n 20 -H 50 -T 40`,
trials last ~18 s; an earlier run with `-T 8` was too short and is discarded):
`-N 2`: 150.00–162.13 ms; `-N 4`: 150.00–159.08 ms. No `SCHED_FIFO 50 failed` warning was printed.
These FIFO 50 numbers do **not** contradict the teleopd 3011.9 ms: the sample's heartbeat thread
(FIFO 30) starves together with the watchdog, so no trial is measured while the hogs run; in a
timed re-run the reported trial happened after the hogs ended (see §Priority-50 investigation
above). See
`docs/codelab/README.md`.

## Earlier short runs

| Run | Trials | min (ms) | median (ms) | max (ms) |
|---|---|---|---|---|
| 1 | 20 | 150.9 | 154.8 | 159.4 |
| 2 | 25 | 150.2 | 156.5 | 160.4 |

**Test pass bound** (`wsclient.py --max-detect-ms`, default 170 ms) = deadline 150 ms + tick
10 ms + 10 ms margin for QEMU TCG emulation jitter. It only decides PASS/FAIL of the test;
teleopd's safe-stop deadline stays 150 ms.
