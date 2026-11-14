# QEMU: QNX 8.0 aarch64le di Mac

Image dibangun di container SDP (`tools/sdp/run.sh /work/tools/sdp/make-image.sh`),
lalu dijalankan native di Mac dengan `qemu-system-aarch64` (Homebrew).

```sh
tools/qemu/run-qemu.sh                                   # serial di terminal (Ctrl-a x keluar)
QEMU_SERIAL=build/qnx-image/serial.log \
  tools/qemu/run-qemu.sh -pidfile build/qnx-image/qemu.pid &   # background, log ke file
kill "$(cat build/qnx-image/qemu.pid)"                  # matikan
```

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
`QEMU_SSH_PORT=2223 QEMU_TELEOP_PORT=8081 tools/qemu/run-qemu.sh`, lalu
`QNX_SSH_PORT=2223 tools/qemu/deploy.sh` dan `wsclient.py --port 8081`.

## hvf belum bisa (2026-11-14, QEMU 11.1.3)

Dengan `-accel hvf -cpu host`, startup QNX berhenti di:
`gic_v3.c:966 -- ASSERT((use_memory_mapped_callouts == 0) || (gicc_paddr_base != ...)) failed!`.
HVF hanya mendukung GICv3 (`gic-version=2` → "HVF does not support GICv2 emulation"),
dan `kernel-irqchip=on|off`, `its=off`, `highmem=off` tidak mengubah hasil. TCG dengan
GICv2/GICv3 (cortex-a57, neoverse-n1) boot normal, jadi masalahnya spesifik kombinasi
HVF + `startup-qemu-virt`. TCG cukup cepat: "Startup complete" ±2,4 dtk, SSH siap ±9 dtk.
