# QNX API evidence

Where each QNX-specific API is used (line numbers as of M3).

| File:function | QNX API | Purpose |
|---|---|---|
| `qnx/teleopd/teleopd.c:main` (L1220) | `ChannelCreate(_NTO_CHF_FIXED_PRIORITY)` | Control channel; fixed priority so a prio-10 pulse does not lower the prio-50 receiver |
| `qnx/teleopd/teleopd.c:main` (L1240), `set_sched` (L219) | `pthread_attr_setschedpolicy(SCHED_FIFO)` prio 50, `pthread_setschedparam(SCHED_RR)` prio 10, `pthread_setname_np` | Control thread `50f`, net + resmgr threads `10r` (visible in `pidin`) |
| `qnx/teleopd/teleopd.c:control_main` (L493–494) | `ConnectAttach(_NTO_SIDE_CHANNEL)`, `SIGEV_PULSE_INIT`, `timer_create(CLOCK_MONOTONIC)` + `timer_settime` | 100 Hz tick delivered as a pulse to the control channel |
| `qnx/teleopd/teleopd.c:control_main` (L501) | `MsgReceive` | Single wait point for tick / hb / cmd / arm / estop pulses |
| `qnx/teleopd/teleopd.c:pulse`, `pulse_once` (L558–575) | `MsgSendPulse` | Net thread → control thread, non-blocking; `estop` sent at prio 50 |
| `qnx/teleopd/teleopd.c:now_ns`, `on_tick` (L370) | `clock_gettime(CLOCK_MONOTONIC)` | Heartbeat age vs 150 ms deadline, `detect_us` → stats ring (`stats_add` L241, `stats_get` L266, PI mutex) |
| `qnx/teleopd/teleopd.c:plant_exchange` (L346–352) | `name_open`, `TimerTimeout(_NTO_TIMEOUT_SEND\|_NTO_TIMEOUT_REPLY)`, `MsgSend`, `name_close` | Velocity → simplant, pose back; 5 ms bound so a hung plant cannot stall the monitor; reconnect every 500 ms (`plant_ok`) |
| `qnx/teleopd/teleopd.c:resmgr_main` (L1079–1125) | `dispatch_create_channel`, `iofunc_func_init`, `iofunc_attr_init(S_IFCHR\|0640)`, `resmgr_attach("/dev/teleop")`, `dispatch_context_alloc`, `dispatch_block` / `dispatch_handler` | `/dev/teleop` resource manager in its own thread (`resmgr 10r`), node `crw-r----- root root` |
| `qnx/teleopd/teleopd.c:rm_read` (L999–1026) | `iofunc_read_verify`, `_IO_SET_READ_NBYTES`, `_RESMGR_PTR` | `cat /dev/teleop` → status text (mode, hb_age_ms, deadline_ms, pose, plant_ok, events, detect p50/p99/max) |
| `qnx/teleopd/teleopd.c:rm_devctl` (L1030–1076) | `iofunc_devctl_default`, `_DEVCTL_DATA`, `ocb->ioflag & _IO_FLAG_WR`, `ctp->size` check, `MsgSendPulse` | `DCMD_TELEOP_SET_DEADLINE` (50–1000 ms, else `EINVAL`), `DCMD_TELEOP_ESTOP` (same estop path as the WebSocket), `DCMD_TELEOP_RESET_STATS` (empty the detect ring) |
| `qnx/common/teleop_dcmd.h` | `__DIOT`, `__DION` (private class 0xE0, outside the QNX-reserved 0x0000–0x0FFF) | devctl command codes shared by teleopd and teleopctl |
| `qnx/teleopctl/teleopctl.c:do_devctl` (L43–58) | `devctl()` | Shell tool: `teleopctl status \| set-deadline <ms> \| estop \| reset-stats` |
| `qnx/latbench/latbench.c:hog` (L47), `main` (L81) | `pthread_setschedparam(SCHED_FIFO\|SCHED_RR, prio)`, `sysconf(_SC_NPROCESSORS_ONLN)` | CPU hog, one busy thread per CPU, for the priority experiments in BENCH.md |
| `qnx/simplant/simplant.c:main` (L109) | `name_attach("simplant")` | Publish the plant server under `/dev/name/local/simplant` |
| `qnx/simplant/simplant.c:main` (L106, L114–120) | `pthread_setschedparam(SCHED_FIFO 40)`, `ConnectAttach`, `SIGEV_PULSE_INIT`, `timer_create` | 200 Hz integration tick on the same channel |
| `qnx/simplant/simplant.c:main` (L130–169) | `MsgReceive`, `MsgReply`, `MsgError`, `ConnectDetach` | Serve `PLANT_MSG_SET_VEL`, answer `_IO_CONNECT` from `name_open`, handle `_PULSE_CODE_DISCONNECT` |
| `qnx/{teleopd,simplant}/*.c:log_init`, `logf_` | `slog2_register`, `vslog2f` (va_list form of `slog2f`) | Logs readable with `slog2info` on the target |
| HAM (`ham_attach`, condition death → restart) | — | **Not done yet**: package `com.qnx.qnx800.target.os_services.ham` not installed in the SDP (no `ham`, `libham`, `<ha/ham.h>`); `tools/sdp/install-qsc.sh` now includes it |

Runtime proof (QEMU TCG, 2026-11-14): `pidin -p teleopd` → `net 10r`, `control 50f`,
`resmgr 10r`; `simplant` `40f` (shown as `50f` while serving a prio-50 `MsgSend`: priority
inheritance). `ls -l /dev/teleop` → `crw-r----- 1 root root`; `teleopctl set-deadline 200`
→ detect p50 202.9 / max 210.3 ms (20 trials), back to 150 with `set-deadline 150`.
