#!/usr/bin/env bash
# Interactive recorder for the demo video footage (iPhone via iPhone Mirroring + Mac terminal).
# Records each shot of the video script (docs/SUBMISSION_DRAFT.md) to $OUT/<NN>-<name>.mov
# with `screencapture -v` and logs timestamps to $OUT/shots.json for the Remotion edit.
#
# Usage: tools/demo/record.sh [options] [segment...]
#   segment   a..g or 1..7 (default: all, in order); "list" prints them
#   --check   preflight only (records nothing)
#   --phone   window (default: iPhone Mirroring window) | full (main display)
#             | sim (iOS Simulator: `simctl io recordVideo`, input in the DeviceHub/Simulator window)
#   --term    window (default: this terminal window) | full | off   (terminal shots in e and g)
#   --out DIR output directory (default ~/Movies/qnx-demo)
#   --auto    segments a..f drive the app themselves (cliclick clicks/drags inside the
#             iPhone Mirroring / Simulator window; a = Exit -> Connect with the saved host +
#             token), g is always automatic
#   --yes     unattended: no Enter prompts; a failed --auto take is moved to $OUT/rejected/
#             and retaken (DEMO_RETAKES, 2), then the next segment starts by itself
#   --calibrate  point the mouse at each control, saves fractions to $OUT/calib.json
#             (calib-sim.json with --phone sim)
# Env: DEMO_PHONE_RECT / DEMO_TERM_RECT (x,y,w,h in points, overrides window lookup),
#      DEMO_SIM_RECT (device screen inside the Simulator window, default: Accessibility lookup),
#      DEMO_TARGET=sim (= --phone sim), DEMO_SIM_UDID (booted), DEMO_UNATTENDED=1 (= --yes),
#      DEMO_RETAKES (2),
#      DEMO_SLAY_DELAY (10 s), DEMO_HOG_SECS (90), DEMO_HOG_POLICY (rr), DEMO_PAUSE (3 s),
#      DEMO_DRYRUN=1 (--auto prints the cliclick commands instead of running them),
#      DEMO_JOY_R (joystick drag radius, fraction of window width, 0.11),
#      TELEOP_TOKEN (only for the optional redeploy), QNX_SSH_PORT (2222), QNX_IMAGE_DIR.
# Nothing here opens a WebSocket to teleopd: target state is read over ssh (/dev/teleop).
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_DIR="${QNX_IMAGE_DIR:-$REPO_DIR/build/qnx-image}"
SSH_PORT="${QNX_SSH_PORT:-2222}"
KEY="$IMAGE_DIR/ssh/id_ed25519"
DEST=/data
DEADLINE_DEFAULT=150
OUT="${DEMO_OUT:-$HOME/Movies/qnx-demo}"
SLAY_DELAY="${DEMO_SLAY_DELAY:-10}"
HOG_SECS="${DEMO_HOG_SECS:-90}"
HOG_POLICY="${DEMO_HOG_POLICY:-rr}"
PAUSE="${DEMO_PAUSE:-3}"
PHONE_MODE="${DEMO_TARGET:-window}"   # DEMO_TARGET=sim = --phone sim
TERM_MODE=window
CHECK_ONLY=0
AUTO=0
CALIBRATE=0
DRYRUN="${DEMO_DRYRUN:-0}"
JOY_R="${DEMO_JOY_R:-0.11}"
UNATTENDED="${DEMO_UNATTENDED:-0}"
RETAKES="${DEMO_RETAKES:-2}"
SIM_UDID="${DEMO_SIM_UDID:-booted}"

SEG_IDS="a b c d e f g"
seg_file() {
  case "$1" in
    a) echo 01-connect ;;        b) echo 02-arm-drive ;;   c) echo 03-link-loss ;;
    d) echo 04-estop ;;          e) echo 05-plant-restart ;; f) echo 06-cpu-hog ;;
    g) echo 07-qnx-proof ;;
  esac
}
seg_title() {
  case "$1" in
    a) echo "Connect + pairing token" ;;
    b) echo "RE-ARM + drive + trail" ;;
    c) echo "Simulated link loss -> SAFE STOP (hb_timeout) -> RE-ARM" ;;
    d) echo "E-STOP" ;;
    e) echo "slay simplant while ARMED -> PLANT DOWN -> HAM restart -> RE-ARM" ;;
    f) echo "CPU hog prio 10 while driving + Latency tab" ;;
    g) echo "Terminal: pidin, cat /dev/teleop, teleopctl set-deadline" ;;
  esac
}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*"; }
ok() { printf '\033[32mok\033[0m  %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --phone) PHONE_MODE="${2:-}"; shift ;;
    --term) TERM_MODE="${2:-}"; shift ;;
    --out) OUT="${2:-}"; shift ;;
    --auto) AUTO=1 ;;
    --calibrate) CALIBRATE=1 ;;
    --yes) UNATTENDED=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    list) for s in $SEG_IDS; do say "$s  $(seg_file "$s").mov  $(seg_title "$s")"; done; exit 0 ;;
    all) SEGMENTS="$SEG_IDS" ;;
    [a-g]) SEGMENTS="${SEGMENTS:+$SEGMENTS }$1" ;;
    [1-7]) SEGMENTS="${SEGMENTS:+$SEGMENTS }$(echo "$SEG_IDS" | cut -d' ' -f"$1")" ;;
    *) die "unknown argument '$1' (see --help)" ;;
  esac
  shift
done
SEGMENTS="${SEGMENTS:-$SEG_IDS}"
case "$PHONE_MODE" in window|full|sim) ;; *) die "--phone must be window|full|sim" ;; esac
case "$TERM_MODE" in window|full|off) ;; *) die "--term must be window|full|off" ;; esac
[[ -n "$OUT" ]] || die "--out needs a directory"
[[ "$SLAY_DELAY" =~ ^[0-9]{1,3}$ && "$HOG_SECS" =~ ^[0-9]{1,4}$ && "$PAUSE" =~ ^[0-9]{1,2}$ ]] \
  || die "DEMO_SLAY_DELAY / DEMO_HOG_SECS / DEMO_PAUSE must be integers"
[[ "$JOY_R" =~ ^0?\.[0-9]+$ ]] || die "DEMO_JOY_R must be a fraction like 0.11"
[[ "$DRYRUN" == 0 || "$DRYRUN" == 1 ]] || die "DEMO_DRYRUN must be 0 or 1"
[[ "$UNATTENDED" == 0 || "$UNATTENDED" == 1 ]] || die "DEMO_UNATTENDED must be 0 or 1"
[[ "$RETAKES" =~ ^[0-9]$ ]] || die "DEMO_RETAKES must be 0-9"
[[ "$SIM_UDID" =~ ^(booted|[0-9A-Fa-f-]{36})$ ]] || die "DEMO_SIM_UDID must be 'booted' or a device UDID"
case "$HOG_POLICY" in rr|fifo) ;; *) die "DEMO_HOG_POLICY must be rr|fifo" ;; esac
[[ "$(uname -s)" == Darwin ]] || die "macOS only (screencapture, osascript)"
[[ -f "$KEY" ]] || die "project ssh key $KEY missing (tools/sdp/make-image.sh)"
chmod 600 "$KEY"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/qnx-demo.XXXXXX")" || die "mktemp failed"
SESSION="$(date +%Y%m%d-%H%M%S)"
JSONL="$OUT/shots.jsonl"
JSON="$OUT/shots.json"

# --- ssh to the target (one multiplexed connection: fast and no repeated handshakes) ---
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o LogLevel=ERROR -o ConnectTimeout=10 -o ControlMaster=auto
          -o "ControlPath=$TMPD/cm" -o ControlPersist=300 -p "$SSH_PORT")
tssh() { ssh -n "${SSH_OPTS[@]}" root@localhost "$@"; }

# --- timestamps + shots.json ---
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
jstr() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
SEG_T0=""
SEG_CUR=""
# log_event <type> <name> [extra json fields, already formatted: "\"k\":v,..."] [t]
log_event() {
  local t="${4:-$(now)}" off="null" seg="null"
  [[ -n "$SEG_T0" ]] && off="$(perl -e 'printf "%.3f", $ARGV[0] - $ARGV[1]' "$t" "$SEG_T0")"
  [[ -n "$SEG_CUR" ]] && seg="$(jstr "$SEG_CUR")"
  printf '{"session":%s,"t":%s,"iso":%s,"segment":%s,"offset_s":%s,"type":%s,"name":%s%s}\n' \
    "$(jstr "$SESSION")" "$t" "$(jstr "$(date -u -r "${t%.*}" +%Y-%m-%dT%H:%M:%SZ)")" "$seg" "$off" \
    "$(jstr "$1")" "$(jstr "$2")" "${3:+,$3}" >> "$JSONL"
  write_json
}
write_json() {
  [[ -s "$JSONL" ]] || return 0
  { printf '{"note":"t = Mac epoch seconds; offset_s = seconds since the segment recording was launched (first frame lags ~0.3-1 s)",\n "events":[\n'
    awk 'NR > 1 { printf ",\n" } { printf "%s", $0 } END { printf "\n" }' "$JSONL"
    printf ']}\n'; } > "$JSON.tmp" && mv "$JSON.tmp" "$JSON"
}

# --- window rectangles (System Events needs Accessibility permission for the terminal app) ---
read -r TERM_PID TERM_APP <<< "$(osascript -e 'tell application "System Events" to tell (first process whose frontmost is true) to get (unix id as text) & " " & name' 2>/dev/null)"
# Started while another app had focus (e.g. from an IDE agent): there is no terminal window to use.
case "$TERM_APP" in "iPhone Mirroring"|DeviceHub|Simulator) TERM_APP=""; TERM_PID="" ;; esac
# The process is addressed by pid: several instances may share a name (e.g. ghostty).
term_proc() { printf 'first process whose unix id is %s' "$TERM_PID"; }
win_rect() {  # <process name | AppleScript process specifier> -> x,y,w,h of its front window
  local r p="process \"$1\""
  [[ "$1" == "first process "* ]] && p="$1"
  r="$(osascript -e "tell application \"System Events\" to tell $p to get {position, size} of window 1" 2>/dev/null | tr -d ' ')" || return 1
  [[ "$r" =~ ^-?[0-9]+,-?[0-9]+,[0-9]+,[0-9]+$ ]] || return 1
  printf '%s' "$r"
}
# iOS Simulator host app: Xcode 27 shows simulators in DeviceHub, older Xcode in Simulator.
SIM_APP=""
sim_app() {
  [[ -n "$SIM_APP" ]] && { printf '%s' "$SIM_APP"; return 0; }
  local a
  for a in DeviceHub Simulator; do
    if pgrep -xq "$a"; then SIM_APP="$a"; printf '%s' "$a"; return 0; fi
  done
  return 1
}
# DeviceHub reports no window to Accessibility while another app is active (e.g. with
# Stage Manager): bring it to the front first when needed.
sim_front() {  # <app>
  [[ "$(osascript -e "tell application \"System Events\" to count windows of process \"$1\"" 2>/dev/null)" =~ ^[1-9] ]] && return 0
  osascript -e "tell application \"$1\" to activate" > /dev/null 2>&1
  sleep 0.7
}
sim_win() {  # x,y,w,h of the Simulator host window
  local app
  app="$(sim_app)" || return 1
  win_rect "$app" && return 0
  sim_front "$app"
  win_rect "$app"
}
# Device screen inside the Simulator window: the deepest Accessibility group with a phone
# aspect ratio (h/w 1.9-2.4), e.g. 583,132,393,853 for an iPhone 16 at 100 % zoom.
sim_rect() {
  if [[ -n "${DEMO_SIM_RECT:-}" ]]; then printf '%s' "$DEMO_SIM_RECT"; return 0; fi
  local app r
  app="$(sim_app)" || return 1
  sim_front "$app"
  # shellcheck disable=SC2016  # JavaScript, not shell
  r="$(osascript -l JavaScript -e '
    function run(argv) {
      const w = Application("System Events").processes.byName(argv[0]).windows[0];
      let best = null;
      (function walk(e, d) {
        if (d > 16) return;
        let k;
        try {
          const s = e.size(), p = e.position();
          if (e.role() === "AXGroup" && s[0] >= 150 && s[1] / s[0] > 1.9 && s[1] / s[0] < 2.4) best = [p[0], p[1], s[0], s[1]];
          k = e.uiElements();
        } catch (x) { return; }
        for (let i = 0; i < k.length; i++) walk(k[i], d + 1);
      })(w, 0);
      return best ? best.join(",") : "";
    }' "$app" 2>/dev/null)"
  [[ "$r" =~ ^-?[0-9]+,-?[0-9]+,[0-9]+,[0-9]+$ ]] || return 1
  printf '%s' "$r"
}
sim_booted() { xcrun simctl list devices booted 2>/dev/null | grep -q '(Booted)'; }
phone_rect() {
  if [[ "$PHONE_MODE" == sim ]]; then sim_booted && printf 'sim'; return; fi
  if [[ -n "${DEMO_PHONE_RECT:-}" ]]; then printf '%s' "$DEMO_PHONE_RECT"; return 0; fi
  [[ "$PHONE_MODE" == full ]] && { printf 'full'; return 0; }
  win_rect "iPhone Mirroring"
}
term_rect() {
  if [[ -n "${DEMO_TERM_RECT:-}" ]]; then printf '%s' "$DEMO_TERM_RECT"; return 0; fi
  [[ "$TERM_MODE" == full ]] && { printf 'full'; return 0; }
  [[ -n "$TERM_PID" ]] && win_rect "$(term_proc)"
}

# --- recording ---
REC_PIDS=""
REC_FILES=""
LAST_FILES=""   # clips of the last take (moved to $OUT/rejected/ when an unattended take fails)
RECORDING=0
STOP_REQ=0
SESSION_STARTED=0
next_file() {  # <base> -> unused path ($OUT/base.mov, then base-take2.mov, ...)
  local f="$OUT/$1.mov" n=2
  while [[ -e "$f" ]]; do f="$OUT/$1-take$n.mov"; n=$((n + 1)); done
  printf '%s' "$f"
}
rec_start() {  # <file> <rect|full|sim> <label>
  local args=(-x -v)
  if [[ "$2" == sim ]]; then
    # Device framebuffer at native resolution: no window chrome, no pointer; SIGINT finalizes.
    xcrun simctl io "$SIM_UDID" recordVideo --codec=h264 --force "$1" < /dev/null > "$TMPD/sc-$3.log" 2>&1 &
    REC_PIDS="$REC_PIDS $!"
    REC_FILES="$REC_FILES$1"$'\n'
    log_event rec_start "$3" "\"file\":$(jstr "$(basename "$1")"),\"rect\":\"sim\""
    sleep 1  # simctl needs a moment before the first frame is written
    return 0
  fi
  if [[ "$2" == full ]]; then args+=(-m); else args+=(-R "$2"); fi
  [[ "$3" == phone ]] && args+=(-k)
  # stdin from /dev/null: screencapture stops on "any character" otherwise.
  screencapture "${args[@]}" "$1" < /dev/null > "$TMPD/sc-$3.log" 2>&1 &
  REC_PIDS="$REC_PIDS $!"
  REC_FILES="$REC_FILES$1"$'\n'
  log_event rec_start "$3" "\"file\":$(jstr "$(basename "$1")"),\"rect\":$(jstr "$2")"
}
rec_stop_all() {
  local p i
  for p in $REC_PIDS; do kill -INT "$p" 2>/dev/null; done
  for p in $REC_PIDS; do
    i=0
    while kill -0 "$p" 2>/dev/null && [[ $i -lt 100 ]]; do sleep 0.1; i=$((i + 1)); done
    kill -0 "$p" 2>/dev/null && { warn "screencapture $p did not stop on SIGINT, sending TERM"; kill -TERM "$p" 2>/dev/null; }
    wait "$p" 2>/dev/null
  done
  REC_PIDS=""
  local f dur
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if [[ ! -s "$f" ]]; then
      warn "$(basename "$f") is missing or empty (Screen Recording permission for $TERM_APP?)"
      log_event rec_file_bad "$(basename "$f")"
      continue
    fi
    dur=""
    command -v ffprobe > /dev/null && dur="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" 2>/dev/null)"
    say "  saved $f${dur:+ ($(printf '%.1f' "$dur") s)}"
    log_event rec_saved "$(basename "$f")" "\"duration_s\":${dur:-null}"
  done <<< "$REC_FILES"
  LAST_FILES="$REC_FILES"
  REC_FILES=""
}

# --- target state monitor: one ssh session prints /dev/teleop fields when they change ---
MON_PID=""
MON_FILE=""
# shellcheck disable=SC2016  # expands on the target, not here
MON_CMD='prev=; n=0
while :; do
  s=$(grep -E "^(mode|plant_ok|deadline_ms|events)=" /dev/teleop | tr "\n" " ")
  if [ "$s" != "$prev" ]; then echo "$s"; prev=$s; n=0
  else n=$((n+1)); [ $n -ge 20 ] && { echo "#"; n=0; }; fi
  sleep 0.1
done'
mon_start() {
  MON_FILE="$TMPD/mon-$SEG_CUR.txt"
  # The "#" keepalive makes the remote loop die of SIGPIPE soon after the reader is killed.
  tssh "$MON_CMD" 2>/dev/null \
    | perl -MTime::HiRes=time -ne 'BEGIN { $| = 1 } next if /^#/; chomp; s/\s+$//; printf "%.3f %s\n", time, $_' \
    > "$MON_FILE" &
  MON_PID=$!
  disown "$MON_PID" 2>/dev/null  # no "Terminated" job notice when it is killed
}
mon_stop() {
  [[ -n "$MON_PID" ]] || return 0
  # No wait: the ssh half of the pipeline only exits on its next write (SIGPIPE, <= 2 s).
  kill "$MON_PID" 2>/dev/null; MON_PID=""
  local t s
  while read -r t s; do
    [[ -n "$s" ]] && log_event target "$(printf '%s' "$s" | sed -n 's/.*mode=\([A-Z_]*\).*/\1/p')" "\"state\":$(jstr "$s")" "$t"
  done < "$MON_FILE"
}

teleop_field() { tssh "grep '^$1=' /dev/teleop" 2>/dev/null | cut -d= -f2; }

# --- fail-safe: deadline back to 150 ms, no hog left running ---
failsafe() {
  local d
  d="$(tssh "$DEST/teleopctl set-deadline $DEADLINE_DEFAULT >/dev/null 2>&1; slay -f latbench >/dev/null 2>&1; grep '^deadline_ms=' /dev/teleop" 2>/dev/null | cut -d= -f2)"
  if [[ "$d" == "$DEADLINE_DEFAULT" ]]; then
    log_event failsafe ok "\"deadline_ms\":$d"
  else
    warn "fail-safe: could not confirm deadline_ms=$DEADLINE_DEFAULT (got '${d:-no answer}'); run: ssh ... $DEST/teleopctl set-deadline $DEADLINE_DEFAULT"
    log_event failsafe unconfirmed
  fi
}

cleanup() {
  trap - INT TERM EXIT
  release_mouse
  if [[ -n "$REC_PIDS" ]]; then rec_stop_all; fi
  mon_stop
  [[ $SESSION_STARTED -eq 1 ]] && failsafe
  [[ -n "$SEG_CUR" ]] && log_event aborted "$SEG_CUR"
  ssh "${SSH_OPTS[@]}" -O exit root@localhost > /dev/null 2>&1
  rm -rf "$TMPD"
}
on_int() {
  if [[ $RECORDING -eq 1 ]]; then STOP_REQ=1; else printf '\n'; exit 130; fi
}
trap cleanup EXIT
trap on_int INT
trap 'exit 143' TERM

# Waits for Enter (or Ctrl-C) while recording.
wait_stop() {
  [[ $UNATTENDED -eq 1 ]] && { sleep 2; return 0; }
  bold ">>> RECORDING - press Enter (or Ctrl-C) to stop"
  while [[ $STOP_REQ -eq 0 ]]; do
    read -r -t 1 _ && break
  done
}
# Unattended: every prompt takes its default (Enter); [y/N] questions therefore answer no.
ask_enter() {
  local r=""
  if [[ $UNATTENDED -eq 1 ]]; then printf '%s(--yes: Enter)\n' "$1" >&2; return 0; fi
  read -r -p "$1" r; printf '%s' "$r"
}

# --- preflight ---
preflight() {
  local fail=0 r
  bold "Preflight"
  if pgrep -qf qemu-system-aarch64; then ok "QEMU running"
  else
    say "    QEMU is not running. Start it detached (see tools/qemu/README.md):"
    say "    launchctl submit -l com.qnx.safestop.qemu ... tools/qemu/run-qemu.sh"
    return 1
  fi
  if lsof -nP -iTCP:8080 -sTCP:LISTEN > /dev/null 2>&1; then ok "port 8080 listening"
  else warn "nothing listens on 8080 (QEMU hostfwd)"; fail=1; fi
  if ! tssh true 2>/dev/null; then warn "ssh to the target on 127.0.0.1:$SSH_PORT failed"; return 1; fi
  ok "ssh to target"
  if tssh "pidin -f a -p teleopd" 2>/dev/null | grep -q '[0-9]' && tssh "test -r /dev/teleop"; then
    ok "teleopd running: mode=$(teleop_field mode) deadline_ms=$(teleop_field deadline_ms) plant_ok=$(teleop_field plant_ok)"
  else
    warn "teleopd is not running"
    r="$(ask_enter "    Redeploy now with QNX_DEST=$DEST tools/qemu/deploy.sh? [y/N] ")"
    if [[ "$r" == [yY]* ]]; then
      if [[ -z "${TELEOP_TOKEN:-}" ]]; then
        read -r -s -p "    Pairing token (hidden, empty = random token in teleopd.log): " TELEOP_TOKEN; printf '\n'
      fi
      TELEOP_TOKEN="$TELEOP_TOKEN" QNX_DEST=$DEST "$REPO_DIR/tools/qemu/deploy.sh" || { warn "deploy failed"; return 1; }
      sleep 1
      tssh "test -r /dev/teleop" || { warn "teleopd still not up"; return 1; }
      ok "teleopd redeployed"
    else
      fail=1
    fi
  fi
  if tssh "pidin -f a -p simplant" 2>/dev/null | grep -q '[0-9]'; then ok "simplant running"; else warn "simplant not running"; fi
  if tssh "pidin -f a -p ham" 2>/dev/null | grep -q '[0-9]'; then ok "ham running (restarts simplant)"; else warn "ham not running: segment e will not recover"; fi
  if tssh "pidin -f a -p latbench" 2>/dev/null | grep -q '[0-9]'; then warn "a latbench hog is running; the fail-safe will stop it"; fi
  [[ "$(teleop_field deadline_ms)" == "$DEADLINE_DEFAULT" ]] || warn "deadline is not $DEADLINE_DEFAULT ms; the fail-safe will reset it"
  if lsof -nP -iTCP:8081 -sTCP:LISTEN > /dev/null 2>&1; then ok "Metro (8081) running"
  else warn "Metro is not running on 8081 (cd app && npm start)"; fi
  if [[ "$PHONE_MODE" == sim ]]; then
    if sim_booted; then ok "Simulator booted ($SIM_UDID), clips via simctl recordVideo"
    else warn "no booted iOS Simulator (xcrun simctl boot <udid>)"; fail=1; fi
    if r="$(sim_rect)"; then ok "Simulator screen in $(sim_app): $r"
    else warn "Simulator device screen not found (open it in DeviceHub/Simulator, or DEMO_SIM_RECT=x,y,w,h)"; [[ $AUTO -eq 1 ]] && fail=1; fi
  elif r="$(phone_rect)"; then ok "iPhone capture region: $r"
  else warn "iPhone Mirroring window not found (open it; System Events also needs Accessibility permission for $TERM_APP). Override: DEMO_PHONE_RECT=x,y,w,h"; fail=1; fi
  if r="$(term_rect)"; then ok "terminal capture region ($TERM_APP): $r"
  elif [[ "$TERM_MODE" != off ]]; then warn "terminal window not found (use --term full or DEMO_TERM_RECT=x,y,w,h)"; fi
  if command -v ffprobe > /dev/null; then ok "ffprobe present (checks saved clips)"; fi
  if command -v cliclick > /dev/null; then ok "cliclick present ($(cliclick -V 2>/dev/null | cut -d, -f1))"
  else warn "cliclick missing (needed for --auto / --calibrate): brew install cliclick"; [[ $AUTO -eq 1 ]] && fail=1; fi
  if ax_trusted; then ok "Accessibility permission for $TERM_APP"
  else warn "no Accessibility permission: $AX_HINT"; [[ $AUTO -eq 1 ]] && fail=1; fi
  if [[ -f "$CALIB" ]]; then ok "calibration: $CALIB"; else say "    (no $CALIB: --auto uses layout defaults; run --calibrate)"; fi
  return $fail
}

# --- segments ---
instructions() {
  case "$1" in
    a) say "  Before you press Enter: open the app on the iPhone at the Connect screen, fill in host and the"
       say "  pairing token NOW (the token is visible on screen, it must not be in the clip)."
       say "  Disconnect first if the app is already connected."
       say "  After Enter: tap Connect, wait until the Teleop screen shows the robot (DISARMED / SAFE STOP)." ;;
    b) say "  Hold RE-ARM until ARMED, then drive with the joystick: a loop or a figure eight so the"
       say "  map shows the trail. Keep it 10-20 s." ;;
    c) say "  ARM (hold RE-ARM), drive, switch ON 'Simulate link loss'. Watch heartbeat age pass 150 ms,"
       say "  SAFE STOP (hb_timeout) with its detect time. Switch the toggle OFF, hold RE-ARM, drive again." ;;
    d) say "  ARM, drive, then press E-STOP. Hold on the latched SAFE STOP (estop) card, then RE-ARM." ;;
    e) say "  ARM and drive. The script slays simplant after a ${SLAY_DELAY} s countdown (keep driving)."
       say "  Expect SAFE STOP (plant_lost) + PLANT DOWN banner, then HAM restarts simplant (plant OK)."
       say "  Then hold RE-ARM and drive again. Note: hamreg gives up after > 5 deaths in 60 s, keep takes >= 12 s apart." ;;
    f) say "  The script starts a CPU hog (latbench prio 10 $HOG_POLICY, ${HOG_SECS} s) when recording starts."
       say "  ARM, drive, trip link loss once or twice, then open the Latency tab and hold on it." ;;
    g) say "  Terminal shot: the script clears this window and types the commands itself."
       say "  Make the terminal window big with a readable font. Nothing to do on the iPhone." ;;
  esac
}

run_slay() {
  local i mode r out
  for ((i = SLAY_DELAY; i > 0; i--)); do
    [[ $STOP_REQ -eq 1 ]] && { printf '\n'; log_event action slay_skipped; return 0; }
    printf '\r  slay simplant in %2d s ' "$i"; sleep 1
  done
  printf '\n'
  mode="$(teleop_field mode)"
  if [[ "$mode" != ARMED ]]; then
    r="$(ask_enter "  mode is ${mode:-unknown}, not ARMED. Enter = slay anyway, s = skip: ")"
    [[ "$r" == [sS]* ]] && { log_event action slay_skipped; return 0; }
  fi
  log_event action slay_simplant "\"mode_before\":$(jstr "$mode")"
  bold "  \$ tools/fault/slay-plant.sh"
  out="$("$REPO_DIR/tools/fault/slay-plant.sh" 15 2>&1)"
  say "  $out"
  log_event action plant_restart_result "\"output\":$(jstr "$out")"
}

run_proof() {  # segment g, runs inside the terminal recording; prints no token, IP or key
  local p='qnx# '
  clear
  sleep 1
  bold "${p}pidin -p teleopd -f abhnpl"; tssh "pidin -p teleopd -f abhnpl"; log_event action pidin; sleep "$PAUSE"
  bold "${p}cat /dev/teleop"; tssh "cat /dev/teleop"; log_event action cat_dev_teleop; sleep "$PAUSE"
  bold "${p}teleopctl set-deadline 200"; tssh "$DEST/teleopctl set-deadline 200"
  log_event action set_deadline "\"deadline_ms\":200"; sleep 1
  bold "${p}grep deadline /dev/teleop"; tssh "grep deadline /dev/teleop"; sleep "$PAUSE"
  bold "${p}teleopctl set-deadline $DEADLINE_DEFAULT"; tssh "$DEST/teleopctl set-deadline $DEADLINE_DEFAULT"
  log_event action set_deadline "\"deadline_ms\":$DEADLINE_DEFAULT"; sleep 1
  bold "${p}grep deadline /dev/teleop"; tssh "grep deadline /dev/teleop"
}

# --- automation (--auto, --calibrate): cliclick, only ever inside the iPhone Mirroring window
#     (--phone sim: inside the device screen of the Simulator window) ---
CALIB="$OUT/calib.json"
[[ "$PHONE_MODE" == sim ]] && CALIB="$OUT/calib-sim.json"
# tab_* = tab row while ARMED; tab_*_stop = the same row under the taller SAFE STOP card.
CALIB_TARGETS="joystick rearm estop linkloss tab_map tab_latency tab_events tab_map_stop tab_latency_stop exit connect host token"
# Defaults: fractions (x, y). Mirroring: of the window, measured on screenshots of an
# iPhone 12 mini (434x952 pt window). sim: of the device screen, measured on an iPhone 16
# simulator (393x852 pt) with the Expo Go tools button hidden.
calib_default() {
  if [[ "$PHONE_MODE" == sim ]]; then
    case "$1" in
      joystick) echo "0.244 0.863" ;;  rearm) echo "0.733 0.917" ;;  estop) echo "0.733 0.806" ;;
      linkloss) echo "0.893 0.714" ;;  tab_map) echo "0.198 0.359" ;; tab_latency) echo "0.499 0.359" ;;
      tab_events) echo "0.799 0.359" ;; tab_map_stop) echo "0.198 0.405" ;; tab_latency_stop) echo "0.499 0.405" ;;
      exit) echo "0.888 0.100" ;;      connect) echo "0.500 0.743" ;; host) echo "0.500 0.495" ;;
      token) echo "0.125 0.627" ;;
    esac
    return 0
  fi
  case "$1" in
    joystick) echo "0.263 0.851" ;;   rearm) echo "0.724 0.911" ;;      estop) echo "0.724 0.814" ;;
    linkloss) echo "0.859 0.715" ;;   tab_map) echo "0.210 0.370" ;;    tab_latency) echo "0.500 0.370" ;;
    tab_events) echo "0.763 0.370" ;; tab_map_stop) echo "0.210 0.410" ;; tab_latency_stop) echo "0.500 0.410" ;;
    exit) echo "0.878 0.129" ;;       connect) echo "0.500 0.700" ;;    host) echo "0.500 0.450" ;;
    token) echo "0.500 0.580" ;;
  esac
}
calib_desc() {
  case "$1" in
    joystick) echo "centre of the joystick" ;;   rearm) echo "RE-ARM button" ;;
    estop) echo "E-STOP button" ;;               linkloss) echo "'Simulate link loss' switch" ;;
    tab_map) echo "Map tab" ;;                   tab_latency) echo "Latency tab" ;;
    tab_events) echo "Events tab" ;;             tab_map_stop) echo "Map tab while SAFE STOP" ;;
    tab_latency_stop) echo "Latency tab while SAFE STOP" ;; exit) echo "Exit button (Teleop screen)" ;;
    connect) echo "Connect button (Connect screen)" ;;
    host) echo "Robot address field (Connect screen)" ;; token) echo "Pairing code boxes (Connect screen)" ;;
  esac
}
calib_get() {  # <target> -> "fx fy" from calib.json, else the layout default
  local v=""
  [[ -f "$CALIB" ]] && v="$(sed -n "s/^ *\"$1\": *\[ *\([0-9.]*\) *, *\([0-9.]*\) *\].*/\1 \2/p" "$CALIB")"
  if [[ -n "$v" ]]; then printf '%s' "$v"; else calib_default "$1"; fi
}
ax_trusted() {  # Accessibility permission of the app this terminal runs in
  [[ "$(osascript -l JavaScript -e 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()' 2>/dev/null)" == true ]]
}
AX_HINT="System Settings -> Privacy & Security -> Accessibility: enable your terminal app ($TERM_APP)"

AUTO_RECT=""    # x,y,w,h of the window when the segment started; any change aborts
AUTO_ABORT=""   # reason, empty while automation may continue
MOUSE_DOWN=""   # "x,y" while cliclick holds the button
MOUSE_HOME=""   # mouse position before the segment
PARK=""         # where the mouse rests between actions; moved by hand = abort
X=0; Y=0; PT=""
cc() {
  if [[ $DRYRUN -eq 1 ]]; then say "  [dry-run] cliclick $*"; return 0; fi
  cliclick "$@"
}
cpt() {  # cliclick coordinates: absolute negative values need "="
  local x="$1" y="$2"
  [[ "$x" == -* ]] && x="=$x"
  [[ "$y" == -* ]] && y="=$y"
  printf '%s,%s' "$x" "$y"
}
AUTO_WIN=""    # host window rect when the segment started (change = abort)
host_app() { if [[ "$PHONE_MODE" == sim ]]; then sim_app; else printf 'iPhone Mirroring'; fi; }
auto_win() {  # rect of the window that receives the clicks (cheap: checked often)
  if [[ "$PHONE_MODE" == sim ]]; then sim_win; return; fi
  if [[ -n "${DEMO_PHONE_RECT:-}" ]]; then printf '%s' "$DEMO_PHONE_RECT"; else win_rect "iPhone Mirroring"; fi
}
auto_rect() {  # area the target fractions refer to: Mirroring window, or the simulated screen
  if [[ "$PHONE_MODE" == sim ]]; then sim_rect; else auto_win; fi
}
abs_pt() {  # <fx> <fy> -> "x y" in screen points for AUTO_RECT
  perl -e '($x, $y, $w, $h) = split /,/, $ARGV[0]; printf "%d %d", $x + $ARGV[1] * $w, $y + $ARGV[2] * $h' "$AUTO_RECT" "$1" "$2"
}
in_win() {  # <x> <y>: inside AUTO_RECT with a 4 pt margin
  local rx ry rw rh
  IFS=, read -r rx ry rw rh <<< "$AUTO_RECT"
  (( $1 >= rx + 4 && $1 <= rx + rw - 4 && $2 >= ry + 4 && $2 <= ry + rh - 4 ))
}
mouse_pos() { cliclick p 2>/dev/null | tr -d ' '; }
near() {  # <"x,y"> <"x,y"> within 12 pt
  local ax="${1%,*}" ay="${1#*,}" bx="${2%,*}" by="${2#*,}"
  ax="${ax#=}"; ay="${ay#=}"; bx="${bx#=}"; by="${by#=}"
  (( (ax - bx) * (ax - bx) + (ay - by) * (ay - by) <= 144 ))
}
release_mouse() {
  [[ -n "$MOUSE_DOWN" ]] || return 0
  cc "du:$MOUSE_DOWN"
  MOUSE_DOWN=""
}
auto_fail() {
  [[ -n "$AUTO_ABORT" ]] && return 1
  AUTO_ABORT="$1"
  release_mouse
  warn "automation stopped: $1"
  log_event auto_aborted "$1"
  return 1
}
auto_ok() {  # may the next action run?
  [[ -n "$AUTO_ABORT" ]] && return 1
  [[ $STOP_REQ -eq 1 ]] && { auto_fail "stopped by user (Ctrl-C)"; return 1; }
  local p
  auto_rect_same || return 1
  if [[ $DRYRUN -eq 0 && -n "$PARK" ]]; then
    p="$(mouse_pos)"
    near "$p" "$PARK" || { auto_fail "mouse moved by hand"; return 1; }
  fi
}
activate_mirror() {
  [[ $DRYRUN -eq 1 ]] && return 0
  osascript -e "tell application \"$(host_app)\" to activate" > /dev/null 2>&1
  sleep 0.5
}
focus_terminal() {
  [[ $DRYRUN -eq 1 || -z "$TERM_PID" ]] && return 0
  osascript -e "tell application \"System Events\" to set frontmost of ($(term_proc)) to true" > /dev/null 2>&1
}
park_mouse() {  # outside the window: back where it was, or right of the window
  local rx ry rw rh
  IFS=, read -r rx ry rw rh <<< "$AUTO_RECT"
  if [[ -n "$MOUSE_HOME" ]] && ! in_win "${MOUSE_HOME%,*}" "${MOUSE_HOME#*,}"; then
    PARK="$MOUSE_HOME"
  else
    PARK="$(cpt $((rx + rw + 40)) $((ry + rh / 2)))"
  fi
  cc "m:$PARK"
}
tgt_pt() {  # <target> -> X, Y, PT (cliclick form); refuses points outside the window
  local fx fy
  read -r fx fy <<< "$(calib_get "$1")"
  read -r X Y <<< "$(abs_pt "$fx" "$fy")"
  in_win "$X" "$Y" || { auto_fail "target $1 ($X,$Y) is outside the window $AUTO_RECT"; return 1; }
  PT="$(cpt "$X" "$Y")"
}
pause() {
  sleep "$1"
  [[ $STOP_REQ -eq 0 ]] || { auto_fail "stopped by user (Ctrl-C)"; return 1; }
}
mon_field() { tail -n 1 "$MON_FILE" 2>/dev/null | sed -n "s/.*$1=\([^ ]*\).*/\1/p"; }
wait_field() {  # <field> <value> <timeout s>, from the /dev/teleop monitor
  if [[ $DRYRUN -eq 1 ]]; then say "  [dry-run] wait for $1=$2"; return 0; fi
  local i=0 lim=$(($3 * 10))
  while [[ "$(mon_field "$1")" != "$2" ]]; do
    [[ $STOP_REQ -eq 1 ]] && { auto_fail "stopped by user (Ctrl-C)"; return 1; }
    [[ $i -ge $lim ]] && { auto_fail "$1 did not become $2 within $3 s (now: $(mon_field "$1"))"; return 1; }
    i=$((i + 1)); sleep 0.1
  done
  log_event state "$1=$2"
}
wait_hb() {  # <above|below> <ms> <timeout s>: heartbeat age seen by teleopd (app link up/down)
  if [[ $DRYRUN -eq 1 ]]; then say "  [dry-run] wait for hb_age_ms $1 $2"; return 0; fi
  local i=0 h
  while :; do
    h="$(teleop_field hb_age_ms)"
    if [[ "$h" =~ ^[0-9]+$ ]]; then
      [[ "$1" == above && $h -gt $2 ]] && break
      [[ "$1" == below && $h -lt $2 ]] && break
    fi
    [[ $STOP_REQ -eq 1 ]] && { auto_fail "stopped by user (Ctrl-C)"; return 1; }
    [[ $i -ge $(($3 * 4)) ]] && { auto_fail "hb_age_ms not $1 $2 within $3 s (now: ${h:-?})"; return 1; }
    i=$((i + 1)); sleep 0.25
  done
  log_event state "hb_age_ms $1 $2" "\"hb_age_ms\":$h"
}

a_tap() {  # <target>
  auto_ok || return 1
  activate_mirror
  tgt_pt "$1" || return 1
  cc "m:$PT" && sleep 0.3
  # A short press instead of c: (the Simulator ignores zero-length clicks now and then).
  cc "dd:$PT" || { auto_fail "cliclick dd: failed (Accessibility?)"; return 1; }
  MOUSE_DOWN="$PT"; sleep 0.12; release_mouse
  log_event action "tap_$1" "\"x\":$X,\"y\":$Y"
  park_mouse
}
a_tab() {  # <map|latency>: the tab row sits lower under the SAFE STOP card
  # sim: the monitor may lag the card (CPU hog), so tap both rows; a miss lands on the
  # card or map, which ignore taps.
  if [[ "$PHONE_MODE" == sim ]]; then a_tap "tab_$1" && a_tap "tab_$1_stop"; return; fi
  if [[ $DRYRUN -eq 0 && "$(mon_field mode)" != ARMED ]]; then a_tap "tab_$1_stop"; else a_tap "tab_$1"; fi
}
LINKLOSS_ON=0
a_linkloss() {  # <on|off>
  a_tap linkloss || return 1
  if [[ "$1" == on ]]; then LINKLOSS_ON=1; else LINKLOSS_ON=0; fi
}
recover_linkloss() {  # an aborted take must not leave "Simulate link loss" on for the next one
  [[ $LINKLOSS_ON -eq 1 && $STOP_REQ -eq 0 ]] || return 0
  local saved="$AUTO_ABORT"
  AUTO_ABORT=""; PARK=""
  a_linkloss off && log_event action linkloss_recovered
  AUTO_ABORT="$saved"
}
a_rearm() {  # press and hold RE-ARM (app needs 1 s)
  auto_ok || return 1
  activate_mirror
  tgt_pt rearm || return 1
  # Mirroring drops a press that arrives together with the pointer jump: move, settle, then press.
  cc "m:$PT" && sleep 0.3
  cc "dd:$PT" || { auto_fail "cliclick dd: failed (Accessibility?)"; return 1; }
  MOUSE_DOWN="$PT"
  log_event action rearm_hold "\"x\":$X,\"y\":$Y"
  sleep 1.8
  release_mouse
  log_event action rearm_release
  park_mouse
}
ensure_armed() {
  [[ $DRYRUN -eq 0 && "$(mon_field mode)" == ARMED ]] && return 0
  a_rearm && wait_field mode ARMED 5
}
# Joystick paths: "dx dy seconds" per leg, in joystick radii (y down: -1 = full forward;
# -x = turn left). Each leg ramps in over 0.3 s, then holds with a 1 pt wiggle every 0.1 s.
drive_path() {
  case "$1" in
    loop) echo "0 -1 2.0;-0.55 -0.85 3.0;0 -1 1.5;0.55 -0.85 3.0;0 -1 1.0" ;;
    long) echo "0 -1 2.0;-0.55 -0.85 3.0;0 -1 2.0;0.55 -0.85 3.0;0 -1 3.0" ;;
    short) echo "0 -1 1.5;-0.5 -0.85 2.0" ;;
    arc) echo "0 -1 1.0;0.5 -0.85 2.5" ;;
  esac
}
a_drive() {  # <path> [tick hook]: drag the joystick; runs <hook> once at <tick> (0.1 s ticks)
  local path="$1" hook_tick="${2:--1}" hook="${3:-}" r pts x y n=0 last
  auto_ok || return 1
  activate_mirror
  tgt_pt joystick || return 1
  r="$(perl -e '@r = split /,/, $ARGV[0]; printf "%d", $ARGV[1] * $r[2]' "$AUTO_RECT" "$JOY_R")"
  pts="$(perl -e '
    my ($cx, $cy, $r, $path) = @ARGV; my ($px, $py) = (0, 0);
    for my $leg (split /;/, $path) {
      my ($dx, $dy, $s) = split " ", $leg;
      for my $i (1 .. 3) { my $f = $i / 3; printf "%d %d\n", $cx + ($px + ($dx - $px) * $f) * $r, $cy + ($py + ($dy - $py) * $f) * $r }
      for my $i (1 .. int($s * 10) - 3) { printf "%d %d\n", $cx + $dx * $r + ($i % 2 ? 1 : -1), $cy + $dy * $r }
      ($px, $py) = ($dx, $dy);
    }
    for my $i (1 .. 2) { my $f = 1 - $i / 2; printf "%d %d\n", $cx + $px * $f * $r, $cy + $py * $f * $r }
  ' "$X" "$Y" "$r" "$(drive_path "$path")")"
  cc "m:$PT" && sleep 0.3  # same as a_rearm: settle the pointer before pressing
  cc "dd:$PT" || { auto_fail "cliclick dd: failed (Accessibility?)"; return 1; }
  MOUSE_DOWN="$PT"; last="$PT"
  log_event action "drive_$path" "\"radius_pt\":$r"
  while read -r x y; do
    [[ $n -eq $hook_tick && -n "$hook" ]] && "$hook"
    in_win "$x" "$y" || { auto_fail "joystick drag point ($x,$y) left the window"; return 1; }
    [[ $STOP_REQ -eq 1 ]] && { auto_fail "stopped by user (Ctrl-C)"; return 1; }
    if [[ $((n % 10)) -eq 9 ]]; then
      auto_rect_same || return 1
      if [[ $DRYRUN -eq 0 ]] && ! near "$(mouse_pos)" "$last"; then auto_fail "mouse moved by hand"; return 1; fi
    fi
    last="$(cpt "$x" "$y")"
    cc "dm:$last" || { auto_fail "cliclick dm: failed"; return 1; }
    MOUSE_DOWN="$last"
    n=$((n + 1))
    sleep 0.1
  done <<< "$pts"
  release_mouse
  log_event action "drive_${path}_end"
  park_mouse
}
auto_rect_same() {
  local r
  r="$(auto_win)" || { auto_fail "$(host_app) window is gone"; return 1; }
  [[ "$r" == "$AUTO_WIN" ]] || { auto_fail "$(host_app) window moved or resized ($AUTO_WIN -> $r)"; return 1; }
}

SLAY_PID=""
slay_hook() {  # segment e: kill simplant while the joystick is held
  local mode
  mode="$(mon_field mode)"
  if [[ $DRYRUN -eq 1 ]]; then say "  [dry-run] tools/fault/slay-plant.sh 15"; log_event action slay_dryrun; return 0; fi
  if [[ "$mode" != ARMED ]]; then warn "mode is ${mode:-unknown}, not ARMED: slay skipped"; log_event action slay_skipped; return 0; fi
  log_event action slay_simplant "\"mode_before\":$(jstr "$mode")"
  "$REPO_DIR/tools/fault/slay-plant.sh" 15 > "$TMPD/slay.out" 2>&1 &
  SLAY_PID=$!
}

# a: host + token are saved in the app (AsyncStorage), so nothing is typed here.
auto_a() {
  a_tap exit && wait_hb above 1000 6 && pause 2.5 && a_tap connect && wait_hb below 500 10 && pause 3
}
auto_b() { ensure_armed && a_drive loop; }
auto_c() {
  ensure_armed && a_drive short && a_linkloss on && wait_field mode SAFE_STOP 3 && pause 3 \
    && a_linkloss off && pause 1 && a_rearm && wait_field mode ARMED 5 && a_drive arc
}
auto_d() {
  ensure_armed && a_drive short && a_tap estop && wait_field mode SAFE_STOP 2 && pause 3 \
    && a_rearm && wait_field mode ARMED 5 && a_drive arc
}
auto_e() {
  local out
  SLAY_PID=""
  ensure_armed || return 1
  a_drive long $((SLAY_DELAY * 10)) slay_hook
  if [[ -n "$SLAY_PID" ]]; then
    wait "$SLAY_PID"; out="$(cat "$TMPD/slay.out")"; SLAY_PID=""
    say "  $out"
    log_event action plant_restart_result "\"output\":$(jstr "$out")"
  fi
  [[ -z "$AUTO_ABORT" ]] && wait_field plant_ok 1 15 && pause 1.5 && a_rearm && wait_field mode ARMED 5 && a_drive arc
}
# The prio 10 hog also slows the ssh monitor of /dev/teleop (seconds, not the 150 ms
# detection itself), hence the longer waits here.
auto_f() {
  ensure_armed && a_drive short && pause 1 && a_linkloss on && wait_field mode SAFE_STOP 10 && pause 1.5 \
    && a_linkloss off && pause 1 && a_rearm && wait_field mode ARMED 10 && a_drive arc \
    && a_tab latency && pause 6 && a_tab map
}

calibrate() {
  local t fx fy r p x y lines="" first=1
  command -v cliclick > /dev/null || die "cliclick missing: brew install cliclick"
  ax_trusted || warn "no Accessibility permission yet ($AX_HINT)"
  AUTO_RECT="$(auto_rect)" || die "$(host_app) window / device screen not found (open it first)"
  bold "Calibrate (window $AUTO_RECT, saves $CALIB)"
  say "  Show the Teleop screen on the iPhone. Point the mouse at each control (do not click),"
  say "  keep this terminal focused and press Enter. s = keep the current value."
  for t in $CALIB_TARGETS; do
    read -r fx fy <<< "$(calib_get "$t")"
    r="$(ask_enter "  $t: $(calib_desc "$t") [now $fx,$fy] Enter = save, s = keep: ")"
    if [[ "$r" != [sS]* ]]; then
      p="$(mouse_pos)"; x="${p%,*}"; y="${p#*,}"
      if [[ "$x" =~ ^-?[0-9]+$ && "$y" =~ ^-?[0-9]+$ ]] && in_win "$x" "$y"; then
        read -r fx fy <<< "$(perl -e '($x, $y, $w, $h) = split /,/, $ARGV[0]; printf "%.4f %.4f", ($ARGV[1] - $x) / $w, ($ARGV[2] - $y) / $h' "$AUTO_RECT" "$x" "$y")"
        ok "$t = $fx,$fy"
      else
        warn "mouse at ${p:-?} is outside the iPhone Mirroring window, keeping $fx,$fy"
      fi
    fi
    [[ $first -eq 1 ]] || lines="$lines,"$'\n'
    lines="$lines    \"$t\": [$fx, $fy]"; first=0
  done
  printf '{\n  "window": %s,\n  "saved": %s,\n  "targets": {\n%s\n  }\n}\n' \
    "$(jstr "$AUTO_RECT")" "$(jstr "$(date -u +%Y-%m-%dT%H:%M:%SZ)")" "$lines" > "$CALIB"
  ok "saved $CALIB"
}

record_segment() {
  local s="$1" base pr tr r use_auto hb
  base="$(seg_file "$s")"
  printf '\n'
  bold "=== [$s] $base: $(seg_title "$s")"
  instructions "$s"
  if [[ "$s" != g ]]; then
    if [[ "$PHONE_MODE" == sim ]]; then
      pr="$(phone_rect)" || { warn "no booted iOS Simulator"; return 1; }
    else
      pr="$(phone_rect)" || { warn "iPhone Mirroring window not found; open it (or set DEMO_PHONE_RECT / --phone full)"; return 1; }
    fi
  fi
  tr=""
  if [[ "$s" == g || "$s" == e ]] && [[ "$TERM_MODE" != off ]]; then
    tr="$(term_rect)" || { warn "terminal window not found (use --term full or DEMO_TERM_RECT)"; [[ "$s" == g ]] && return 1; tr=""; }
  fi
  [[ "$s" == g && "$TERM_MODE" == off ]] && { warn "segment g needs a terminal capture (--term window|full)"; return 1; }
  use_auto=0
  TAKE_FAILED=0
  [[ $AUTO -eq 1 && "$s" != g ]] && use_auto=1
  if [[ $use_auto -eq 1 ]]; then
    AUTO_WIN="$(auto_win)" || { warn "$(host_app) window not found (needed for --auto)"; return 1; }
    AUTO_RECT="$(auto_rect)" || { warn "device screen in $(host_app) not found (needed for --auto)"; return 1; }
    hb="$(teleop_field hb_age_ms)"
    if [[ ! "$hb" =~ ^[0-9]+$ || "$hb" -gt 1000 ]]; then
      warn "the app does not send heartbeats (hb_age_ms=${hb:-?}): connect it first (Teleop screen)"
      [[ $DRYRUN -eq 1 ]] || return 1
    fi
    say "  --auto: the script clicks and drags in the $(host_app) window ($AUTO_RECT)."
    say "  Show the Teleop screen (Map tab, link loss OFF). Hands off the mouse: moving it aborts;"
    say "  Ctrl-C in this terminal also aborts."
  fi
  r="$(ask_enter "  Enter = start recording, s = skip: ")"
  [[ "$r" == [sS]* ]] && return 0
  [[ -n "$tr" ]] && clear
  if [[ $use_auto -eq 1 ]]; then
    MOUSE_HOME="$(mouse_pos)"; PARK=""; AUTO_ABORT=""; MOUSE_DOWN=""
  fi

  SEG_CUR="$s"
  SEG_T0="$(now)"
  log_event segment_start "$base"
  mon_start
  STOP_REQ=0
  RECORDING=1
  if [[ "$s" == g ]]; then
    rec_start "$(next_file "$base")" "$tr" term
  else
    rec_start "$(next_file "$base")" "$pr" phone
    [[ -n "$tr" ]] && rec_start "$(next_file "$base-term")" "$tr" term
  fi
  if [[ "$s" == f ]]; then
    if "$REPO_DIR/tools/fault/cpu-hog.sh" 10 "$HOG_SECS" "$HOG_POLICY" > /dev/null; then
      log_event action hog_start "\"prio\":10,\"policy\":$(jstr "$HOG_POLICY"),\"seconds\":$HOG_SECS"
    else
      warn "cpu-hog.sh failed"
    fi
  fi
  if [[ $use_auto -eq 1 ]]; then
    bold ">>> RECORDING (auto) - hands off the mouse; moving it or Ctrl-C aborts"
    log_event auto_start "$s"
    sleep 1  # the first frame lags the start of screencapture
    "auto_$s"
    recover_linkloss
    release_mouse
    [[ -n "$PARK" ]] && park_mouse
    focus_terminal
    if [[ -z "$AUTO_ABORT" ]]; then
      log_event auto_done "$s"
      sleep 2
    else
      TAKE_FAILED=1
      log_event auto_failed "$s" "\"reason\":$(jstr "$AUTO_ABORT")"
      [[ $STOP_REQ -eq 0 ]] && wait_stop
    fi
  else
    case "$s" in
      e) bold ">>> RECORDING - ARM and drive now"; run_slay; say "  Now hold RE-ARM and drive again." ;;
      g) run_proof ;;
    esac
    wait_stop
  fi
  RECORDING=0
  rec_stop_all
  mon_stop
  failsafe
  log_event segment_stop "$base"
  SEG_CUR=""
  SEG_T0=""
}

mkdir -p "$OUT" || die "cannot create $OUT"
if [[ $CALIBRATE -eq 1 ]]; then calibrate; exit 0; fi
if [[ $AUTO -eq 1 && $DRYRUN -eq 0 ]] && ! command -v cliclick > /dev/null; then
  die "--auto needs cliclick: brew install cliclick"
fi
if ! preflight; then
  [[ $CHECK_ONLY -eq 1 ]] && exit 1
  r="$(ask_enter "Preflight has warnings. Continue anyway? [y/N] ")"
  [[ "$r" == [yY]* ]] || exit 1
fi
[[ $CHECK_ONLY -eq 1 ]] && exit 0

SESSION_STARTED=1
log_event session_start "$SESSION" "\"segments\":$(jstr "$SEGMENTS"),\"phone\":$(jstr "$PHONE_MODE"),\"term\":$(jstr "$TERM_MODE")"
say "Output: $OUT   (log: $JSON)"
reject_take() {  # unattended: keep the failed take out of the clip names Remotion uses
  local f
  mkdir -p "$OUT/rejected" || return 1
  while IFS= read -r f; do
    [[ -n "$f" && -e "$f" ]] || continue
    mv "$f" "$OUT/rejected/$SESSION-$(basename "$f")" && log_event take_rejected "$(basename "$f")"
  done <<< "$LAST_FILES"
  LAST_FILES=""
}
for s in $SEGMENTS; do
  tries=0
  while :; do
    tries=$((tries + 1))
    if [[ $UNATTENDED -eq 1 ]]; then
      if ! record_segment "$s"; then
        [[ $tries -le $RETAKES ]] && { warn "segment $s could not start, retrying in 3 s"; sleep 3; continue; }
        warn "segment $s skipped: could not start"; log_event segment_skipped "$s"; break
      fi
      if [[ $TAKE_FAILED -eq 1 ]]; then
        reject_take
        [[ $tries -le $RETAKES ]] && { warn "segment $s take failed, retake $tries/$RETAKES"; sleep 3; continue; }
        warn "segment $s failed after $RETAKES retakes"; log_event segment_failed "$s"
      fi
      break
    fi
    record_segment "$s" || { r="$(ask_enter "  Segment $s could not start. Enter = retry, s = skip, q = quit: ")"
                             case "$r" in [qQ]*) exit 0 ;; [sS]*) break ;; *) continue ;; esac; }
    r="$(ask_enter "  Enter = next segment, r = retake, q = quit: ")"
    case "$r" in [rR]*) continue ;; [qQ]*) exit 0 ;; *) break ;; esac
  done
done
log_event session_end "$SESSION"
bold "Done. Clips and shots.json in $OUT"
