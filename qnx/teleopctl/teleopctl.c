/* teleopctl: command-line client for teleopd's /dev/teleop resource manager.
 *   teleopctl status              print the status text (same as cat /dev/teleop)
 *   teleopctl set-deadline <ms>   DCMD_TELEOP_SET_DEADLINE (50..1000 ms)
 *   teleopctl estop               DCMD_TELEOP_ESTOP
 *   teleopctl reset-stats         DCMD_TELEOP_RESET_STATS (empty the detect_us ring)
 * devctls need write access to the node (0640 root:root -> run as root). */
#include <devctl.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "teleop_dcmd.h"

static int usage(const char *prog)
{
    fprintf(stderr, "usage: %s status | set-deadline <%d..%d ms> | estop | reset-stats\n", prog, TELEOP_DEADLINE_MIN_MS,
            TELEOP_DEADLINE_MAX_MS);
    return 2;
}

static int do_status(void)
{
    char buf[1024];
    ssize_t n;
    int fd = open(TELEOP_DEV_PATH, O_RDONLY);

    if (fd == -1) {
        fprintf(stderr, "teleopctl: open %s: %s\n", TELEOP_DEV_PATH, strerror(errno));
        return 1;
    }
    while ((n = read(fd, buf, sizeof(buf))) > 0)
        fwrite(buf, 1, (size_t)n, stdout);
    if (n == -1)
        fprintf(stderr, "teleopctl: read %s: %s\n", TELEOP_DEV_PATH, strerror(errno));
    close(fd);
    return n == -1;
}

static int do_devctl(int dcmd, void *data, size_t len, const char *what)
{
    int fd = open(TELEOP_DEV_PATH, O_RDWR), rc;

    if (fd == -1) {
        fprintf(stderr, "teleopctl: open %s for writing: %s\n", TELEOP_DEV_PATH, strerror(errno));
        return 1;
    }
    rc = devctl(fd, dcmd, data, len, NULL);    /* returns an errno value, not -1 */
    close(fd);
    if (rc != EOK) {
        fprintf(stderr, "teleopctl: %s: %s\n", what, strerror(rc));
        return 1;
    }
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "status") == 0)
        return do_status();
    if (argc == 2 && strcmp(argv[1], "estop") == 0)
        return do_devctl(DCMD_TELEOP_ESTOP, NULL, 0, "estop");
    if (argc == 2 && strcmp(argv[1], "reset-stats") == 0)
        return do_devctl(DCMD_TELEOP_RESET_STATS, NULL, 0, "reset-stats");
    if (argc == 3 && strcmp(argv[1], "set-deadline") == 0) {
        char *end;
        long ms;
        int32_t v;

        errno = 0;
        ms = strtol(argv[2], &end, 10);
        if (errno != 0 || end == argv[2] || *end != '\0' || ms < TELEOP_DEADLINE_MIN_MS
            || ms > TELEOP_DEADLINE_MAX_MS) {
            fprintf(stderr, "teleopctl: deadline must be an integer %d..%d ms\n", TELEOP_DEADLINE_MIN_MS,
                    TELEOP_DEADLINE_MAX_MS);
            return 2;
        }
        v = (int32_t)ms;
        return do_devctl(DCMD_TELEOP_SET_DEADLINE, &v, sizeof(v), "set-deadline");
    }
    return usage(argv[0]);
}
