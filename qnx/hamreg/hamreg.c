/* hamreg: registers simplant with the High Availability Manager (ham must be running) and
 * stays resident as the restart governor.
 *   ham_attach(pid<=0)      HAM starts "<simplant> -v" and monitors it
 *   CONDDEATH actions       notify_pulse -> hamreg, waitfor delay, restart (all re-armed)
 * HAM itself has no restart limit, so hamreg counts the notify pulses (sent BEFORE the
 * delay) and detaches the entity when more than MAX_RESTARTS deaths fall in WINDOW_S,
 * which stops a crash loop. Usage: hamreg [-d delay_ms] [-n max] [-w window_s] <simplant path> */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/neutrino.h>
#include <ha/ham.h>

#define ENAME       "simplant"
#define PULSE_DEATH (_PULSE_CODE_MINAVAIL + 1)

static int64_t now_s(void)
{
    struct timespec ts;

    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec;
}

static int die(const char *what)
{
    fprintf(stderr, "hamreg: %s failed: %s\n", what, strerror(errno));
    return 1;
}

int main(int argc, char **argv)
{
    long delay_ms = 100, max_restarts = 5, window_s = 60;
    char line[256];
    int opt, chid, n;
    ham_entity_t *ent;
    ham_condition_t *cond;
    int64_t stamps[64];
    long head = 0;

    while ((opt = getopt(argc, argv, "d:n:w:")) != -1) {
        char *end;
        long v;

        if (opt != 'd' && opt != 'n' && opt != 'w')
            goto usage;
        v = strtol(optarg, &end, 10);
        if (*end || v < 1 || v > 60000 || (opt == 'n' && v > 63))
            goto usage;
        if (opt == 'd')
            delay_ms = v;
        else if (opt == 'n')
            max_restarts = v;
        else
            window_s = v;
    }
    if (optind + 1 != argc) {
usage:
        fprintf(stderr, "usage: %s [-d delay_ms] [-n max_restarts<=63] [-w window_s] <simplant path>\n",
                argv[0]);
        return 2;
    }
    n = snprintf(line, sizeof(line), "%s -v", argv[optind]);
    if (n < 0 || n >= (int)sizeof(line)) {
        fprintf(stderr, "hamreg: path too long\n");
        return 2;
    }

    chid = ChannelCreate(0);
    if (chid == -1)
        return die("ChannelCreate");
    ent = ham_attach(ENAME, 0, 0, line, 0);
    if (!ent)
        return die("ham_attach (is ham running?)");
    if (ham_connect(0) == -1)
        return die("ham_connect");
    cond = ham_condition(ent, CONDDEATH, "death", HREARMAFTERRESTART);
    if (!cond)
        return die("ham_condition(CONDDEATH)");
    /* Actions run in the order added. */
    if (!ham_action_notify_pulse(cond, "count", 0, getpid(), chid, PULSE_DEATH, 0, HREARMAFTERRESTART))
        return die("ham_action_notify_pulse");
    if (!ham_action_waitfor(cond, "delay", NULL, (int)delay_ms, HREARMAFTERRESTART))
        return die("ham_action_waitfor");
    if (!ham_action_restart(cond, "restart", line, HREARMAFTERRESTART))
        return die("ham_action_restart");
    printf("hamreg: %s under HAM (restart after %ld ms, max %ld per %ld s)\n", ENAME, delay_ms,
           max_restarts, window_s);
    fflush(stdout);

    for (;;) {
        struct _pulse p;
        int64_t t;
        long i, recent = 0;

        if (MsgReceive(chid, &p, sizeof(p), NULL) == -1) {
            if (errno == EINTR)
                continue;
            return die("MsgReceive");
        }
        if (p.code != PULSE_DEATH)
            continue;
        t = now_s();
        stamps[head++ % 64] = t;
        for (i = 0; i < 64 && i < head; i++)
            if (t - stamps[i] < window_s)
                recent++;
        printf("hamreg: %s died (%ld in last %ld s)\n", ENAME, recent, window_s);
        fflush(stdout);
        if (recent > max_restarts) {
            if (ham_detach_name(0, ENAME, 0) == -1)
                return die("ham_detach_name");
            printf("hamreg: restart limit exceeded, %s detached, not restarting\n", ENAME);
            fflush(stdout);
            return 3;
        }
    }
}
