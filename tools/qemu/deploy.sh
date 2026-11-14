#!/usr/bin/env bash
# Copy teleopd, simplant, teleopctl, latbench, hamreg (+ ham, hamctrl, libham from the SDP) to the
# running QEMU target and (re)start them. simplant is started and restarted by HAM (hamreg).
# Usage: tools/qemu/deploy.sh [teleopd args...]   (default: -p 8080 -v)
# Env:   TELEOP_TOKEN (adds -t), QNX_SSH_PORT (2222), QNX_IMAGE_DIR (<repo>/build/qnx-image), QNX_DEST (/tmp)
# Logs on target: $QNX_DEST/ham.log, hamreg.log, teleopd.log (simplant logs to slog2info).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_DIR="${QNX_IMAGE_DIR:-$REPO_DIR/build/qnx-image}"
PORT="${QNX_SSH_PORT:-2222}"
DEST="${QNX_DEST:-/tmp}"
KEY="$IMAGE_DIR/ssh/id_ed25519"
BINS=("$REPO_DIR/qnx/teleopd/teleopd" "$REPO_DIR/qnx/simplant/simplant"
      "$REPO_DIR/qnx/teleopctl/teleopctl" "$REPO_DIR/qnx/latbench/latbench"
      "$REPO_DIR/qnx/hamreg/hamreg")
# ham is not in the image; it comes from the SDP (package os_services.ham).
HAM_DIR="${QNX_TARGET_DIR:-$HOME/qnx/qnx800/target/qnx}/aarch64le"
HAM_FILES=("$HAM_DIR/usr/sbin/ham" "$HAM_DIR/usr/sbin/hamctrl")
HAM_LIB="$HAM_DIR/usr/lib/libham.so.2"

[[ -f "$KEY" ]] || { echo "error: project key $KEY missing (tools/sdp/make-image.sh)" >&2; exit 1; }
for b in "${BINS[@]}"; do
  [[ -x "$b" ]] || { echo "error: $b not built (tools/sdp/run.sh make -C qnx)" >&2; exit 1; }
done
for f in "${HAM_FILES[@]}" "$HAM_LIB"; do
  [[ -f "$f" ]] || { echo "error: $f missing (install QSC package com.qnx.qnx800.target.os_services.ham)" >&2; exit 1; }
done
chmod 600 "$KEY"

ARGS=("$@")
[[ ${#ARGS[@]} -gt 0 ]] || ARGS=(-p 8080 -v)
# Fixed pairing token for tests; without it teleopd prints a random one to teleopd.log.
if [[ -n "${TELEOP_TOKEN:-}" ]]; then
  [[ "$TELEOP_TOKEN" =~ ^[A-Za-z0-9]{1,32}$ ]] || { echo "error: TELEOP_TOKEN must be [A-Za-z0-9]{1,32}" >&2; exit 2; }
  ARGS+=(-t "$TELEOP_TOKEN")
fi

O=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
   -o LogLevel=ERROR -o ConnectTimeout=10)

# Background only the fully redirected binary itself: "cd X && prog > log &" would
# background a subshell that keeps the ssh channel open (session never returns).
# pidin takes a single -p.
# Stop ham with hamctrl -stop (the documented way; ham also runs a guardian process).
# Wait until old instances are gone: overwriting a running binary fails (text busy).
ssh -n "${O[@]}" -p "$PORT" root@localhost "slay -f hamreg >/dev/null 2>&1; [ -x $DEST/hamctrl ] && LD_LIBRARY_PATH=$DEST/lib $DEST/hamctrl -stop >/dev/null 2>&1; \
  slay -f teleopd simplant >/dev/null 2>&1; \
  i=0; while { pidin -f a -p teleopd; pidin -f a -p simplant; pidin -f a -p ham; pidin -f a -p hamreg; } 2>/dev/null | grep -q '[0-9]'; do \
    i=\$((i+1)); [ \$i -gt 50 ] && { echo 'old instances still running' >&2; exit 1; }; sleep 0.1; done"
ssh -n "${O[@]}" -p "$PORT" root@localhost "mkdir -p $DEST/lib"
scp "${O[@]}" -P "$PORT" "${BINS[@]}" "${HAM_FILES[@]}" "root@localhost:$DEST/"
scp "${O[@]}" -P "$PORT" "$HAM_LIB" "root@localhost:$DEST/lib/"
ssh -n "${O[@]}" -p "$PORT" root@localhost "cd $DEST || exit 1; \
  export LD_LIBRARY_PATH=$DEST/lib; \
  ./ham -f ham.log > /dev/null 2>&1 < /dev/null & \
  sleep 1; ./hamreg $DEST/simplant > hamreg.log 2>&1 < /dev/null & \
  sleep 1; ./teleopd ${ARGS[*]} > teleopd.log 2>&1 < /dev/null & \
  sleep 1; pidin -p simplant -f abhnpl; pidin -p teleopd -f abhnpl | tail -n +2"
