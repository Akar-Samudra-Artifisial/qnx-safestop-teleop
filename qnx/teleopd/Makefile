# QNX SDP 8.0 aarch64le.
# Requires: source <qnxsdp-env.sh> so qcc and QNX_TARGET are available.
CC      = qcc
TARGET  = -Vgcc_ntoaarch64le
CFLAGS  = $(TARGET) -Wall -Wextra -O2 -I../common
LDFLAGS = $(TARGET)
LDLIBS  = -lm -lsocket -lslog2

vpath %.c ../common

BIN  = teleopd
SRCS = teleopd.c ws.c json.c
OBJS = $(SRCS:.c=.o)

all: $(BIN)

$(BIN): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $^ $(LDLIBS)

%.o: %.c ../common/ws.h ../common/json.h ../common/proto.h ../common/teleop_dcmd.h
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJS) $(BIN)

.PHONY: all clean
