#!/usr/bin/env bash
# Start the latbench CPU hog on the QEMU target, detached (returns at once).
# Usage: tools/fault/cpu-hog.sh <prio> <seconds> [fifo|rr] [threads]
#   prio 10 rr   -> shares the CPUs with teleopd's net thread (RR 10); control (FIFO 50) preempts.
#   prio 10 fifo -> net/sshd starve while it runs; control still safe-stops on time.
#   prio >= 50   -> misconfiguration demo: control (FIFO 50) cannot run until the hog ends.
# The hog stops by itself after <seconds>; with fifo at >= 10 ssh is unreachable meanwhile.
# Env: QNX_SSH_PORT (2222), QNX_IMAGE_DIR (<repo>/build/qnx-image), QNX_DEST (/data).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_DIR="${QNX_IMAGE_DIR:-$REPO_DIR/build/qnx-image}"
PORT="${QNX_SSH_PORT:-2222}"
DEST="${QNX_DEST:-/data}"
KEY="$IMAGE_DIR/ssh/id_ed25519"

[[ $# -ge 2 ]] || { echo "usage: $0 <prio> <seconds> [fifo|rr] [threads]" >&2; exit 2; }
PRIO="$1"; SECS="$2"; POLICY="${3:-fifo}"; THREADS="${4:-}"
[[ "$PRIO" =~ ^[0-9]{1,3}$ && "$SECS" =~ ^[0-9]{1,4}$ ]] || { echo "error: prio/seconds must be integers" >&2; exit 2; }
[[ -z "$THREADS" || "$THREADS" =~ ^[0-9]{1,2}$ ]] || { echo "error: threads must be an integer" >&2; exit 2; }
case "$POLICY" in fifo) PFLAG="" ;; rr) PFLAG="-r" ;; *) echo "error: policy fifo|rr" >&2; exit 2 ;; esac

ARGS="-p $PRIO -s $SECS $PFLAG${THREADS:+ -n $THREADS}"
ssh -n -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o ConnectTimeout=10 -p "$PORT" root@localhost \
  "$DEST/latbench $ARGS > $DEST/hog.log 2>&1 < /dev/null &"
echo "hog started: latbench $ARGS (log $DEST/hog.log on target)"
