# common

Shared code, compiled into each package via `vpath`:

- `proto.h` — teleopd ↔ simplant message definitions (`PLANT_MSG_SET_VEL`, pose reply).
- `ws.c/.h` — minimal RFC 6455 WebSocket server (handshake SHA-1 + base64, masked text
  frames, ping/pong, close; no fragmentation, payload ≤ 4 KiB).
- `json.c/.h` — reader for flat JSON objects (`json_get_str`, `json_get_num`).
