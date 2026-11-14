#!/usr/bin/env python3
"""Host test client for teleopd (Python 3 stdlib only).

Runs, against ws://HOST:PORT/:
  1. state is received; arm; pose changes while cmd is sent
  2. N heartbeat-loss trials: hb+cmd, stop hb, time until event SAFE_STOP (hb_timeout)
  3. estop latency
  4. cmd rejected while SAFE_STOP (before re-arm), accepted after arm; stale-ts cmd rejected

  5. pairing: 401 wrong/missing token, 403 foreign Origin, 409 second client while ARMED
  6. NaN/Infinity/non-integer seq|ts rejected; estop zeroes vel at once; arm+estop race

Usage: tools/wsclient/wsclient.py --token 123456 [--host localhost] [--port 8080] [--trials 20]
       (token also from TELEOP_TOKEN)
Exit code 0 when every check passes.
"""

import argparse
import base64
import csv
import hashlib
import json
import math
import os
import queue
import socket
import statistics
import struct
import sys
import threading
import time

HB_PERIOD = 0.05  # 20 Hz


class HandshakeRejected(ConnectionError):
    def __init__(self, status, head):
        super().__init__(f"handshake rejected: {head[:60]!r}")
        self.status = status


class WsClient:
    def __init__(self, host, port, token, origin=None, host_header=None):
        self.sock = socket.create_connection((host, port), timeout=5)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        path = "/" if token is None else f"/?t={token}"
        extra = f"Origin: {origin}\r\n" if origin is not None else ""
        host_header = host_header or f"{host}:{port}"
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host_header}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            f"{extra}\r\n"
        )
        self.sock.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            chunk = self.sock.recv(1024)
            if not chunk:
                raise ConnectionError("handshake: connection closed")
            resp += chunk
        head, self.buf = resp.split(b"\r\n\r\n", 1)
        if not head.startswith(b"HTTP/1.1 101"):
            parts = head.split(b" ", 2)
            status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
            self.sock.close()
            raise HandshakeRejected(status, head)

        want = base64.b64encode(
            hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()
        )
        if want not in head:
            raise ConnectionError("bad Sec-WebSocket-Accept")
        self.sock.settimeout(None)
        self.lock = threading.Lock()
        self.msgs = queue.Queue()
        self.closed = False
        threading.Thread(target=self._reader, daemon=True).start()

    def _send_frame(self, op, payload):
        mask = os.urandom(4)
        n = len(payload)
        hdr = bytes([0x80 | op])
        hdr += (
            bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n)
        )
        body = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self.lock:
            self.sock.sendall(hdr + mask + body)

    def send(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode())

    def send_raw(self, text):
        self._send_frame(0x1, text.encode())

    def send_many(self, objs):
        """Several text frames in one TCP write (back-to-back arrival)."""
        frames = b""
        for obj in objs:
            payload = json.dumps(obj).encode()
            mask = os.urandom(4)
            frames += bytes([0x81, 0x80 | len(payload)]) + mask
            frames += bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        with self.lock:
            self.sock.sendall(frames)

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _reader(self):
        try:
            while True:
                b0, b1 = self._recv_exact(2)
                op, n = b0 & 0x0F, b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self._recv_exact(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self._recv_exact(8))[0]
                payload = self._recv_exact(n)
                t = time.monotonic()
                if op == 0x1:
                    self.msgs.put((t, json.loads(payload)))
                elif op == 0x9:
                    self._send_frame(0xA, payload)
                elif op == 0x8:
                    break
        except (ConnectionError, OSError):
            pass
        self.closed = True

    def close(self):
        try:
            self._send_frame(0x8, struct.pack(">H", 1000))
        except OSError:
            pass
        self.sock.close()


class Session:
    """Background heartbeat (and optional cmd) sender plus message bookkeeping."""

    def __init__(self, ws):
        self.ws = ws
        self.hb_on = threading.Event()
        self.cmd = None  # (v, w) or None
        self.cmd_ts_offset_ms = 0
        self.hb_seq = 0
        self.cmd_seq = 0
        self.last_hb_sent = 0.0
        self.state = None
        self.state_t = 0.0
        self.events = []
        self.stats_msg = None
        threading.Thread(target=self._sender, daemon=True).start()

    def _sender(self):
        nxt = time.monotonic()
        while not self.ws.closed:
            if self.hb_on.is_set():
                self.hb_seq += 1
                self.ws.send(
                    {"type": "hb", "seq": self.hb_seq, "ts": int(time.time() * 1000)}
                )
                self.last_hb_sent = time.monotonic()
                if self.cmd is not None:
                    self.send_cmd(*self.cmd)
            nxt += HB_PERIOD
            time.sleep(max(0.0, nxt - time.monotonic()))

    def send_cmd(self, v, w, ts_offset_ms=None):
        self.cmd_seq += 1
        off = self.cmd_ts_offset_ms if ts_offset_ms is None else ts_offset_ms
        self.ws.send(
            {
                "type": "cmd",
                "seq": self.cmd_seq,
                "v": v,
                "w": w,
                "ts": int(time.time() * 1000) + off,
            }
        )

    def pump(self, timeout):
        """Process messages for up to timeout s; returns list of (t, event) seen."""
        end = time.monotonic() + timeout
        seen = []
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return seen
            try:
                t, m = self.ws.msgs.get(timeout=left)
            except queue.Empty:
                return seen
            if m.get("type") == "state":
                self.state = m
                self.state_t = t
            elif m.get("type") == "event":
                self.events.append((t, m))
                seen.append((t, m))
            elif m.get("type") == "stats":
                self.stats_msg = m

    def wait_event(self, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            seen = self.pump(min(0.01, end - time.monotonic()))
            if seen:
                return seen[0]
        return None

    def wait_mode(self, mode, timeout):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump(0.02)
            if self.state and self.state["mode"] == mode:
                return True
        return False

    def arm(self):
        self.ws.send({"type": "arm"})
        return self.wait_mode("ARMED", 1.0)

    def next_state(self, after, timeout=0.5):
        """First state received after monotonic time `after` (None on timeout)."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            self.pump(0.01)
            if self.state is not None and self.state_t > after:
                return self.state
        return None

    def request_stats(self, timeout=1.0):
        """Send stats_req; returns the next stats message (None on timeout)."""
        self.stats_msg = None
        self.ws.send({"type": "stats_req"})
        end = time.monotonic() + timeout
        while time.monotonic() < end and self.stats_msg is None:
            self.pump(0.02)
        return self.stats_msg


def stats(xs):
    return f"min {min(xs):.1f} / median {statistics.median(xs):.1f} / max {max(xs):.1f}"


def pct(sorted_xs, p):
    """Nearest-rank percentile (same definition as teleopd's stats)."""
    k = max(1, math.ceil(p * len(sorted_xs)))
    return sorted_xs[k - 1]


STATS_LE_US = [150000, 152000, 154000, 156000, 158000, 160000, 165000, 170000, None]


def stats_msg_ok(m):
    """Structure check of a teleopd "stats" message; returns (ok, detail)."""
    if not m:
        return False, "no stats reply"
    b = m.get("buckets") or []
    les = [x.get("le_us") for x in b]
    total = sum(x.get("count", 0) for x in b)
    ok = (
        les == STATS_LE_US
        and total == m.get("n")
        and (m["n"] == 0 or m["p50_us"] <= m["p99_us"] <= m["max_us"])
    )
    return ok, (
        f"n={m.get('n')} p50 {m.get('p50_us')} / p99 {m.get('p99_us')} / "
        f"max {m.get('max_us')} us, {len(b)} buckets sum {total}"
    )


def run_bench(a):
    """--bench N: N hb-loss trials, one CSV row per trial, p50/p99/max summary."""
    ws = WsClient(a.host, a.port, a.token)
    s = Session(ws)
    s.hb_on.set()
    s.pump(0.5)
    rows = []
    t_start = time.time()
    for i in range(a.bench):
        armed = bool(s.state and s.state["mode"] == "ARMED")
        for _ in range(5):
            if armed:
                break
            s.hb_on.set()
            s.pump(1.0)
            armed = s.arm()
        if not armed:
            print(
                f"trial {i}: arm failed (mode={s.state and s.state['mode']})",
                file=sys.stderr,
            )
            break
        s.pump(0.25)
        s.hb_on.clear()
        last = s.last_hb_sent
        ev = s.wait_event(10.0)
        if ev is None or ev[1]["reason"] != "hb_timeout":
            print(f"trial {i}: no hb_timeout event ({ev!r})", file=sys.stderr)
            break
        client_ms = round((ev[0] - last) * 1000, 3)
        # The server cannot detect a loss earlier than the client observed it, so detect_us
        # larger than client_ms means the guest clock ran ahead of the host clock (QEMU TCG
        # virtual-time catch-up or host sleep): flag it, it is not a teleopd latency.
        skew = int(ev[1]["detect_us"] / 1000 - client_ms > 5)
        rows.append((i, ev[1]["detect_us"], client_ms, skew))
        s.hb_on.set()
        # Wait for the SAFE_STOP state: a stale ARMED state would skip the next arm and the
        # trial would then wait for an event that cannot come.
        s.wait_mode("SAFE_STOP", 3.0)
        s.pump(0.1)
        if a.progress and (i + 1) % a.progress == 0:
            print(f"{i + 1}/{a.bench}", flush=True)
    srv = s.request_stats()
    ws.close()
    if a.csv:
        with open(a.csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["trial", "detect_us", "client_ms", "clock_skew"])
            w.writerows(rows)
    if not rows:
        print("no trials completed", file=sys.stderr)
        return 1
    d = sorted(r[1] / 1000 for r in rows)
    print(
        f"label={a.label} trials={len(rows)}/{a.bench} "
        f"elapsed={time.time() - t_start:.0f}s detect_ms "
        f"p50={pct(d, 0.5):.2f} p99={pct(d, 0.99):.2f} max={d[-1]:.2f} min={d[0]:.2f} "
        f"clock_skew_trials={sum(r[3] for r in rows)}"
    )
    ok, detail = stats_msg_ok(srv)
    print(f"server stats ({'ok' if ok else 'BAD'}): {detail}")
    return 0 if len(rows) == a.bench else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="localhost")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--trials", type=int, default=20)
    ap.add_argument(
        "--max-detect-ms",
        type=float,
        default=170.0,
        help="pass bound for server detect_us (default: %(default)s = deadline 150 + "
        "tick 10 + 10 margin for QEMU TCG timer jitter; teleopd's deadline is unchanged)",
    )
    ap.add_argument("--race", type=int, default=20, help="arm+estop race iterations")
    ap.add_argument(
        "--token",
        default=os.environ.get("TELEOP_TOKEN"),
        help="pairing token printed by teleopd (default: $TELEOP_TOKEN)",
    )
    ap.add_argument(
        "--bench", type=int, default=0, help="bench mode: N hb-loss trials, no checks"
    )
    ap.add_argument("--csv", help="bench mode: write per-trial CSV here")
    ap.add_argument(
        "--label", default="", help="bench mode: label for the summary line"
    )
    ap.add_argument(
        "--progress", type=int, default=0, help="bench mode: print every N trials"
    )
    a = ap.parse_args()
    if not a.token:
        ap.error("--token or TELEOP_TOKEN is required")
    if a.bench:
        return run_bench(a)

    checks = []

    def check(name, ok, detail=""):
        checks.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}{': ' + detail if detail else ''}")

    def rejected_with(token, origin=None, host_header=None):
        try:
            WsClient(a.host, a.port, token, origin, host_header).close()
            return 101
        except HandshakeRejected as e:
            return e.status

    wrong = "000000" if a.token != "000000" else "111111"
    st = rejected_with(wrong)
    check("wrong token -> 401", st == 401, f"status {st}")
    st = rejected_with(None)
    check("missing token -> 401", st == 401, f"status {st}")
    st = rejected_with(a.token, "http://evil.example")
    check("foreign Origin -> 403", st == 403, f"status {st}")
    # iOS (SocketRocket) sends Origin http://<host>:<port> = the WS host itself.
    st = rejected_with(a.token, f"http://{a.host}:{a.port}")
    check("Origin same-host diterima -> 101", st == 101, f"status {st}")
    # DNS rebinding: attacker name resolving to the robot -> Host is a name, refused.
    st = rejected_with(
        a.token, f"http://evil.example:{a.port}", f"evil.example:{a.port}"
    )
    check(
        "same-host Origin with non-IP Host (rebinding) -> 403",
        st == 403,
        f"status {st}",
    )

    ws = WsClient(a.host, a.port, a.token)
    s = Session(ws)
    s.pump(0.3)
    check(
        "state received",
        s.state is not None,
        f"mode={s.state and s.state['mode']} plant_ok={s.state and s.state.get('plant_ok')}",
    )

    s.hb_on.set()
    s.pump(0.3)
    check(
        "arm accepted",
        s.arm(),
        f"seq_ack={s.state['seq_ack']} hb_age_ms={s.state['hb_age_ms']}",
    )

    p0 = dict(s.state["pose"])
    s.cmd = (0.5, 0.0)
    s.pump(2.0)
    p1 = s.state["pose"]
    dist = ((p1["x"] - p0["x"]) ** 2 + (p1["y"] - p0["y"]) ** 2) ** 0.5
    check(
        "pose changes with cmd",
        dist > 0.3,
        f"moved {dist:.2f} m in 2 s, vel={s.state['vel']} rtt={s.state['rtt']} ms",
    )

    # Heartbeat-loss trials (circle motion keeps the robot inside the 10x10 m area).
    client_ms, detect_ms = [], []
    for i in range(a.trials):
        if s.state["mode"] != "ARMED" and not s.arm():
            check(f"trial {i} re-arm", False)
            break
        s.cmd = (0.3, 1.0)
        s.pump(0.5)
        s.hb_on.clear()
        s.cmd = None
        last = s.last_hb_sent
        ev = s.wait_event(2.0)
        if ev is None or ev[1]["reason"] != "hb_timeout":
            check(f"trial {i} SAFE_STOP", False, repr(ev))
            break
        client_ms.append((ev[0] - last) * 1000)
        detect_ms.append(ev[1]["detect_us"] / 1000)
        s.hb_on.set()
        s.pump(0.2)
    if len(detect_ms) == a.trials:
        check(
            f"hb loss -> SAFE_STOP x{a.trials}, server detect_us (ms)",
            max(detect_ms) <= a.max_detect_ms,
            stats(detect_ms),
        )
        print(
            f"       client-observed last hb sent -> event recv (ms): {stats(client_ms)}"
        )
        m = s.request_stats()
        ok, detail = stats_msg_ok(m)
        check(
            "stats_req -> stats histogram (9 fixed buckets, counts sum to n)",
            ok and m["n"] >= len(detect_ms),
            detail,
        )

    s.pump(1.0)
    v_end = s.state["vel"]
    check(
        "velocity ramped to 0 after SAFE_STOP",
        abs(v_end["v"]) < 1e-3 and abs(v_end["w"]) < 1e-3,
        f"vel={v_end}",
    )

    # estop
    s.arm()
    s.cmd = (0.3, 0.0)
    s.pump(0.5)
    t0 = time.monotonic()
    ws.send({"type": "estop"})
    ev = s.wait_event(1.0)
    ok = ev is not None and ev[1]["reason"] == "estop"
    check(
        "estop -> SAFE_STOP",
        ok,
        f"client {((ev[0] - t0) * 1000):.1f} ms, server detect_us {ev[1]['detect_us']}"
        if ok
        else repr(ev),
    )
    st_after = s.next_state(ev[0]) if ok else None
    check(
        "estop zeroes velocity at once (first state after event)",
        st_after is not None
        and abs(st_after["vel"]["v"]) < 1e-6
        and abs(st_after["vel"]["w"]) < 1e-6,
        f"vel={st_after and st_after['vel']}",
    )

    # cmd rejected until re-arm (hb still running)
    s.cmd = (0.5, 0.5)
    s.pump(1.5)
    vel = s.state["vel"]
    check(
        "cmd rejected before re-arm",
        s.state["mode"] == "SAFE_STOP" and abs(vel["v"]) < 1e-3,
        f"mode={s.state['mode']} vel={vel}",
    )
    s.cmd = None
    s.pump(0.6)  # let the cmd hold expire
    armed = s.arm()
    s.cmd = (0.5, 0.0)
    s.pump(0.5)
    check(
        "cmd accepted after re-arm",
        armed and s.state["vel"]["v"] > 0.2,
        f"vel={s.state['vel']}",
    )

    # stale timestamp (1 s in the past) rejected
    s.cmd = None
    s.pump(1.0)
    s.cmd_ts_offset_ms = -1000
    s.cmd = (0.5, 0.0)
    s.pump(0.5)
    check(
        "stale-ts cmd rejected",
        abs(s.state["vel"]["v"]) < 1e-3,
        f"vel={s.state['vel']}",
    )
    s.cmd = None
    s.cmd_ts_offset_ms = 0

    # Non-finite / out-of-range numbers are rejected (raw JSON: json.dumps cannot emit NaN).
    s.pump(0.6)  # cmd hold expires -> target 0
    if s.state["mode"] != "ARMED":
        s.arm()
    for text in (
        '{"type":"cmd","seq":%d,"v":0.5,"w":0,"ts":NaN}',
        '{"type":"cmd","seq":%d,"v":0.5,"w":0,"ts":Infinity}',
        '{"type":"cmd","seq":NaN,"v":0.5,"w":0,"ts":%d}',
        '{"type":"cmd","seq":%d.5,"v":0.5,"w":0,"ts":0}',
        '{"type":"cmd","seq":1e300,"v":0.5,"w":0,"ts":%d}',
    ):
        s.cmd_seq += 1
        arg = s.cmd_seq if "%d," in text or "%d." in text else int(time.time() * 1000)
        ws.send_raw(text % arg)
    s.pump(0.5)
    check(
        "NaN/Infinity/non-integer/huge seq|ts cmd rejected",
        s.state["mode"] == "ARMED" and abs(s.state["vel"]["v"]) < 1e-3,
        f"mode={s.state['mode']} vel={s.state['vel']}",
    )

    # Second client while ARMED -> 409 (and the first session stays ARMED).
    st = rejected_with(a.token)
    s.pump(0.2)
    check(
        "second client while ARMED -> 409",
        st == 409 and s.state["mode"] == "ARMED",
        f"status {st}, mode={s.state['mode']}",
    )

    # arm + estop back-to-back (one TCP write): estop must always win.
    finals = []
    for _ in range(a.race):
        ws.send_many([{"type": "arm"}, {"type": "estop"}])
        t_sent = time.monotonic()
        st_after = s.next_state(t_sent + 0.1, timeout=1.0)
        finals.append(st_after["mode"] if st_after else None)
        s.pump(0.05)
    check(
        f"arm+estop race x{a.race} -> SAFE_STOP every time",
        all(m == "SAFE_STOP" for m in finals),
        f"{finals.count('SAFE_STOP')}/{len(finals)} SAFE_STOP",
    )

    ws.send({"type": "estop"})
    s.pump(0.2)
    # Not ARMED: a new client may take over the session.
    st = rejected_with(a.token)
    check("new client allowed when not ARMED", st == 101, f"status {st}")
    ws.close()
    print(f"{sum(checks)}/{len(checks)} checks passed")
    return 0 if all(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
