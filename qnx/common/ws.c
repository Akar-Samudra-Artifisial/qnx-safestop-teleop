#include "ws.h"

#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define WS_GUID "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/* ---- SHA-1 (FIPS 180-1), only used for the handshake ---- */

typedef struct {
    uint32_t h[5];
    uint64_t bits;
    uint8_t block[64];
    size_t used;
} sha1_t;

static uint32_t rol(uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }

static void sha1_block(sha1_t *s, const uint8_t *b)
{
    uint32_t w[80], a, bb, c, d, e, t;
    int i;

    for (i = 0; i < 16; i++)
        w[i] = (uint32_t)b[4 * i] << 24 | (uint32_t)b[4 * i + 1] << 16
             | (uint32_t)b[4 * i + 2] << 8 | b[4 * i + 3];
    for (; i < 80; i++)
        w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    a = s->h[0]; bb = s->h[1]; c = s->h[2]; d = s->h[3]; e = s->h[4];
    for (i = 0; i < 80; i++) {
        uint32_t f, k;
        if (i < 20)      { f = (bb & c) | (~bb & d);           k = 0x5A827999; }
        else if (i < 40) { f = bb ^ c ^ d;                     k = 0x6ED9EBA1; }
        else if (i < 60) { f = (bb & c) | (bb & d) | (c & d);  k = 0x8F1BBCDC; }
        else             { f = bb ^ c ^ d;                     k = 0xCA62C1D6; }
        t = rol(a, 5) + f + e + k + w[i];
        e = d; d = c; c = rol(bb, 30); bb = a; a = t;
    }
    s->h[0] += a; s->h[1] += bb; s->h[2] += c; s->h[3] += d; s->h[4] += e;
}

static void sha1(const uint8_t *data, size_t len, uint8_t out[20])
{
    sha1_t s = { { 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0 }, 0, { 0 }, 0 };
    size_t i;

    s.bits = (uint64_t)len * 8;
    for (i = 0; i < len; i++) {
        s.block[s.used++] = data[i];
        if (s.used == 64) { sha1_block(&s, s.block); s.used = 0; }
    }
    s.block[s.used++] = 0x80;
    if (s.used > 56) {
        while (s.used < 64) s.block[s.used++] = 0;
        sha1_block(&s, s.block);
        s.used = 0;
    }
    while (s.used < 56) s.block[s.used++] = 0;
    for (i = 0; i < 8; i++)
        s.block[56 + i] = (uint8_t)(s.bits >> (56 - 8 * i));
    sha1_block(&s, s.block);
    for (i = 0; i < 5; i++) {
        out[4 * i] = (uint8_t)(s.h[i] >> 24);
        out[4 * i + 1] = (uint8_t)(s.h[i] >> 16);
        out[4 * i + 2] = (uint8_t)(s.h[i] >> 8);
        out[4 * i + 3] = (uint8_t)s.h[i];
    }
}

static void base64(const uint8_t *in, size_t len, char *out)
{
    static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t i, o = 0;

    for (i = 0; i + 2 < len; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16 | (uint32_t)in[i + 1] << 8 | in[i + 2];
        out[o++] = tbl[v >> 18]; out[o++] = tbl[(v >> 12) & 63];
        out[o++] = tbl[(v >> 6) & 63]; out[o++] = tbl[v & 63];
    }
    if (i < len) {
        uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < len ? (uint32_t)in[i + 1] << 8 : 0);
        out[o++] = tbl[v >> 18]; out[o++] = tbl[(v >> 12) & 63];
        out[o++] = i + 1 < len ? tbl[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    out[o] = '\0';
}

/* ---- sockets ---- */

static int send_all(int fd, const uint8_t *p, size_t len)
{
    while (len > 0) {
        ssize_t n = send(fd, p, len, 0);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

int ws_listen(uint16_t port)
{
    struct sockaddr_in sa;
    int one = 1;
    int fd = socket(AF_INET, SOCK_STREAM, 0);

    if (fd < 0)
        return -1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    memset(&sa, 0, sizeof(sa));
    sa.sin_family = AF_INET;
    sa.sin_addr.s_addr = htonl(INADDR_ANY);
    sa.sin_port = htons(port);
    if (bind(fd, (struct sockaddr *)&sa, sizeof(sa)) < 0 || listen(fd, 4) < 0) {
        int e = errno;
        close(fd);
        errno = e;
        return -1;
    }
    return fd;
}

void ws_pending_start(ws_pending_t *p, int fd, int64_t now_ns, int timeout_ms)
{
    int fl = fcntl(fd, F_GETFL);

    if (fl != -1)
        fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    p->fd = fd;
    p->deadline_ns = now_ns + (int64_t)timeout_ms * 1000000LL;
    p->used = 0;
    p->req[0] = '\0';
}

/* Copy the trimmed value of header `name` (case-insensitive) into out. 1 = found. */
static int get_header(const char *req, const char *name, char *out, size_t outlen)
{
    size_t nl = strlen(name);
    const char *line = strstr(req, "\r\n");

    while (line && line[2] != '\r' && line[2] != '\0') {
        line += 2;
        if (strncasecmp(line, name, nl) == 0 && line[nl] == ':') {
            const char *v = line + nl + 1;
            size_t n = 0;
            while (*v == ' ' || *v == '\t')
                v++;
            while (v[n] && v[n] != '\r' && n < outlen - 1)
                n++;
            while (n > 0 && (v[n - 1] == ' ' || v[n - 1] == '\t'))
                n--;
            memcpy(out, v, n);
            out[n] = '\0';
            return 1;
        }
        line = strstr(line, "\r\n");
    }
    out[0] = '\0';
    return 0;
}

/* Extract query parameter "t" from "GET <target> HTTP/1.1". Only [A-Za-z0-9] is accepted
 * (no percent-decoding needed); anything else yields "". */
static void get_token(const char *req, char *out, size_t outlen)
{
    const char *end = strchr(req + 4, ' ');
    const char *q = strchr(req + 4, '?');

    out[0] = '\0';
    if (!end || !q || q > end)
        return;
    q++;
    while (q < end) {
        const char *amp = memchr(q, '&', (size_t)(end - q));
        const char *stop = amp ? amp : end;
        if (stop - q > 2 && q[0] == 't' && q[1] == '=') {
            size_t n = (size_t)(stop - q - 2), i;
            if (n >= outlen)
                return;
            for (i = 0; i < n; i++) {
                char ch = q[2 + i];
                if (!((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')))
                    return;
            }
            memcpy(out, q + 2, n);
            out[n] = '\0';
            return;
        }
        q = stop + 1;
    }
}

int ws_pending_read(ws_pending_t *p, ws_request_t *r)
{
    ssize_t n = recv(p->fd, p->req + p->used, sizeof(p->req) - 1 - p->used, 0);

    if (n < 0)
        return (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) ? 0 : -1;
    if (n == 0)
        return -1;
    p->used += (size_t)n;
    p->req[p->used] = '\0';
    if (!strstr(p->req, "\r\n\r\n")) {
        if (p->used >= sizeof(p->req) - 1) {
            ws_reject(p->fd, 400, "Bad Request");
            return -1;
        }
        return 0;
    }
    memset(r, 0, sizeof(*r));
    get_header(p->req, "Sec-WebSocket-Key", r->key, sizeof(r->key));
    r->has_origin = get_header(p->req, "Origin", r->origin, sizeof(r->origin));
    get_header(p->req, "Host", r->host, sizeof(r->host));
    if (strncmp(p->req, "GET ", 4) != 0 || r->key[0] == '\0') {
        ws_reject(p->fd, 400, "Bad Request");
        return -1;
    }
    get_token(p->req, r->token, sizeof(r->token));
    return 1;
}

int ws_accept(int fd, const ws_request_t *r, int send_timeout_ms)
{
    char src[128], resp[256], accept_b64[32];
    uint8_t digest[20];
    struct timeval tv = { send_timeout_ms / 1000, (send_timeout_ms % 1000) * 1000 };
    int one = 1, fl = fcntl(fd, F_GETFL);

    if (fl != -1)
        fcntl(fd, F_SETFL, fl & ~O_NONBLOCK);
    /* A client that stops reading must not block the net thread: sends fail after this. */
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    snprintf(src, sizeof(src), "%s%s", r->key, WS_GUID);
    sha1((const uint8_t *)src, strlen(src), digest);
    base64(digest, sizeof(digest), accept_b64);
    snprintf(resp, sizeof(resp),
             "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
             "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept_b64);
    return send_all(fd, (const uint8_t *)resp, strlen(resp));
}

void ws_reject(int fd, int status, const char *reason)
{
    char resp[160];
    int n = snprintf(resp, sizeof(resp),
                     "HTTP/1.1 %d %s\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", status, reason);

    if (n > 0)
        (void)send(fd, resp, (size_t)n, 0);   /* best effort, fd may be non-blocking */
}

int ws_secure_streq(const char *a, const char *b)
{
    size_t la = strlen(a), lb = strlen(b), i;
    unsigned diff = (unsigned)(la ^ lb);

    for (i = 0; i < la; i++)
        diff |= (unsigned char)a[i] ^ (unsigned char)(i < lb ? b[i] : 0);
    return diff == 0;
}

int ws_send(int fd, int opcode, const void *data, size_t len)
{
    uint8_t frame[WS_MAX_PAYLOAD + 10];
    size_t h = 0;

    if (len > WS_MAX_PAYLOAD)
        return -1;
    frame[h++] = (uint8_t)(0x80 | (opcode & 0x0F));
    if (len < 126) {
        frame[h++] = (uint8_t)len;
    } else {
        frame[h++] = 126;
        frame[h++] = (uint8_t)(len >> 8);
        frame[h++] = (uint8_t)len;
    }
    memcpy(frame + h, data, len);
    return send_all(fd, frame, h + len);
}

void ws_send_close(int fd, uint16_t code)
{
    uint8_t p[2] = { (uint8_t)(code >> 8), (uint8_t)code };
    (void)ws_send(fd, WS_OP_CLOSE, p, sizeof(p));
}

int ws_on_readable(ws_conn_t *c, const ws_handlers_t *h)
{
    ssize_t n = recv(c->fd, c->buf + c->len, sizeof(c->buf) - c->len, 0);

    if (n <= 0)
        return -1;
    c->len += (size_t)n;

    for (;;) {
        uint8_t *b = c->buf;
        size_t hdr = 2, plen, i;
        int fin, op;

        if (c->len < 2)
            return 0;
        fin = b[0] & 0x80;
        op = b[0] & 0x0F;
        if (b[0] & 0x70) {              /* RSV1-3: no extensions negotiated */
            ws_send_close(c->fd, WS_CLOSE_PROTOCOL);
            return -1;
        }
        if (!(b[1] & 0x80)) {           /* client frames must be masked */
            ws_send_close(c->fd, WS_CLOSE_PROTOCOL);
            return -1;
        }
        plen = b[1] & 0x7F;
        if (plen == 126) {
            if (c->len < 4)
                return 0;
            plen = (size_t)b[2] << 8 | b[3];
            hdr = 4;
        } else if (plen == 127) {       /* 64-bit lengths are always > WS_MAX_PAYLOAD */
            ws_send_close(c->fd, WS_CLOSE_TOO_BIG);
            return -1;
        }
        if ((op & 0x8) && (!fin || plen > 125)) {  /* RFC 6455 5.5: control frames */
            ws_send_close(c->fd, WS_CLOSE_PROTOCOL);
            return -1;
        }
        if (plen > WS_MAX_PAYLOAD) {
            ws_send_close(c->fd, WS_CLOSE_TOO_BIG);
            return -1;
        }
        if (c->len < hdr + 4 + plen)
            return 0;

        {
            const uint8_t *mask = b + hdr;
            uint8_t *payload = b + hdr + 4;
            char text[WS_MAX_PAYLOAD + 1];

            for (i = 0; i < plen; i++)
                payload[i] ^= mask[i & 3];

            if (!fin || op == 0x0 || op == 0x2) {   /* fragmentation / binary unsupported */
                ws_send_close(c->fd, WS_CLOSE_UNSUPPORTED);
                return -1;
            }
            switch (op) {
            case WS_OP_TEXT:
                memcpy(text, payload, plen);
                text[plen] = '\0';
                if (h->on_text)
                    h->on_text(h->ctx, text, plen);
                break;
            case WS_OP_PING:
                if (ws_send(c->fd, WS_OP_PONG, payload, plen) < 0)
                    return -1;
                break;
            case WS_OP_PONG:
                if (h->on_pong)
                    h->on_pong(h->ctx, payload, plen);
                break;
            case WS_OP_CLOSE:
                ws_send_close(c->fd, WS_CLOSE_NORMAL);
                return -1;
            default:
                ws_send_close(c->fd, WS_CLOSE_PROTOCOL);
                return -1;
            }
        }
        {
            size_t used = hdr + 4 + plen;
            memmove(c->buf, c->buf + used, c->len - used);
            c->len -= used;
        }
    }
}
