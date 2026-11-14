/* M1 smoke test: proves the qcc aarch64le cross toolchain produces a runnable QNX binary. */
#include <stdio.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(void)
{
    struct utsname u;

    if (uname(&u) != 0) {
        perror("uname");
        return 1;
    }
    printf("hello from QNX: %s %s %s (pid %d)\n", u.sysname, u.release, u.machine, (int)getpid());
    return 0;
}
