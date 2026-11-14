# QNX SDP 8.0 aarch64le. Requires qnxsdp-env.sh (tools/sdp/run.sh sources it).
CC      = qcc
TARGET  = -Vgcc_ntoaarch64le
CFLAGS  = $(TARGET) -Wall -Wextra -O2
LDFLAGS = $(TARGET)
LDLIBS  = -lham

BIN  = hamreg
SRCS = $(wildcard *.c)
OBJS = $(SRCS:.c=.o)

all: $(BIN)

$(BIN): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $^ $(LDLIBS)

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJS) $(BIN)

.PHONY: all clean
