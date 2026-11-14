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
| 2 × `SCHED_FIFO` 50 | 1 (session armed, hog 3 s) | **3011.9 ms** | **Misconfiguration example.** Same priority as control: FIFO does not preempt equal priority, so the check only runs when the hog ends. Anything at ≥ the control priority breaks the 150 ms guarantee. |

Rule: the safety thread must be strictly above every CPU-bound thread in the system.

## Deadline change via `/dev/teleop`

`teleopctl set-deadline 200` (devctl `DCMD_TELEOP_SET_DEADLINE`), 20 trials: p50 202.9 ms,
max 210.3 ms (bound 200 + 10 + jitter); then `teleopctl set-deadline 150` restored the default.
Values outside 50–1000 ms are rejected with `EINVAL`.

## Plant failure (`tools/fault/slay-plant.sh`)

`slay -f simplant` → teleopd reports `plant_ok=0` in `/dev/teleop` after 43 ms (MsgSend fails,
teleopd retries `name_open` every 500 ms). Automatic restart needs HAM, which is **not installed**
in the SDP or the image yet (package `com.qnx.qnx800.target.os_services.ham`), so the script
reports "still 0 after 3 s". After a manual restart of simplant, `plant_ok=1` came back after
222 and 370 ms (two runs).

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
The 3011.9 ms of the teleopd FIFO 50 demo (table above) was therefore **not reproduced** by the
codelab sample. Measured differences: teleopd's demo hogs came from `latbench` (3 s, session
armed, network path involved), the codelab run uses a single process with no sockets. Not
measured, so only hypotheses: (a) with `-smp 2` the two hogs may not occupy both vCPUs at all
times under TCG, leaving a window for the watchdog; (b) the codelab hog threads may block or
yield periodically; (c) in teleopd the stall came from the 10r net/resmgr threads (below the hogs)
rather than from the control thread. I did not check the hog threads' state with `pidin` during
the run. See `docs/codelab/README.md`.

## Earlier short runs

| Run | Trials | min (ms) | median (ms) | max (ms) |
|---|---|---|---|---|
| 1 | 20 | 150.9 | 154.8 | 159.4 |
| 2 | 25 | 150.2 | 156.5 | 160.4 |

**Test pass bound** (`wsclient.py --max-detect-ms`, default 170 ms) = deadline 150 ms + tick
10 ms + 10 ms margin for QEMU TCG emulation jitter. It only decides PASS/FAIL of the test;
teleopd's safe-stop deadline stays 150 ms.
