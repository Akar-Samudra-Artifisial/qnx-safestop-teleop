#!/usr/bin/env bash
# Build the QNX 8.0 aarch64le QEMU image with mkqnximage. Idempotent: mkqnximage only
# rebuilds when options/inputs change; QNX_IMAGE_CLEAN=1 forces --clean.
# Run INSIDE the container:  ./run.sh /work/tools/sdp/make-image.sh
# Output: /work/build/qnx-image/{output,local}  +  project ssh key in .../ssh/
set -euo pipefail

SDP_DIR="${SDP_DIR:-/root/qnx/qnx800}"
OUT_DIR="${QNX_IMAGE_DIR:-/work/build/qnx-image}"
HOSTNAME_QNX="${QNX_HOSTNAME:-safestop}"
KEY="$OUT_DIR/ssh/id_ed25519"

[[ -f "$SDP_DIR/qnxsdp-env.sh" ]] || { echo "Error: SDP not found at $SDP_DIR (run install-qsc.sh)" >&2; exit 1; }
# shellcheck disable=SC1091
source "$SDP_DIR/qnxsdp-env.sh" >/dev/null

mkdir -p "$OUT_DIR/ssh"
# Project-only key (never the user's personal key); git-ignored via build/.
[[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N '' -C qnx-safestop-teleop -f "$KEY"

clean=()
[[ "${QNX_IMAGE_CLEAN:-0}" == "1" ]] && clean=(--clean)

cd "$OUT_DIR"
mkqnximage "${clean[@]}" --noprompt --force \
  --type=qemu --arch=aarch64le \
  --hostname="$HOSTNAME_QNX" \
  --ip=dhcp \
  --ssh-ident="$KEY.pub" --sshd-pregen=yes \
  --cpu=2 --ram=1G \
  "$@"

echo "Image built in $OUT_DIR/output"
ls -l "$OUT_DIR/output"
