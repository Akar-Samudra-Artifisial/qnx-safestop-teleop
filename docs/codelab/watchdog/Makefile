# QNX SDP 8.0 aarch64le. Requires: source qnxsdp-env.sh (qcc, QNX_TARGET).
CC      = qcc
TARGET  = -Vgcc_ntoaarch64le
CFLAGS  = $(TARGET) -Wall -Wextra -O2

all: watchdog

watchdog: watchdog.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f watchdog

.PHONY: all clean
