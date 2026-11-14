# QNX SDP 8.0 aarch64le — skeleton, not compiled yet.
# Requires: source <qnxsdp-env.sh> so qcc and QNX_TARGET are available.
CC      = qcc
TARGET  = -Vgcc_ntoaarch64le
CFLAGS  = $(TARGET) -Wall -Wextra -O2 -I../common
LDFLAGS = $(TARGET)
LDLIBS  =

BIN  = latbench
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
