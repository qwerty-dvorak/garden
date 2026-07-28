/* crossword.c — a 5x5 mini, with the grid, the numbering and the checking
 * all done in C. JS draws a table and forwards keystrokes; it does not know
 * the answers.
 *
 * The solution is a symmetric word square: reading down gives the same five
 * words as reading across. That is the joke, and it is also why the clues
 * differ between across and down — otherwise there'd be nothing to solve.
 *
 *   clang --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export-all -O2
 */

#define N 5
#define CELLS (N * N)

static const char SOLUTION[CELLS + 1] =
    "HEART"
    "EMBER"
    "ABUSE"
    "RESIN"
    "TREND";

static char guess[CELLS];
static int  number[CELLS];

void *memset(void *d, int c, unsigned long n)
{
    unsigned char *p = d;
    while (n--) *p++ = (unsigned char)c;
    return d;
}

int   size(void)     { return N; }
int   cells(void)    { return CELLS; }
char *grid(void)     { return guess; }
int  *numbers(void)  { return number; }

/* Standard crossword numbering: a cell is numbered when it begins an across
 * word or a down word — that is, when there is no filled cell to its left, or
 * none above it. On a full square that means the top row and the left column. */
void init(void)
{
    memset(guess, 0, sizeof guess);
    memset(number, 0, sizeof number);

    int n = 0;
    for (int r = 0; r < N; r++)
        for (int c = 0; c < N; c++) {
            int starts_across = (c == 0);
            int starts_down   = (r == 0);
            if (starts_across || starts_down) number[r * N + c] = ++n;
        }
}

/* Accepts A-Z and a-z; anything else clears the cell. */
void set(int i, int ch)
{
    if (i < 0 || i >= CELLS) return;
    if (ch >= 'a' && ch <= 'z') ch -= 32;
    guess[i] = (ch >= 'A' && ch <= 'Z') ? (char)ch : 0;
}

int get(int i) { return (i < 0 || i >= CELLS) ? 0 : guess[i]; }

/* how many cells are filled and right */
int correct(void)
{
    int k = 0;
    for (int i = 0; i < CELLS; i++)
        if (guess[i] && guess[i] == SOLUTION[i]) k++;
    return k;
}

int filled(void)
{
    int k = 0;
    for (int i = 0; i < CELLS; i++) if (guess[i]) k++;
    return k;
}

int solved(void) { return correct() == CELLS; }

/* per-cell verdict, only when asked: 0 empty, 1 right, 2 wrong */
int verdict(int i)
{
    if (i < 0 || i >= CELLS || !guess[i]) return 0;
    return guess[i] == SOLUTION[i] ? 1 : 2;
}

/* Reveal one cell — the polite version of giving up. */
void reveal(int i)
{
    if (i < 0 || i >= CELLS) return;
    guess[i] = SOLUTION[i];
}
