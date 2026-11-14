# fault

Fault injection for the safe-stop demos. All scripts talk to the QEMU target over the
project ssh key (`build/qnx-image/ssh/id_ed25519`, port 2222) and expect the binaries in
`/data` (`QNX_DEST=/data tools/qemu/deploy.sh`).

| Script | Fault | Measures |
|---|---|---|
| `cpu-hog.sh <prio> <s> [fifo\|rr] [threads]` | `qnx/latbench` busy-loop threads (one per CPU) at the given priority, set with `pthread_setschedparam()`; they stop by themselves | combine with `wsclient.py --bench N` (detect_us per trial, CSV) |
| `slay-plant.sh [timeout_s]` | `slay -f simplant` | target-clock time until `/dev/teleop` shows `plant_ok=0`, then `plant_ok=1` again (simplant restarted by HAM + teleopd reconnect, retry 500 ms) |

Heartbeat loss itself needs no script: `wsclient.py` stops sending `hb` (or use the app's
"simulate link loss" toggle).

## CPU hog: priority is the whole point

teleopd runs control at `SCHED_FIFO` 50 and net/resmgr at `SCHED_RR` 10.

```sh
tools/fault/cpu-hog.sh 10 900 rr      # shares CPUs with net, control preempts: detect unchanged
python3 tools/wsclient/wsclient.py --token <t> --bench 1000 --csv build/bench/hog10rr.csv
tools/fault/cpu-hog.sh 10 3 fifo      # net + sshd starve 3 s; control still safe-stops on time
tools/fault/cpu-hog.sh 50 3 fifo      # MISCONFIGURATION: control cannot run until the hog ends
```

Results (QEMU TCG emulation) are in [docs/BENCH.md](../../docs/BENCH.md). Keep FIFO hogs
short: ssh to the target is unreachable while they run.

## Deadline at run time

`/data/teleopctl set-deadline 200` (50..1000 ms) changes the heartbeat deadline through
`/dev/teleop`; `/data/teleopctl set-deadline 150` restores the default.
`/data/teleopctl reset-stats` empties the hb_timeout detect ring before a bench run.
