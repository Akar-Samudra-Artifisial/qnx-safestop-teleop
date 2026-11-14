#include "json.h"

#include <stdlib.h>
#include <string.h>

static const char *skip_ws(const char *p)
{
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')
        p++;
    return p;
}

/* Parse a JSON string starting at p (on the opening quote). Writes the unescaped value
 * into out (if non-NULL). Returns pointer past the closing quote, or NULL. */
static const char *parse_string(const char *p, char *out, size_t outlen)
{
    size_t n = 0;

    if (*p != '"')
        return NULL;
    p++;
    while (*p && *p != '"') {
        char c = *p;
        if (c == '\\') {
            p++;
            if (*p != '"' && *p != '\\' && *p != '/')
                return NULL;
            c = *p;
        } else if ((unsigned char)c < 0x20) {
            return NULL;
        }
        if (out) {
            if (n + 1 >= outlen)
                return NULL;
            out[n] = c;
        }
        n++;
        p++;
    }
    if (*p != '"')
        return NULL;
    if (out)
        out[n] = '\0';
    return p + 1;
}

/* Skip any JSON value. Returns pointer past it, or NULL on malformed input. */
static const char *skip_value(const char *p)
{
    p = skip_ws(p);
    if (*p == '"')
        return parse_string(p, NULL, 0);
    if (*p == '{' || *p == '[') {
        int depth = 0;
        while (*p) {
            if (*p == '"') {
                p = parse_string(p, NULL, 0);
                if (!p)
                    return NULL;
                continue;
            }
            if (*p == '{' || *p == '[')
                depth++;
            else if (*p == '}' || *p == ']') {
                depth--;
                if (depth == 0)
                    return p + 1;
            }
            p++;
        }
        return NULL;
    }
    /* number / true / false / null */
    const char *start = p;
    while (*p && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\t'
           && *p != '\n' && *p != '\r')
        p++;
    return p == start ? NULL : p;
}

/* Find the value of a top-level key; returns pointer to the value start or NULL. */
static const char *find_key(const char *js, const char *key)
{
    char name[64];
    const char *p = skip_ws(js);

    if (*p != '{')
        return NULL;
    p = skip_ws(p + 1);
    while (*p && *p != '}') {
        p = parse_string(p, name, sizeof(name));
        if (!p)
            return NULL;
        p = skip_ws(p);
        if (*p != ':')
            return NULL;
        p = skip_ws(p + 1);
        if (strcmp(name, key) == 0)
            return p;
        p = skip_value(p);
        if (!p)
            return NULL;
        p = skip_ws(p);
        if (*p == ',')
            p = skip_ws(p + 1);
        else if (*p != '}')
            return NULL;
    }
    return NULL;
}

int json_get_str(const char *js, const char *key, char *out, size_t outlen)
{
    const char *p = find_key(js, key);

    if (!p || outlen == 0)
        return -1;
    return parse_string(p, out, outlen) ? 0 : -1;
}

int json_get_num(const char *js, const char *key, double *out)
{
    const char *p = find_key(js, key);
    char *end;
    double d;

    if (!p || (*p != '-' && (*p < '0' || *p > '9')))
        return -1;
    d = strtod(p, &end);
    if (end == p)
        return -1;
    *out = d;
    return 0;
}
