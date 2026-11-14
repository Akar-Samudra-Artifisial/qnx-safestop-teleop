/* teleopd: teleoperation daemon with a heartbeat-deadline safe-stop (QNX 8.0).
 *
 * Threads:
 *   net     (SCHED_RR 10)    WebSocket server (qnx/common/ws.c). Authenticates the client
 *                            (pairing token, Origin), decodes JSON, stores the payload in a
 *                            mutex-protected inbox and wakes the control thread with a
 *                            coalesced MsgSendPulse. Sends state at 20 Hz and events immediately.
 *   control (SCHED_FIFO 50)  Blocks in MsgReceive on a fixed-priority channel. A 100 Hz
 *                            timer_create(CLOCK_MONOTONIC, SIGEV_PULSE) tick checks heartbeat
 *                            age, ramps velocity and forwards it to simplant (MsgSend).
 *
 * Modes: DISARMED -(arm, fresh hb)-> ARMED -(hb age > deadline | estop | client lost)-> SAFE_STOP
 *        SAFE_STOP stays latched until the next accepted arm. estop zeroes velocity at once;
 *        the other reasons ramp it down (see docs/ARCHITECTURE.md). */
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>
#include <netinet/in.h>
#include <sys/dispatch.h>
#include <sys/neutrino.h>
#include <sys/slog2.h>
#include <sys/socket.h>

#include "json.h"
#include "proto.h"
#include "ws.h"

#define CONTROL_PRIO        50
#define NET_PRIO            10
#define TICK_HZ             100
#define STATE_PERIOD_NS     50000000LL      /* 20 Hz */
#define PING_PERIOD_NS      1000000000LL    /* rtt probe */
#define PLANT_RETRY_NS      500000000LL
#define PLANT_TIMEOUT_NS    5000000ULL      /* MsgSend send+reply bound */
#define CMD_HOLD_NS         500000000LL     /* no fresh cmd -> target 0 */
#define CMD_MAX_LAG_MS      300.0           /* cmd older than this (vs. best seen) is stale */
#define V_MAX               1.0             /* m/s */
#define W_MAX               2.0             /* rad/s */
#define A_LIN               2.0             /* m/s^2 */
#define A_ANG               4.0             /* rad/s^2 */
#define HANDSHAKE_MS        2000            /* total budget for the HTTP upgrade request */
#define SEND_TIMEOUT_MS     200             /* SO_SNDTIMEO: a stalled reader gets dropped */
#define MAX_PENDING         4               /* concurrent handshakes; extra connects are closed */
#define LOG_INTERVAL_NS     1000000000LL    /* rate limit for per-message logs */
#define SEQ_LIMIT           9007199254740992.0  /* 2^53: exact integers in a JS number */
#define TOKEN_MAX           32

enum {
    PULSE_TICK = _PULSE_CODE_MINAVAIL + 1,
    PULSE_CMD,
    PULSE_ARM,
    PULSE_ESTOP,
    PULSE_CLIENT,       /* new client admitted: reset per-connection state */
    PULSE_CLIENT_LOST,  /* client disconnected / send failed */
};

/* Coalescing: net sends a CMD/ARM/ESTOP pulse only when that bit is not already pending;
 * control clears the bit before reading the inbox, so no update is ever missed. */
#define PENDING_BIT(code)   (1u << ((code) - PULSE_TICK))
static atomic_uint g_pending;

typedef enum { MODE_DISARMED, MODE_ARMED, MODE_SAFE_STOP } mode_t_;
static const char *const MODE_NAME[] = { "DISARMED", "ARMED", "SAFE_STOP" };

/* net -> control, guarded by in.mtx (priority inheritance). Timestamps: CLOCK_MONOTONIC ns. */
static struct {
    pthread_mutex_t mtx;
    int64_t hb_seq;
    int64_t hb_rx_ns;           /* 0 = no hb yet */
    int64_t cmd_seq;
    double cmd_v, cmd_w, cmd_lag_ms;
    int64_t cmd_rx_ns;
    int64_t arm_rx_ns;
    int64_t estop_rx_ns;
} in;

/* control -> net, guarded by out.mtx (priority inheritance). */
static struct {
    pthread_mutex_t mtx;
    mode_t_ mode;
    plant_pose_t pose;
    double v, w;
    int64_t hb_rx_ns;
    bool plant_ok;
    unsigned event_count;       /* bumps on each SAFE_STOP */
    char event_reason[24];
    int64_t event_detect_us;
} out;

static int g_chid = -1;
static int g_wake_pipe[2] = { -1, -1 };
static int64_t g_deadline_ns = 150000000LL;
static bool g_verbose;
static slog2_buffer_t g_log;
static char g_token[TOKEN_MAX + 1];
static char g_origin[128];      /* allowed browser Origin ("" = none) */

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

/* true at most once per LOG_INTERVAL_NS for a given *last. */
static bool log_ok(int64_t *last)
{
    int64_t t = now_ns();

    if (*last != 0 && t - *last < LOG_INTERVAL_NS)
        return false;
    *last = t;
    return true;
}

static double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

static double ramp(double cur, double target, double step)
{
    if (target > cur + step)
        return cur + step;
    if (target < cur - step)
        return cur - step;
    return target;
}

static void log_init(void)
{
    slog2_buffer_set_config_t cfg;

    memset(&cfg, 0, sizeof(cfg));
    cfg.num_buffers = 1;
    cfg.buffer_set_name = "teleopd";
    cfg.verbosity_level = SLOG2_INFO;
    cfg.buffer_config[0].buffer_name = "main";
    cfg.buffer_config[0].num_pages = 8;
    if (slog2_register(&cfg, &g_log, 0) == -1) {
        g_log = NULL;
        fprintf(stderr, "teleopd: slog2_register failed: %s\n", strerror(errno));
    }
}

static int init_pi_mutex(pthread_mutex_t *m)
{
    pthread_mutexattr_t a;
    int rc = pthread_mutexattr_init(&a);

    if (rc == 0)
        rc = pthread_mutexattr_setprotocol(&a, PTHREAD_PRIO_INHERIT);
    if (rc == 0)
        rc = pthread_mutex_init(m, &a);
    pthread_mutexattr_destroy(&a);
    return rc;
}

static void set_sched(int policy, int prio, const char *name)
{
    struct sched_param sp = { .sched_priority = prio };
    int rc = pthread_setschedparam(pthread_self(), policy, &sp);

    if (rc != 0)
        logf_(SLOG2_WARNING, "teleopd: %s: pthread_setschedparam(%d) failed: %s", name, prio, strerror(rc));
    pthread_setname_np(pthread_self(), name);
}

static mode_t_ current_mode(void)
{
    mode_t_ m;

    pthread_mutex_lock(&out.mtx);
    m = out.mode;
    pthread_mutex_unlock(&out.mtx);
    return m;
}

/* ------------------------------------------------------------------ control thread */

typedef struct {
    mode_t_ mode;
    int64_t last_cmd_seq;       /* reset per connection */
    double target_v, target_w;
    int64_t target_ns;
    double v, w;
    int plant_coid;
    int64_t plant_retry_ns;
    plant_pose_t pose;
    int64_t log_cmd_ns, log_plant_ns;
} ctl_t;

static void publish(const ctl_t *c, int64_t hb_rx)
{
    pthread_mutex_lock(&out.mtx);
    out.mode = c->mode;
    out.pose = c->pose;
    out.v = c->v;
    out.w = c->w;
    out.hb_rx_ns = hb_rx;
    out.plant_ok = c->plant_coid != -1;
    pthread_mutex_unlock(&out.mtx);
}

static void enter_safe_stop(ctl_t *c, const char *reason, int64_t detect_us)
{
    c->mode = MODE_SAFE_STOP;
    c->target_v = c->target_w = 0;
    pthread_mutex_lock(&out.mtx);
    out.mode = c->mode;
    out.event_count++;
    snprintf(out.event_reason, sizeof(out.event_reason), "%s", reason);
    out.event_detect_us = detect_us;
    pthread_mutex_unlock(&out.mtx);
    (void)write(g_wake_pipe[1], "e", 1);
    logf_(SLOG2_WARNING, "teleopd: SAFE_STOP reason=%s detect_us=%lld", reason, (long long)detect_us);
}

static bool pose_finite(const plant_pose_t *p)
{
    return isfinite(p->x) && isfinite(p->y) && isfinite(p->theta) && isfinite(p->v) && isfinite(p->w);
}

static void plant_exchange(ctl_t *c, int64_t t)
{
    plant_set_vel_t req = { .type = PLANT_MSG_SET_VEL, .v = c->v, .w = c->w };
    plant_pose_t rep;
    uint64_t timeout = PLANT_TIMEOUT_NS;
    long rc;

    if (c->plant_coid == -1) {
        if (t < c->plant_retry_ns)
            return;
        c->plant_retry_ns = t + PLANT_RETRY_NS;
        c->plant_coid = name_open(SIMPLANT_NAME, 0);
        if (c->plant_coid == -1)
            return;
        logf_(SLOG2_INFO, "teleopd: connected to %s", SIMPLANT_NAME);
    }
    /* Bound the blocking time so a hung plant cannot stall the deadline monitor. */
    TimerTimeout(CLOCK_MONOTONIC, _NTO_TIMEOUT_SEND | _NTO_TIMEOUT_REPLY, NULL, &timeout, NULL);
    rc = MsgSend(c->plant_coid, &req, sizeof(req), &rep, sizeof(rep));
    if (rc == -1 || rc != (long)sizeof(rep) || !pose_finite(&rep)) {
        /* simplant replies status = sizeof(plant_pose_t) (proto.h); anything else is bogus. */
        if (log_ok(&c->log_plant_ns)) {
            if (rc == -1)
                logf_(SLOG2_WARNING, "teleopd: MsgSend to %s failed: %s", SIMPLANT_NAME, strerror(errno));
            else
                logf_(SLOG2_WARNING, "teleopd: invalid reply from %s (status %ld)", SIMPLANT_NAME, rc);
        }
        name_close(c->plant_coid);
        c->plant_coid = -1;
        c->plant_retry_ns = t + PLANT_RETRY_NS;
        return;
    }
    c->pose = rep;
}

static void on_tick(ctl_t *c)
{
    const double dt = 1.0 / TICK_HZ;
    int64_t t = now_ns(), hb_rx;

    pthread_mutex_lock(&in.mtx);
    hb_rx = in.hb_rx_ns;
    pthread_mutex_unlock(&in.mtx);

    if (c->mode == MODE_ARMED) {
        if (hb_rx == 0 || t - hb_rx > g_deadline_ns)
            enter_safe_stop(c, "hb_timeout", hb_rx ? (t - hb_rx) / 1000 : -1);
        else if (t - c->target_ns > CMD_HOLD_NS)
            c->target_v = c->target_w = 0;
    }
    c->v = ramp(c->v, c->target_v, A_LIN * dt);
    c->w = ramp(c->w, c->target_w, A_ANG * dt);
    plant_exchange(c, t);
    publish(c, hb_rx);
}

static void on_cmd(ctl_t *c)
{
    int64_t seq, rx;
    double v, w, lag;

    pthread_mutex_lock(&in.mtx);
    seq = in.cmd_seq;
    v = in.cmd_v;
    w = in.cmd_w;
    lag = in.cmd_lag_ms;
    rx = in.cmd_rx_ns;
    pthread_mutex_unlock(&in.mtx);

    if (c->mode != MODE_ARMED) {
        if (log_ok(&c->log_cmd_ns))
            logf_(SLOG2_INFO, "teleopd: cmd seq=%lld rejected: mode %s", (long long)seq, MODE_NAME[c->mode]);
        return;
    }
    if (seq <= c->last_cmd_seq) {
        if (log_ok(&c->log_cmd_ns))
            logf_(SLOG2_INFO, "teleopd: cmd seq=%lld rejected: not newer than %lld", (long long)seq,
                  (long long)c->last_cmd_seq);
        return;
    }
    if (lag > CMD_MAX_LAG_MS) {
        if (log_ok(&c->log_cmd_ns))
            logf_(SLOG2_INFO, "teleopd: cmd seq=%lld rejected: stale by %.0f ms", (long long)seq, lag);
        return;
    }
    c->last_cmd_seq = seq;
    c->target_v = clampd(v, -V_MAX, V_MAX);
    c->target_w = clampd(w, -W_MAX, W_MAX);
    c->target_ns = rx;
}

static void on_arm(ctl_t *c)
{
    int64_t t = now_ns(), hb_rx, arm_rx, estop_rx;

    pthread_mutex_lock(&in.mtx);
    hb_rx = in.hb_rx_ns;
    arm_rx = in.arm_rx_ns;
    estop_rx = in.estop_rx_ns;
    pthread_mutex_unlock(&in.mtx);

    if (c->mode == MODE_ARMED)
        return;
    /* An estop received after this arm wins, whatever order the pulses are handled in. */
    if (arm_rx <= estop_rx) {
        logf_(SLOG2_INFO, "teleopd: arm rejected: estop received after it");
        return;
    }
    if (hb_rx == 0 || t - hb_rx > g_deadline_ns) {
        logf_(SLOG2_INFO, "teleopd: arm rejected: no fresh heartbeat");
        return;
    }
    c->mode = MODE_ARMED;
    c->target_v = c->target_w = 0;
    c->target_ns = t;
    pthread_mutex_lock(&out.mtx);
    out.mode = c->mode;
    pthread_mutex_unlock(&out.mtx);
    logf_(SLOG2_INFO, "teleopd: ARMED");
}

static void on_estop(ctl_t *c)
{
    int64_t t, rx, hb_rx;

    pthread_mutex_lock(&in.mtx);
    rx = in.estop_rx_ns;
    hb_rx = in.hb_rx_ns;
    pthread_mutex_unlock(&in.mtx);

    t = now_ns();
    enter_safe_stop(c, "estop", (t - rx) / 1000);
    /* Operator-commanded stop: zero the setpoint now instead of ramping (ARCHITECTURE.md). */
    c->v = c->w = 0;
    plant_exchange(c, t);
    publish(c, hb_rx);
}

static void *control_main(void *arg)
{
    ctl_t c = { .mode = MODE_DISARMED, .plant_coid = -1, .last_cmd_seq = INT64_MIN };
    struct sigevent ev;
    struct itimerspec its = { { 0, 1000000000L / TICK_HZ }, { 0, 1000000000L / TICK_HZ } };
    timer_t tid;
    int self_coid;

    (void)arg;
    set_sched(SCHED_FIFO, CONTROL_PRIO, "control");

    self_coid = ConnectAttach(0, 0, g_chid, _NTO_SIDE_CHANNEL, 0);
    if (self_coid == -1) {
        logf_(SLOG2_ERROR, "teleopd: control ConnectAttach failed: %s", strerror(errno));
        exit(1);
    }
    SIGEV_PULSE_INIT(&ev, self_coid, CONTROL_PRIO, PULSE_TICK, 0);
    if (timer_create(CLOCK_MONOTONIC, &ev, &tid) == -1 || timer_settime(tid, 0, &its, NULL) == -1) {
        logf_(SLOG2_ERROR, "teleopd: timer setup failed: %s", strerror(errno));
        exit(1);
    }

    for (;;) {
        struct _pulse p;
        int rcvid = MsgReceive(g_chid, &p, sizeof(p), NULL);

        if (rcvid == -1) {
            if (errno == EINTR)
                continue;
            logf_(SLOG2_ERROR, "teleopd: MsgReceive failed: %s", strerror(errno));
            exit(1);
        }
        if (rcvid != 0) {                   /* nobody should MsgSend to this channel */
            MsgError(rcvid, ENOSYS);
            continue;
        }
        switch (p.code) {
        case PULSE_TICK:
            on_tick(&c);
            break;
        case PULSE_CMD:
            atomic_fetch_and(&g_pending, ~PENDING_BIT(PULSE_CMD));
            on_cmd(&c);
            break;
        case PULSE_ARM:
            atomic_fetch_and(&g_pending, ~PENDING_BIT(PULSE_ARM));
            on_arm(&c);
            break;
        case PULSE_ESTOP:
            atomic_fetch_and(&g_pending, ~PENDING_BIT(PULSE_ESTOP));
            on_estop(&c);
            break;
        case PULSE_CLIENT:
            c.last_cmd_seq = INT64_MIN;
            if (c.mode == MODE_ARMED)
                enter_safe_stop(&c, "client_replaced", 0);
            break;
        case PULSE_CLIENT_LOST:
            if (c.mode == MODE_ARMED)
                enter_safe_stop(&c, "client_lost", 0);
            break;
        default:
            break;
        }
    }
    return NULL;
}

/* ------------------------------------------------------------------ net thread */

typedef struct {
    int coid;                   /* side-channel connection to the control channel */
    ws_conn_t conn;
    double min_offset_ms;       /* min(server_ms - client_ts) for this connection */
    bool have_offset;
    int rtt_ms;
    int64_t next_state, next_ping;
    int64_t log_msg_ns, log_pulse_ns, log_conn_ns;
} net_t;

static void pulse(net_t *n, int prio, int code)
{
    if (MsgSendPulse(n->coid, prio, code, 0) == -1 && log_ok(&n->log_pulse_ns))
        logf_(SLOG2_ERROR, "teleopd: MsgSendPulse(%d) failed: %s", code, strerror(errno));
}

/* Send a coalesced pulse: skipped when one with this code is already queued. */
static void pulse_once(net_t *n, int prio, int code)
{
    unsigned bit = PENDING_BIT(code);

    if (atomic_fetch_or(&g_pending, bit) & bit)
        return;
    if (MsgSendPulse(n->coid, prio, code, 0) == -1) {
        atomic_fetch_and(&g_pending, ~bit);
        if (log_ok(&n->log_pulse_ns))
            logf_(SLOG2_ERROR, "teleopd: MsgSendPulse(%d) failed: %s", code, strerror(errno));
    }
}

static bool valid_seq(double s) { return isfinite(s) && s == trunc(s) && fabs(s) < SEQ_LIMIT; }
static bool valid_ts(double s) { return isfinite(s) && s >= 0 && s < SEQ_LIMIT; }

static void drop_msg(net_t *n, const char *what)
{
    if (log_ok(&n->log_msg_ns))
        logf_(SLOG2_INFO, "teleopd: dropping %s", what);
}

static void on_text(void *ctx, const char *text, size_t len)
{
    net_t *n = ctx;
    char type[16];
    double seq, ts, v, w;
    int64_t t = now_ns();

    (void)len;
    if (json_get_str(text, "type", type, sizeof(type)) != 0) {
        drop_msg(n, "malformed message");
        return;
    }
    if (strcmp(type, "hb") == 0) {
        if (json_get_num(text, "seq", &seq) != 0 || !valid_seq(seq)) {
            drop_msg(n, "invalid hb");
            return;
        }
        /* No pulse: the control tick reads the heartbeat age from the inbox. */
        pthread_mutex_lock(&in.mtx);
        in.hb_seq = (int64_t)seq;
        in.hb_rx_ns = t;
        pthread_mutex_unlock(&in.mtx);
    } else if (strcmp(type, "cmd") == 0) {
        double off;
        if (json_get_num(text, "seq", &seq) != 0 || json_get_num(text, "v", &v) != 0
            || json_get_num(text, "w", &w) != 0 || json_get_num(text, "ts", &ts) != 0
            || !valid_seq(seq) || !valid_ts(ts) || !isfinite(v) || !isfinite(w)) {
            drop_msg(n, "invalid cmd");
            return;
        }
        /* Client clock is unknown: the smallest offset seen approximates the clock offset
         * plus minimum one-way latency; anything later than that by > CMD_MAX_LAG_MS is stale. */
        off = (double)t / 1e6 - ts;
        if (!n->have_offset || off < n->min_offset_ms) {
            n->min_offset_ms = off;
            n->have_offset = true;
        }
        pthread_mutex_lock(&in.mtx);
        in.cmd_seq = (int64_t)seq;
        in.cmd_v = v;
        in.cmd_w = w;
        in.cmd_lag_ms = off - n->min_offset_ms;
        in.cmd_rx_ns = t;
        pthread_mutex_unlock(&in.mtx);
        pulse_once(n, NET_PRIO, PULSE_CMD);
    } else if (strcmp(type, "arm") == 0) {
        pthread_mutex_lock(&in.mtx);
        in.arm_rx_ns = t;
        pthread_mutex_unlock(&in.mtx);
        pulse_once(n, NET_PRIO, PULSE_ARM);
    } else if (strcmp(type, "estop") == 0) {
        pthread_mutex_lock(&in.mtx);
        in.estop_rx_ns = t;
        pthread_mutex_unlock(&in.mtx);
        /* Control priority: queued ahead of any pending net pulses. */
        pulse_once(n, CONTROL_PRIO, PULSE_ESTOP);
    } else {
        drop_msg(n, "unknown message type");
    }
}

static void on_pong(void *ctx, const uint8_t *data, size_t len)
{
    net_t *n = ctx;
    int64_t sent;

    if (len != sizeof(sent))
        return;
    memcpy(&sent, data, sizeof(sent));
    n->rtt_ms = (int)((now_ns() - sent) / 1000000);
}

static int send_text(int fd, const char *s)
{
    return ws_send(fd, WS_OP_TEXT, s, strlen(s));
}

static int send_state(net_t *n)
{
    char buf[512];
    int64_t t = now_ns(), seq_ack, hb_age;

    pthread_mutex_lock(&in.mtx);
    seq_ack = in.hb_seq;
    pthread_mutex_unlock(&in.mtx);
    pthread_mutex_lock(&out.mtx);
    hb_age = out.hb_rx_ns ? (t - out.hb_rx_ns) / 1000000 : -1;
    /* pose/v/w are finite: plant replies are validated in plant_exchange(). */
    snprintf(buf, sizeof(buf),
             "{\"type\":\"state\",\"seq_ack\":%lld,\"pose\":{\"x\":%.4f,\"y\":%.4f,\"theta\":%.4f},"
             "\"vel\":{\"v\":%.4f,\"w\":%.4f},\"mode\":\"%s\",\"hb_age_ms\":%lld,\"rtt\":%d,"
             "\"plant_ok\":%s}",
             (long long)seq_ack, out.pose.x, out.pose.y, out.pose.theta, out.v, out.w,
             MODE_NAME[out.mode], (long long)hb_age, n->rtt_ms, out.plant_ok ? "true" : "false");
    pthread_mutex_unlock(&out.mtx);
    return send_text(n->conn.fd, buf);
}

/* lost = the operator link is gone (not a replacement): control safe-stops if ARMED. */
static void drop_client(net_t *n, const char *why, bool lost)
{
    if (n->conn.fd == -1)
        return;
    logf_(SLOG2_INFO, "teleopd: client closed (%s)", why);
    close(n->conn.fd);
    n->conn.fd = -1;
    if (lost)
        pulse(n, NET_PRIO, PULSE_CLIENT_LOST);
}

/* Copy for logging: printable ASCII only (header values are attacker-controlled). */
static void log_safe(char *dst, size_t len, const char *src)
{
    size_t i;

    for (i = 0; i + 1 < len && src[i]; i++)
        dst[i] = (src[i] >= 0x20 && src[i] < 0x7f) ? src[i] : '?';
    dst[i] = '\0';
}

/* Path/token is never logged (the query carries the pairing token). */
static void refuse(net_t *n, int fd, int status, const char *reason, const ws_request_t *r)
{
    ws_reject(fd, status, reason);
    close(fd);
    if (log_ok(&n->log_conn_ns)) {
        char origin[sizeof(r->origin)], host[sizeof(r->host)];
        log_safe(origin, sizeof(origin), r->has_origin ? r->origin : "(none)");
        log_safe(host, sizeof(host), r->host);
        logf_(SLOG2_INFO, "teleopd: handshake refused: %d %s (origin=%s host=%s)", status, reason, origin,
              host);
    }
}

/* Host header is an IPv4 literal or "localhost", optional ":port". Names other than
 * localhost are refused so a DNS-rebinding page (attacker name -> robot IP) cannot pass
 * the same-host Origin check. */
static bool host_is_literal(const char *h)
{
    const char *colon = strchr(h, ':');
    size_t hl = colon ? (size_t)(colon - h) : strlen(h);
    int parts = 0, digits = 0;
    size_t i;

    if (colon) {
        const char *p = colon + 1;
        if (*p == '\0' || strlen(p) > 5)
            return false;
        for (; *p; p++)
            if (*p < '0' || *p > '9')
                return false;
    }
    if (hl == 9 && strncasecmp(h, "localhost", 9) == 0)
        return true;
    for (i = 0; i < hl; i++) {
        if (h[i] >= '0' && h[i] <= '9') {
            if (++digits > 3)
                return false;
        } else if (h[i] == '.' && digits > 0) {
            parts++;
            digits = 0;
        } else {
            return false;
        }
    }
    return digits > 0 && parts == 3;
}

/* Allowed: no Origin (RN Android, wsclient), "null", the -o origin, or same-host
 * (Origin == http(s)://<Host header>, e.g. iOS SocketRocket). Anything else is a foreign
 * page (cross-site WebSocket hijacking) -> 403. */
static bool origin_ok(const ws_request_t *r)
{
    const char *o = r->origin, *rest;

    if (!r->has_origin || o[0] == '\0' || strcmp(o, "null") == 0)
        return true;
    if (g_origin[0] != '\0' && strcmp(o, g_origin) == 0)
        return true;
    if (strncasecmp(o, "http://", 7) == 0)
        rest = o + 7;
    else if (strncasecmp(o, "https://", 8) == 0)
        rest = o + 8;
    else
        return false;
    return r->host[0] != '\0' && host_is_literal(r->host) && strcasecmp(rest, r->host) == 0;
}

/* Upgrade request fully read: authenticate, then admit or refuse. Owns fd. */
static void admit(net_t *n, int fd, const ws_request_t *r)
{
    bool replacing;

    if (!origin_ok(r)) {
        refuse(n, fd, 403, "Forbidden", r);
        return;
    }
    if (!ws_secure_streq(g_token, r->token)) {
        refuse(n, fd, 401, "Unauthorized", r);
        return;
    }
    if (n->conn.fd != -1 && current_mode() == MODE_ARMED) {
        refuse(n, fd, 409, "Conflict", r);
        return;
    }
    if (ws_accept(fd, r, SEND_TIMEOUT_MS) != 0) {
        close(fd);
        return;
    }
    replacing = n->conn.fd != -1;
    drop_client(n, "replaced by new client", false);
    n->conn.fd = fd;
    n->conn.len = 0;
    n->have_offset = false;
    n->rtt_ms = -1;
    n->next_state = n->next_ping = now_ns();
    pulse(n, NET_PRIO, PULSE_CLIENT);
    logf_(SLOG2_INFO, "teleopd: client connected%s", replacing ? " (replaced previous)" : "");
}

static void net_loop(int lfd)
{
    net_t n = { .conn = { .fd = -1 }, .rtt_ms = -1 };
    ws_handlers_t h = { on_text, on_pong, &n };
    ws_pending_t pend[MAX_PENDING];
    unsigned events_seen;
    int i;

    for (i = 0; i < MAX_PENDING; i++)
        pend[i].fd = -1;
    n.coid = ConnectAttach(0, 0, g_chid, _NTO_SIDE_CHANNEL, 0);
    if (n.coid == -1) {
        logf_(SLOG2_ERROR, "teleopd: net ConnectAttach failed: %s", strerror(errno));
        exit(1);
    }
    pthread_mutex_lock(&out.mtx);
    events_seen = out.event_count;
    pthread_mutex_unlock(&out.mtx);

    for (;;) {
        struct pollfd pfd[3 + MAX_PENDING];
        int64_t t = now_ns(), due = INT64_MAX;
        int timeout_ms;

        /* poll() ignores negative fds. */
        pfd[0] = (struct pollfd){ .fd = lfd, .events = POLLIN };
        pfd[1] = (struct pollfd){ .fd = g_wake_pipe[0], .events = POLLIN };
        pfd[2] = (struct pollfd){ .fd = n.conn.fd, .events = POLLIN };
        for (i = 0; i < MAX_PENDING; i++) {
            pfd[3 + i] = (struct pollfd){ .fd = pend[i].fd, .events = POLLIN };
            if (pend[i].fd != -1 && pend[i].deadline_ns < due)
                due = pend[i].deadline_ns;
        }
        if (n.conn.fd != -1) {
            if (n.next_state < due)
                due = n.next_state;
            if (n.next_ping < due)
                due = n.next_ping;
        }
        timeout_ms = due == INT64_MAX ? -1 : due <= t ? 0 : (int)((due - t + 999999) / 1000000);
        if (poll(pfd, 3 + MAX_PENDING, timeout_ms) < 0) {
            if (errno == EINTR)
                continue;
            logf_(SLOG2_ERROR, "teleopd: poll failed: %s", strerror(errno));
            exit(1);
        }

        if (pfd[0].revents & POLLIN) {
            int fd = accept(lfd, NULL, NULL);
            if (fd >= 0) {
                for (i = 0; i < MAX_PENDING && pend[i].fd != -1; i++)
                    ;
                if (i == MAX_PENDING) {
                    close(fd);
                    if (log_ok(&n.log_conn_ns))
                        logf_(SLOG2_INFO, "teleopd: too many pending handshakes");
                } else {
                    ws_pending_start(&pend[i], fd, now_ns(), HANDSHAKE_MS);
                }
            }
        }
        for (i = 0; i < MAX_PENDING; i++) {
            ws_request_t req;
            int rc;
            if (pend[i].fd == -1)
                continue;
            if (pfd[3 + i].fd == pend[i].fd && (pfd[3 + i].revents & (POLLIN | POLLHUP | POLLERR))) {
                rc = ws_pending_read(&pend[i], &req);
                if (rc == 1) {
                    admit(&n, pend[i].fd, &req);
                    pend[i].fd = -1;
                    continue;
                }
                if (rc < 0) {
                    close(pend[i].fd);
                    pend[i].fd = -1;
                    continue;
                }
            }
            if (now_ns() >= pend[i].deadline_ns) {
                close(pend[i].fd);
                pend[i].fd = -1;
                if (log_ok(&n.log_conn_ns))
                    logf_(SLOG2_INFO, "teleopd: handshake timed out");
            }
        }
        if (pfd[1].revents & POLLIN) {
            char drain[16];
            (void)read(g_wake_pipe[0], drain, sizeof(drain));
        }
        if (n.conn.fd != -1 && pfd[2].fd == n.conn.fd && (pfd[2].revents & (POLLIN | POLLHUP | POLLERR))) {
            if (ws_on_readable(&n.conn, &h) != 0)
                drop_client(&n, "read/close", true);
        }

        /* Events first (they are what the operator must see promptly). */
        {
            char buf[160];
            bool have = false;
            pthread_mutex_lock(&out.mtx);
            if (out.event_count != events_seen) {
                events_seen = out.event_count;
                snprintf(buf, sizeof(buf),
                         "{\"type\":\"event\",\"event\":\"SAFE_STOP\",\"reason\":\"%s\",\"detect_us\":%lld}",
                         out.event_reason, (long long)out.event_detect_us);
                have = true;
            }
            pthread_mutex_unlock(&out.mtx);
            if (have && n.conn.fd != -1 && send_text(n.conn.fd, buf) != 0)
                drop_client(&n, "send event", true);
        }

        t = now_ns();
        if (n.conn.fd != -1 && t >= n.next_state) {
            n.next_state = t + STATE_PERIOD_NS;
            if (send_state(&n) != 0)
                drop_client(&n, "send state", true);
        }
        if (n.conn.fd != -1 && t >= n.next_ping) {
            n.next_ping = t + PING_PERIOD_NS;
            if (ws_send(n.conn.fd, WS_OP_PING, &t, sizeof(t)) != 0)
                drop_client(&n, "send ping", true);
        }
    }
}

/* 6-digit pairing token from the kernel entropy pool. 0 or -1. */
static int make_token(void)
{
    static const char *const dev[] = { "/dev/urandom", "/dev/random" };
    uint32_t r = 0;
    size_t k;

    for (k = 0; k < sizeof(dev) / sizeof(dev[0]); k++) {
        int fd = open(dev[k], O_RDONLY);
        if (fd == -1)
            continue;
        /* Reject the top partial range so r % 1000000 is uniform. */
        do {
            if (read(fd, &r, sizeof(r)) != (ssize_t)sizeof(r)) {
                close(fd);
                fd = -1;
                break;
            }
        } while (r >= UINT32_MAX - UINT32_MAX % 1000000u);
        if (fd == -1)
            continue;
        close(fd);
        snprintf(g_token, sizeof(g_token), "%06u", (unsigned)(r % 1000000u));
        return 0;
    }
    return -1;
}

static bool valid_token(const char *s)
{
    size_t n = strlen(s), i;

    if (n < 1 || n > TOKEN_MAX)
        return false;
    for (i = 0; i < n; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= 'a' && s[i] <= 'z')))
            return false;
    return true;
}

int main(int argc, char **argv)
{
    pthread_attr_t attr;
    struct sched_param sp = { .sched_priority = CONTROL_PRIO };
    pthread_t ctl;
    int opt, lfd, rc;
    long port = 8080, deadline_ms = 150;

    while ((opt = getopt(argc, argv, "p:d:t:o:v")) != -1) {
        switch (opt) {
        case 'p': port = strtol(optarg, NULL, 10); break;
        case 'd': deadline_ms = strtol(optarg, NULL, 10); break;
        case 't':
            if (!valid_token(optarg)) {
                fprintf(stderr, "teleopd: -t must be 1..%d characters [A-Za-z0-9]\n", TOKEN_MAX);
                return 2;
            }
            snprintf(g_token, sizeof(g_token), "%s", optarg);
            break;
        case 'o':
            if (strlen(optarg) >= sizeof(g_origin)) {
                fprintf(stderr, "teleopd: -o origin too long\n");
                return 2;
            }
            snprintf(g_origin, sizeof(g_origin), "%s", optarg);
            break;
        case 'v': g_verbose = true; break;
        default:
            fprintf(stderr, "usage: %s [-p port] [-d hb_deadline_ms] [-t token] [-o allowed_origin] [-v]\n",
                    argv[0]);
            return 2;
        }
    }
    if (port < 1 || port > 65535 || deadline_ms < 20 || deadline_ms > 10000) {
        fprintf(stderr, "teleopd: invalid -p (1..65535) or -d (20..10000 ms)\n");
        return 2;
    }
    g_deadline_ns = deadline_ms * 1000000LL;
    signal(SIGPIPE, SIG_IGN);
    log_init();

    if (g_token[0] == '\0' && make_token() != 0) {
        logf_(SLOG2_ERROR, "teleopd: cannot read /dev/urandom for the pairing token (use -t)");
        fprintf(stderr, "teleopd: cannot read /dev/urandom for the pairing token (use -t)\n");
        return 1;
    }
    if ((rc = init_pi_mutex(&in.mtx)) != 0 || (rc = init_pi_mutex(&out.mtx)) != 0) {
        logf_(SLOG2_ERROR, "teleopd: mutex init failed: %s", strerror(rc));
        return 1;
    }

    /* Fixed priority: receiving a prio-10 pulse must not lower the control thread to 10. */
    g_chid = ChannelCreate(_NTO_CHF_FIXED_PRIORITY);
    if (g_chid == -1) {
        logf_(SLOG2_ERROR, "teleopd: ChannelCreate failed: %s", strerror(errno));
        return 1;
    }
    if (pipe(g_wake_pipe) == -1) {
        logf_(SLOG2_ERROR, "teleopd: pipe failed: %s", strerror(errno));
        return 1;
    }
    fcntl(g_wake_pipe[0], F_SETFL, O_NONBLOCK);
    fcntl(g_wake_pipe[1], F_SETFL, O_NONBLOCK);

    lfd = ws_listen((uint16_t)port);
    if (lfd == -1) {
        logf_(SLOG2_ERROR, "teleopd: listen on %ld failed: %s", port, strerror(errno));
        return 1;
    }

    pthread_attr_init(&attr);
    pthread_attr_setinheritsched(&attr, PTHREAD_EXPLICIT_SCHED);
    pthread_attr_setschedpolicy(&attr, SCHED_FIFO);
    pthread_attr_setschedparam(&attr, &sp);
    rc = pthread_create(&ctl, &attr, control_main, NULL);
    if (rc != 0) {
        logf_(SLOG2_ERROR, "teleopd: pthread_create(control) failed: %s", strerror(rc));
        return 1;
    }
    pthread_attr_destroy(&attr);

    set_sched(SCHED_RR, NET_PRIO, "net");
    /* The operator types this into the app; printed even without -v. */
    printf("teleopd: pairing token %s (connect ws://<host>:%ld/?t=%s)\n", g_token, port, g_token);
    fflush(stdout);
    if (g_log)
        slog2f(g_log, 0, SLOG2_INFO, "teleopd: pairing token %s", g_token);
    logf_(SLOG2_INFO, "teleopd: listening on :%ld, hb deadline %ld ms, tick %d Hz, origin %s", port,
          deadline_ms, TICK_HZ, g_origin[0] ? g_origin : "(none)");
    net_loop(lfd);
    return 0;
}
