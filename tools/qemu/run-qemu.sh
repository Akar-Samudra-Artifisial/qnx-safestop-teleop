#!/usr/bin/env bash
# Boot a QNX 8.0 aarch64le image in QEMU (macOS / Linux).
# TODO: QNX image not built yet — boot args (-kernel vs -drive, IFS layout, NIC model)
#       must be confirmed once the SDP produces an image for the virt machine.
set -euo pipefail

IMAGE="${1:-}"
if [[ -z "$IMAGE" ]]; then
  echo "usage: $0 <qnx-image> [extra qemu args...]" >&2
  exit 2
fi
if [[ ! -f "$IMAGE" ]]; then
  echo "error: image not found: $IMAGE" >&2
  exit 1
fi
shift

MEM="${QEMU_MEM:-1G}"
SMP="${QEMU_SMP:-2}"

# Prefer hardware acceleration (hvf on Apple Silicon); fall back to TCG.
if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] \
   && qemu-system-aarch64 -accel help 2>/dev/null | grep -qx hvf; then
  ACCEL=(-accel hvf -cpu max)
else
  ACCEL=(-accel tcg -cpu cortex-a57)
fi

# User-mode net: 8080 = teleopd WebSocket, 2222 -> 22 = ssh.
exec qemu-system-aarch64 \
  -machine virt \
  "${ACCEL[@]}" \
  -smp "$SMP" -m "$MEM" \
  -nographic \
  -netdev user,id=net0,hostfwd=tcp::8080-:8080,hostfwd=tcp::2222-:22 \
  -device virtio-net-device,netdev=net0 \
  -kernel "$IMAGE" \
  "$@"
