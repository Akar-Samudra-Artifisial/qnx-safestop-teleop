/* simplant: simulated differential-drive robot for QNX 8.0.
 * Server via name_attach("simplant"); 200 Hz integration driven by a timer pulse on the
 * same channel; teleopd sends velocity setpoints with MsgSend and gets the pose back.
 * Plant-side watchdog: no setpoint for PLANT_CMD_TIMEOUT_NS -> velocity 0. */
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/dispatch.h>
#include <sys/iomsg.h>
#include <sys/neutrino.h>
#include <sys/slog2.h>

#include "proto.h"

#define PLANT_HZ              200
#define PLANT_PRIO            40
#define PLANT_HALF_SIZE_M     5.0            /* 10 x 10 m area centred on the origin */
#define PLANT_CMD_TIMEOUT_NS  200000000LL    /* 200 ms */
#define PULSE_TICK            (_PULSE_CODE_MINAVAIL + 1)

typedef union {
    struct _pulse pulse;
    uint16_t type;
    plant_set_vel_t set;
} plant_msg_t;

static slog2_buffer_t g_log;
static bool g_verbose;

static void logf_(int sev, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void logf_(int sev, const char *fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    if (g_log)
        vslog2f(g_log, 0, (uint8_t)sev, fmt, ap);
    va_end(ap);
    if (g_verbose) {
        va_start(ap, fmt);
        vprintf(fmt, ap);
        putchar('\n');
        fflush(stdout);
        va_end(ap);
    }
}

static int64_t now_ns(void)
{
    struct timespec ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

static void log_init(void)
{
    slog2_buffer_set_config_t cfg;

    memset(&cfg, 0, sizeof(cfg));
    cfg.num_buffers = 1;
    cfg.buffer_set_name = "simplant";
    cfg.verbosity_level = SLOG2_INFO;
    cfg.buffer_config[0].buffer_name = "main";
    cfg.buffer_config[0].num_pages = 4;
    if (slog2_register(&cfg, &g_log, 0) == -1) {
        g_log = NULL;
        fprintf(stderr, "simplant: slog2_register failed: %s\n", strerror(errno));
    }
}

int main(int argc, char **argv)
{
    name_attach_t *att;
    plant_pose_t st = { 0 };
    double cmd_v = 0, cmd_w = 0;
    int64_t last_cmd = 0, last_tick;
    struct sched_param sp = { .sched_priority = PLANT_PRIO };
    struct sigevent ev;
    struct itimerspec its = { { 0, 1000000000L / PLANT_HZ }, { 0, 1000000000L / PLANT_HZ } };
    timer_t tid;
    int opt, coid;

    while ((opt = getopt(argc, argv, "v")) != -1) {
        if (opt == 'v')
            g_verbose = true;
        else {
            fprintf(stderr, "usage: %s [-v]\n", argv[0]);
            return 2;
        }
    }
    log_init();

    if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp) != 0)
        logf_(SLOG2_WARNING, "simplant: SCHED_FIFO %d not set", PLANT_PRIO);

    att = name_attach(NULL, SIMPLANT_NAME, 0);
    if (!att) {
        logf_(SLOG2_ERROR, "simplant: name_attach(%s) failed: %s", SIMPLANT_NAME, strerror(errno));
        return 1;
    }
    coid = ConnectAttach(0, 0, att->chid, _NTO_SIDE_CHANNEL, 0);
    if (coid == -1) {
        logf_(SLOG2_ERROR, "simplant: ConnectAttach failed: %s", strerror(errno));
        return 1;
    }
    SIGEV_PULSE_INIT(&ev, coid, PLANT_PRIO, PULSE_TICK, 0);
    if (timer_create(CLOCK_MONOTONIC, &ev, &tid) == -1 || timer_settime(tid, 0, &its, NULL) == -1) {
        logf_(SLOG2_ERROR, "simplant: timer setup failed: %s", strerror(errno));
        return 1;
    }
    logf_(SLOG2_INFO, "simplant: up, %d Hz, area %.0fx%.0f m", PLANT_HZ,
          2 * PLANT_HALF_SIZE_M, 2 * PLANT_HALF_SIZE_M);

    last_tick = now_ns();
    for (;;) {
        plant_msg_t msg;
        struct _msg_info info;
        int rcvid = MsgReceive(att->chid, &msg, sizeof(msg), &info);

        if (rcvid == -1) {
            if (errno == EINTR)
                continue;
            logf_(SLOG2_ERROR, "simplant: MsgReceive failed: %s", strerror(errno));
            return 1;
        }
        if (rcvid == 0) {
            switch (msg.pulse.code) {
            case PULSE_TICK: {
                int64_t t = now_ns();
                double dt = (double)(t - last_tick) / 1e9;
                last_tick = t;
                if (t - last_cmd > PLANT_CMD_TIMEOUT_NS)
                    cmd_v = cmd_w = 0;
                st.v = cmd_v;
                st.w = cmd_w;
                st.x = clampd(st.x + st.v * cos(st.theta) * dt, -PLANT_HALF_SIZE_M, PLANT_HALF_SIZE_M);
                st.y = clampd(st.y + st.v * sin(st.theta) * dt, -PLANT_HALF_SIZE_M, PLANT_HALF_SIZE_M);
                st.theta = remainder(st.theta + st.w * dt, 2 * M_PI);
                break;
            }
            case _PULSE_CODE_DISCONNECT:
                ConnectDetach(msg.pulse.scoid);
                break;
            default:
                break;
            }
            continue;
        }
        if (info.srcmsglen < (ssize_t)sizeof(msg.type)) {
            MsgError(rcvid, EBADMSG);
        } else if (msg.type == _IO_CONNECT) {   /* from name_open() */
            MsgReply(rcvid, EOK, NULL, 0);
        } else if (msg.type == PLANT_MSG_SET_VEL) {
            if (info.srcmsglen < (ssize_t)sizeof(plant_set_vel_t)) {
                MsgError(rcvid, EBADMSG);
                continue;
            }
            if (isfinite(msg.set.v) && isfinite(msg.set.w)) {
                cmd_v = msg.set.v;
                cmd_w = msg.set.w;
                last_cmd = now_ns();
            }
            MsgReply(rcvid, (long)sizeof(st), &st, sizeof(st));   /* status = reply length */
        } else {
            MsgError(rcvid, ENOSYS);
        }
    }
}
