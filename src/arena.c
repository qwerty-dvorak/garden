#include "arena.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHUNK_MIN (64 * 1024)
#define ALIGN     16

struct Chunk {
    Chunk *next;
    size_t cap, len;
    char   data[];
};

void arena_init(Arena *a) { a->head = NULL; a->chunks = 0; a->used = 0; }

static Chunk *chunk_new(Arena *a, size_t need)
{
    size_t cap = need > CHUNK_MIN ? need : CHUNK_MIN;
    Chunk *c = malloc(sizeof *c + cap);
    if (!c) { fputs("arena: out of memory\n", stderr); exit(1); }
    c->next = a->head;
    c->cap  = cap;
    c->len  = 0;
    a->head = c;
    a->chunks++;
    return c;
}

void *arena_alloc(Arena *a, size_t n)
{
    n = (n + (ALIGN - 1)) & ~(size_t)(ALIGN - 1);
    Chunk *c = a->head;
    if (!c || c->cap - c->len < n) c = chunk_new(a, n);
    void *p = c->data + c->len;
    c->len  += n;
    a->used += n;
    return p;
}

/* Growing in an arena means copying. That is fine: buffers double, so the
 * copies are amortised, and the wasted prefix dies with the arena. */
void *arena_grow(Arena *a, void *p, size_t old, size_t want)
{
    Chunk *c = a->head;
    /* if p is the most recent allocation, extend it in place */
    if (c && p && (char *)p + ((old + ALIGN - 1) & ~(size_t)(ALIGN - 1)) == c->data + c->len) {
        size_t oldpad = (old + ALIGN - 1) & ~(size_t)(ALIGN - 1);
        size_t newpad = (want + ALIGN - 1) & ~(size_t)(ALIGN - 1);
        if (c->cap - (c->len - oldpad) >= newpad) {
            c->len = (c->len - oldpad) + newpad;
            a->used += newpad - oldpad;
            return p;
        }
    }
    void *q = arena_alloc(a, want);
    if (p && old) memcpy(q, p, old);
    return q;
}

char *arena_strndup(Arena *a, const char *s, size_t n)
{
    char *p = arena_alloc(a, n + 1);
    memcpy(p, s, n);
    p[n] = '\0';
    return p;
}

char *arena_strdup(Arena *a, const char *s)
{
    return arena_strndup(a, s, strlen(s));
}

void arena_reset(Arena *a)
{
    Chunk *c = a->head;
    while (c) { Chunk *n = c->next; free(c); c = n; }
    arena_init(a);
}
