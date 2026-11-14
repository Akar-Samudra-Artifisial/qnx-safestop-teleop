/* Minimal RFC 6455 WebSocket server: handshake, masked text frames from the client,
 * ping/pong, close. No fragmentation, no extensions, single-frame payload <= WS_MAX_PAYLOAD. */
#ifndef WS_H
#define WS_H

#include <stddef.h>
#include <stdint.h>

#define WS_MAX_PAYLOAD 4096
#define WS_REQ_MAX     4096

#define WS_OP_TEXT  0x1
#define WS_OP_CLOSE 0x8
#define WS_OP_PING  0x9
#define WS_OP_PONG  0xA

#define WS_CLOSE_NORMAL      1000
#define WS_CLOSE_PROTOCOL    1002
#define WS_CLOSE_UNSUPPORTED 1003
#define WS_CLOSE_TOO_BIG     1009

typedef struct {
    /* text is NUL-terminated (copy owned by the parser, valid during the call). */
    void (*on_text)(void *ctx, const char *text, size_t len);
    void (*on_pong)(void *ctx, const uint8_t *data, size_t len);
    void *ctx;
} ws_handlers_t;

typedef struct {
    int fd;
    size_t len;
    uint8_t buf[WS_MAX_PAYLOAD + 14];
} ws_conn_t;

/* An accepted TCP connection whose HTTP upgrade request is still being read
 * (non-blocking, so a slow client cannot stall the caller). */
typedef struct {
    int fd;                     /* -1 = slot free */
    int64_t deadline_ns;        /* CLOCK_MONOTONIC */
    size_t used;
    char req[WS_REQ_MAX];
} ws_pending_t;

/* Parsed upgrade request (copies, NUL-terminated). */
typedef struct {
    char key[64];
    char token[40];             /* value of query parameter "t", "" if absent */
    char origin[128];           /* "" if absent */
    int has_origin;
} ws_request_t;

/* TCP listen socket on 0.0.0.0:port. Returns fd or -1 (errno set). */
int ws_listen(uint16_t port);

/* Take ownership of fd: non-blocking reads, handshake must finish within timeout_ms. */
void ws_pending_start(ws_pending_t *p, int fd, int64_t now_ns, int timeout_ms);

/* Call when p->fd is readable. 1 = full request parsed into *r, 0 = need more,
 * -1 = invalid/too large/closed (caller closes; a 400 was sent when malformed). */
int ws_pending_read(ws_pending_t *p, ws_request_t *r);

/* Send "101 Switching Protocols" and switch fd back to blocking with a send timeout.
 * Returns 0 or -1. */
int ws_accept(int fd, const ws_request_t *r, int send_timeout_ms);

/* Send an HTTP error status (401/403/409/...) with Connection: close. Best effort. */
void ws_reject(int fd, int status, const char *reason);

/* Constant-time string comparison (time depends only on the length of a). 1 = equal. */
int ws_secure_streq(const char *a, const char *b);

/* Call when c->fd is readable. Dispatches complete frames; answers ping and close.
 * Returns 0 while the connection is usable, -1 when it must be closed. */
int ws_on_readable(ws_conn_t *c, const ws_handlers_t *h);

/* Send one unmasked frame. Returns 0 or -1 (incl. send timeout). */
int ws_send(int fd, int opcode, const void *data, size_t len);

/* Send a close frame with code (best effort). Does not close the fd. */
void ws_send_close(int fd, uint16_t code);

#endif
