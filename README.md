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
| `qnx/latbench/` | Latency benchmark (p50/p99/max under CPU hog) — stretch |
| `qnx/common/` | Shared headers (protocol, pulse codes) |
| `app/` | Expo / React Native companion app (TypeScript) |
| `tools/qemu/` | Run the QNX image under QEMU (aarch64, hvf/tcg) |
| `tools/fault/` | Fault injection scripts (network drop, process kill) |
| `tools/sdp/` | QNX SDP setup helpers |
| `docs/` | Architecture, benchmarks, QNX API evidence, codelab |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```sh
# App
cd app && npm install && npx expo start

# QNX target in QEMU (image not yet built — see tools/qemu/run-qemu.sh)
tools/qemu/run-qemu.sh path/to/qnx-image
```

## License

[MIT](LICENSE) © 2026 Bayu Trisnapati
