#!/usr/bin/env bash
# Boot the QNX 8.0 aarch64le image built by tools/sdp/make-image.sh, natively on the Mac.
# Device layout mirrors mkqnximage's qemu/runimage (aarch64): -kernel ifs.bin,
# virtio-blk-device BEFORE virtio-net-device (virtio-mmio addresses follow device order).
#
# Usage: tools/qemu/run-qemu.sh [extra qemu args...]
# Env:   QNX_IMAGE_DIR (default <repo>/build/qnx-image)
#        QEMU_ACCEL=tcg|hvf (default tcg; hvf currently fails in QNX startup, see below)
#        QEMU_SERIAL=stdio|<logfile> (default stdio; a path = background-friendly log)
#        QEMU_MACHINE (virt; mkqnximage uses virt-4.2, removed in QEMU 11)
#        QEMU_MEM (1G), QEMU_SMP (2), QEMU_HOSTFWD_ADDR (8080; 0.0.0.0 = reachable from LAN),
#        QEMU_SSH_FWD_ADDR (2222; default 127.0.0.1 = this Mac only)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_DIR="${QNX_IMAGE_DIR:-$REPO_DIR/build/qnx-image}"
OUT="$IMAGE_DIR/output"
MEM="${QEMU_MEM:-1G}"
SMP="${QEMU_SMP:-2}"
FWD_ADDR="${QEMU_HOSTFWD_ADDR:-0.0.0.0}"          # teleopd 8080: the phone reaches it over LAN
SSH_FWD_ADDR="${QEMU_SSH_FWD_ADDR:-127.0.0.1}"    # ssh 2222: host only (root login)
SERIAL="${QEMU_SERIAL:-stdio}"

for f in "$OUT/ifs.bin" "$OUT/disk-qemu.vmdk"; do
  [[ -f "$f" ]] || { echo "error: $f not found; build it with: tools/sdp/run.sh /work/tools/sdp/make-image.sh" >&2; exit 1; }
done

# Default TCG: with hvf, QNX 8.0 startup-qemu-virt aborts at boot
#   gic_v3.c:966 ASSERT((use_memory_mapped_callouts == 0) || (gicc_paddr_base != ...))
# (HVF only offers GICv3; GICv2 -> "HVF does not support GICv2 emulation"). TCG + GICv2
# or GICv3 with cortex-a57 boots fine. QEMU_ACCEL=hvf keeps the experiment reachable.
ACCEL="${QEMU_ACCEL:-tcg}"
MACHINE="${QEMU_MACHINE:-virt}"
case "$ACCEL" in
  hvf) ACCEL_ARGS=(-accel hvf -cpu host); [[ -n "${QEMU_MACHINE:-}" ]] || MACHINE="virt,gic-version=3" ;;
  tcg) ACCEL_ARGS=(-accel tcg -cpu cortex-a57) ;;
  *) echo "error: QEMU_ACCEL must be hvf or tcg" >&2; exit 2 ;;
esac

if [[ "$SERIAL" == "stdio" ]]; then
  CONSOLE_ARGS=(-nographic)
else
  CONSOLE_ARGS=(-display none -serial "file:$SERIAL" -monitor none)
fi

# User-mode net: 2222 -> 22 = ssh, 8080 = teleopd WebSocket.
exec qemu-system-aarch64 \
  -machine "$MACHINE" \
  "${ACCEL_ARGS[@]}" \
  -smp "$SMP" -m "$MEM" \
  -kernel "$OUT/ifs.bin" \
  -drive "file=$OUT/disk-qemu.vmdk,if=none,id=drv0" -device virtio-blk-device,drive=drv0 \
  -netdev "user,id=net0,hostfwd=tcp:$SSH_FWD_ADDR:2222-:22,hostfwd=tcp:$FWD_ADDR:8080-:8080" \
  -device virtio-net-device,netdev=net0 \
  -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-device,rng=rng0 \
  "${CONSOLE_ARGS[@]}" \
  "$@"
