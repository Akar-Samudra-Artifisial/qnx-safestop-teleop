/* Minimal JSON reader for flat protocol objects: {"key": value, ...}.
 * Nested objects/arrays are skipped (not readable). No allocation. */
#ifndef JSON_H
#define JSON_H

#include <stddef.h>

/* Copy the string value of top-level key into out. 0 on success, -1 if missing/not a
 * string/too long/malformed. Escapes other than \" and \\ are rejected. */
int json_get_str(const char *js, const char *key, char *out, size_t outlen);

/* Read the numeric value of top-level key. 0 on success, -1 otherwise. */
int json_get_num(const char *js, const char *key, double *out);

#endif
