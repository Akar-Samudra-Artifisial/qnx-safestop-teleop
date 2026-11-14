#!/usr/bin/env bash
# Kill simplant on the QEMU target and measure, on the target clock, how long until
# teleopd reports plant_ok=1 again in /dev/teleop (simplant restarted by HAM and
# reconnected; teleopd retries name_open every 500 ms).
# Usage: tools/fault/slay-plant.sh [timeout_s (default 15)]
# Env: QNX_SSH_PORT (2222), QNX_IMAGE_DIR (<repo>/build/qnx-image).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_DIR="${QNX_IMAGE_DIR:-$REPO_DIR/build/qnx-image}"
PORT="${QNX_SSH_PORT:-2222}"
KEY="$IMAGE_DIR/ssh/id_ed25519"
TIMEOUT="${1:-15}"
[[ "$TIMEOUT" =~ ^[0-9]{1,3}$ ]] || { echo "error: timeout must be an integer (s)" >&2; exit 2; }

# Runs on the target (ksh): date +%s%N gives ns; /dev/teleop is teleopd's status node.
ssh -n -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o ConnectTimeout=10 -p "$PORT" root@localhost "
  grep -q '^plant_ok=1' /dev/teleop || { echo 'plant_ok is not 1 before the test' >&2; exit 1; }
  old=\$(pidin -f a -p simplant | tail -n +2 | tr -d ' ')
  # QNX slay exits with the number of processes it signalled (0 = none found).
  t0=\$(date +%s%N); slay -f simplant; [ \$? -ge 1 ] || { echo 'simplant not running' >&2; exit 1; }
  end=\$((t0 + $TIMEOUT * 1000000000))
  until grep -q '^plant_ok=0' /dev/teleop; do sleep 0.01; done; td=\$(date +%s%N)
  while ! grep -q '^plant_ok=1' /dev/teleop; do
    [ \$(date +%s%N) -gt \$end ] && { echo \"plant_ok=0 after \$(( (td - t0) / 1000000 )) ms, still 0 after ${TIMEOUT} s (no restart: HAM running?)\"; exit 1; }
    sleep 0.01
  done; tu=\$(date +%s%N)
  new=\$(pidin -f a -p simplant | tail -n +2 | tr -d ' ')
  echo \"simplant pid \$old -> \$new; plant_ok=0 after \$(( (td - t0) / 1000000 )) ms, plant_ok=1 again after \$(( (tu - t0) / 1000000 )) ms\"
"
