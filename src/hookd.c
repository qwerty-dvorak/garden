/* hookd.c — authenticated deploy webhook and status endpoint.
 *
 * garden serves the site. This separate loopback process verifies a push,
 * starts deploy.sh, and reports which commit is serving. It keeps no content
 * or visitor state.
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
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/wait.h>

#define HDR_MAX     16384
#define BODY_MAX    1048576      /* github push payloads are not small */

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
    }
    fclose(f);
}

/* -------------------------------------------------------------------- http */

static int write_all(int fd, const char *p, size_t n)
{
    while (n) {
        ssize_t wrote = write(fd, p, n);
        if (wrote < 0) { if (errno == EINTR) continue; return -1; }
        if (wrote == 0) return -1;
        p += wrote;
        n -= (size_t)wrote;
    }
    return 0;
}

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
    if (write_all(fd, head, (size_t)n) < 0) return;
    if (len) write_all(fd, body, len);
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
    if ((size_t)n >= sizeof body) n = (int)sizeof body - 1;
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

/* A full git object name, or a future longer hash: hexadecimal and bounded. */
static int hex_ok(const char *s)
{
    size_t i;
    if (!s || !*s || strlen(s) > 64) return 0;
    for (i = 0; s[i]; i++)
        if (!isxdigit((unsigned char)s[i])) return 0;
    return 1;
}

/* ----------------------------------------------------------------- deploy */

/* Detached: the caller gets a 202 and hangs up. GitHub allows a webhook about
 * ten seconds and a clean build plus a restart plus the health check does not
 * reliably fit in ten, and a hook that times out is a hook GitHub starts
 * calling broken. SIGCHLD is ignored in main(), so nothing is left to reap. */
static int spawn_deploy(void)
{
    pid_t pid = fork();
    char script[1024];

    if (pid < 0) return -1;
    if (pid > 0) return 0;

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
            if (spawn_deploy() < 0) {
                json(fd, "500 Internal Server Error", "{\"error\":\"could not fork\"}");
                goto done;
            }
            json(fd, "202 Accepted", "{\"ok\":true,\"deploying\":true}");
            goto done;
        }
        json(fd, "404 Not Found", "{\"error\":\"not found\"}");
        goto done;
    }

    json(fd, "405 Method Not Allowed", "{\"error\":\"GET or POST\"}");

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
