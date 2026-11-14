# A deadline watchdog with QNX 8.0 pulses and timers, on QEMU, on Apple Silicon

| | |
|---|---|
| **Summary** | Build a 100 Hz deadline watchdog with a QNX channel, a `SIGEV_PULSE` timer and `MsgReceive`; run it on QNX 8.0 under QEMU on an Apple Silicon Mac; measure detection latency and see how thread priority changes it. |
| **Duration** | ~90 min (most of it is the one-time SDP install) |
| **Authors** | qnx-safestop-teleop team (QNX Global Hackathon 2026) |
| **Level** | Intermediate C, no prior QNX experience needed |
| **Tested** | QNX SDP 8.0, QSC via Linux container, QEMU 11.1.3 (TCG), macOS arm64 |

## 1. Overview (5 min)

QNX SDP 8.0 host tools exist only for Linux and Windows. On an Apple Silicon Mac you can
still do everything: run the SDP in an x86-64 Linux container, build a QNX `aarch64le`
image with `mkqnximage`, and boot it in QEMU on the Mac.

What you build: a **deadline watchdog**, the core of a "safe-stop" loop. A heartbeat thread
sends pulses; a watchdog thread, blocked in `MsgReceive`, gets a 100 Hz timer pulse and
declares a deadline miss if no heartbeat arrived for 150 ms. It prints how late it noticed.
Same pattern as the safety loop of the full project (see Recap).

Concepts: `ChannelCreate`, `ConnectAttach`, `timer_create` with `SIGEV_PULSE`,
`MsgSendPulse`, `MsgReceive`, `SCHED_FIFO`, `CLOCK_MONOTONIC`.

## 2. Prerequisites (10 min)

- Mac with Apple Silicon, Homebrew.
- A free [myQNX](https://www.myqnx.com) account and a **QNX Everywhere** non-commercial
  license key (QNX SDP 8.0), plus the QNX Software Center installer
  `qnx-setup-<version>-linux.run` from myQNX, saved in `~/qnx/`.
- `brew install colima docker qemu`
- ~60 GiB free disk (colima VM) and 8 GiB RAM for the VM.

Clone the project (it contains the scripts used below) somewhere under your home directory:
colima only shares `$HOME` with its VM, so a clone in `/tmp` shows up as an empty `/work`
inside the container (`tools/sdp/run.sh` refuses to start in that case).

```sh
git clone <this repository> qnx-safestop-teleop && cd qnx-safestop-teleop
```

## 3. Step 1 - The SDP container (30 min, mostly download)

The SDP runs in an Ubuntu 24.04 `linux/amd64` container on a colima VM
(`tools/sdp/Dockerfile:3`; QEMU and tools are installed at `:11-17`). colima's VZ VM is
aarch64; x86-64 binaries run through binfmt emulation (Rosetta if present, else qemu-user).

```sh
colima start -p qnx --arch aarch64 --vm-type vz --vz-rosetta --cpu 4 --memory 8 --disk 60 --runtime docker
cd tools/sdp
./run.sh build                              # builds qnx-sdp-host:latest
./run.sh /work/tools/sdp/install-qsc.sh     # QSC + license + SDP 8.0 + packages
```

`run.sh` mounts `~/qnx` as `/root/qnx` (SDP, license) and the repo as `/work`
(`tools/sdp/run.sh:60-62`), and sources `qnxsdp-env.sh` before every command
(`tools/sdp/run.sh:51-66`), so `qcc` is always on the PATH.

`install-qsc.sh` asks for your myQNX login (password hidden, kept only in a chmod-600 temp
file, `install-qsc.sh:40-48`) and the license key, then installs the `com.qnx.qnx800` baseline
and the extra packages `qemuvirt`, `driver.virtio.devb`, `driver.virtio.startup`,
`net.openSSH` and `os_services.ham` (`install-qsc.sh:25`; HAM is only needed by the full
project, not by this codelab). **Running it accepts the QSC EULA** (`--agree`,
`install-qsc.sh:35`). Check:

```sh
./run.sh qcc -V 2>&1 | head -5     # lists gcc_ntoaarch64le among the variants
```

## 4. Step 2 - Build the QEMU image with mkqnximage (10 min)

```sh
./run.sh /work/tools/sdp/make-image.sh
```

This runs (`tools/sdp/make-image.sh:25-30`):

```sh
mkqnximage --noprompt --force --type=qemu --arch=aarch64le --hostname=safestop \
  --ip=dhcp --ssh-ident=<project key>.pub --sshd-pregen=yes --cpu=2 --ram=1G
```

Output: `build/qnx-image/output/ifs.bin` (boot image) and `disk-qemu.vmdk`. The script also
creates a throw-away ed25519 key (`make-image.sh:19`) so you can ssh in as root without
using a personal key.

## 5. Step 3 - Boot QNX in QEMU (5 min)

```sh
cd ../..                        # repo root
tools/qemu/run-qemu.sh          # serial console on stdio, Ctrl-A X quits QEMU
```

It uses `qemu-system-aarch64` with `-accel tcg -cpu cortex-a57`, 2 vCPUs, 1 GiB, user-mode
networking with `localhost:2222 -> 22` (`tools/qemu/run-qemu.sh:54-63`; another free host
port: `QEMU_SSH_PORT=2223`, then use `-p 2223`/`-P 2223` below). When the `#` prompt
appears, from a second terminal (every image build regenerates the host key, so skip
`known_hosts`; `IdentitiesOnly` avoids "Too many authentication failures" with a loaded agent):

```sh
ssh -i build/qnx-image/ssh/id_ed25519 -p 2222 -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@localhost 'uname -a'
```

> **Honest note: why TCG and not hvf?** On Apple Silicon, hvf would give near-native speed,
> but QNX 8.0's `startup-qemu-virt` aborts at boot with
> `gic_v3.c:966 ASSERT((use_memory_mapped_callouts == 0) || (gicc_paddr_base != ...))`
> (HVF only offers GICv3 and refuses GICv2). We therefore use TCG (software CPU emulation):
> boots fine, but is slower and timers jitter more. `QEMU_ACCEL=hvf tools/qemu/run-qemu.sh`
> keeps the experiment reachable (`run-qemu.sh:36-46`). Expect numbers from this codelab to be
> *worse* than real hardware.

## 6. Step 4 - The minimal watchdog (20 min)

The full source is `watchdog/watchdog.c` (161 lines, standalone). The four ideas:

**a) One channel, only pulses.** Pulses are tiny, non-blocking messages. A
fixed-priority channel keeps the receiver at its own priority regardless of the sender:

```c
g_chid = ChannelCreate(_NTO_CHF_FIXED_PRIORITY);          /* watchdog.c:114 */
g_coid = ConnectAttach(0, 0, g_chid, _NTO_SIDE_CHANNEL, 0); /* connection to ourselves */
```

**b) A timer that sends a pulse, not a signal.** 100 Hz, `CLOCK_MONOTONIC`:

```c
SIGEV_PULSE_INIT(&ev, g_coid, WD_PRIO, PULSE_TICK, 0);    /* watchdog.c:123 */
timer_create(CLOCK_MONOTONIC, &ev, &tid);
timer_settime(tid, 0, &its, NULL);                         /* its = 10 ms period */
```

**c) A heartbeat thread that can fall silent.** It sends `PULSE_HB` every 20 ms for 500 ms,
then stays quiet for 400 ms, forever. Each silence is one deadline miss to detect:

```c
MsgSendPulse(g_coid, HB_PRIO, PULSE_HB, 0);                /* watchdog.c:68 */
```

**d) The receive loop and the deadline check.** Everything runs in one place, with no locks:

```c
int rcvid = MsgReceive(g_chid, &p, sizeof(p), NULL);       /* watchdog.c:140 */
if (p.code == PULSE_HB)            { last_hb = now_ns(); armed = 1; }
else if (p.code == PULSE_TICK && armed &&
         now_ns() - last_hb > DEADLINE_MS * 1000000LL)      /* watchdog.c:153 */
    printf("deadline miss detected %.2f ms after last heartbeat\n", ...);
```

Because the deadline is evaluated only on a tick, you should see latencies between
150 ms and 150 + 10 ms (tick period) plus jitter. Predict it before you run it.

The main thread runs at `SCHED_FIFO` 50, the heartbeat thread at 30, optional hogs at a
priority you choose.

## 7. Step 5 - Build with qcc, copy, run (5 min)

```sh
cd tools/sdp
./run.sh make -C /work/docs/codelab/watchdog           # qcc -Vgcc_ntoaarch64le -Wall -Wextra
cd ../..
KEY=build/qnx-image/ssh/id_ed25519
scp -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -P 2222 docs/codelab/watchdog/watchdog root@localhost:/tmp/
ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -p 2222 root@localhost '/tmp/watchdog -n 10'
```

Our build result: `qcc` compiles with zero warnings and produces an
`ELF 64-bit ... ARM aarch64 ... interpreter /usr/lib/ldqnx-64.so.2` executable.

Expected output, for 10 trials, 10 lines like:

```
watchdog: deadline 150 ms, tick 100 Hz, hogs 0 @ prio 0
trial  1: deadline miss detected 15x.xx ms after last heartbeat
```

Measured on the target (QNX 8.0 aarch64le, QEMU TCG, 2 vCPU, `/data/watchdog -n 10`, no hogs):
detection 152.81 to 159.56 ms over 10 trials (e.g. 155.99, 154.17, 159.56, 153.28, ...). That
matches the bound 150 ms + 10 ms tick + about 1 ms jitter. The full project's numbers are in
`docs/BENCH.md`. Your numbers will differ a little; QEMU TCG is emulation, not real hardware.

## 8. Step 6 - Experiment: does priority matter? (15 min)

Two hog threads burn the CPU (the VM has 2 vCPUs, so one hog alone would just take the other
core). Hogs stop by themselves after `-T` seconds.

```sh
/tmp/watchdog -n 10 -H 10 -N 2 -T 5     # hogs at prio 10 (below everything)
/tmp/watchdog -n 10 -H 50 -N 2 -T 5     # hogs at prio 50 (same as the watchdog)
```

**Predict first**, then check. Measured on the target (QEMU TCG, 2 vCPU):

| Hogs | Prediction (author) | Measured |
|---|---|---|
| prio 10 (`-n 10 -H 10 -N 2 -T 5`) | Same as without hogs (150-160 ms). | 150.70 to 158.96 ms, as predicted. |
| prio 50 (`-n 20 -H 50 -N 2 -T 40`) | Equal-priority `SCHED_FIFO` hogs starve the watchdog and heartbeat until they end. | **Not confirmed**: 20 trials 150.00 to 162.13 ms. |
| prio 50 (`-n 20 -H 50 -N 4 -T 40`) | Same. | **Not confirmed**: 20 trials 150.00 to 159.08 ms. |

`-T 40` covers all 20 trials (~18 s). An earlier run with `-T 8` ended before the trials did and
is not used. `SCHED_FIFO 50` was accepted (no warning), but I did not confirm with `pidin` that
the hogs kept running at 50 during the trials. In the full project, two `SCHED_FIFO` 50 hogs
delayed detection to 3011.9 ms (`docs/BENCH.md`), so the sample and teleopd disagree on the same
VM (`-smp 2`, so two hogs can occupy both vCPUs). Why is **not established**. Hypotheses, untested:
the codelab hogs get descheduled or yield under TCG; the watchdog gets a vCPU while the hogs are
being switched; in teleopd the delay came from lower-priority threads, not the control thread.
Treat it as an open exercise: check with `pidin` during the run and vary `-N`.

The general point still holds: a watchdog is only as reliable as its priority is high relative
to everything else. Real systems put the watchdog above all work it supervises.

Warning: keep `-T` short; with equal-priority hogs the target can become unresponsive.

## 9. Troubleshooting (10 min)

| Symptom | Cause / fix |
|---|---|
| `colima status -p qnx` fails | `colima start -p qnx` (`tools/sdp/run.sh:13-16`). |
| SDP container very slow | colima uses qemu-user for amd64. Install Rosetta (`softwareupdate --install-rosetta --agree-to-license`) and `colima restart -p qnx`. Check `colima ssh -p qnx -- ls /proc/sys/fs/binfmt_misc/` lists `rosetta` (`tools/sdp/README.md:20-22`). |
| QEMU aborts at boot with `gic_v3.c:966 ASSERT` | You used `QEMU_ACCEL=hvf`. Use default TCG (see Step 3). |
| Install error "license key not activated" | Activate it with `qnxsoftwarecenter_clt -addLicenseKey <key> @options` (`-activateLicenseKey` in the error text is the same handler); `install-qsc.sh:56-77` does this. Set `QNX_FORCE_ACTIVATE=1` to redo. |
| `SCHED_FIFO 50 failed: Operation not permitted` | Run as root on the QNX target (the image's ssh user is root). |
| `mkqnximage` cannot find virtio/qemu files | Package missing: rerun `install-qsc.sh` (`QNX_EXTRA_PACKAGES`). |
| iOS "Origin" or WebSocket issues | Not relevant here; only for the full project's phone UI. |

## 10. Recap (5 min)

You ran the QNX 8.0 SDP on Apple Silicon (container + colima), built an aarch64le image with
`mkqnximage`, booted it in QEMU (TCG, with the honest hvf limitation) and wrote a deadline
watchdog from three QNX primitives: channel, pulse timer, `MsgReceive`.

The full project, **qnx-safestop-teleop**, applies the same pattern to a real-time safe-stop
loop for a phone-controlled vehicle: `qnx/teleopd/teleopd.c` (control thread at `SCHED_FIFO`
50, `ChannelCreate` at `:1230`, 100 Hz `timer_create` + `MsgReceive` loop at `:503-511`,
`MsgSendPulse` at `:570`), with measurements in `docs/BENCH.md` and architecture in
`docs/ARCHITECTURE.md`.

Ideas to extend: a lower deadline with a faster tick (`TICK_HZ`), measuring jitter on real
hardware, `SCHED_RR`, priority inheritance for shared data.
