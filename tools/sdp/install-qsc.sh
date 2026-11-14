#!/usr/bin/env bash
# Install QNX Software Center (QSC) + QNX SDP 8.0 + QEMU aarch64 packages, unattended.
# Run INSIDE the container:  ./run.sh /work/tools/sdp/install-qsc.sh
#
# !! RUNNING THIS SCRIPT MEANS YOU ACCEPT THE QNX SOFTWARE CENTER EULA !!
#    (license.txt inside the installer; the installer is run with --agree).
#    Read it first:  <installer>.run --noexec --target /tmp/qsc-eula && less /tmp/qsc-eula/qnxsoftwarecenter/license.txt
#
# myQNX credentials are read interactively (password hidden) and written only to a
# chmod-600 temp file inside the container, passed to qnxsoftwarecenter_clt as
# "@options_file" (format documented by QNX), and deleted on exit. Nothing goes to
# shell history, argv, or the host volume.
set -euo pipefail

QNX_ROOT="${QNX_ROOT:-/root/qnx}"
INSTALLER="${QSC_INSTALLER:-$(ls -1 "$QNX_ROOT"/qnx-setup-*-linux.run 2>/dev/null | sort | tail -n1)}"
QSC_DIR="$QNX_ROOT/qnxsoftwarecenter"
CLT="$QSC_DIR/qnxsoftwarecenter_clt"
SDP_DIR="${SDP_DIR:-$QNX_ROOT/qnx800}"
SDP_BASELINE="${SDP_BASELINE:-com.qnx.qnx800}"
# IDs verified in the qnx800 server-cache content.xml. sshd/sshd-auth/sshd-session come
# from com.qnx.qnx800.target.net.openSSH, which the SDP baseline already installs.
# driver.virtio.startup is needed for mkqnximage --arch=aarch64le on the QEMU virt board.
# os_services.ham = High Availability Manager (ham, libham, <ha/ham.h>) for simplant restart.
QNX_EXTRA_PACKAGES="${QNX_EXTRA_PACKAGES:-com.qnx.qnx800.target.qemuvirt,com.qnx.qnx800.target.driver.virtio.devb,com.qnx.qnx800.target.driver.virtio.startup,com.qnx.qnx800.target.net.openSSH,com.qnx.qnx800.target.os_services.ham}"

die() { echo "Error: $*" >&2; exit 1; }

# 1. QSC installer
if [[ -x "$CLT" ]]; then
  echo "QSC already installed at $QSC_DIR, skipping installer (EULA step not repeated)."
else
  [[ -n "$INSTALLER" && -f "$INSTALLER" ]] || die "installer qnx-setup-*-linux.run not found in $QNX_ROOT"
  chmod +x "$INSTALLER"
  # --agree = accept the QSC EULA (see header). Target dir gets /qnxsoftwarecenter appended.
  "$INSTALLER" --nox11 -- --target "$QNX_ROOT" --agree --disable-auto-start
  [[ -x "$CLT" ]] || die "installer finished but $CLT is missing"
fi

# 2. myQNX credentials -> temporary options file
OPTS="$(mktemp /tmp/qsc-options.XXXXXX)"
KEYOPTS="$(mktemp /tmp/qsc-key.XXXXXX)"
chmod 600 "$OPTS" "$KEYOPTS"
trap 'rm -f "$OPTS" "$KEYOPTS"' EXIT
read -rp "myQNX username (email): " MYQNX_USER
read -rsp "myQNX password: " MYQNX_PASS; echo
[[ -n "$MYQNX_USER" && -n "$MYQNX_PASS" ]] || die "username and password are required"
printf -- '-myqnx.user\n%s\n-myqnx.password\n%s\n' "$MYQNX_USER" "$MYQNX_PASS" > "$OPTS"
unset MYQNX_PASS

clt() { "$CLT" "$@" "@$OPTS"; }

# 3. Login check + license keys from the myQNX account
clt -syncLicenseKeys
clt -listLicenseKeys

# 3b. Activate the license key (remote activation needs -myqnx.user, hence @OPTS).
# -addLicenseKey (help: "activate license key"); the install error's -activateLicenseKey is registered alongside it in LicenseHandler.
# QSC writes activated licenses to ~/.qnx/license; non-empty = already activated.
LICENSE_DIR="${QNX_LICENSE_DIR:-$HOME/.qnx/license}"
if [[ "${QNX_FORCE_ACTIVATE:-0}" != "1" && -n "$(ls -A "$LICENSE_DIR" 2>/dev/null)" ]]; then
  echo "License already activated ($LICENSE_DIR not empty), skipping. QNX_FORCE_ACTIVATE=1 to redo."
else
  KEY="${QNX_LICENSE_KEY:-}"
  if [[ -z "$KEY" ]]; then
    read -rsp "QNX SDP 8.0 license key (input hidden; empty = -activateAll for synced keys): " KEY; echo
  fi
  if [[ -n "$KEY" ]]; then
    # Key + credentials go through one chmod-600 options file, not argv.
    { printf -- '-addLicenseKey\n%s\n' "$KEY"; cat "$OPTS"; } > "$KEYOPTS"
    unset KEY QNX_LICENSE_KEY
    "$CLT" "@$KEYOPTS"
    rm -f "$KEYOPTS"
  else
    clt -activateAll
  fi
  clt -listLicenseKeys
fi

# 4. SDP 8.0 baseline
clt -mirrorBaseline qnx800
if [[ -f "$SDP_DIR/qnxsdp-env.sh" ]]; then
  echo "SDP already installed in $SDP_DIR, skipping baseline install."
else
  clt -installBaseline "$SDP_BASELINE" -destination "$SDP_DIR"
  [[ -f "$SDP_DIR/qnxsdp-env.sh" ]] || die "baseline install did not produce $SDP_DIR/qnxsdp-env.sh"
fi

# 5. Show candidate package IDs (send this output if the next step fails)
for kw in qemuvirt virtio openSSH; do
  echo "=== -listQuery $kw"
  clt -listQuery "$kw" || echo "(listQuery $kw failed)"
done

# 6. Extra packages: install every ID that exists, report the ones that don't.
IFS=',' read -ra pkgs <<< "$QNX_EXTRA_PACKAGES"
found=(); missing=()
for p in "${pkgs[@]}"; do
  if clt -listQuery "$p" | grep -qF "$p"; then found+=("$p"); else missing+=("$p"); fi
done
if (( ${#found[@]} )); then
  found_csv="$(IFS=','; echo "${found[*]}")"
  clt -destination "$SDP_DIR" -installPackage "$found_csv"
fi
clt -destination "$SDP_DIR" -listInstalledRoots

if (( ${#missing[@]} )); then
  echo "WARNING: package ID(s) not found, not installed: ${missing[*]}" >&2
  echo "  Check the IDs in the -listQuery output above, rerun with QNX_EXTRA_PACKAGES=<id1,id2,...>" >&2
  exit 2
fi
echo "Done. Use: source $SDP_DIR/qnxsdp-env.sh"
