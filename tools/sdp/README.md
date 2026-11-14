# QNX SDP 8.0 host tools di Mac Apple Silicon (container linux/amd64)

SDP 8.0 host tools hanya tersedia untuk Linux/Windows, jadi dijalankan di container
Ubuntu 24.04 `linux/amd64` di atas VM colima profil `qnx`.

- VM: colima `qnx` — VZ, aarch64, 4 CPU, 8 GiB RAM, disk 60 GiB, runtime docker
  (docker context `colima-qnx`). VZ tidak bisa membuat VM x86_64; binary amd64 di
  container dijalankan lewat emulasi binfmt (Rosetta bila tersedia, kalau tidak qemu-user).
- Persistensi: `~/qnx` (host) → `/root/qnx` (QSC, SDP, installer) dan
  `~/qnx/.dotqnx` → `/root/.qnx` (konfigurasi QSC & license key).
- Repo → `/work`.

## 1. Start VM

```sh
colima start -p qnx          # profil sudah dibuat; pertama kali:
# colima start -p qnx --arch aarch64 --vm-type vz --vz-rosetta --cpu 4 --memory 8 --disk 60 --runtime docker
```

Opsional (lebih cepat dari qemu-user): pasang Rosetta di macOS lalu restart profil:
`softwareupdate --install-rosetta --agree-to-license && colima restart -p qnx`.
Cek: `colima ssh -p qnx -- ls /proc/sys/fs/binfmt_misc/` memuat `rosetta`.

## 2. Build image & masuk shell

```sh
cd tools/sdp
./run.sh build      # build image qnx-sdp-host:latest
./run.sh            # shell interaktif; ./run.sh <cmd> untuk satu perintah
```

## 3. Install QSC + login + SDP 8.0 (sekali jalan)

Simpan `qnx-setup-<versi>-linux.run` (unduh dari myQNX) di `~/qnx/`, lalu:

```sh
./run.sh /work/tools/sdp/install-qsc.sh
```

**Menjalankan skrip ini berarti menyetujui EULA QNX Software Center** (installer
dipanggil dengan `--agree`). Baca dulu bila perlu:
`./run.sh bash -c '/root/qnx/qnx-setup-*-linux.run --noexec --nox11 --target /tmp/e && less /tmp/e/qnxsoftwarecenter/license.txt'`.

Isi skrip:

1. Installer (Makeself; opsi skrip disalurkan setelah `--`):
   `qnx-setup-*.run --nox11 -- --target /root/qnx --agree --disable-auto-start`
   → QSC di `/root/qnx/qnxsoftwarecenter`.
2. Username & password myQNX diminta interaktif (password tersembunyi), ditulis ke file
   sementara chmod 600 di `/tmp` container dengan format `options_file` QNX
   (`-myqnx.user` / user / `-myqnx.password` / password per baris), dipakai sebagai
   `@file`, lalu dihapus. Tidak masuk history/argv/volume host.
3. `qnxsoftwarecenter_clt -syncLicenseKeys @opts` lalu `-listLicenseKeys`.
4. Aktivasi license key: key diambil dari env `QNX_LICENSE_KEY` atau diminta interaktif
   (tersembunyi), lalu `-addLicenseKey <key>` (= `-activateLicenseKey` di pesan error) + kredensial
   lewat satu options file chmod 600. Input kosong → `-activateAll` (key hasil sync).
   Dilewati bila `/root/.qnx/license` sudah berisi (paksa ulang: `QNX_FORCE_ACTIVATE=1`).
5. `-mirrorBaseline qnx800`, lalu `-installBaseline com.qnx.qnx800 -destination /root/qnx/qnx800`
   (dilewati bila `qnxsdp-env.sh` sudah ada).
6. Mencetak `-listQuery` untuk `qemuvirt`, `virtio`, `openSSH` (kirim output ini bila langkah 7 gagal).
7. `-installPackage <id,id,...> -destination /root/qnx/qnx800` untuk `QNX_EXTRA_PACKAGES`.
   ID yang ada dipasang; yang tidak ditemukan dilaporkan (exit 2), tidak menggagalkan yang lain.

Default `QNX_EXTRA_PACKAGES` (ID terverifikasi dari metadata server-cache qnx800):

| Paket | Fungsi |
| --- | --- |
| `com.qnx.qnx800.target.qemuvirt` | BSP/startup board QEMU `virt` aarch64 |
| `com.qnx.qnx800.target.driver.virtio.devb` | `devb-virtio` (disk blok) |
| `com.qnx.qnx800.target.driver.virtio.startup` | dukungan virtio di startup (aarch64 virt) |
| `com.qnx.qnx800.target.net.openSSH` | `sshd`, `sshd-auth`, `sshd-session` (sudah ikut baseline) |

Tidak ada paket `sshd-auth`; binary `sshd-auth` berasal dari `net.openSSH`.
ID lain: `./run.sh env QNX_EXTRA_PACKAGES=<id1>,<id2> /work/tools/sdp/install-qsc.sh`
(langkah yang sudah selesai dilewati).

Referensi flag: `qnxsoftwarecenter_clt -help` (QSC 2.0.4); format `@options_file`
dari QNX Everywhere CTI guide (qnx.com/developers/docs/qnxeverywhere, "Getting started").

## 4. Pakai SDP

Image QEMU aarch64le (idempoten; `QNX_IMAGE_CLEAN=1` memaksa `--clean`):

```sh
./run.sh /work/tools/sdp/make-image.sh
```

Isi: `mkqnximage --noprompt --force --type=qemu --arch=aarch64le --hostname=safestop
--ip=dhcp --ssh-ident=<key proyek>.pub --sshd-pregen=yes --cpu=2 --ram=1G` di
`build/qnx-image/` → `output/ifs.bin`, `output/disk-qemu.vmdk`. Key SSH khusus proyek
dibuat sekali di `build/qnx-image/ssh/id_ed25519` (git-ignored, bukan key pribadi).
QEMU dijalankan di Mac, bukan di container: lihat `tools/qemu/README.md`.

Cross-build hello-world:

```sh
./run.sh bash -c 'mkdir -p /work/build/hello && \
  qcc -Vgcc_ntoaarch64le -Wall -O2 -o /work/build/hello/hello /work/tools/hello/hello.c'
```

`run.sh` otomatis men-source `/root/qnx/qnx800/qnxsdp-env.sh` (bila SDP sudah terpasang)
sebelum menjalankan perintah, jadi `tools/sdp/run.sh make -C qnx` langsung jalan dari root repo.
