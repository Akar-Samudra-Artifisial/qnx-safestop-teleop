#!/usr/bin/env bash
# Copy teleopd, simplant, teleopctl, latbench, hamreg (+ ham, hamctrl, libham from the SDP) to the
# running QEMU target and (re)start them with teleop-start.sh (the image's boot autostart,
# which first stops the running instances). simplant is started and restarted by HAM (hamreg).
# Not needed after a fresh image boot: the image starts the stack itself; use this to update it.
# Usage: tools/qemu/deploy.sh [teleopd args...]   (default: -p 8080 -v; -t is refused)
# Env:   TELEOP_TOKEN (passed as -t, saved to /data/teleop.token; unset = keep the target's token),
#        QNX_SSH_PORT (2222), QNX_IMAGE_DIR (<repo>/build/qnx-image), QNX_DEST (/data)
# Logs on target: $QNX_DEST/ham.log, hamreg.log, teleopd.log (simplant logs to slog2info).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_DIR="${QNX_IMAGE_DIR:-$REPO_DIR/build/qnx-image}"
PORT="${QNX_SSH_PORT:-2222}"
DEST="${QNX_DEST:-/data}"   # /data: the image's autostart (teleop-start.sh) runs from here
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
for a in "${ARGS[@]}"; do
  [[ "$a" != -t* ]] || { echo "error: do not pass -t; the token comes from TELEOP_TOKEN (or the target's /data/teleop.token)" >&2; exit 2; }
done
# Fixed pairing token for tests (also saved to /data/teleop.token for later boots); without it
# teleop-start.sh reuses /data/teleop.token (or generates one and prints it).
TOKEN_ENV=""
if [[ -n "${TELEOP_TOKEN:-}" ]]; then
  [[ "$TELEOP_TOKEN" =~ ^[A-Za-z0-9]{1,32}$ ]] || { echo "error: TELEOP_TOKEN must be [A-Za-z0-9]{1,32}" >&2; exit 2; }
  TOKEN_ENV="TELEOP_TOKEN=$TELEOP_TOKEN"
fi

O=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
   -o LogLevel=ERROR -o ConnectTimeout=10)

# pidin takes a single -p.
# Stop ham with hamctrl -stop (the documented way; ham also runs a guardian process).
# Wait until old instances are gone; even then, overwriting a just-exited binary in place can
# fail for a moment (text busy, seen right after the boot autostart), so the files go to a
# staging dir first and are renamed into place.
ssh -n "${O[@]}" -p "$PORT" root@localhost "slay -f hamreg >/dev/null 2>&1; [ -x $DEST/hamctrl ] && LD_LIBRARY_PATH=$DEST/lib $DEST/hamctrl -stop >/dev/null 2>&1; \
  slay -f teleopd simplant >/dev/null 2>&1; \
  i=0; while { pidin -f a -p teleopd; pidin -f a -p simplant; pidin -f a -p ham; pidin -f a -p hamreg; } 2>/dev/null | grep -q '[0-9]'; do \
    i=\$((i+1)); [ \$i -gt 50 ] && { echo 'old instances still running' >&2; exit 1; }; sleep 0.1; done; \
  rm -rf $DEST/.deploy; mkdir -p $DEST/lib $DEST/.deploy"
FILES=("${BINS[@]}" "${HAM_FILES[@]}" "$SCRIPT_DIR/teleop-start.sh" "$HAM_LIB")
NAMES=()
for f in "${FILES[@]}"; do NAMES+=("${f##*/}"); done
scp "${O[@]}" -P "$PORT" "${FILES[@]}" "root@localhost:$DEST/.deploy/"
# Same start script as at boot (ham -> hamreg simplant -> teleopd); it backgrounds the
# daemons with redirected output, so the ssh session returns.
ssh -n "${O[@]}" -p "$PORT" root@localhost "cd $DEST/.deploy || exit 1; mv -f libham.so.2 ../lib/ || exit 1; \
  for f in ${NAMES[*]}; do [ \$f = libham.so.2 ] || mv -f \$f ../ || exit 1; done; cd .. && rmdir .deploy && \
  $TOKEN_ENV $DEST/teleop-start.sh ${ARGS[*]} < /dev/null && \
  pidin -p simplant -f abhnpl && pidin -p teleopd -f abhnpl | tail -n +2"
