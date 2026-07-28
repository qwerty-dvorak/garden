/* life.c — Conway, in text, wrapping at the edges.
 *
 * The whole simulation is 40 lines. It is here because a garden should have
 * something growing in it that nobody is steering.
 *
 *   clang --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export-all -O3
 */

#define W 96
#define H 36

static unsigned char a[W * H], b[W * H];
static char buf[(W + 1) * H];
static unsigned seed = 2463534242u;

void *memset(void *d, int c, unsigned long n)
{
    unsigned char *p = d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}

char *buffer(void) { return buf; }
int   buflen(void) { return (W + 1) * H; }
int   cols(void)   { return W; }
int   rows(void)   { return H; }

/* xorshift32 — deterministic, so a given seed always grows the same garden */
static unsigned rnd(void)
{
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return seed;
}

void init(unsigned s, int density)
{
    if (s) seed = s;
    if (density < 1)  density = 1;
    if (density > 99) density = 99;
    for (int i = 0; i < W * H; i++)
        a[i] = (rnd() % 100) < (unsigned)density;
}

void step(void)
{
    for (int y = 0; y < H; y++) {
        int yu = (y + H - 1) % H, yd = (y + 1) % H;
        for (int x = 0; x < W; x++) {
            int xl = (x + W - 1) % W, xr = (x + 1) % W;
            int n = a[yu * W + xl] + a[yu * W + x] + a[yu * W + xr]
                  + a[y  * W + xl] +                 a[y  * W + xr]
                  + a[yd * W + xl] + a[yd * W + x] + a[yd * W + xr];
            b[y * W + x] = (n == 3) || (n == 2 && a[y * W + x]);
        }
    }
    for (int i = 0; i < W * H; i++) a[i] = b[i];
}

/* how many cells are alive — lets the caller notice a dead or frozen board */
int population(void)
{
    int k = 0;
    for (int i = 0; i < W * H; i++) k += a[i];
    return k;
}

void render(void)
{
    int o = 0;
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) buf[o++] = a[y * W + x] ? '#' : ' ';
        buf[o++] = '\n';
    }
}
