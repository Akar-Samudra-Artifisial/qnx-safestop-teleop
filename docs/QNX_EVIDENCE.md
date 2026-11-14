# QNX API evidence

Where each QNX-specific API is used (filled in as code lands).

| File:function | QNX API | Purpose |
|---|---|---|
| `qnx/teleopd/teleopd.c:main` (L597) | `ChannelCreate(_NTO_CHF_FIXED_PRIORITY)` | Control channel; fixed priority so a prio-10 pulse does not lower the prio-50 receiver |
| `qnx/teleopd/teleopd.c:main` (L617), `set_sched` | `pthread_attr_setschedpolicy(SCHED_FIFO)` prio 50, `pthread_setschedparam(SCHED_RR)` prio 10, `pthread_setname_np` | Control thread `50f`, net thread `10r` (visible in `pidin`) |
| `qnx/teleopd/teleopd.c:control_main` (L304–310) | `ConnectAttach(_NTO_SIDE_CHANNEL)`, `SIGEV_PULSE_INIT`, `timer_create(CLOCK_MONOTONIC)` + `timer_settime` | 100 Hz tick delivered as a pulse to the control channel |
| `qnx/teleopd/teleopd.c:control_main` (L317) | `MsgReceive` | Single wait point for tick / hb / cmd / arm / estop pulses |
| `qnx/teleopd/teleopd.c:pulse` (L371) | `MsgSendPulse` | Net thread → control thread, non-blocking; `estop` sent at prio 50 |
| `qnx/teleopd/teleopd.c:now_ns`, `on_tick` | `clock_gettime(CLOCK_MONOTONIC)` | Heartbeat age vs 150 ms deadline, `detect_us` |
| `qnx/teleopd/teleopd.c:plant_exchange` (L195–204) | `name_open`, `TimerTimeout(_NTO_TIMEOUT_SEND\|_NTO_TIMEOUT_REPLY)`, `MsgSend`, `name_close` | Velocity → simplant, pose back; 5 ms bound so a hung plant cannot stall the monitor; reconnect every 500 ms (`plant_ok`) |
| `qnx/simplant/simplant.c:main` (L109) | `name_attach("simplant")` | Publish the plant server under `/dev/name/local/simplant` |
| `qnx/simplant/simplant.c:main` (L106, L114–120) | `pthread_setschedparam(SCHED_FIFO 40)`, `ConnectAttach`, `SIGEV_PULSE_INIT`, `timer_create` | 200 Hz integration tick on the same channel |
| `qnx/simplant/simplant.c:main` (L130–169) | `MsgReceive`, `MsgReply`, `MsgError`, `ConnectDetach` | Serve `PLANT_MSG_SET_VEL`, answer `_IO_CONNECT` from `name_open`, handle `_PULSE_CODE_DISCONNECT` |
| `qnx/{teleopd,simplant}/*.c:log_init`, `logf_` | `slog2_register`, `vslog2f` (va_list form of `slog2f`) | Logs readable with `slog2info` on the target |

Runtime proof (QEMU TCG, 2026-11-14): `pidin -p teleopd` → `net 10r`, `control 50f`;
`simplant` `40f` (shown as `50f` while serving a prio-50 `MsgSend`: priority inheritance).
