/*
 * watchdog.c - minimal deadline watchdog for QNX 8.0 (codelab sample, standalone).
 *
 *   watchdog thread (main, SCHED_FIFO 50)  blocks in MsgReceive on one channel and handles
 *                                          two pulses: TICK (100 Hz timer) and HB (heartbeat).
 *   heartbeat thread (SCHED_FIFO 30)       sends an HB pulse every 20 ms for 500 ms, then goes
 *                                          silent for 400 ms; repeats forever.
 *   hog threads (optional, -H prio -N n)   busy loops that compete for the CPU for -T seconds.
 *
 * On every TICK the watchdog checks: now - last_heartbeat > DEADLINE_MS ?  If so it prints the
 * detection latency (time from the last heartbeat to the moment the miss was noticed).
 * Since the check only runs on a tick, latency is in [150, 150 + 10] ms plus scheduling jitter.
 *
 * Build: make   (qcc -Vgcc_ntoaarch64le)      Run: ./watchdog [-n trials] [-H prio -N n -T sec]
 */
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/neutrino.h>
#include <sys/siginfo.h>

#define TICK_HZ       100
#define DEADLINE_MS   150
#define HB_PERIOD_MS  20
#define HB_BURST_MS   500
#define HB_SILENCE_MS 400
#define WD_PRIO       50
#define HB_PRIO       30

#define PULSE_TICK (_PULSE_CODE_MINAVAIL + 0)
#define PULSE_HB   (_PULSE_CODE_MINAVAIL + 1)

static int g_chid;
static int g_coid;                    /* self connection, used by the heartbeat thread */

static long long now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void set_prio(int prio)
{
    struct sched_param sp = { .sched_priority = prio };
    int rc = pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);
    if (rc != 0)
        fprintf(stderr, "warning: SCHED_FIFO %d failed: %s\n", prio, strerror(rc));
}

static void sleep_ms(long ms)
{
    struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
    nanosleep(&ts, NULL);
}

static void *heartbeat_thread(void *arg)
{
    (void)arg;
    set_prio(HB_PRIO);
    for (;;) {
        for (int t = 0; t < HB_BURST_MS; t += HB_PERIOD_MS) {
            if (MsgSendPulse(g_coid, HB_PRIO, PULSE_HB, 0) == -1)
                perror("MsgSendPulse");
            sleep_ms(HB_PERIOD_MS);
        }
        sleep_ms(HB_SILENCE_MS);              /* the "heartbeat stops" window */
    }
    return NULL;
}

struct hog_cfg { int prio; int seconds; };

static void *hog_thread(void *arg)
{
    const struct hog_cfg *cfg = arg;
    long long end = now_ns() + cfg->seconds * 1000000000LL;
    set_prio(cfg->prio);
    while (now_ns() < end)
        ;                                     /* burn CPU; ends by itself so the target stays usable */
    return NULL;
}

static void usage(const char *p)
{
    fprintf(stderr, "usage: %s [-n trials] [-H hog_prio -N hog_count -T hog_seconds]\n", p);
    exit(2);
}

int main(int argc, char **argv)
{
    int trials = 10, hog_prio = 0, hog_n = 0;
    struct hog_cfg hog = { 0, 5 };
    int opt;

    while ((opt = getopt(argc, argv, "n:H:N:T:")) != -1) {
        switch (opt) {
        case 'n': trials = atoi(optarg); break;
        case 'H': hog_prio = atoi(optarg); break;
        case 'N': hog_n = atoi(optarg); break;
        case 'T': hog.seconds = atoi(optarg); break;
        default:  usage(argv[0]);
        }
    }
    hog.prio = hog_prio;

    set_prio(WD_PRIO);

    g_chid = ChannelCreate(_NTO_CHF_FIXED_PRIORITY);
    if (g_chid == -1) { perror("ChannelCreate"); return 1; }
    g_coid = ConnectAttach(0, 0, g_chid, _NTO_SIDE_CHANNEL, 0);
    if (g_coid == -1) { perror("ConnectAttach"); return 1; }

    /* 100 Hz periodic timer that delivers a pulse instead of a signal. */
    struct sigevent ev;
    struct itimerspec its = { { 0, 1000000000L / TICK_HZ }, { 0, 1000000000L / TICK_HZ } };
    timer_t tid;
    SIGEV_PULSE_INIT(&ev, g_coid, WD_PRIO, PULSE_TICK, 0);
    if (timer_create(CLOCK_MONOTONIC, &ev, &tid) == -1 || timer_settime(tid, 0, &its, NULL) == -1) {
        perror("timer");
        return 1;
    }

    pthread_t th;
    pthread_create(&th, NULL, heartbeat_thread, NULL);
    for (int i = 0; i < hog_n; i++)
        pthread_create(&th, NULL, hog_thread, &hog);

    printf("watchdog: deadline %d ms, tick %d Hz, hogs %d @ prio %d\n", DEADLINE_MS, TICK_HZ, hog_n, hog_prio);

    long long last_hb = 0;
    int armed = 0, done = 0;
    while (done < trials) {
        struct _pulse p;
        int rcvid = MsgReceive(g_chid, &p, sizeof(p), NULL);
        if (rcvid == -1) {
            if (errno == EINTR) continue;
            perror("MsgReceive");
            return 1;
        }
        if (rcvid != 0) { MsgError(rcvid, ENOSYS); continue; }   /* only pulses expected */

        if (p.code == PULSE_HB) {
            last_hb = now_ns();
            armed = 1;
        } else if (p.code == PULSE_TICK && armed) {
            long long now = now_ns();
            if (now - last_hb > DEADLINE_MS * 1000000LL) {
                printf("trial %2d: deadline miss detected %.2f ms after last heartbeat\n",
                       ++done, (double)(now - last_hb) / 1e6);
                armed = 0;                    /* re-arm on the next heartbeat */
            }
        }
    }
    return 0;
}
