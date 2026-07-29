/* garden — a small http server that reads blocks and renders them.
 *
 *   C   does sockets, files, the loam parser, and escaping.
 *   Lua does the templates. edit lua/render.lua and refresh; no recompile.
 *
 * Memory: one arena per request. Every allocation a request makes comes out
 * of it and the whole thing is released in one call when the response is
 * written. There is no free() in this file.
 *
 * Single-threaded and blocking on purpose. This serves one person editing
 * their own garden. The VPS gets static files from `garden build`.
 */

#include "arena.h"
#include "loam.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>

#define BLOCKS_DIR "blocks"
#define SITE_DIR   "site"
#define LUA_RENDER "lua/render.lua"
#define REQ_MAX    8192
#define MAX_BLOCKS 4096

static lua_State *L;
static Arena      A;          /* the per-request arena */

/* ---------- lua ---------- */

/* Reloaded on every request so template edits show up without a restart.
 * A fresh state per request also means a broken template can't corrupt
 * anything that outlives it. */
static int lua_reload(void)
{
    if (L) lua_close(L);
    L = luaL_newstate();
    if (!L) return -1;
    luaL_openlibs(L);
    if (luaL_dofile(L, LUA_RENDER) != 0) {
        fprintf(stderr, "lua: %s\n", lua_tostring(L, -1));
        lua_close(L); L = NULL;
        return -1;
    }
    return 0;
}

static void push_field(const char *k, const char *v)
{
    lua_pushstring(L, k);
    lua_pushstring(L, v ? v : "");
    lua_settable(L, -3);
}

/* calls render.<fn>(table_on_top) -> string, copied into the arena. */
static char *lua_call_render(const char *fn)
{
    lua_getglobal(L, "render");
    if (!lua_istable(L, -1)) { lua_pop(L, 2); return NULL; }
    lua_getfield(L, -1, fn);
    if (!lua_isfunction(L, -1)) { lua_pop(L, 3); return NULL; }

    lua_pushvalue(L, -3);           /* the argument table */
    lua_remove(L, -4);              /* drop the original copy */
    lua_remove(L, -3);              /* drop `render` */

    if (lua_pcall(L, 1, 1, 0) != 0) {
        fprintf(stderr, "lua: %s\n", lua_tostring(L, -1));
        lua_pop(L, 1);
        return NULL;
    }
    const char *s = lua_tostring(L, -1);
    char *out = s ? arena_strdup(&A, s) : NULL;
    lua_pop(L, 1);
    return out;
}

/* ---------- walking the graph ---------- */

static int cmp_str(const void *a, const void *b)
{
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

/* every block id in blocks/, sorted. returns count. */
static int all_ids(char **ids, int max)
{
    int n = 0;
    DIR *d = opendir(BLOCKS_DIR);
    if (!d) return 0;
    struct dirent *e;
    while ((e = readdir(d)) && n < max) {
        if (e->d_name[0] == '.') continue;
        char stem[192];
        snprintf(stem, sizeof stem, "%.191s", e->d_name);
        char *dot = strrchr(stem, '.');
        if (!dot) continue;
        *dot = '\0';
        if (!loam_id_ok(stem)) continue;
        ids[n++] = arena_strdup(&A, stem);
    }
    closedir(d);
    qsort(ids, (size_t)n, sizeof ids[0], cmp_str);
    return n;
}

/* one entry in a list-of-blocks table */
static void push_summary(int idx, const Block *b)
{
    const char *t = loam_get(b, "title");
    lua_pushinteger(L, idx);
    lua_newtable(L);
    push_field("id",    b->id);
    push_field("type",  b->type);
    push_field("title", t ? t : b->id);
    push_field("date",  loam_get(b, "date"));
    push_field("tags",  loam_get(b, "tags"));
    push_field("stage", loam_get(b, "stage"));
    lua_settable(L, -3);
}

/* `draft yes` removes a block completely: 404 on its own URL, and gone from
 * every index, backlink, tag and transclusion. The file stays on disk.
 * `hidden yes` is softer — reachable by URL, absent from listings. */
static int is_yes(const char *v)
{
    return v && (*v == 'y' || *v == 'Y' || *v == 't' || *v == 'T' || *v == '1');
}
static int is_draft(const Block *b)  { return is_yes(loam_get(b, "draft")); }
static int is_hidden(const Block *b) { return is_draft(b) || is_yes(loam_get(b, "hidden")); }

/* whitespace-separated word match, so `rot` doesn't match `rotten` */
static int has_word(const char *list, const char *word)
{
    if (!list || !word || !*word) return 0;
    size_t wl = strlen(word);
    const char *p = list;
    while (*p) {
        while (*p == ' ' || *p == '\t') p++;
        const char *s = p;
        while (*p && *p != ' ' && *p != '\t') p++;
        if ((size_t)(p - s) == wl && strncmp(s, word, wl) == 0) return 1;
    }
    return 0;
}

/* all blocks, optionally filtered to one tag */
static void push_blocks(const char *tag)
{
    lua_newtable(L);
    char *ids[MAX_BLOCKS];
    int n = all_ids(ids, MAX_BLOCKS), k = 0;
    for (int i = 0; i < n; i++) {
        Block b;
        if (loam_load(&A, BLOCKS_DIR, ids[i], &b) != 0) continue;
        if (is_hidden(&b)) continue;
        if (tag && !has_word(loam_get(&b, "tags"), tag)) continue;
        push_summary(++k, &b);
    }
}

/* who links to `id`? scan every block for [[id]]. O(n) per request, which is
 * the right complexity for a garden with hundreds of blocks and no database. */
static void push_incoming(const char *id)
{
    lua_newtable(L);
    char needle[192], needle2[192];
    snprintf(needle,  sizeof needle,  "[[%.150s]]", id);
    snprintf(needle2, sizeof needle2, "[[%.150s|", id);
    size_t nlen = strlen(needle), nlen2 = strlen(needle2);

    char *ids[MAX_BLOCKS];
    int n = all_ids(ids, MAX_BLOCKS), k = 0;
    for (int i = 0; i < n; i++) {
        if (strcmp(ids[i], id) == 0) continue;
        Block b;
        if (loam_load(&A, BLOCKS_DIR, ids[i], &b) != 0) continue;
        if (is_hidden(&b)) continue;
        if (loam_find(b.body, b.body_len, needle, nlen) ||
            loam_find(b.body, b.body_len, needle2, nlen2))
            push_summary(++k, &b);
    }
}

/* every declared contradiction, as pairs. the edge is symmetric: declaring
 * `contra` on either side puts the pair here exactly once. */
static void push_contradictions(void)
{
    lua_newtable(L);
    char *ids[MAX_BLOCKS];
    int n = all_ids(ids, MAX_BLOCKS), k = 0;

    for (int i = 0; i < n; i++) {
        Block b;
        if (loam_load(&A, BLOCKS_DIR, ids[i], &b) != 0) continue;
        if (is_hidden(&b)) continue;
        const char *c = loam_get(&b, "contra");
        if (!c || !*c) continue;

        char list[512];
        snprintf(list, sizeof list, "%.511s", c);
        for (char *tok = strtok(list, " \t"); tok; tok = strtok(NULL, " \t")) {
            Block o;
            if (!loam_id_ok(tok) || loam_load(&A, BLOCKS_DIR, tok, &o) != 0) continue;
            /* emit once: skip if the other side also declares it and sorts first */
            const char *oc = loam_get(&o, "contra");
            if (oc && has_word(oc, b.id) && strcmp(o.id, b.id) < 0) continue;

            Buf lb, rb;
            buf_init(&lb, &A); buf_init(&rb, &A);
            loam_render(&A, BLOCKS_DIR, &b, &lb, LOAM_MAX_DEPTH);
            loam_render(&A, BLOCKS_DIR, &o, &rb, LOAM_MAX_DEPTH);

            lua_pushinteger(L, ++k);
            lua_newtable(L);

            lua_pushstring(L, "left");
            lua_newtable(L);
            push_field("id", b.id);
            push_field("title", loam_get(&b, "title") ? loam_get(&b, "title") : b.id);
            push_field("body", lb.p ? lb.p : "");
            lua_settable(L, -3);

            lua_pushstring(L, "right");
            lua_newtable(L);
            push_field("id", o.id);
            push_field("title", loam_get(&o, "title") ? loam_get(&o, "title") : o.id);
            push_field("body", rb.p ? rb.p : "");
            lua_settable(L, -3);

            lua_settable(L, -3);
        }
    }
}

/* every tag in the garden, with a count */
static void push_tags(void)
{
    lua_newtable(L);
    char seen[256][64];
    int  count[256];
    int  ntags = 0;

    char *ids[MAX_BLOCKS];
    int n = all_ids(ids, MAX_BLOCKS);
    for (int i = 0; i < n; i++) {
        Block b;
        if (loam_load(&A, BLOCKS_DIR, ids[i], &b) != 0) continue;
        if (is_hidden(&b)) continue;
        const char *tg = loam_get(&b, "tags");
        if (!tg) continue;
        char list[512];
        snprintf(list, sizeof list, "%.511s", tg);
        for (char *tok = strtok(list, " \t"); tok; tok = strtok(NULL, " \t")) {
            int found = 0;
            for (int j = 0; j < ntags; j++)
                if (strcmp(seen[j], tok) == 0) { count[j]++; found = 1; break; }
            if (!found && ntags < 256 && strlen(tok) < 64) {
                snprintf(seen[ntags], 64, "%s", tok);
                count[ntags++] = 1;
            }
        }
    }
    for (int j = 0; j < ntags; j++) {
        lua_pushinteger(L, j + 1);
        lua_newtable(L);
        push_field("tag", seen[j]);
        lua_pushstring(L, "n");
        lua_pushinteger(L, count[j]);
        lua_settable(L, -3);
        lua_settable(L, -3);
    }
}

/* ---------- http ---------- */

/* write() on a socket returns short whenever the send buffer fills, which for
 * anything past a few hundred KB is every time. A single write() call was
 * silently truncating large responses. Loop until it's all out. */
static int write_all(int fd, const char *p, size_t n)
{
    while (n) {
        ssize_t w = write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

static int send_head(int fd, const char *status, const char *ctype, size_t len)
{
    char head[512];
    int hn = snprintf(head, sizeof head,
        "HTTP/1.1 %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %zu\r\n"
        "Cache-Control: no-store\r\n"
        "X-Content-Type-Options: nosniff\r\n"
        "Connection: close\r\n\r\n",
        status, ctype, len);
    return write_all(fd, head, (size_t)hn);
}

static void respond(int fd, const char *status, const char *ctype,
                    const char *body, size_t len)
{
    if (send_head(fd, status, ctype, len) < 0) return;
    if (len) write_all(fd, body, len);
}

/* Stream a file straight to the socket in chunks. A 2GB PDF under a mount
 * must never land in the arena. */
static int stream_file(int fd, const char *full, const char *ctype, size_t size)
{
    FILE *f = fopen(full, "rb");
    if (!f) return 0;
    if (send_head(fd, "200 OK", ctype, size) < 0) { fclose(f); return 1; }

    char buf[64 * 1024];
    size_t got;
    while ((got = fread(buf, 1, sizeof buf, f)) > 0)
        if (write_all(fd, buf, got) < 0) break;
    fclose(f);
    return 1;
}

static void respond_lua(int fd, const char *status, const char *fn)
{
    char *html = lua_call_render(fn);
    if (!html) {
        const char *e = "<!doctype html><title>template error</title>"
                        "<p>lua/render.lua failed. see the terminal.";
        respond(fd, "500 Internal Server Error", "text/html; charset=utf-8",
                e, strlen(e));
        return;
    }
    respond(fd, status, "text/html; charset=utf-8", html, strlen(html));
}

/* Load a block, parse it, hand it to Lua. NULL if there's no such block. */
static char *render_block(const char *id)
{
    Block b;
    if (!loam_id_ok(id) || loam_load(&A, BLOCKS_DIR, id, &b) != 0) return NULL;
    if (is_draft(&b)) return NULL;      /* present on disk, absent from the site */

    Buf body; buf_init(&body, &A);
    loam_render(&A, BLOCKS_DIR, &b, &body, 0);

    lua_newtable(L);
    push_field("id",   b.id);
    push_field("type", b.type);
    push_field("body", body.p ? body.p : "");
    for (int i = 0; i < b.nfields; i++)
        push_field(b.fields[i].key, b.fields[i].val);

    lua_pushstring(L, "incoming");
    push_incoming(b.id);
    lua_settable(L, -3);

    /* table of contents: every `## ` line, with the anchor the h2 got.
     * a very long page needs a way in that isn't scrolling. */
    lua_pushstring(L, "toc");
    lua_newtable(L);
    {
        const char *s = b.body;
        size_t n = b.body_len, i = 0;
        int k = 0, verse = 0, raw = 0;
        while (i < n) {
            size_t st = i;
            while (i < n && s[i] != '\n') i++;
            size_t ln = i - st;
            i++;
            while (ln && s[st + ln - 1] == '\r') ln--;
            /* headings inside ~~~ or ::: are not headings */
            if (ln >= 3 && !strncmp(s + st, "~~~", 3)) { verse = !verse; continue; }
            if (ln >= 3 && !strncmp(s + st, ":::", 3)) { raw = !raw; continue; }
            if (verse || raw) continue;
            if (ln < 3 || strncmp(s + st, "## ", 3)) continue;
            char slug[128], text[256];
            loam_slug(s + st + 3, ln - 3, slug, sizeof slug);
            size_t tl = ln - 3 < sizeof text - 1 ? ln - 3 : sizeof text - 1;
            memcpy(text, s + st + 3, tl); text[tl] = '\0';
            lua_pushinteger(L, ++k);
            lua_newtable(L);
            push_field("id", slug);
            push_field("text", text);
            lua_settable(L, -3);
        }
    }
    lua_settable(L, -3);

    /* how long is this thing, so the template can decide */
    lua_pushstring(L, "bytes");
    lua_pushnumber(L, (double)b.body_len);
    lua_settable(L, -3);

    return lua_call_render("block");
}

static void not_found(int fd, const char *path)
{
    lua_newtable(L);
    push_field("path", path);
    respond_lua(fd, "404 Not Found", "notfound");
}

static const char *mime_of(const char *path)
{
    const char *d = strrchr(path, '.');
    if (!d) return "application/octet-stream";
    if (!strcmp(d, ".css"))   return "text/css; charset=utf-8";
    if (!strcmp(d, ".js"))    return "text/javascript; charset=utf-8";
    if (!strcmp(d, ".wasm"))  return "application/wasm";
    if (!strcmp(d, ".svg"))   return "image/svg+xml";
    if (!strcmp(d, ".png"))   return "image/png";
    if (!strcmp(d, ".jpg"))   return "image/jpeg";
    if (!strcmp(d, ".gif"))   return "image/gif";
    if (!strcmp(d, ".avif"))  return "image/avif";
    if (!strcmp(d, ".webp"))  return "image/webp";
    if (!strcmp(d, ".webm"))  return "video/webm";
    if (!strcmp(d, ".mp4"))   return "video/mp4";
    if (!strcmp(d, ".opus"))  return "audio/ogg";
    if (!strcmp(d, ".ogg"))   return "audio/ogg";
    if (!strcmp(d, ".mp3"))   return "audio/mpeg";
    if (!strcmp(d, ".flac"))  return "audio/flac";
    if (!strcmp(d, ".woff2")) return "font/woff2";
    if (!strcmp(d, ".woff"))  return "font/woff";
    if (!strcmp(d, ".ttf"))   return "font/ttf";
    if (!strcmp(d, ".otf"))   return "font/otf";
    if (!strcmp(d, ".xml"))   return "application/xml";
    if (!strcmp(d, ".txt"))   return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

/* Static assets only: css, js, fonts, wasm, media. Never lists a directory,
 * never serves anything outside site/. */
static int serve_static(int fd, const char *path)
{
    if (strstr(path, "..")) return 0;

    char full[640];
    snprintf(full, sizeof full, "%s%.480s", SITE_DIR, path);

    struct stat st;
    if (stat(full, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
    return stream_file(fd, full, mime_of(full), (size_t)st.st_size);
}

/* Generated from whatever is in site/fonts/. Drop `blackletter.woff2` in
 * there and you immediately get `font  blackletter` as a header field and
 * `{f-blackletter|word}` as inline markup. No registration step. */
static void serve_fonts_css(int fd)
{
    Buf css; buf_init(&css, &A);
    buf_str(&css, "/* generated from site/fonts/ */\n");

    DIR *d = opendir(SITE_DIR "/fonts");
    if (d) {
        char *names[256];
        int n = 0;
        struct dirent *e;
        while ((e = readdir(d)) && n < 256) {
            size_t l = strlen(e->d_name);
            if (l < 7 || strcmp(e->d_name + l - 6, ".woff2")) continue;
            char stem[128];
            if (l - 6 >= sizeof stem) continue;
            memcpy(stem, e->d_name, l - 6); stem[l - 6] = '\0';
            if (!loam_id_ok(stem)) continue;
            names[n++] = arena_strdup(&A, stem);
        }
        closedir(d);
        qsort(names, (size_t)n, sizeof names[0], cmp_str);

        for (int i = 0; i < n; i++) {
            buf_str(&css, "@font-face{font-family:");
            buf_str(&css, names[i]);
            buf_str(&css, ";src:url(/fonts/");
            buf_str(&css, names[i]);
            buf_str(&css, ".woff2) format(\"woff2\");font-display:swap}\n.f-");
            buf_str(&css, names[i]);
            buf_str(&css, "{font-family:");
            buf_str(&css, names[i]);
            buf_str(&css, "}\n");
        }
    }
    respond(fd, "200 OK", "text/css; charset=utf-8", css.p ? css.p : "", css.len);
}

/* ---------- mounts ----------
 *
 * site/mnt/<name> is a symlink to a directory somewhere else on disk. Those
 * are the only paths that may leave site/, and the only ones that get a
 * directory listing. Everything else 404s.
 *
 * Containment: the textual `..` reject stops the obvious thing, and then
 * realpath() of the resolved target must still sit under realpath() of the
 * mount root. A symlink *inside* a mounted tree that points at /etc is
 * therefore refused, which the textual check alone would not catch.
 */
static int mount_root(const char *name, char *out, size_t outn)
{
    if (!loam_id_ok(name)) return 0;
    char link[512];
    snprintf(link, sizeof link, "%s/mnt/%.128s", SITE_DIR, name);
    return realpath(link, out) && strlen(out) < outn;
}

static int under(const char *root, const char *p)
{
    size_t rl = strlen(root);
    return strncmp(p, root, rl) == 0 && (p[rl] == '\0' || p[rl] == '/');
}

static int cmp_dirent(const void *a, const void *b)
{
    return strcmp(*(const char *const *)a, *(const char *const *)b);
}

/* one directory, listed. `rel` is the path below the mount, for links. */
static void push_listing(const char *real, const char *name, const char *rel)
{
    lua_newtable(L);
    push_field("mount", name);
    push_field("rel", rel);

    lua_pushstring(L, "entries");
    lua_newtable(L);

    DIR *d = opendir(real);
    if (d) {
        char *names[4096];
        int n = 0;
        struct dirent *e;
        while ((e = readdir(d)) && n < 4096) {
            if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
            if (e->d_name[0] == '.') continue;          /* no dotfiles, ever */
            names[n++] = arena_strdup(&A, e->d_name);
        }
        closedir(d);
        qsort(names, (size_t)n, sizeof names[0], cmp_dirent);

        int k = 0;
        for (int i = 0; i < n; i++) {
            char child[2048];
            snprintf(child, sizeof child, "%s/%s", real, names[i]);
            struct stat st;
            if (stat(child, &st) != 0) continue;

            lua_pushinteger(L, ++k);
            lua_newtable(L);
            push_field("name", names[i]);
            push_field("kind", S_ISDIR(st.st_mode) ? "dir" : "file");
            lua_pushstring(L, "size");
            lua_pushnumber(L, (double)st.st_size);
            lua_settable(L, -3);
            lua_settable(L, -3);
        }
    }
    lua_settable(L, -3);      /* outer.entries = the table we just filled */
}

/* /mnt/<name>/<rest...> */
static int serve_mount(int fd, const char *path)
{
    if (strstr(path, "..")) return 0;

    char name[160];
    const char *p = path + 5;                  /* past "/mnt/" */
    const char *slash = strchr(p, '/');
    size_t nl = slash ? (size_t)(slash - p) : strlen(p);
    if (nl == 0 || nl >= sizeof name) return 0;
    memcpy(name, p, nl); name[nl] = '\0';

    char root[1024];
    if (!mount_root(name, root, sizeof root)) return 0;

    const char *rel = slash ? slash + 1 : "";
    char want[2048];
    snprintf(want, sizeof want, "%s%s%.900s", root, *rel ? "/" : "", rel);

    char real[1024];
    if (!realpath(want, real)) return 0;
    if (!under(root, real)) return 0;          /* a symlink tried to escape */

    struct stat st;
    if (stat(real, &st) != 0) return 0;

    if (S_ISDIR(st.st_mode)) {
        push_listing(real, name, rel);
        respond_lua(fd, "200 OK", "dir");
        return 1;
    }
    if (!S_ISREG(st.st_mode)) return 0;
    return stream_file(fd, real, mime_of(real), (size_t)st.st_size);
}

static void handle(int fd)
{
    char req[REQ_MAX];
    ssize_t got = read(fd, req, sizeof req - 1);
    if (got <= 0) return;
    req[got] = '\0';

    if (strncmp(req, "GET ", 4) != 0) {
        const char *e = "only GET";
        respond(fd, "405 Method Not Allowed", "text/plain", e, strlen(e));
        return;
    }

    char path[512];
    const char *p = req + 4;
    const char *sp = strchr(p, ' ');
    size_t plen = sp ? (size_t)(sp - p) : strlen(p);
    if (plen >= sizeof path) plen = sizeof path - 1;
    memcpy(path, p, plen); path[plen] = '\0';

    char *q = strchr(path, '?');
    if (q) *q = '\0';

    /* percent-decode. mounted folders have spaces and brackets in their
     * names, so without this half the library is unreachable. Decoding
     * happens before every path check, and %2e%2e therefore cannot smuggle
     * a `..` past the textual reject downstream. */
    {
        char dec[512];
        size_t o = 0;
        for (size_t i = 0; path[i] && o < sizeof dec - 1; i++) {
            if (path[i] == '%' && isxdigit((unsigned char)path[i + 1]) &&
                                  isxdigit((unsigned char)path[i + 2])) {
                char hex[3] = { path[i + 1], path[i + 2], 0 };
                unsigned v = (unsigned)strtoul(hex, NULL, 16);
                if (v == 0) return;                /* no NUL injection */
                dec[o++] = (char)v;
                i += 2;
            } else {
                dec[o++] = path[i];
            }
        }
        dec[o] = '\0';
        memcpy(path, dec, o + 1);
    }

    if (lua_reload() != 0) {
        const char *e = "<!doctype html><title>lua error</title>"
                        "<p>lua/render.lua did not load. see the terminal.";
        respond(fd, "500 Internal Server Error", "text/html; charset=utf-8",
                e, strlen(e));
        return;
    }

    printf("  %s\n", path);
    fflush(stdout);

    if (!strcmp(path, "/") || !strcmp(path, "/index.html")) {
        lua_newtable(L);
        lua_pushstring(L, "blocks");
        push_blocks(NULL);
        lua_settable(L, -3);
        lua_pushstring(L, "tags");
        push_tags();
        lua_settable(L, -3);
        respond_lua(fd, "200 OK", "home");
        return;
    }

    if (!strcmp(path, "/contradictions")) {
        lua_newtable(L);
        lua_pushstring(L, "pairs");
        push_contradictions();
        lua_settable(L, -3);
        respond_lua(fd, "200 OK", "contradictions");
        return;
    }

    if (!strcmp(path, "/tags")) {
        lua_newtable(L);
        lua_pushstring(L, "tags");
        push_tags();
        lua_settable(L, -3);
        respond_lua(fd, "200 OK", "tags");
        return;
    }

    if (!strncmp(path, "/tag/", 5)) {
        char tag[64];
        snprintf(tag, sizeof tag, "%.63s", path + 5);
        if (!loam_id_ok(tag)) { not_found(fd, path); return; }
        lua_newtable(L);
        push_field("tag", tag);
        lua_pushstring(L, "blocks");
        push_blocks(tag);
        lua_settable(L, -3);
        respond_lua(fd, "200 OK", "tag");
        return;
    }

    if (!strncmp(path, "/b/", 3)) {
        char id[192];
        snprintf(id, sizeof id, "%.191s", path + 3);
        char *dot = strstr(id, ".html");
        if (dot) *dot = '\0';

        char *html = render_block(id);
        if (!html) { not_found(fd, path); return; }
        respond(fd, "200 OK", "text/html; charset=utf-8", html, strlen(html));
        return;
    }

    if (!strcmp(path, "/fonts.css")) { serve_fonts_css(fd); return; }

    /* mounted folders: the only paths allowed to leave site/
     *
     * The index goes first. "/mnt/" matches the prefix below with an empty
     * name, which serve_mount rejects, so with the branches the other way
     * round the trailing slash was a 404 and the `|| "/mnt/"` here could
     * never be reached — a directory whose own listing depended on being
     * asked for without the slash a directory usually has. */
    if (!strcmp(path, "/mnt") || !strcmp(path, "/mnt/")) {
        push_listing(SITE_DIR "/mnt", "", "");
        respond_lua(fd, "200 OK", "mounts");
        return;
    }
    if (!strncmp(path, "/mnt/", 5)) {
        if (serve_mount(fd, path)) return;
        not_found(fd, path);
        return;
    }

    if (serve_static(fd, path)) return;
    not_found(fd, path);
}

int main(int argc, char **argv)
{
    arena_init(&A);

    /* garden -r <id>   render one block to stdout and exit. no socket. */
    if (argc > 2 && !strcmp(argv[1], "-r")) {
        if (lua_reload() != 0) return 1;
        char *html = render_block(argv[2]);
        if (!html) { fprintf(stderr, "no block: %s\n", argv[2]); return 1; }
        fputs(html, stdout);
        lua_close(L);
        arena_reset(&A);
        return 0;
    }

    int port = argc > 1 ? atoi(argv[1]) : 8000;

    signal(SIGPIPE, SIG_IGN);

    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) { perror("socket"); return 1; }
    int one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);

    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons((uint16_t)port);
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   /* localhost only */

    if (bind(s, (struct sockaddr *)&a, sizeof a) != 0) { perror("bind"); return 1; }
    if (listen(s, 16) != 0) { perror("listen"); return 1; }

    printf("garden: http://localhost:%d/\n", port);
    printf("blocks: %s/   templates: %s   (edits reload on refresh)\n\n",
           BLOCKS_DIR, LUA_RENDER);
    fflush(stdout);

    for (;;) {
        int c = accept(s, NULL, NULL);
        if (c < 0) { if (errno == EINTR) continue; perror("accept"); break; }
        handle(c);
        close(c);
        arena_reset(&A);        /* the entire request, gone, in one call */
    }
    if (L) lua_close(L);
    arena_reset(&A);
    close(s);
    return 0;
}
