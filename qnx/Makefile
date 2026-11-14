# Build all QNX packages: tools/sdp/run.sh make -C qnx (run.sh sources qnxsdp-env.sh).
# latbench is not listed until it has sources.
SUBDIRS = teleopd simplant

all clean:
	@for d in $(SUBDIRS); do $(MAKE) -C $$d $@ || exit 1; done

.PHONY: all clean
