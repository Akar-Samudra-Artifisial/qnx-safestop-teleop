# simplant

Simulated differential-drive plant (QNX 8.0): `name_attach("simplant")`, 200 Hz integration
driven by a timer pulse, 10×10 m area (clamped), `SCHED_FIFO` prio 40. Serves
`PLANT_MSG_SET_VEL` (`../common/proto.h`) with `MsgReceive`/`MsgReply` and returns the pose.
No setpoint for 200 ms → velocity 0. HAM supervision comes in M3.

```sh
simplant [-v]
```
