# demo

`record.sh` records the footage for the demo video (shot list in
[docs/SUBMISSION_DRAFT.md](../../docs/SUBMISSION_DRAFT.md)): the iPhone app through the
iPhone Mirroring window, plus terminal shots, one `.mov` per segment, for editing in Remotion.

## Prerequisites

- macOS 15+ with iPhone Mirroring; Mac and iPhone signed in to the same Apple Account.
- System Settings → Privacy & Security → **Screen Recording**: allow your terminal app
  (without it the clips are empty or show only the wallpaper).
- System Settings → Privacy & Security → **Accessibility**: allow your terminal app, so the
  script can read the iPhone Mirroring / terminal window position (or set `DEMO_PHONE_RECT`).
- QEMU target running with teleopd, simplant and HAM in `/data`
  (`QNX_DEST=/data TELEOP_TOKEN=... tools/qemu/deploy.sh`, see [tools/qemu](../qemu/README.md)).
- Metro running (`cd app && npm start`) and the app open on the iPhone.
- Optional: `ffprobe` (Homebrew `ffmpeg`) to print the duration of each saved clip.
- For `--auto` / `--calibrate`: `brew install cliclick`, and the Accessibility permission
  above (cliclick posts mouse events as your terminal app).

## Steps

```sh
tools/demo/record.sh --check   # preflight only: QEMU, 8080, teleopd, HAM, Metro, windows
tools/demo/record.sh           # all segments a..g in order
tools/demo/record.sh e         # one segment (letter a..g or number 1..7)
tools/demo/record.sh list      # segment list
```

For each segment the script prints what to do on the iPhone, then: Enter starts recording,
Enter or Ctrl-C stops it. After each segment: Enter = next, `r` = retake, `q` = quit.
Recording starts about 1 s after Enter, so wait a moment before acting.

| Seg | File | Shot |
|---|---|---|
| a | `01-connect` | Connect + token (type host and token **before** recording starts) |
| b | `02-arm-drive` | RE-ARM, drive, trail on the map |
| c | `03-link-loss` | Simulate link loss → SAFE STOP `hb_timeout` → RE-ARM |
| d | `04-estop` | E-STOP |
| e | `05-plant-restart` (+ `-term`) | script slays simplant after a countdown while ARMED → `plant_lost`, PLANT DOWN → HAM restart → RE-ARM |
| f | `06-cpu-hog` | latbench hog prio 10 RR while driving, Latency tab |
| g | `07-qnx-proof` | terminal: `pidin` (control 50f, net 10r), `cat /dev/teleop`, `teleopctl set-deadline 200` then 150 |

Segment g prints only target output (no token, LAN IP or key path). After every segment a
fail-safe sets the deadline back to 150 ms and stops any latbench hog.

Options: `--phone window|full|sim`, `--yes`, `--term window|full|off` (terminal capture for e and g),
`--out DIR`. Env: `DEMO_PHONE_RECT` / `DEMO_TERM_RECT` (`x,y,w,h` in points),
`DEMO_SLAY_DELAY` (10), `DEMO_HOG_SECS` (90), `DEMO_HOG_POLICY` (`rr`), `DEMO_PAUSE` (3).

## Hands-free: `--auto`

```sh
tools/demo/record.sh --calibrate   # once: point the mouse at each control, press Enter
tools/demo/record.sh --auto b c d e f
DEMO_DRYRUN=1 tools/demo/record.sh --auto c   # print the cliclick commands, click nothing
```

With `--auto`, segments b–f operate the app by clicking and dragging with `cliclick` in the
iPhone Mirroring (or Simulator) window; you only watch. Segment a reconnects with the saved
token, g is always automatic. Before each segment, connect the app and show the Teleop screen (Map tab,
"Simulate link loss" off); the script refuses to start when teleopd sees no heartbeats.

| Seg | Scenario |
|---|---|
| b | hold RE-ARM → drive a loop |
| c | drive → link loss on → wait SAFE STOP → link loss off → RE-ARM → drive |
| d | drive → E-STOP → wait SAFE STOP → RE-ARM → drive |
| e | RE-ARM → drive; simplant is slain during the drive → wait plant OK (HAM) → RE-ARM → drive |
| f | hog prio 10 → drive → link loss trip → RE-ARM → drive → Latency tab → Map |

Targets are fractions of the window (bounds re-read at every segment), so moving the
window between segments is fine. Defaults come from the app layout on a 393×852 pt iPhone;
`--calibrate` stores your own in `~/Movies/qnx-demo/calib.json`. Each step waits for the
expected mode in `/dev/teleop` (over ssh). The joystick drag radius is `DEMO_JOY_R`
(fraction of the window width, 0.11).

Segment a with `--auto`: taps Exit, waits until teleopd sees the heartbeat stop, then taps
Connect; host and token come from what the app saved at the last connect, nothing is typed.

## iOS Simulator + unattended: `--phone sim --yes`

```sh
xcrun simctl boot <udid>               # iPhone 16 (393x852 pt), open it in DeviceHub/Simulator
xcrun simctl openurl booted exp://127.0.0.1:8081   # Expo Go, connect once to 127.0.0.1:8080
DEMO_TARGET=sim tools/demo/record.sh --auto --yes --term off a b c d e f
```

- Clips come from `xcrun simctl io booted recordVideo` (device framebuffer at 1179×2556, no
  window chrome or pointer), sharper than a `screencapture` of the window region.
- Clicks go to the device screen inside the DeviceHub (Xcode 27) or Simulator window, located
  through Accessibility (`DEMO_SIM_RECT=x,y,w,h` overrides); calibration lives in
  `calib-sim.json`. Hide the Expo Go tools button (Expo menu) so it does not cover controls.
- Use host `127.0.0.1:8080` in the app: teleopd accepts the same-host Origin of iOS.
- `--yes` answers every prompt with Enter. A failed `--auto` take is moved to
  `rejected/<session>-<file>` and retaken up to `DEMO_RETAKES` (2) times, then the next
  segment starts. The Mac must stay unlocked (run under `caffeinate -d`).
- Segment g needs a visible terminal: run it separately from a terminal window (`g`).

Safety: clicks never land outside the window. Automation aborts (button released, clip
saved, fail-safe run) on Ctrl-C in the terminal, when you move the mouse, or when the
window disappears, moves or resizes. Every action is logged to `shots.json`.

## Output

`~/Movies/qnx-demo/<NN>-<name>.mov` (retakes: `-take2`, `-take3`, …) and
`~/Movies/qnx-demo/shots.json`: per event `t` (Mac epoch s), `segment`, `offset_s` (seconds
since the recording was launched), `type` (`segment_start`, `rec_start`, `rec_saved`,
`target` mode changes read from `/dev/teleop`, `action` such as `slay_simplant` and
`hog_start`, `failsafe`). Use `offset_s` to place overlays in Remotion; it is approximate
(±1 s), so fine-tune on the visible change.
