# Benchmarks

Status: not measured yet.

| Scenario | Samples | p50 (µs) | p99 (µs) | max (µs) |
|---|---|---|---|---|
| Control tick, idle | | | | |
| Control tick, CPU hog | | | | |
| Safe-stop detect (hb loss → SAFE_STOP) | | | | |

Environment: QNX 8.0 aarch64le, QEMU 11.1.3 (accel: TCG, cortex-a57, 2 vCPU), host: macOS arm64.

## Safe-stop detection latency (hb loss → SAFE_STOP)

Measured with `tools/wsclient/wsclient.py` over localhost:8080 (2026-11-14). `detect_us` is
reported by teleopd: last `hb` received → deadline miss detected in the control tick.

| Run | Trials | min (ms) | median (ms) | max (ms) |
|---|---|---|---|---|
| 1 | 20 | 150.9 | 154.8 | 159.4 |
| 2 | 25 | 150.2 | 156.5 | 160.4 |

**Theoretical bound** = deadline + tick period + jitter = 150 ms + 10 ms (100 Hz
`timer_create` tick) + scheduling/timer jitter. The deadline is only evaluated on a tick,
so a miss is seen between 0 and 10 ms after it happens. Under QEMU TCG (emulated CPU and
timers) the jitter is a few hundred µs to ~1 ms, so an occasional 160.4 ms is
expected and is not a deadline bug (a later run peaked at 161.0 ms). The 150 ms threshold is
deliberately unchanged; on real hardware or with a faster tick the bound tightens accordingly.

**Test pass bound** (`wsclient.py --max-detect-ms`, default 170 ms) = deadline 150 ms +
tick 10 ms + 10 ms margin for QEMU TCG emulation jitter. It only decides PASS/FAIL of the
test; teleopd's safe-stop deadline stays 150 ms.
