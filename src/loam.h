/* loam — the markup the garden grows in.
 *
 * A block is a header, a `---`, and a body.
 * Everything is arena-allocated. Nothing here is ever freed individually.
 *
 * Rename it if you want; it's your language.
 */
#ifndef LOAM_H
#define LOAM_H

#include <stddef.h>
#include "arena.h"

/* growable byte buffer, arena-backed */
typedef struct { char *p; size_t len, cap; Arena *a; } Buf;

void buf_init(Buf *b, Arena *a);
void buf_add(Buf *b, const char *s, size_t n);
void buf_str(Buf *b, const char *s);
void buf_esc(Buf *b, const char *s, size_t n);  /* & < > " ' -> entities */

#define LOAM_MAX_FIELDS 32
#define LOAM_MAX_DEPTH   3   /* transclusion recursion limit */

typedef struct { char key[32]; char val[512]; } Field;

typedef struct {
    char   id[128];
    char   type[16];   /* note quote link collection poem image audio video */
    Field  fields[LOAM_MAX_FIELDS];
    int    nfields;
    char  *body;       /* arena-owned */
    size_t body_len;
} Block;

/* -1 if no block with that id exists in dir */
int         loam_load(Arena *a, const char *dir, const char *id, Block *out);
const char *loam_get(const Block *b, const char *key);   /* NULL if absent */

/* body -> html. resolves [[links]] and ![[transclusions]] against dir,
 * and emits the media element for image/audio/video blocks. */
void        loam_render(Arena *a, const char *dir, const Block *b, Buf *out, int depth);

/* true if id is safe to use as a filename component */
int         loam_id_ok(const char *id);

/* heading text -> anchor id. same rule in the toc and the <h2 id>. */
void        loam_slug(const char *s, size_t n, char *out, size_t outn);

/* substring search over bytes. ours, so we don't need _GNU_SOURCE/memmem. */
const char *loam_find(const char *hay, size_t hn, const char *needle, size_t nn);

#endif
