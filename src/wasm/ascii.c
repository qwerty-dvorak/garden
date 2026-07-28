/* ascii.c — the Mandelbrot set, drawn in text.
 *
 * Freestanding wasm32: no libc, no libm, no emscripten. Every float here is
 * done with arithmetic the target has natively, which is why this is escape
 * iterations and not something needing sin().
 *
 *   clang --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export-all -O3
 *
 * JS reads `buffer()` out of the wasm memory and drops it into a <pre>.
 * Nothing is shared but bytes.
 */

#define W 96
#define H 40
#define MAXIT 90

static char buf[(W + 1) * H];

/* -nostdlib means no memset, but clang still emits calls to it for
 * zero-initialisation. Supply our own or the link fails. */
void *memset(void *d, int c, unsigned long n)
{
    unsigned char *p = d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}

char *buffer(void)  { return buf; }
int   buflen(void)  { return (W + 1) * H; }
int   cols(void)    { return W; }
int   rows(void)    { return H; }

/* Denser glyphs mean slower escape: empty space far outside, solid '@' for
 * points that never escaped at all. Nine steps of shading plus the interior. */
static const char ramp[] = " .:-=+*#%";

/* t is a zoom parameter the caller animates. Centre is a point on the
 * boundary, so zooming never runs out of structure. */
void render(double t)
{
    double cx = -0.743643887037151;
    double cy =  0.131825904205330;

    double scale = 3.0;
    for (double z = 0; z < t; z += 1.0) scale *= 0.88;   /* no pow() here */
    if (scale < 1e-13) scale = 1e-13;

    int o = 0;
    for (int y = 0; y < H; y++) {
        for (int x = 0; x < W; x++) {
            /* character cells are about twice as tall as wide */
            double re = cx + ((double)x / W - 0.5) * scale * 2.0;
            double im = cy + ((double)y / H - 0.5) * scale;

            double zr = 0, zi = 0;
            int i = 0;
            while (i < MAXIT) {
                double zr2 = zr * zr, zi2 = zi * zi;
                if (zr2 + zi2 > 4.0) break;
                zi = 2.0 * zr * zi + im;
                zr = zr2 - zi2 + re;
                i++;
            }
            buf[o++] = (i >= MAXIT) ? '@' : ramp[(i * 8) / MAXIT];
        }
        buf[o++] = '\n';
    }
}
