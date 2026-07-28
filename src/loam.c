#include "loam.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------- buffer ---------- */

void buf_init(Buf *b, Arena *a) { b->p = NULL; b->len = b->cap = 0; b->a = a; }

void buf_add(Buf *b, const char *s, size_t n)
{
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 1024;
        while (cap < b->len + n + 1) cap *= 2;
        b->p = arena_grow(b->a, b->p, b->cap, cap);
        b->cap = cap;
    }
    memcpy(b->p + b->len, s, n);
    b->len += n;
    b->p[b->len] = '\0';
}

void buf_str(Buf *b, const char *s) { buf_add(b, s, strlen(s)); }

/* Escape on output. Every byte of block text goes through here. Forgetting it
 * once is stored XSS, so there is exactly one path and this is it.
 * The ::: raw block is the single deliberate exception. */
void buf_esc(Buf *b, const char *s, size_t n)
{
    size_t i, run = 0;
    for (i = 0; i < n; i++) {
        const char *ent = NULL;
        switch (s[i]) {
        case '&':  ent = "&amp;";  break;
        case '<':  ent = "&lt;";   break;
        case '>':  ent = "&gt;";   break;
        case '"':  ent = "&quot;"; break;
        case '\'': ent = "&#39;";  break;
        default:   run++; continue;
        }
        if (run) buf_add(b, s + i - run, run);
        run = 0;
        buf_str(b, ent);
    }
    if (run) buf_add(b, s + n - run, run);
}

/* ---------- ids and search ---------- */

const char *loam_find(const char *hay, size_t hn, const char *needle, size_t nn)
{
    if (nn == 0 || hn < nn) return NULL;
    for (size_t i = 0; i + nn <= hn; i++)
        if (hay[i] == needle[0] && memcmp(hay + i, needle, nn) == 0)
            return hay + i;
    return NULL;
}

void loam_slug(const char *s, size_t n, char *out, size_t outn)
{
    size_t o = 0, dash = 1;
    for (size_t i = 0; i < n && o + 1 < outn; i++) {
        unsigned char c = (unsigned char)s[i];
        if (isalnum(c)) { out[o++] = (char)tolower(c); dash = 0; }
        else if (!dash) { out[o++] = '-'; dash = 1; }
    }
    while (o && out[o - 1] == '-') o--;
    out[o] = '\0';
    if (!o) snprintf(out, outn, "section");
}

int loam_id_ok(const char *id)
{
    size_t n = strlen(id);
    if (n == 0 || n > 100) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = id[i];
        if (!(isalnum((unsigned char)c) || c == '-' || c == '_')) return 0;
    }
    return 1;
}

/* a path that is safe to put in a src="" — relative, no scheme, no traversal */
static int src_ok(const char *s)
{
    if (!s || !*s) return 0;
    if (strstr(s, "..")) return 0;
    if (strchr(s, '"') || strchr(s, '\'') || strchr(s, '<')) return 0;
    if (s[0] != '/') return 0;          /* must be site-relative */
    if (strstr(s, "//")) return 0;      /* no //evil.com */
    return 1;
}

/* ---------- loading ---------- */

static const char *TYPES[] = {
    "note", "quote", "link", "collection", "poem",
    "image", "audio", "video", "html", NULL
};

static char *slurp(Arena *a, const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) { fclose(f); return NULL; }
    long sz = ftell(f);
    if (sz < 0 || sz > (1L << 26)) { fclose(f); return NULL; }  /* 64MB cap */
    rewind(f);
    char *p = arena_alloc(a, (size_t)sz + 1);
    size_t got = fread(p, 1, (size_t)sz, f);
    fclose(f);
    p[got] = '\0';
    *len = got;
    return p;
}

static void trim(char *s)
{
    char *e = s + strlen(s);
    while (e > s && isspace((unsigned char)e[-1])) *--e = '\0';
    char *b = s;
    while (*b && isspace((unsigned char)*b)) b++;
    if (b != s) memmove(s, b, strlen(b) + 1);
}

int loam_load(Arena *a, const char *dir, const char *id, Block *out)
{
    if (!loam_id_ok(id)) return -1;

    char path[512];
    char *raw = NULL;
    size_t raw_len = 0;
    const char *type = NULL;

    for (int i = 0; TYPES[i]; i++) {
        snprintf(path, sizeof path, "%s/%s.%s", dir, id, TYPES[i]);
        raw = slurp(a, path, &raw_len);
        if (raw) { type = TYPES[i]; break; }
    }
    if (!raw) return -1;

    memset(out, 0, sizeof *out);
    snprintf(out->id,   sizeof out->id,   "%.127s", id);
    snprintf(out->type, sizeof out->type, "%.15s",  type);

    /* header: `key  value` lines until a line that is exactly `---` */
    char *p = raw;
    while (*p) {
        char *nl = strchr(p, '\n');
        size_t n = nl ? (size_t)(nl - p) : strlen(p);

        if (n == 3 && strncmp(p, "---", 3) == 0) { p = nl ? nl + 1 : p + n; break; }

        char line[768];
        size_t cp = n < sizeof line - 1 ? n : sizeof line - 1;
        memcpy(line, p, cp); line[cp] = '\0';

        char *sp = line;
        while (*sp && !isspace((unsigned char)*sp)) sp++;
        if (*sp && out->nfields < LOAM_MAX_FIELDS) {
            *sp = '\0';
            Field *f = &out->fields[out->nfields++];
            snprintf(f->key, sizeof f->key, "%.31s",  line);
            snprintf(f->val, sizeof f->val, "%.511s", sp + 1);
            trim(f->val);
        }

        if (!nl) { p += n; break; }
        p = nl + 1;
    }

    out->body_len = strlen(p);
    out->body = p;   /* points into the arena-owned slurp */
    return 0;
}

const char *loam_get(const Block *b, const char *key)
{
    for (int i = 0; i < b->nfields; i++)
        if (strcmp(b->fields[i].key, key) == 0) return b->fields[i].val;
    return NULL;
}

/* ---------- media ---------- */

/* image / audio / video blocks emit their element before the body text.
 * Nothing autoplays, nothing preloads. A clip waits to be asked for. */
static void render_media(const Block *b, Buf *out)
{
    const char *src     = loam_get(b, "src");
    const char *poster  = loam_get(b, "poster");
    const char *alt     = loam_get(b, "alt");
    const char *caption = loam_get(b, "caption");

    if (!src_ok(src)) {
        if (src) {
            buf_str(out, "<p class=\"cite\">[bad src: ");
            buf_esc(out, src, strlen(src));
            buf_str(out, "]</p>\n");
        }
        return;
    }

    buf_str(out, "<figure class=\"media ");
    buf_esc(out, b->type, strlen(b->type));
    buf_str(out, "\">\n");

    if (strcmp(b->type, "image") == 0) {
        buf_str(out, "<img loading=\"lazy\" decoding=\"async\" src=\"");
        buf_esc(out, src, strlen(src));
        buf_str(out, "\" alt=\"");
        if (alt) buf_esc(out, alt, strlen(alt));
        buf_str(out, "\">\n");
    } else if (strcmp(b->type, "audio") == 0) {
        buf_str(out, "<audio controls preload=\"none\" src=\"");
        buf_esc(out, src, strlen(src));
        buf_str(out, "\"></audio>\n");
    } else {  /* video */
        buf_str(out, "<video controls preload=\"none\"");
        if (src_ok(poster)) {
            buf_str(out, " poster=\"");
            buf_esc(out, poster, strlen(poster));
            buf_str(out, "\"");
        }
        buf_str(out, "><source src=\"");
        buf_esc(out, src, strlen(src));
        buf_str(out, "\"></video>\n");
    }

    if (caption) {
        buf_str(out, "<figcaption>");
        buf_esc(out, caption, strlen(caption));
        buf_str(out, "</figcaption>\n");
    }
    buf_str(out, "</figure>\n");
}

/* ---------- rendering ---------- */

/* inline: [[id]]  [[id|text]]  `code`  *em*  everything else escaped */
static void render_inline(const char *s, size_t n, Buf *out)
{
    size_t i = 0;
    while (i < n) {
        if (i + 1 < n && s[i] == '[' && s[i + 1] == '[') {
            const char *close = loam_find(s + i, n - i, "]]", 2);
            if (close) {
                size_t inner = (size_t)(close - (s + i + 2));
                char id[256], text[256];
                size_t cp = inner < sizeof id - 1 ? inner : sizeof id - 1;
                memcpy(id, s + i + 2, cp); id[cp] = '\0';

                char *bar = strchr(id, '|');
                if (bar) { *bar = '\0'; snprintf(text, sizeof text, "%.255s", bar + 1); }
                else     { snprintf(text, sizeof text, "%.255s", id); }
                trim(id); trim(text);

                if (loam_id_ok(id)) {
                    buf_str(out, "<a href=\"/b/");
                    buf_esc(out, id, strlen(id));
                    buf_str(out, "\">");
                    buf_esc(out, text, strlen(text));
                    buf_str(out, "</a>");
                } else {
                    buf_esc(out, text, strlen(text));
                }
                i = (size_t)(close - s) + 2;
                continue;
            }
        }
        /* {cls|text} -> <span class="cls">text</span>
         * The universal inline knob. Any class you define in a skin becomes
         * available per word: {f-blackletter|word}, {huge|word}, {sideways|word}. */
        if (s[i] == '{') {
            /* find the *matching* brace, not the first one, so spans nest:
             * {f-mono|{invert|both apply}} */
            const char *bar = memchr(s + i + 1, '|', n - i - 1);
            const char *close = NULL;
            for (size_t j = i + 1, depth = 1; j < n; j++) {
                if (s[j] == '{') depth++;
                else if (s[j] == '}' && --depth == 0) { close = s + j; break; }
            }
            if (bar && close && bar < close) {
                char cls[96];
                size_t cn = (size_t)(bar - (s + i + 1));
                if (cn < sizeof cls) {
                    memcpy(cls, s + i + 1, cn); cls[cn] = '\0';
                    int ok = cn > 0;
                    for (size_t j = 0; j < cn; j++)
                        if (!(isalnum((unsigned char)cls[j]) || cls[j] == '-' ||
                              cls[j] == '_' || cls[j] == ' ')) ok = 0;
                    if (ok) {
                        buf_str(out, "<span class=\"");
                        buf_str(out, cls);
                        buf_str(out, "\">");
                        render_inline(bar + 1, (size_t)(close - bar - 1), out);
                        buf_str(out, "</span>");
                        i = (size_t)(close - s) + 1;
                        continue;
                    }
                }
            }
        }
        /* ==text== -> <mark> */
        if (i + 1 < n && s[i] == '=' && s[i + 1] == '=') {
            const char *close = loam_find(s + i + 2, n - i - 2, "==", 2);
            if (close) {
                buf_str(out, "<mark>");
                render_inline(s + i + 2, (size_t)(close - (s + i + 2)), out);
                buf_str(out, "</mark>");
                i = (size_t)(close - s) + 2;
                continue;
            }
        }
        /* **text** -> <strong>. checked before *em* so it wins. */
        if (i + 1 < n && s[i] == '*' && s[i + 1] == '*') {
            const char *close = loam_find(s + i + 2, n - i - 2, "**", 2);
            if (close) {
                buf_str(out, "<strong>");
                render_inline(s + i + 2, (size_t)(close - (s + i + 2)), out);
                buf_str(out, "</strong>");
                i = (size_t)(close - s) + 2;
                continue;
            }
        }
        if (s[i] == '`') {
            const char *close = memchr(s + i + 1, '`', n - i - 1);
            if (close) {
                buf_str(out, "<code>");
                buf_esc(out, s + i + 1, (size_t)(close - (s + i + 1)));
                buf_str(out, "</code>");
                i = (size_t)(close - s) + 1;
                continue;
            }
        }
        if (s[i] == '*') {
            const char *close = memchr(s + i + 1, '*', n - i - 1);
            if (close && close > s + i + 1) {
                buf_str(out, "<em>");
                buf_esc(out, s + i + 1, (size_t)(close - (s + i + 1)));
                buf_str(out, "</em>");
                i = (size_t)(close - s) + 1;
                continue;
            }
        }
        buf_esc(out, s + i, 1);
        i++;
    }
}

static void close_para(Buf *out, int *open)  { if (*open) { buf_str(out, "</p>\n");     *open = 0; } }
static void close_aside(Buf *out, int *open) { if (*open) { buf_str(out, "</aside>\n"); *open = 0; } }

void loam_render(Arena *a, const char *dir, const Block *b, Buf *out, int depth)
{
    /* a .html block is a page you wrote by hand. the body is emitted exactly
     * as written — no parsing, no escaping, no opinion. same trust model as
     * the ::: fence, just for the whole file. */
    if (strcmp(b->type, "html") == 0) {
        buf_add(out, b->body, b->body_len);
        return;
    }

    if (strcmp(b->type, "image") == 0 || strcmp(b->type, "audio") == 0 ||
        strcmp(b->type, "video") == 0)
        render_media(b, out);

    const char *s = b->body;
    size_t n = b->body_len, i = 0;
    int in_p = 0, in_aside = 0;

    while (i <= n) {
        size_t start = i;
        while (i < n && s[i] != '\n') i++;
        size_t len = i - start;
        const char *line = s + start;
        i++;  /* past newline */

        while (len && line[len - 1] == '\r') len--;

        /* ~~~ verse: whitespace preserved exactly, to the column.
         * this is what concrete poetry needs and markdown cannot do. */
        if (len >= 3 && strncmp(line, "~~~", 3) == 0) {
            close_para(out, &in_p); close_aside(out, &in_aside);
            buf_str(out, "<pre class=\"verse");
            if (len > 3) {  /* ~~~classname */
                char cls[64];
                size_t cn = len - 3 < sizeof cls - 1 ? len - 3 : sizeof cls - 1;
                memcpy(cls, line + 3, cn); cls[cn] = '\0';
                trim(cls);
                if (loam_id_ok(cls)) { buf_str(out, " "); buf_str(out, cls); }
            }
            buf_str(out, "\">");
            while (i <= n) {
                size_t vs = i;
                while (i < n && s[i] != '\n') i++;
                size_t vl = i - vs;
                i++;
                while (vl && s[vs + vl - 1] == '\r') vl--;
                if (vl >= 3 && strncmp(s + vs, "~~~", 3) == 0) break;
                buf_esc(out, s + vs, vl);
                buf_str(out, "\n");
                if (vs >= n) break;
            }
            buf_str(out, "</pre>\n");
            continue;
        }

        /* ::: raw html, verbatim. the escape hatch.
         * your own files, your own garden — this is the freedom knob.
         * guestbook entries never go through loam, so this cannot be reached
         * by anyone but you. */
        if (len >= 3 && strncmp(line, ":::", 3) == 0) {
            close_para(out, &in_p); close_aside(out, &in_aside);
            while (i <= n) {
                size_t rs = i;
                while (i < n && s[i] != '\n') i++;
                size_t rl = i - rs;
                i++;
                while (rl && s[rs + rl - 1] == '\r') rl--;
                if (rl >= 3 && strncmp(s + rs, ":::", 3) == 0) break;
                buf_add(out, s + rs, rl);
                buf_str(out, "\n");
                if (rs >= n) break;
            }
            continue;
        }

        size_t ws = 0;
        while (ws < len && isspace((unsigned char)line[ws])) ws++;
        if (ws == len) {
            close_para(out, &in_p);
            close_aside(out, &in_aside);
            if (start >= n) break;
            continue;
        }

        /* ## heading */
        if (len >= 3 && line[0] == '#' && line[1] == '#' && line[2] == ' ') {
            close_para(out, &in_p); close_aside(out, &in_aside);
            char slug[128];
            loam_slug(line + 3, len - 3, slug, sizeof slug);
            buf_str(out, "<h2 id=\"");
            buf_str(out, slug);
            buf_str(out, "\">");
            render_inline(line + 3, len - 3, out);
            buf_str(out, "</h2>\n");
            continue;
        }

        /* > marginalia -> <aside>, consecutive lines merge */
        if (len >= 2 && line[0] == '>' && line[1] == ' ') {
            close_para(out, &in_p);
            if (!in_aside) { buf_str(out, "<aside>"); in_aside = 1; }
            else            buf_str(out, " ");
            render_inline(line + 2, len - 2, out);
            continue;
        }
        close_aside(out, &in_aside);

        /* ![[id]] alone on a line -> transclusion */
        if (len > 4 && line[0] == '!' && line[1] == '[' && line[2] == '[' &&
            line[len - 1] == ']' && line[len - 2] == ']') {
            close_para(out, &in_p);
            char id[256];
            size_t idn = len - 5;
            if (idn < sizeof id) {
                memcpy(id, line + 3, idn); id[idn] = '\0';
                trim(id);
                Block t;
                if (depth < LOAM_MAX_DEPTH && loam_load(a, dir, id, &t) == 0) {
                    buf_str(out, "<blockquote class=\"block ");
                    buf_esc(out, t.type, strlen(t.type));
                    buf_str(out, "\">\n");
                    loam_render(a, dir, &t, out, depth + 1);
                    buf_str(out, "<p class=\"cite\"><a href=\"/b/");
                    buf_esc(out, t.id, strlen(t.id));
                    buf_str(out, "\">");
                    const char *ti = loam_get(&t, "title");
                    buf_esc(out, ti ? ti : t.id, strlen(ti ? ti : t.id));
                    buf_str(out, "</a></p>\n</blockquote>\n");
                } else {
                    /* missing or too deep: show it, don't hide it. rot is data. */
                    buf_str(out, "<p class=\"cite\">[missing block: ");
                    buf_esc(out, id, strlen(id));
                    buf_str(out, "]</p>\n");
                }
            }
            continue;
        }

        /* ordinary text */
        if (!in_p) { buf_str(out, "<p>"); in_p = 1; }
        else        buf_str(out, "\n");
        render_inline(line, len, out);

        if (start >= n) break;
    }
    close_para(out, &in_p);
    close_aside(out, &in_aside);
}
