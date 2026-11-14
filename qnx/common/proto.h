/* Shared definitions between teleopd and simplant (QNX message passing). */
#ifndef PROTO_H
#define PROTO_H

#include <stdint.h>
#include <sys/iomsg.h>

/* name_attach()/name_open() name of the plant server. */
#define SIMPLANT_NAME "simplant"

/* Message types above _IO_MAX so they never collide with resource-manager I/O messages
 * (name_open() sends an _IO_CONNECT first). */
#define PLANT_MSG_SET_VEL ((uint16_t)(_IO_MAX + 1))

/* teleopd -> simplant: velocity setpoint. Reply: plant_pose_t, with MsgReply status =
 * sizeof(plant_pose_t) so the sender can verify the reply length (MsgSend's return value). */
typedef struct {
    uint16_t type;      /* PLANT_MSG_SET_VEL */
    uint16_t reserved;
    uint32_t pad;
    double v;           /* m/s */
    double w;           /* rad/s */
} plant_set_vel_t;

typedef struct {
    double x;           /* m */
    double y;           /* m */
    double theta;       /* rad, [-pi, pi] */
    double v;           /* applied linear velocity, m/s */
    double w;           /* applied angular velocity, rad/s */
} plant_pose_t;

#endif
