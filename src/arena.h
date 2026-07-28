/* arena — bump allocation, freed all at once.
 *
 * One arena per request. Every string, every parsed block, every byte of
 * rendered HTML comes out of it, and at the end of the request the whole
 * thing is released in one call. Nothing is freed individually, so there is
 * nothing to leak, double-free, or use after free.
 *
 * Chunks are linked; a request that needs more than one just gets another.
 * Allocations larger than a chunk get a chunk of their own.
 */
#ifndef ARENA_H
#define ARENA_H

#include <stddef.h>

typedef struct Chunk Chunk;

typedef struct {
    Chunk *head;
    size_t chunks;     /* how many chunks are live (a cheap pressure gauge) */
    size_t used;       /* bytes handed out since the last reset */
} Arena;

void  arena_init(Arena *a);
void *arena_alloc(Arena *a, size_t n);              /* never returns NULL; dies loudly */
void *arena_grow(Arena *a, void *p, size_t old, size_t want);
char *arena_strdup(Arena *a, const char *s);
char *arena_strndup(Arena *a, const char *s, size_t n);
void  arena_reset(Arena *a);                        /* release everything */

#endif
