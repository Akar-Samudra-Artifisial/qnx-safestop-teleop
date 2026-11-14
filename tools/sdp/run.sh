#!/usr/bin/env bash
# Run the QNX SDP host-tools container (linux/amd64) on the colima profile "qnx".
# Usage: ./run.sh [build] | ./run.sh [command ...]   (e.g. tools/sdp/run.sh make -C qnx)
# Commands run with qnxsdp-env.sh already sourced (when the SDP is installed).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="${QNX_SDP_IMAGE:-qnx-sdp-host:latest}"
CONTEXT="${QNX_DOCKER_CONTEXT:-colima-qnx}"
QNX_HOME="${QNX_HOME_DIR:-$HOME/qnx}"

if ! colima status -p qnx >/dev/null 2>&1; then
  echo "colima profile 'qnx' is not running. Start it with:" >&2
  echo "  colima start -p qnx" >&2
  exit 1
fi

# colima shares only $HOME with its VM by default: a repo or QNX home elsewhere (e.g. /tmp)
# is mounted as an empty directory and every command fails with "No such file or directory".
# QNX_SKIP_MOUNT_CHECK=1 skips this when extra colima mounts are configured.
if [[ "${QNX_SKIP_MOUNT_CHECK:-0}" != "1" ]]; then
  for d in "$REPO_DIR" "$QNX_HOME"; do
    case "$d/" in
      "$HOME"/*) ;;
      *) echo "error: $d is outside \$HOME; colima only mounts \$HOME into the VM." >&2
         echo "  Clone the repo under \$HOME (or set QNX_SKIP_MOUNT_CHECK=1 if you added a colima mount)." >&2
         exit 1 ;;
    esac
  done
fi

docker_q() { docker --context "$CONTEXT" "$@"; }

if [[ "${1:-}" == "build" ]]; then
  shift
  exec docker --context "$CONTEXT" build --platform linux/amd64 -t "$IMAGE" "$@" "$SCRIPT_DIR"
fi

if ! docker_q image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image $IMAGE not found; building..." >&2
  docker_q build --platform linux/amd64 -t "$IMAGE" "$SCRIPT_DIR"
fi

# ~/.qnx holds QSC user config (install location, license keys); persist it too.
mkdir -p "$QNX_HOME" "$QNX_HOME/.dotqnx"

tty_flags=(-i)
[[ -t 0 && -t 1 ]] && tty_flags=(-it)

# Wrapper: source the SDP environment (qcc, QNX_HOST/QNX_TARGET) when it is installed,
# so "./run.sh make -C qnx" works without a manual source. Before install-qsc.sh has run
# the file is absent and the command runs with the plain environment. The source runs in a
# function so qnxsdp-env.sh does not see the command's arguments as its own, and $0 must
# not be the env path (qnxsdp-env.sh exits when $BASH_SOURCE == $0).
SDP_ENV=/root/qnx/qnx800/qnxsdp-env.sh
exec docker --context "$CONTEXT" run --rm "${tty_flags[@]}" \
  --platform linux/amd64 \
  --hostname qnx-sdp \
  -v "$QNX_HOME:/root/qnx" \
  -v "$QNX_HOME/.dotqnx:/root/.qnx" \
  -v "$REPO_DIR:/work" \
  -w /work \
  -e QNX_SDP_ENV="$SDP_ENV" \
  "$IMAGE" /bin/bash -c 'sdp_env() { . "$QNX_SDP_ENV" >/dev/null; }; [ -f "$QNX_SDP_ENV" ] && sdp_env; exec "$@"' \
  qnx-sdp "${@:-/bin/bash}"
