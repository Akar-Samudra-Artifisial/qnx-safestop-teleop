/* /dev/teleop resource manager interface (teleopd), shared with teleopctl.
 *   read            -> status text, "key=value" lines (one read from offset 0)
 *   devctl SET_DEADLINE (int32_t ms, TELEOP_DEADLINE_MIN_MS..MAX) -> EOK / EINVAL
 *   devctl ESTOP    -> forces SAFE_STOP (reason "estop")
 *   devctl RESET_STATS -> empties the detect_us ring (hb_timeouts total is kept)
 * devctls need the node opened for writing (node mode 0640 root:root). */
#ifndef TELEOP_DCMD_H
#define TELEOP_DCMD_H

#include <stdint.h>
#include <devctl.h>

#define TELEOP_DEV_PATH          "/dev/teleop"
#define TELEOP_DEADLINE_MIN_MS   50
#define TELEOP_DEADLINE_MAX_MS   1000

/* dcmd values 0x0000..0x0FFF are reserved for QNX (class < 0x10): use a private class. */
#define TELEOP_DCMD_CLASS        0xE0
#define DCMD_TELEOP_SET_DEADLINE __DIOT(TELEOP_DCMD_CLASS, 0x01, int32_t)
#define DCMD_TELEOP_ESTOP        __DION(TELEOP_DCMD_CLASS, 0x02)
/* Clears the hb_timeout detect_us ring so each bench run starts from n=0. */
#define DCMD_TELEOP_RESET_STATS  __DION(TELEOP_DCMD_CLASS, 0x03)

#endif
