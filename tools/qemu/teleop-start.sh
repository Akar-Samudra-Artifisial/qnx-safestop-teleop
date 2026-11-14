#!/bin/sh
# Runs ON THE QNX TARGET (ksh). (Re)starts the stack from the directory this script is in:
# ham -> hamreg simplant (HAM restarts simplant) -> teleopd. Stops old instances first, so it
# never leaves duplicates. Called at boot from post_startup.sh (image built by
# tools/sdp/make-image.sh, files in /data) and by tools/qemu/deploy.sh after copying binaries.
# Usage: teleop-start.sh [teleopd args...]   (default: -p 8080 -v; deadline = teleopd default 150;
#        -t is refused: the token comes only from the sources below)
# Pairing token, in this order:
#   TELEOP_TOKEN env  -> used and saved to /data/teleop.token (later boots reuse it)
#   /data/teleop.token (written at image build from TELEOP_TOKEN, or by an earlier run)
#   none              -> random 6 digits, saved, and printed on the console at every boot
#                        ("Pairing token: NNNNNN"; QEMU serial log, QEMU_SERIAL, e.g.
#                        build/qnx-image/serial.log)
# Logs: ham.log, hamreg.log, teleopd.log next to this script (simplant logs to slog2info).

DIR=$(dirname "$0")
cd "$DIR" || exit 1
DIR=$(pwd)
TOKEN_FILE=/data/teleop.token
SHOW_FLAG=/data/teleop.token.show    # present = token was generated here, print it at boot
export LD_LIBRARY_PATH="$DIR/lib"

for b in ham hamctrl hamreg simplant teleopd; do
    [ -x "$DIR/$b" ] || { echo "teleop-start: $DIR/$b missing" >&2; exit 1; }
done

# Stop old instances (hamreg first so HAM does not restart simplant; hamctrl -stop is the
# documented way to stop ham and its guardian). Overwriting a running binary fails, so
# deploy.sh also waits for this before copying.
slay -f hamreg > /dev/null 2>&1
./hamctrl -stop > /dev/null 2>&1
slay -f teleopd simplant > /dev/null 2>&1
i=0
while { pidin -f a -p teleopd; pidin -f a -p simplant; pidin -f a -p ham; pidin -f a -p hamreg; } 2> /dev/null | grep -q '[0-9]'; do
    i=$((i + 1))
    [ $i -gt 50 ] && { echo "teleop-start: old instances still running" >&2; exit 1; }
    sleep 0.1
done

valid() {
    case "$1" in
    "" | *[!A-Za-z0-9]*) return 1 ;;
    esac
    [ ${#1} -le 32 ]
}

if [ -n "$TELEOP_TOKEN" ]; then
    valid "$TELEOP_TOKEN" || { echo "teleop-start: TELEOP_TOKEN must be [A-Za-z0-9]{1,32}" >&2; exit 2; }
    tok=$TELEOP_TOKEN
    (umask 077; echo "$tok" > "$TOKEN_FILE")
    rm -f "$SHOW_FLAG"
elif [ -s "$TOKEN_FILE" ]; then
    tok=$(head -n 1 "$TOKEN_FILE")
    valid "$tok" || { echo "teleop-start: bad token in $TOKEN_FILE" >&2; exit 2; }
else
    n=$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')
    case "$n" in ''|*[!0-9]*) echo "teleop-start: cannot read /dev/urandom" >&2; exit 2;; esac
    tok=$(printf '%06d' $((n % 1000000)))
    (umask 077; echo "$tok" > "$TOKEN_FILE")
    : > "$SHOW_FLAG"
fi

[ $# -gt 0 ] || set -- -p 8080 -v
for a in "$@"; do
    case "$a" in
    -t*) echo "teleop-start: do not pass -t; set TELEOP_TOKEN or /data/teleop.token instead" >&2; exit 2 ;;
    esac
done

./ham -f ham.log > /dev/null 2>&1 < /dev/null &
sleep 1
./hamreg "$DIR/simplant" > hamreg.log 2>&1 < /dev/null &
sleep 1
./teleopd "$@" -t "$tok" > teleopd.log 2>&1 < /dev/null &
sleep 1

if pidin -f a -p teleopd 2> /dev/null | grep -q '[0-9]'; then
    echo "teleop-start: ham, simplant, teleopd started from $DIR (teleopd $*)"
else
    echo "teleop-start: teleopd did not start, see $DIR/teleopd.log" >&2
    exit 1
fi
if [ -e "$SHOW_FLAG" ]; then
    echo "Pairing token: $tok"
else
    echo "Pairing token: as set with TELEOP_TOKEN (stored in $TOKEN_FILE)"
fi
