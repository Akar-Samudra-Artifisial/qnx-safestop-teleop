# Build all QNX packages: tools/sdp/run.sh make -C qnx (run.sh sources qnxsdp-env.sh).
SUBDIRS = teleopd simplant teleopctl latbench hamreg

all clean:
	@for d in $(SUBDIRS); do $(MAKE) -C $$d $@ || exit 1; done

.PHONY: all clean
