# qnx-safestop-teleop

React Native companion app for teleoperating a robot running on **QNX 8.0**, with a
deterministic **safe-stop**: if the operator's heartbeat misses its 150 ms deadline,
the real-time control loop ramps velocity to zero and locks until re-armed.

Entry for the QNX Global Hackathon — category **Robotics & Medical**.

## Layout

| Path | Contents |
|---|---|
| `qnx/teleopd/` | WebSocket server + SCHED_FIFO control loop (safe-stop) |
| `qnx/simplant/` | Simulated diff-drive plant (200 Hz), supervised by HAM |
| `qnx/teleopctl/` | Shell client for teleopd's `/dev/teleop` resmgr (status, set-deadline, estop, reset-stats). `set-deadline` accepts 50–1000 ms: values above 150 weaken safe-stop (up to 1 s); root only, logged as WARNING |
| `qnx/hamreg/` | Registers simplant with HAM (death → delay → restart) with a restart limit |
| `qnx/latbench/` | CPU hog (FIFO/RR, configurable priority) for the latency bench |
| `qnx/common/` | Shared headers (protocol, pulse codes, devctl codes) |
| `app/` | Expo / React Native companion app (TypeScript) |
| `tools/qemu/` | Run the QNX image under QEMU (aarch64, hvf/tcg) |
| `tools/fault/` | Fault injection: `cpu-hog.sh` (priority experiments), `slay-plant.sh` (kill simplant, time recovery) — see [tools/fault/README.md](tools/fault/README.md) |
| `tools/sdp/` | QNX SDP setup helpers |
| `docs/` | Architecture, benchmarks, QNX API evidence, codelab |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Security scope**: teleopd pairs with a 6-digit token over plain `ws://` — fine for a
trusted LAN demo, not for the public internet (no TLS; do not port-forward 8080). Browser
pages are refused by Origin, a second client cannot take over while ARMED, and the QEMU SSH
forward listens on 127.0.0.1 only. Details: ARCHITECTURE "Pairing & threat model".

## Quick start

```sh
# App
cd app && npm install && npx expo start

# QNX: build image + binaries in the SDP container (run.sh sources qnxsdp-env.sh)
tools/sdp/run.sh /work/tools/sdp/make-image.sh
tools/sdp/run.sh make -C qnx

# Boot QEMU (TCG) on the Mac, deploy, test
QEMU_SERIAL=build/qnx-image/serial.log tools/qemu/run-qemu.sh &
TELEOP_TOKEN=123456 tools/qemu/deploy.sh
python3 tools/wsclient/wsclient.py --token 123456
python3 tools/wsclient/wsclient.py --token 123456 --bench 1000 --csv build/bench/run.csv
ssh -i build/qnx-image/ssh/id_ed25519 -p 2222 root@localhost cat /dev/teleop
```

## License

[MIT](LICENSE) © 2026 Bayu Trisnapati
