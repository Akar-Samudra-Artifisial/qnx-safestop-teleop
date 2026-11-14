# QEMU: QNX 8.0 aarch64le di Mac

Image dibangun di container SDP (`tools/sdp/run.sh /work/tools/sdp/make-image.sh`),
lalu dijalankan native di Mac dengan `qemu-system-aarch64` (Homebrew).

## Autostart: tanpa deploy manual

Image memuat stack di `/data` dan menyalakannya saat boot (`post_startup.sh` →
`/data/teleop-start.sh`): `ham` → `hamreg simplant` → `teleopd -p 8080 -v` (deadline 150 ms).
Build binari dulu, lalu image:

```sh
tools/sdp/run.sh make -C qnx
TELEOP_TOKEN=<token> tools/sdp/run.sh /work/tools/sdp/make-image.sh   # token pilihan sendiri
tools/sdp/run.sh /work/tools/sdp/make-image.sh                       # atau: token acak saat boot
```

Token pairing (tidak pernah di repo):
- `TELEOP_TOKEN` saat build → ditulis ke `/data/teleop.token` (sumber di
  `build/qnx-image/local/misc_files/`, git-ignored). Konsol mencetak
  `Pairing token: as set with TELEOP_TOKEN`.
- Tanpa `TELEOP_TOKEN` → boot pertama membuat 6 digit acak, menyimpannya di
  `/data/teleop.token`, dan mencetak `Pairing token: NNNNNN` di konsol serial setiap boot
  (file dari `QEMU_SERIAL`; di semua contoh di sini `build/qnx-image/serial.log`:
  `grep -a "Pairing token" build/qnx-image/serial.log`).

Setiap build me-reset `/data` (binari terbaru + token). `make-image.sh` memaksa rebuild
(mkqnximage sendiri hanya rebuild bila opsinya berubah) dan mengulang bila `cpp` SDP crash
di bawah emulasi amd64 (pernah menghasilkan `data.build` kosong / login root gagal).

`tools/qemu/deploy.sh` hanya untuk memperbarui binari di VM yang sedang jalan: menyalin ke
`/data/.deploy`, memindahkannya ke `/data`, lalu menjalankan `teleop-start.sh` yang sama
(menghentikan instance lama dulu, jadi tidak ada proses dobel). Tanpa `TELEOP_TOKEN`, token
di target dipertahankan.

```sh
tools/qemu/run-qemu.sh                                   # serial di terminal (Ctrl-a x keluar)
QEMU_SERIAL=build/qnx-image/serial.log \
  tools/qemu/run-qemu.sh -pidfile build/qnx-image/qemu.pid &   # background, log ke file
kill "$(cat build/qnx-image/qemu.pid)"                  # matikan
```

VM yang dijalankan dengan `&`/`nohup` dari shell agen atau IDE bisa ikut mati saat sesi
itu ditutup atau di-restart. Agar terlepas dari terminal, serahkan ke launchd (path absolut,
karena launchd memulai di `/` dengan PATH minimal):

```sh
P=$PWD   # root repo
launchctl submit -l com.qnx.safestop.qemu \
  -o "$P/build/qemu-stdout.log" -e "$P/build/qemu-stderr.log" -- \
  /usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin QEMU_SERIAL="$P/build/qnx-image/serial.log" \
  /bin/bash -c "cd '$P' && exec tools/qemu/run-qemu.sh -pidfile build/qnx-image/qemu.pid"
launchctl remove com.qnx.safestop.qemu                  # matikan (stop + hapus job)
```

`launchctl submit` men-restart job bila prosesnya keluar sendiri; `launchctl remove`
menghentikan VM dan menghapus job. Job hilang saat logout/reboot Mac. VM yang di-boot ulang
oleh launchd langsung menjalankan teleopd (autostart di atas); deploy tidak diperlukan.

Akses (user-mode net, bind `0.0.0.0` supaya HP di LAN bisa ke 8080):

```sh
ssh -i build/qnx-image/ssh/id_ed25519 -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 2222 root@localhost
```

| Host | Guest |
| --- | --- |
| `127.0.0.1:2222` | `22` (sshd, login root dengan key proyek) |
| `0.0.0.0:8080` | `8080` (teleopd WebSocket) |

Argumen mengikuti `mkqnximage` `qemu/runimage` (aarch64): `-kernel output/ifs.bin`,
`virtio-blk-device` **sebelum** `virtio-net-device` (alamat virtio-mmio mengikuti urutan),
`virtio-rng-device`. Bedanya: `-machine virt` (QEMU 11 sudah tidak punya `virt-4.2`),
net user-mode (bukan bridge).

Env: `QEMU_ACCEL` (`tcg` default | `hvf`), `QEMU_MACHINE`, `QEMU_MEM` (1G), `QEMU_SMP` (2),
`QEMU_SERIAL` (`stdio` | path log), `QEMU_HOSTFWD_ADDR` (port 8080, default 0.0.0.0 agar HP di LAN bisa connect), `QEMU_SSH_FWD_ADDR` (port 2222, default 127.0.0.1: SSH root hanya dari Mac ini), `QNX_IMAGE_DIR`,
`QEMU_SSH_PORT` (port host → guest 22, default 2222) dan `QEMU_TELEOP_PORT` (port host → guest 8080,
default 8080) untuk menjalankan VM kedua tanpa bentrok, mis.
`QNX_IMAGE_DIR=build/qnx-image-2 QEMU_SSH_PORT=2223 QEMU_TELEOP_PORT=8082 tools/qemu/run-qemu.sh`
(8081 dipakai Metro), lalu `wsclient.py --port 8082`; deploy ulang dengan
`QNX_IMAGE_DIR=build/qnx-image-2 QNX_SSH_PORT=2223 tools/qemu/deploy.sh`. Image kedua dibangun
dengan `tools/sdp/run.sh env QNX_IMAGE_DIR=/work/build/qnx-image-2 /work/tools/sdp/make-image.sh`.

## hvf belum bisa (2026-11-14, QEMU 11.1.3)

Dengan `-accel hvf -cpu host`, startup QNX berhenti di:
`gic_v3.c:966 -- ASSERT((use_memory_mapped_callouts == 0) || (gicc_paddr_base != ...)) failed!`.
HVF hanya mendukung GICv3 (`gic-version=2` → "HVF does not support GICv2 emulation"),
dan `kernel-irqchip=on|off`, `its=off`, `highmem=off` tidak mengubah hasil. TCG dengan
GICv2/GICv3 (cortex-a57, neoverse-n1) boot normal, jadi masalahnya spesifik kombinasi
HVF + `startup-qemu-virt`. TCG cukup cepat: "Startup complete" ±2,4 dtk, SSH siap ±9 dtk.
