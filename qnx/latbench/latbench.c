/* latbench: CPU-hog fault injector for the safe-stop latency bench.
 *
 *   latbench -p <prio> -s <seconds> [-n <threads>] [-r]
 *
 * Starts <threads> busy-loop threads (default: one per online CPU) at SCHED_FIFO <prio>
 * (-r: SCHED_RR), set with pthread_setschedparam(), each spinning until <seconds> have
 * elapsed on CLOCK_MONOTONIC. Every thread checks the clock itself, so the hog ends on
 * time even when it starves everything at or below <prio> (this main thread, sshd).
 *
 * teleopd: control SCHED_FIFO 50, net/resmgr SCHED_RR 10:
 *   prio 10 RR   -> shares the CPUs with net (timeslice), preempted by control.
 *   prio 10 FIFO -> net/sshd starve (no hb processed), control still safe-stops on time.
 *   prio >= 50   -> misconfiguration: FIFO at equal priority never yields, so the control
 *                   tick cannot run until the hog stops.
 * The host side (tools/wsclient/wsclient.py --bench) measures detect_us; see docs/BENCH.md. */
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_THREADS 16
#define MAX_SECONDS 3600

static int64_t g_end_ns;
static int g_policy = SCHED_FIFO;
static volatile uint64_t g_sink;

static int64_t now_ns(void)
{
    struct timespec ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void *hog(void *arg)
{
    int prio = *(const int *)arg, rc;
    struct sched_param sp = { .sched_priority = prio };
    uint64_t x = 0;

    rc = pthread_setschedparam(pthread_self(), g_policy, &sp);
    if (rc != 0) {
        fprintf(stderr, "latbench: pthread_setschedparam(%s, %d): %s\n",
                g_policy == SCHED_RR ? "SCHED_RR" : "SCHED_FIFO", prio, strerror(rc));
        return NULL;
    }
    pthread_setname_np(pthread_self(), "hog");
    while (now_ns() < g_end_ns) {
        int i;
        for (i = 0; i < 10000; i++)
            x = x * 6364136223846793005ULL + 1442695040888963407ULL;
    }
    g_sink = x;
    return NULL;
}

static long parse(const char *s, long lo, long hi, const char *what)
{
    char *end;
    long v;

    errno = 0;
    v = strtol(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0' || v < lo || v > hi) {
        fprintf(stderr, "latbench: %s must be an integer %ld..%ld\n", what, lo, hi);
        exit(2);
    }
    return v;
}

int main(int argc, char **argv)
{
    pthread_t tid[MAX_THREADS];
    int prio = -1, opt, i, started = 0, prio_max = sched_get_priority_max(SCHED_FIFO);
    long secs = -1, cpus = sysconf(_SC_NPROCESSORS_ONLN), nthreads = 0;

    while ((opt = getopt(argc, argv, "p:s:n:r")) != -1) {
        switch (opt) {
        case 'p': prio = (int)parse(optarg, 1, prio_max > 0 ? prio_max : 255, "-p prio"); break;
        case 's': secs = parse(optarg, 1, MAX_SECONDS, "-s seconds"); break;
        case 'n': nthreads = parse(optarg, 1, MAX_THREADS, "-n threads"); break;
        case 'r': g_policy = SCHED_RR; break;
        default:
            fprintf(stderr, "usage: %s -p <prio> -s <seconds> [-n <threads>] [-r]\n", argv[0]);
            return 2;
        }
    }
    if (prio < 0 || secs < 0) {
        fprintf(stderr, "usage: %s -p <prio> -s <seconds> [-n <threads>] [-r]\n", argv[0]);
        return 2;
    }
    if (nthreads == 0)
        nthreads = cpus > 0 ? (cpus < MAX_THREADS ? cpus : MAX_THREADS) : 1;

    printf("latbench: %ld hog thread(s) %s %d for %ld s (%ld CPU online)\n", nthreads,
           g_policy == SCHED_RR ? "SCHED_RR" : "SCHED_FIFO", prio, secs, cpus);
    fflush(stdout);
    g_end_ns = now_ns() + secs * 1000000000LL;
    for (i = 0; i < nthreads; i++) {
        int rc = pthread_create(&tid[i], NULL, hog, &prio);
        if (rc != 0) {
            fprintf(stderr, "latbench: pthread_create: %s\n", strerror(rc));
            break;
        }
        started++;
    }
    for (i = 0; i < started; i++)
        pthread_join(tid[i], NULL);
    printf("latbench: done\n");
    return started == nthreads ? 0 : 1;
}
