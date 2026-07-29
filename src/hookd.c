/* hookd.c — the POST surface. Deploys, and the shared background gallery.
 *
 * garden.c speaks GET and nothing else, one request per connection, one at a
 * time. That is the right shape for a site and the wrong one for a deploy
 * hook, so the two things that need POST live in their own process.
 *
 * Separation is not tidiness. This is the program that restarts garden, and a
 * server cannot restart itself and still answer the request that asked it to.
 * hookd is never restarted by a deploy unless its own source changed, and
 * even then it is systemd that does it, after we have exited.
 *
 *   POST /deploy        a push. HMAC-SHA256 over the body, then deploy.sh.
 *   GET  /api/status    which commit is actually serving. the deploy's test.
 *   GET  /api/gallery   backgrounds people have shared.
 *   POST /api/gallery   share one. public, so nothing is trusted.
 *
 * No libcrypto and no lua: SHA-256 is a hundred lines and linking a TLS stack
 * to hash sixty bytes is the kind of dependency this repo exists without.
 *
 * The gallery is a tab-separated text file. One entry per line, the filename
 * is the database. That is the same claim blocks/ makes, and it holds for the
 * same reason: two hundred entries of a few hundred bytes is smaller than one
 * of the fonts, so the whole file is read, rewritten and renamed into place.
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>

#define HDR_MAX     16384
#define BODY_MAX    1048576      /* github push payloads are not small */
#define GALLERY_CAP 100          /* hard ceiling; GALLERY_MAX may lower it */
#define ENTRY_MAX   1024
#define LINE_MAX    2048

/* ------------------------------------------------------------------ sha256 */
/* FIPS 180-4. Straight out of the spec, no tricks, verified against the
 * standard vectors by `make check-hookd`. */

typedef struct {
    uint32_t h[8];
    uint64_t len;
    uint8_t  buf[64];
    size_t   n;
} sha256;

static const uint32_t K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,
    0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,
    0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
    0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,
    0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
    0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

static uint32_t ror(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

static void sha256_block(sha256 *s, const uint8_t *p)
{
    uint32_t w[64], a, b, c, d, e, f, g, h;
    int i;

    for (i = 0; i < 16; i++)
        w[i] = (uint32_t)p[i*4] << 24 | (uint32_t)p[i*4+1] << 16 |
               (uint32_t)p[i*4+2] << 8 | (uint32_t)p[i*4+3];
    for (; i < 64; i++) {
        uint32_t s0 = ror(w[i-15],7) ^ ror(w[i-15],18) ^ (w[i-15] >> 3);
        uint32_t s1 = ror(w[i-2],17) ^ ror(w[i-2],19)  ^ (w[i-2] >> 10);
        w[i] = w[i-16] + s0 + w[i-7] + s1;
    }

    a=s->h[0]; b=s->h[1]; c=s->h[2]; d=s->h[3];
    e=s->h[4]; f=s->h[5]; g=s->h[6]; h=s->h[7];

    for (i = 0; i < 64; i++) {
        uint32_t S1 = ror(e,6) ^ ror(e,11) ^ ror(e,25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + K[i] + w[i];
        uint32_t S0 = ror(a,2) ^ ror(a,13) ^ ror(a,22);
        uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + mj;
        h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
    }

    s->h[0]+=a; s->h[1]+=b; s->h[2]+=c; s->h[3]+=d;
    s->h[4]+=e; s->h[5]+=f; s->h[6]+=g; s->h[7]+=h;
}

static void sha256_init(sha256 *s)
{
    s->h[0]=0x6a09e667; s->h[1]=0xbb67ae85; s->h[2]=0x3c6ef372;
    s->h[3]=0xa54ff53a; s->h[4]=0x510e527f; s->h[5]=0x9b05688c;
    s->h[6]=0x1f83d9ab; s->h[7]=0x5be0cd19;
    s->len = 0; s->n = 0;
}

static void sha256_update(sha256 *s, const void *data, size_t len)
{
    const uint8_t *p = data;
    s->len += len;
    while (len) {
        size_t take = 64 - s->n;
        if (take > len) take = len;
        memcpy(s->buf + s->n, p, take);
        s->n += take; p += take; len -= take;
        if (s->n == 64) { sha256_block(s, s->buf); s->n = 0; }
    }
}

static void sha256_final(sha256 *s, uint8_t out[32])
{
    uint64_t bits = s->len * 8;
    int i;
    uint8_t pad = 0x80;

    sha256_update(s, &pad, 1);
    pad = 0;
    while (s->n != 56) sha256_update(s, &pad, 1);
    for (i = 7; i >= 0; i--) {
        uint8_t b = (uint8_t)(bits >> (i * 8));
        /* update() would recount these into len; write them directly */
        s->buf[s->n++] = b;
    }
    sha256_block(s, s->buf);
    s->n = 0;
    for (i = 0; i < 8; i++) {
        out[i*4]   = (uint8_t)(s->h[i] >> 24);
        out[i*4+1] = (uint8_t)(s->h[i] >> 16);
        out[i*4+2] = (uint8_t)(s->h[i] >> 8);
        out[i*4+3] = (uint8_t)(s->h[i]);
    }
}

static void hmac_sha256(const uint8_t *key, size_t keylen,
                        const uint8_t *msg, size_t msglen, uint8_t out[32])
{
    uint8_t k[64], inner[32], pad[64];
    sha256 s;
    size_t i;

    memset(k, 0, sizeof k);
    if (keylen > 64) {
        sha256_init(&s); sha256_update(&s, key, keylen); sha256_final(&s, k);
    } else {
        memcpy(k, key, keylen);
    }

    for (i = 0; i < 64; i++) pad[i] = k[i] ^ 0x36;
    sha256_init(&s);
    sha256_update(&s, pad, 64);
    sha256_update(&s, msg, msglen);
    sha256_final(&s, inner);

    for (i = 0; i < 64; i++) pad[i] = k[i] ^ 0x5c;
    sha256_init(&s);
    sha256_update(&s, pad, 64);
    sha256_update(&s, inner, 32);
    sha256_final(&s, out);
}

static void hex(const uint8_t *in, size_t n, char *out)
{
    static const char *d = "0123456789abcdef";
    size_t i;
    for (i = 0; i < n; i++) {
        out[i*2]   = d[in[i] >> 4];
        out[i*2+1] = d[in[i] & 15];
    }
    out[n*2] = '\0';
}

/* Constant time. A signature check that returns early on the first wrong
 * byte tells the person guessing how many bytes they got right. */
static int same(const char *a, const char *b)
{
    size_t i;
    unsigned diff;
    if (!a || !b) return 0;
    if (strlen(a) != strlen(b)) return 0;
    diff = 0;
    for (i = 0; a[i]; i++) diff |= (unsigned char)a[i] ^ (unsigned char)b[i];
    return diff == 0;
}

/* ------------------------------------------------------------------ config */

static char SECRET[256]    = "";
/* The unit sets WorkingDirectory to the repo, so "." is right when the config
 * does not say otherwise — and carries no machine's layout into the source. */
static char REPO_DIR[512]  = ".";
static char STATE_DIR[512] = "/var/lib/garden";
static int  HOOK_PORT      = 8001;
static int  GALLERY_MAX    = GALLERY_CAP;

static void trim(char *s)
{
    char *p = s + strlen(s);
    while (p > s && (p[-1] == '\n' || p[-1] == '\r' || p[-1] == ' ' ||
                     p[-1] == '\t' || p[-1] == '"' || p[-1] == '\'')) *--p = '\0';
}

/* The config is shell-sourceable so deploy.sh reads the very same file.
 * Two parsers over one file beats two files that drift apart. */
static void load_conf(const char *path)
{
    char line[1024];
    FILE *f = fopen(path, "r");
    if (!f) { fprintf(stderr, "hookd: no config at %s\n", path); return; }

    while (fgets(line, sizeof line, f)) {
        char *eq, *k, *v;
        k = line;
        while (*k == ' ' || *k == '\t') k++;
        if (*k == '#' || *k == '\n' || !*k) continue;
        eq = strchr(k, '=');
        if (!eq) continue;
        *eq = '\0';
        v = eq + 1;
        while (*v == ' ' || *v == '"' || *v == '\'') v++;
        trim(v);

        if      (!strcmp(k, "DEPLOY_SECRET")) snprintf(SECRET, sizeof SECRET, "%s", v);
        else if (!strcmp(k, "REPO_DIR"))      snprintf(REPO_DIR, sizeof REPO_DIR, "%s", v);
        else if (!strcmp(k, "STATE_DIR"))     snprintf(STATE_DIR, sizeof STATE_DIR, "%s", v);
        else if (!strcmp(k, "HOOK_PORT"))     HOOK_PORT = atoi(v);
        else if (!strcmp(k, "GALLERY_MAX")) {
            int n = atoi(v);
            /* The config may lower the ceiling but never raise it: the read
             * buffer is sized from GALLERY_CAP, so a larger value would be a
             * config file quietly deciding how much memory to allocate. */
            if (n > 0 && n <= GALLERY_CAP) GALLERY_MAX = n;
        }
    }
    fclose(f);
}

/* -------------------------------------------------------------------- http */

static void respond(int fd, const char *status, const char *ctype,
                    const char *body, size_t len)
{
    char head[512];
    int n = snprintf(head, sizeof head,
        "HTTP/1.1 %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Cache-Control: no-store\r\n"
        "X-Content-Type-Options: nosniff\r\n"
        "Connection: close\r\n\r\n",
        status, ctype, len);
    if (write(fd, head, (size_t)n) < 0) return;
    if (len && write(fd, body, len) < 0) return;
}

static void json(int fd, const char *status, const char *fmt, ...)
{
    char body[1024];
    va_list ap;
    int n;
    va_start(ap, fmt);
    n = vsnprintf(body, sizeof body, fmt, ap);
    va_end(ap);
    if (n < 0) n = 0;
    respond(fd, status, "application/json; charset=utf-8", body, (size_t)n);
}

/* Case-insensitive header lookup over the raw header block. Returns the
 * value into `out`. Header names are ASCII and the block is bounded. */
static int header(const char *hdrs, const char *name, char *out, size_t cap)
{
    size_t nlen = strlen(name);
    const char *p = hdrs;

    while (*p) {
        const char *eol = strstr(p, "\r\n");
        if (!eol) eol = p + strlen(p);
        if ((size_t)(eol - p) > nlen && p[nlen] == ':' &&
            !strncasecmp(p, name, nlen)) {
            const char *v = p + nlen + 1;
            size_t len;
            while (*v == ' ' || *v == '\t') v++;
            len = (size_t)(eol - v);
            if (len >= cap) len = cap - 1;
            memcpy(out, v, len);
            out[len] = '\0';
            return 1;
        }
        if (!*eol) break;
        p = eol + 2;
    }
    out[0] = '\0';
    return 0;
}

static char *read_file(const char *path, size_t *lenp)
{
    FILE *f = fopen(path, "rb");
    char *buf;
    long n;
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    n = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (n < 0 || n > (long)(GALLERY_CAP * ENTRY_MAX * 2)) { fclose(f); return NULL; }
    buf = malloc((size_t)n + 1);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); fclose(f); return NULL; }
    buf[n] = '\0';
    fclose(f);
    if (lenp) *lenp = (size_t)n;
    return buf;
}

static void read_line_file(const char *path, char *out, size_t cap,
                           const char *dflt)
{
    FILE *f = fopen(path, "r");
    snprintf(out, cap, "%s", dflt);
    if (!f) return;
    if (fgets(out, (int)cap, f)) trim(out);
    else snprintf(out, cap, "%s", dflt);
    fclose(f);
}

/* ----------------------------------------------------------------- deploy */

/* Detached: the caller gets a 202 and hangs up. GitHub allows a webhook about
 * ten seconds and a clean build plus a restart plus the health check does not
 * reliably fit in ten, and a hook that times out is a hook GitHub starts
 * calling broken. SIGCHLD is ignored in main(), so nothing is left to reap. */
static void spawn_deploy(void)
{
    pid_t pid = fork();
    char script[1024];

    if (pid != 0) return;                  /* parent, or fork failed */

    setsid();

    /* Hand back the signals main() turned off. A handler set to a function is
     * reset by exec, but SIG_IGN is inherited straight through it — and git
     * forks helpers and waits for them, so an inherited SIGCHLD of SIG_IGN
     * makes every waitpid fail with ECHILD and `git fetch` collapse.
     *
     * In the child, not in main(): what reaches git is the default, while
     * hookd keeps SIG_IGN and still never has to reap anything. */
    signal(SIGCHLD, SIG_DFL);
    signal(SIGPIPE, SIG_DFL);

    snprintf(script, sizeof script, "%s/deploy.sh", REPO_DIR);
    freopen("/dev/null", "r", stdin);
    freopen("/dev/null", "w", stdout);
    freopen("/dev/null", "w", stderr);
    execl("/bin/bash", "bash", script, (char *)NULL);
    _exit(127);
}

/* ---------------------------------------------------------------- gallery */

/* Everything below rebuilds a submission rather than sanitising one. An entry
 * is constructed field by field out of what is named here, and anything not
 * named never reaches the file. A filter has to imagine every attack; a
 * whitelist only has to name the ten things that are allowed. */

struct num_opt { const char *key; double lo, hi; };
static const struct num_opt NUM_OPTS[] = {
    { "fps", 1, 60 }, { "speed", 0, 4 }, { "scale", 0.2, 4 },
    { "size", 4, 24 }, { "fade", 0.05, 1 }, { "driftspeed", 0, 5 },
    /* The picture dials. `img` names a slot rather than carrying one, so a
     * shared background renders against whatever the reader has in it. */
    { "img", 1, 5 }, { "gain", 0.4, 4 }, { "maskthr", 0, 1 },
    { "maskspeed", 0, 4 },
    { NULL, 0, 0 }
};
static const char *DRIFT_OK[] = { "nav", "body", "all", "none", NULL };
static const char *RD_OK[] = {
    "worms", "solitons", "mitosis", "coral", "spots", "maze", "holes",
    "chaos", "flower", "moving", NULL
};
static const char *FIT_OK[] = { "cover", "contain", "tile", NULL };
/* Checkboxes. The client writes "1" or clears the key entirely, and an empty
 * value is dropped before it reaches here, so "1" is the only word to allow. */
static const char *FLAG_OK[] = { "1", NULL };

static int in_list(const char *const *list, const char *v)
{
    int i;
    for (i = 0; list[i]; i++) if (!strcmp(list[i], v)) return 1;
    return 0;
}

/* An id, the same rule the server applies to `skin` and the client to a
 * program name. */
static int id_ok(const char *s)
{
    size_t i;
    if (!s || !*s || strlen(s) > 32) return 0;
    for (i = 0; s[i]; i++)
        if (!isalnum((unsigned char)s[i]) && s[i] != '_' && s[i] != '-') return 0;
    return 1;
}

/* A git object name: hex, and long enough to hold a full one. */
static int hex_ok(const char *s)
{
    size_t i;
    if (!s || !*s || strlen(s) > 64) return 0;
    for (i = 0; s[i]; i++) if (!isxdigit((unsigned char)s[i])) return 0;
    return 1;
}

static void pct_decode(char *s)
{
    char *o = s;
    const char *p = s;
    while (*p) {
        if (*p == '+') { *o++ = ' '; p++; }
        else if (*p == '%' && isxdigit((unsigned char)p[1]) &&
                              isxdigit((unsigned char)p[2])) {
            char h[3] = { p[1], p[2], 0 };
            unsigned v = (unsigned)strtoul(h, NULL, 16);
            if (v == 0) { p += 3; continue; }      /* no NUL injection */
            *o++ = (char)v;
            p += 3;
        } else *o++ = *p++;
    }
    *o = '\0';
}

/* Pull one field out of an urlencoded body. The client sends
 * URLSearchParams, which is the least amount of parser on both ends. */
static int field(const char *body, const char *key, char *out, size_t cap)
{
    size_t klen = strlen(key);
    const char *p = body;

    out[0] = '\0';
    while (p && *p) {
        const char *amp = strchr(p, '&');
        size_t seg = amp ? (size_t)(amp - p) : strlen(p);
        if (seg > klen && p[klen] == '=' && !strncmp(p, key, klen)) {
            size_t len = seg - klen - 1;
            if (len >= cap) len = cap - 1;
            memcpy(out, p + klen + 1, len);
            out[len] = '\0';
            pct_decode(out);
            return 1;
        }
        p = amp ? amp + 1 : NULL;
    }
    return 0;
}

/* Names are shown to other people. The client renders them with textContent
 * so markup in one is inert; this is about the file, where a tab or a newline
 * would end the field or the record. */
static void clean_text(const char *in, char *out, size_t cap, const char *dflt)
{
    size_t o = 0;
    size_t i;
    for (i = 0; in[i] && o < cap - 1; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '\t' || c == '\n' || c == '\r') { out[o++] = ' '; continue; }
        if (c < 0x20 || c == 0x7f) continue;
        out[o++] = (char)c;
    }
    out[o] = '\0';
    while (o && out[o-1] == ' ') out[--o] = '\0';
    if (!out[0] && dflt) snprintf(out, cap, "%s", dflt);
}

/* Rebuild `bgopts`: one line of k=v pairs, the format the block header and
 * the query string already use. Unknown keys are dropped, numbers are
 * clamped to the range the slider offers, enums must match exactly. */
static void clean_opts(const char *in, char *out, size_t cap)
{
    char work[LINE_MAX];
    char *save = NULL, *tok;
    size_t o = 0;

    out[0] = '\0';
    snprintf(work, sizeof work, "%s", in);

    for (tok = strtok_r(work, " \t;", &save); tok;
         tok = strtok_r(NULL, " \t;", &save)) {
        char *eq = strchr(tok, '=');
        char key[64], val[128];
        int i, ok = 0;

        if (!eq || eq == tok) continue;
        *eq = '\0';
        snprintf(key, sizeof key, "%s", tok);
        snprintf(val, sizeof val, "%s", eq + 1);
        if (!val[0]) continue;

        for (i = 0; NUM_OPTS[i].key; i++) {
            if (strcmp(key, NUM_OPTS[i].key)) continue;
            {
                char *end;
                double d = strtod(val, &end);
                if (end == val || *end) break;          /* not a number */
                if (!(d >= NUM_OPTS[i].lo && d <= NUM_OPTS[i].hi)) break;
                snprintf(val, sizeof val, "%g", d);
                ok = 1;
            }
            break;
        }

        if (!ok && !strcmp(key, "drift") && in_list(DRIFT_OK, val)) ok = 1;
        if (!ok && !strcmp(key, "rd")    && in_list(RD_OK, val))    ok = 1;
        if (!ok && !strcmp(key, "fit")   && in_list(FIT_OK, val))   ok = 1;
        if (!ok && (!strcmp(key, "maskinv") || !strcmp(key, "masksoft"))
                && in_list(FLAG_OK, val)) ok = 1;

        /* seed, word and masktext are drawn, never executed. Bounded so one
         * entry cannot be a kilobyte, and rejected if they contain a space:
         * `bgopts` is one line of space-separated pairs, so a value with a
         * space in it does not survive its own permalink. */
        if (!ok && (!strcmp(key, "seed") || !strcmp(key, "word")
                                         || !strcmp(key, "masktext"))) {
            char clean[64];
            clean_text(val, clean, sizeof clean, NULL);
            if (!clean[0]) continue;
            snprintf(val, sizeof val, "%.*s",
                     !strcmp(key, "seed") ? 32 : 24, clean);
            if (strchr(val, ' ')) continue;             /* one token only */
            ok = 1;
        }

        if (!ok) continue;
        if (o + strlen(key) + strlen(val) + 2 >= cap) break;
        o += (size_t)snprintf(out + o, cap - o, "%s%s=%s", o ? " " : "", key, val);
    }
}

static void json_escape(const char *in, char *out, size_t cap)
{
    size_t o = 0;
    size_t i;
    for (i = 0; in[i] && o + 7 < cap; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = (char)c; }
        else if (c < 0x20) o += (size_t)snprintf(out + o, cap - o, "\\u%04x", c);
        else out[o++] = (char)c;
    }
    out[o] = '\0';
}

static void gallery_path(char *out, size_t cap)
{
    snprintf(out, cap, "%s/gallery.tsv", STATE_DIR);
}

/* A line is  id, at, tok, name, bg, chars, opts  — tab separated, newest
 * first. `opts` is last because it is the only field allowed to contain
 * spaces, and last means "the rest of the line".
 *
 * `tok` is sha256 of the secret handed back when the entry was posted. It
 * proves nothing about who somebody is and is not meant to: it only says
 * this browser is the one that submitted this entry, which is exactly the
 * claim a delete button has to make. It is never sent to anyone. */
#define FIELDS 7

static int split_entry(char *line, char *f[FIELDS])
{
    char *p = line;
    int i;
    for (i = 0; i < FIELDS; i++) {
        f[i] = p;
        if (i < FIELDS - 1) {
            char *t = strchr(p, '\t');
            if (!t) return 0;
            *t = '\0';
            p = t + 1;
        }
    }
    return 1;
}

static void gallery_get(int fd)
{
    char path[600], *buf;
    char *out;
    size_t o = 0, cap = (size_t)GALLERY_CAP * ENTRY_MAX * 3;
    char *line, *save = NULL;
    int first = 1;

    gallery_path(path, sizeof path);
    out = malloc(cap);
    if (!out) { json(fd, "500 Internal Server Error", "{\"error\":\"oom\"}"); return; }

    o += (size_t)snprintf(out + o, cap - o, "{\"entries\":[");

    buf = read_file(path, NULL);
    if (buf) {
        for (line = strtok_r(buf, "\n", &save); line;
             line = strtok_r(NULL, "\n", &save)) {
            char *f[FIELDS], esc[ENTRY_MAX];

            if (!split_entry(line, f)) continue;        /* malformed, skip */
            if (o + ENTRY_MAX * 2 >= cap) break;

            o += (size_t)snprintf(out + o, cap - o, "%s{", first ? "" : ",");
            first = 0;
            json_escape(f[0], esc, sizeof esc);
            o += (size_t)snprintf(out + o, cap - o, "\"id\":\"%s\",", esc);
            json_escape(f[1], esc, sizeof esc);
            o += (size_t)snprintf(out + o, cap - o, "\"at\":\"%s\",", esc);
            /* f[2] is the token hash and stays here. */
            json_escape(f[3], esc, sizeof esc);
            o += (size_t)snprintf(out + o, cap - o, "\"name\":\"%s\",", esc);
            json_escape(f[4], esc, sizeof esc);
            o += (size_t)snprintf(out + o, cap - o, "\"bg\":\"%s\",", esc);
            json_escape(f[5], esc, sizeof esc);
            o += (size_t)snprintf(out + o, cap - o, "\"chars\":\"%s\",", esc);
            json_escape(f[6], esc, sizeof esc);
            o += (size_t)snprintf(out + o, cap - o, "\"opts\":\"%s\"}", esc);
        }
        free(buf);
    }

    o += (size_t)snprintf(out + o, cap - o, "]}");
    respond(fd, "200 OK", "application/json; charset=utf-8", out, o);
    free(out);
}

/* Remove one entry, if the caller can prove it posted it. */
static void gallery_delete(int fd, const char *body)
{
    char id[32], token[128], want[65], path[600], tmp[620];
    uint8_t dig[32];
    char *old, *line, *save = NULL;
    FILE *f;
    int found = 0, denied = 0, kept = 0;

    if (!field(body, "id", id, sizeof id) || !hex_ok(id)) {
        json(fd, "400 Bad Request", "{\"error\":\"bad id\"}");
        return;
    }
    if (!field(body, "token", token, sizeof token) || !token[0]) {
        json(fd, "403 Forbidden", "{\"error\":\"no token\"}");
        return;
    }
    { sha256 s; sha256_init(&s); sha256_update(&s, token, strlen(token));
      sha256_final(&s, dig); }
    hex(dig, 32, want);

    gallery_path(path, sizeof path);
    old = read_file(path, NULL);
    if (!old) { json(fd, "404 Not Found", "{\"error\":\"no such entry\"}"); return; }

    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    f = fopen(tmp, "w");
    if (!f) { free(old); json(fd, "500 Internal Server Error", "{\"error\":\"cannot write\"}"); return; }

    for (line = strtok_r(old, "\n", &save); line;
         line = strtok_r(NULL, "\n", &save)) {
        char copy[LINE_MAX], *fl[FIELDS];
        snprintf(copy, sizeof copy, "%s", line);
        /* A line that will not split is one nothing can ever read — an entry
         * from an older field layout, or a truncated write. Dropping it on
         * the next rewrite is what makes a format change self-healing;
         * keeping it would hold a slot against the cap forever while being
         * invisible to everyone. */
        if (!split_entry(copy, fl)) continue;
        if (!strcmp(fl[0], id)) {
            if (same(fl[2], want)) { found = 1; continue; }   /* dropped */
            denied = 1;
        }
        fprintf(f, "%s\n", line);
        kept++;
    }
    fclose(f);
    free(old);

    if (!found) {
        remove(tmp);
        if (denied) json(fd, "403 Forbidden", "{\"error\":\"not yours\"}");
        else        json(fd, "404 Not Found", "{\"error\":\"no such entry\"}");
        return;
    }

    rename(tmp, path);
    json(fd, "200 OK", "{\"ok\":true,\"remaining\":%d}", kept);
}

/* Crude, per-IP, in memory, and reset by a restart. It exists to stop a
 * script filling a disk, not to stop a determined person — the entry cap is
 * what actually bounds the file. */
#define RATE_SLOTS 256
#define RATE_WINDOW 60
#define RATE_MAX 5
static struct { char ip[46]; time_t hits[RATE_MAX]; } rate[RATE_SLOTS];

static int rate_ok(const char *ip)
{
    time_t now = time(NULL);
    int i, slot = -1, oldest = 0, j;
    unsigned h = 0;

    for (i = 0; ip[i]; i++) h = h * 31u + (unsigned char)ip[i];
    slot = (int)(h % RATE_SLOTS);

    if (strcmp(rate[slot].ip, ip)) {           /* new tenant, evict */
        snprintf(rate[slot].ip, sizeof rate[slot].ip, "%s", ip);
        memset(rate[slot].hits, 0, sizeof rate[slot].hits);
    }

    for (j = 0; j < RATE_MAX; j++) {
        if (now - rate[slot].hits[j] >= RATE_WINDOW) { oldest = j; goto take; }
    }
    return 0;
take:
    rate[slot].hits[oldest] = now;
    return 1;
}

static void gallery_post(int fd, const char *body, const char *ip)
{
    char name[128], bg[64], chars[128], opts[512];
    char raw[512], id[16], path[600], tmp[620];
    char stamp[32], token[33], tokhash[65];
    uint8_t dig[32];
    char hexbuf[65];
    char *old;
    FILE *f;
    time_t now;
    struct tm tmv;
    int kept = 0;

    if (!rate_ok(ip)) { json(fd, "429 Too Many Requests", "{\"error\":\"slow down\"}"); return; }

    /* A background is a handful of dials. Nothing legitimate is 4K, and the
     * generous BODY_MAX exists for github's push payloads, not for this. */
    if (strlen(body) > 4096) {
        json(fd, "413 Payload Too Large", "{\"error\":\"too large\"}");
        return;
    }

    if (!field(body, "bg", bg, sizeof bg) || !id_ok(bg)) {
        json(fd, "400 Bad Request", "{\"error\":\"bad bg\"}");
        return;
    }
    field(body, "name", raw, sizeof raw);
    clean_text(raw, name, sizeof name, "untitled");
    if (strlen(name) > 48) name[48] = '\0';
    /* Belt and braces. The client renders names with textContent and the
     * JSON is escaped on the way out, so markup in a name is already inert —
     * but this is the one public-writable string on the box, and it costs
     * nothing to make sure it can never be a tag whoever renders it next.
     * Only names: `<` and `>` are legitimate glyphs in a charset ramp. */
    {
        char *p;
        size_t n;
        for (p = name; *p; p++) if (*p == '<' || *p == '>') *p = ' ';
        n = strlen(name);
        while (n && name[n-1] == ' ') name[--n] = '\0';
        if (!name[0]) snprintf(name, sizeof name, "untitled");
    }

    field(body, "chars", raw, sizeof raw);
    clean_text(raw, chars, sizeof chars, NULL);
    if (strlen(chars) > 96) chars[96] = '\0';

    field(body, "opts", raw, sizeof raw);
    clean_opts(raw, opts, sizeof opts);

    /* The id is a hash of the background, not of the submission: sharing a
     * field somebody already shared should replace it, not double it. */
    snprintf(raw, sizeof raw, "%s|%s|%s", bg, chars, opts);
    { sha256 s; sha256_init(&s); sha256_update(&s, raw, strlen(raw)); sha256_final(&s, dig); }
    hex(dig, 32, hexbuf);
    snprintf(id, sizeof id, "%.12s", hexbuf);

    now = time(NULL);
    gmtime_r(&now, &tmv);
    strftime(stamp, sizeof stamp, "%Y-%m-%dT%H:%M:%SZ", &tmv);

    /* The delete token. Random, returned once, and stored only as a hash —
     * so the file that a deletion is checked against never contains anything
     * that would let somebody perform one. */
    {
        uint8_t rnd[16];
        FILE *ur = fopen("/dev/urandom", "rb");
        size_t got = ur ? fread(rnd, 1, sizeof rnd, ur) : 0;
        if (ur) fclose(ur);
        if (got != sizeof rnd) {
            json(fd, "500 Internal Server Error", "{\"error\":\"no entropy\"}");
            return;
        }
        hex(rnd, sizeof rnd, token);
        { sha256 s; sha256_init(&s); sha256_update(&s, token, strlen(token));
          sha256_final(&s, dig); }
        hex(dig, 32, tokhash);
    }

    gallery_path(path, sizeof path);
    snprintf(tmp, sizeof tmp, "%s.tmp", path);

    f = fopen(tmp, "w");
    if (!f) { json(fd, "500 Internal Server Error", "{\"error\":\"cannot write\"}"); return; }

    fprintf(f, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
            id, stamp, tokhash, name, bg, chars, opts);
    kept = 1;

    old = read_file(path, NULL);
    if (old) {
        char *line, *save = NULL;
        for (line = strtok_r(old, "\n", &save); line;
             line = strtok_r(NULL, "\n", &save)) {
            char copy[LINE_MAX], *fl[FIELDS];
            if (!strncmp(line, id, 12) && line[12] == '\t') continue;  /* replaced */
            snprintf(copy, sizeof copy, "%s", line);
            if (!split_entry(copy, fl)) continue;      /* unreadable, drop it */
            /* Newest first, so anything past the cap is the oldest there is
             * and simply stops being written. */
            if (kept >= GALLERY_MAX) break;
            fprintf(f, "%s\n", line);
            kept++;
        }
        free(old);
    }
    fclose(f);
    rename(tmp, path);

    json(fd, "201 Created", "{\"ok\":true,\"id\":\"%s\",\"token\":\"%s\"}", id, token);
}

/* ----------------------------------------------------------------- status */

static void status_get(int fd)
{
    char sha[128], at[64], active[32] = "unknown";
    char p1[600], p2[600];
    FILE *pp;

    snprintf(p1, sizeof p1, "%s/deployed.sha", STATE_DIR);
    snprintf(p2, sizeof p2, "%s/deployed.at", STATE_DIR);
    read_line_file(p1, sha, sizeof sha, "unknown");
    read_line_file(p2, at, sizeof at, "unknown");

    pp = popen("systemctl is-active garden 2>/dev/null", "r");
    if (pp) {
        if (fgets(active, sizeof active, pp)) trim(active);
        pclose(pp);
    }

    if (!hex_ok(sha)) snprintf(sha, sizeof sha, "unknown");

    json(fd, "200 OK",
         "{\"sha\":\"%s\",\"built_at\":\"%s\",\"unit_active\":\"%s\"}",
         sha, at, active);
}

/* ------------------------------------------------------------------ routes */

static int verify(const char *hdrs, const char *body, size_t blen)
{
    char sig[256];
    uint8_t dig[32];
    char want[80];
    char hexbuf[65];

    if (!SECRET[0]) return 0;

    /* GitHub signs the raw body. A local git hook has no body worth signing
     * and sends a bearer token instead. Both are checked here; a request
     * carrying neither is refused here rather than falling through to some
     * later branch that forgot about it. */
    if (header(hdrs, "X-Hub-Signature-256", sig, sizeof sig) && sig[0]) {
        hmac_sha256((const uint8_t *)SECRET, strlen(SECRET),
                    (const uint8_t *)body, blen, dig);
        hex(dig, 32, hexbuf);
        snprintf(want, sizeof want, "sha256=%s", hexbuf);
        return same(sig, want);
    }

    if (header(hdrs, "Authorization", sig, sizeof sig) &&
        !strncmp(sig, "Bearer ", 7)) {
        return same(sig + 7, SECRET);
    }

    return 0;
}

static void handle(int fd)
{
    char hdrs[HDR_MAX];
    char *body = NULL;
    size_t hlen = 0, blen = 0, want = 0;
    char method[16], path[256], ip[46], val[256];
    const char *sep;
    ssize_t n;

    /* headers first, up to the blank line */
    while (hlen < sizeof hdrs - 1) {
        n = read(fd, hdrs + hlen, sizeof hdrs - 1 - hlen);
        if (n <= 0) return;
        hlen += (size_t)n;
        hdrs[hlen] = '\0';
        if (strstr(hdrs, "\r\n\r\n")) break;
    }
    hdrs[hlen] = '\0';
    sep = strstr(hdrs, "\r\n\r\n");
    if (!sep) { respond(fd, "431 Request Header Fields Too Large", "text/plain", "", 0); return; }

    if (sscanf(hdrs, "%15s %255s", method, path) != 2) {
        respond(fd, "400 Bad Request", "text/plain", "", 0);
        return;
    }
    { char *q = strchr(path, '?'); if (q) *q = '\0'; }

    if (!header(hdrs, "X-Real-IP", ip, sizeof ip) || !ip[0])
        snprintf(ip, sizeof ip, "unknown");

    if (header(hdrs, "Content-Length", val, sizeof val)) {
        long cl = atol(val);
        if (cl < 0 || cl > BODY_MAX) {
            json(fd, "413 Payload Too Large", "{\"error\":\"too large\"}");
            return;
        }
        want = (size_t)cl;
    }

    /* whatever of the body already arrived with the headers */
    {
        size_t have = hlen - (size_t)(sep + 4 - hdrs);
        body = malloc(want + 1);
        if (!body) { json(fd, "500 Internal Server Error", "{\"error\":\"oom\"}"); return; }
        if (have > want) have = want;
        memcpy(body, sep + 4, have);
        blen = have;
        while (blen < want) {
            n = read(fd, body + blen, want - blen);
            if (n <= 0) break;
            blen += (size_t)n;
        }
        body[blen] = '\0';
    }

    if (!strcmp(method, "GET")) {
        if (!strcmp(path, "/api/status"))  { status_get(fd);  goto done; }
        if (!strcmp(path, "/api/gallery")) { gallery_get(fd); goto done; }
        json(fd, "404 Not Found", "{\"error\":\"not found\"}");
        goto done;
    }

    if (!strcmp(method, "POST")) {
        if (!strcmp(path, "/deploy")) {
            char ev[64];
            if (!verify(hdrs, body, blen)) {
                fprintf(stderr, "hookd: deploy rejected from %s\n", ip);
                fflush(stderr);
                json(fd, "403 Forbidden", "{\"error\":\"bad signature\"}");
                goto done;
            }
            /* A ping is GitHub checking the hook exists. Deploying on one
             * would rebuild the site every time the settings page is opened. */
            if (header(hdrs, "X-GitHub-Event", ev, sizeof ev) && !strcmp(ev, "ping")) {
                json(fd, "200 OK", "{\"ok\":true,\"pong\":true}");
                goto done;
            }
            printf("hookd: deploy accepted from %s\n", ip);
            fflush(stdout);
            spawn_deploy();
            json(fd, "202 Accepted", "{\"ok\":true,\"deploying\":true}");
            goto done;
        }
        if (!strcmp(path, "/api/gallery")) { gallery_post(fd, body, ip); goto done; }
        json(fd, "404 Not Found", "{\"error\":\"not found\"}");
        goto done;
    }

    if (!strcmp(method, "DELETE")) {
        if (!strcmp(path, "/api/gallery")) {
            if (!rate_ok(ip)) {
                json(fd, "429 Too Many Requests", "{\"error\":\"slow down\"}");
                goto done;
            }
            gallery_delete(fd, body);
            goto done;
        }
        json(fd, "404 Not Found", "{\"error\":\"not found\"}");
        goto done;
    }

    json(fd, "405 Method Not Allowed", "{\"error\":\"GET, POST or DELETE\"}");

done:
    free(body);
}

/* -------------------------------------------------------------- self test */

/* Known answers from FIPS 180-4 and RFC 4231. A hash you wrote yourself is
 * worth exactly as much as its vectors: wrong-but-consistent is the failure
 * mode, and it looks identical to working until github disagrees. */
static int selftest(void)
{
    struct { const char *in, *want; } v[] = {
        { "abc",
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
        { "",
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
        { "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1" },
    };
    uint8_t dig[32];
    char got[65];
    int i, bad = 0;

    for (i = 0; i < 3; i++) {
        sha256 s;
        sha256_init(&s);
        sha256_update(&s, v[i].in, strlen(v[i].in));
        sha256_final(&s, dig);
        hex(dig, 32, got);
        if (strcmp(got, v[i].want)) {
            printf("  sha256 FAIL  %-8s\n    got  %s\n    want %s\n",
                   *v[i].in ? v[i].in : "(empty)", got, v[i].want);
            bad = 1;
        }
    }

    /* one long message, to exercise the multi-block path */
    {
        sha256 s;
        char buf[1000];
        memset(buf, 'a', sizeof buf);
        sha256_init(&s);
        for (i = 0; i < 1000; i++) sha256_update(&s, buf, sizeof buf);
        sha256_final(&s, dig);
        hex(dig, 32, got);
        if (strcmp(got, "cdc76e5c9914fb9281a1c7e284d73e67"
                        "f1809a48a497200e046d39ccc7112cd0")) {
            printf("  sha256 FAIL  one million 'a'\n    got  %s\n", got);
            bad = 1;
        }
    }

    /* RFC 4231 case 2 */
    hmac_sha256((const uint8_t *)"Jefe", 4,
                (const uint8_t *)"what do ya want for nothing?", 28, dig);
    hex(dig, 32, got);
    if (strcmp(got, "5bdcc146bf60754e6a042426089575c7"
                    "5a003f089d2739839dec58b964ec3843")) {
        printf("  hmac FAIL\n    got  %s\n", got);
        bad = 1;
    }

    /* a key longer than the block size takes the hashed-key branch */
    {
        uint8_t longkey[131];
        memset(longkey, 0xaa, sizeof longkey);
        hmac_sha256(longkey, sizeof longkey,
                    (const uint8_t *)"Test Using Larger Than Block-Size Key - "
                                     "Hash Key First", 54, dig);
        hex(dig, 32, got);
        if (strcmp(got, "60e431591ee0b67f0d8a26aacbf5b77f"
                        "8e0bc6213728c5140546040f0ee37f54")) {
            printf("  hmac FAIL  long key\n    got  %s\n", got);
            bad = 1;
        }
    }

    printf(bad ? "hookd: SELFTEST FAILED\n" : "hookd: selftest ok\n");
    return bad;
}

int main(int argc, char **argv)
{
    const char *conf = argc > 1 ? argv[1] : "/etc/garden/garden.conf";
    struct sockaddr_in a;
    int s, one = 1;

    if (argc > 1 && !strcmp(argv[1], "-t")) return selftest();

    load_conf(conf);
    if (!SECRET[0])
        fprintf(stderr, "hookd: WARNING no DEPLOY_SECRET — /deploy refuses everything\n");

    signal(SIGPIPE, SIG_IGN);
    signal(SIGCHLD, SIG_IGN);          /* deploys are detached, never waited on */

    s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) { perror("socket"); return 1; }
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)HOOK_PORT);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   /* nginx is the only way in */

    if (bind(s, (struct sockaddr *)&a, sizeof a) != 0) { perror("bind"); return 1; }
    if (listen(s, 16) != 0) { perror("listen"); return 1; }

    printf("hookd: listening on 127.0.0.1:%d  repo=%s\n", HOOK_PORT, REPO_DIR);
    fflush(stdout);

    for (;;) {
        int c = accept(s, NULL, NULL);
        if (c < 0) { if (errno == EINTR) continue; perror("accept"); break; }
        handle(c);
        close(c);
    }
    close(s);
    return 0;
}
