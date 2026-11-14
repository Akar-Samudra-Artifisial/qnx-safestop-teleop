# Linux x86-64 host environment for QNX Software Center (QSC) + SDP 8.0 host tools.
# Build/run with --platform linux/amd64 (see run.sh).
FROM --platform=linux/amd64 ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# QSC bundles its own JRE; GTK/X libs + Xvfb are only for the optional GUI/headless display.
# QEMU (aarch64) is for booting images built with mkqnximage --type=qemu --arch=aarch64le.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget unzip zip xz-utils bzip2 file cpio rsync \
        make git python3 python3-pip openssh-client sudo less vim-tiny \
        libgtk-3-0t64 libxtst6 libxrender1 libxi6 libnss3 libasound2t64 \
        libwebkit2gtk-4.1-0 xvfb xauth fontconfig fonts-dejavu-core \
        qemu-system-arm qemu-utils iproute2 iputils-ping netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
CMD ["/bin/bash", "-l"]
