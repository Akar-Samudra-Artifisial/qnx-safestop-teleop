# latbench

CPU hog for the safe-stop latency bench: `latbench -p <prio> -s <seconds> [-n threads] [-r]`
starts one busy-loop thread per online CPU at `SCHED_FIFO` (or `SCHED_RR` with `-r`)
priority `<prio>`; the threads stop by themselves after `<seconds>`.

Start it with `tools/fault/cpu-hog.sh`, measure with `tools/wsclient/wsclient.py --bench N`.
Results: [docs/BENCH.md](../../docs/BENCH.md).
