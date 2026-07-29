/* textmode.js — the page as a grid of characters.
 *
 * The idea is ertdfgcvb's play.core: a program fills a grid of cells, a
 * renderer writes the grid to the DOM, and that is the whole of it. This is a
 * rewrite rather than a port, because the original's cell is an object and it
 * spreads a fresh copy of every cell on every frame. At 200×60 that is twelve
 * thousand allocations per frame and the collector never gets a break. Here a
 * cell is two integers in two typed arrays, and after boot nothing allocates.
 *
 * Four things it does that the original does not:
 *
 *   - a monochrome fast path. If no cell carries a style and no cell carries
 *     a link, the frame is one string and one textContent write. This is the
 *     common case and it is roughly four times faster than building spans.
 *   - rect and metrics are cached and recomputed on resize. play.core calls
 *     getBoundingClientRect() inside the frame loop, which forces layout on
 *     every single frame.
 *   - glyphs are escaped once, at charset load, into a parallel array. The
 *     original writes `html += cell.char` raw; its own charsets are safe by
 *     construction but a charset that arrives from a block header is not.
 *     `&` `<` `>` in a ramp are now just glyphs.
 *   - rows are compared as integers, not as objects with four string fields.
 *
 * Everything is one closure on `window.Textmode`. No modules, no bundler, no
 * dependency, in keeping with the rest of this place.
 */
(function (root) {
  'use strict';

  /* ---------- maths, GLSL flavoured ---------------------------------- */

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mix(a, b, t) { return a + (b - a) * t; }
  function fract(v) { return v - Math.floor(v); }
  function map(v, a, b, c, d) { return c + (d - c) * ((v - a) / (b - a)); }
  function step(e, x) { return x < e ? 0 : 1; }
  function smoothstep(a, b, t) { var x = clamp((t - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); }
  function smootherstep(a, b, t) { var x = clamp((t - a) / (b - a), 0, 1); return x * x * x * (x * (x * 6 - 15) + 10); }

  /* A named seed gives the same field every reload, which matters when you
   * are tuning a program and want the change you made to be the only thing
   * that moved. No seed means Math.random. */
  function rng(seed) {
    if (seed === undefined || seed === null || seed === '') return Math.random;
    var h = 2166136261 >>> 0;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () {
      h |= 0; h = h + 0x6D2B79F5 | 0;
      var t = Math.imul(h ^ h >>> 15, 1 | h);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* Value noise over a permutation table. Not gradient noise — this is the
   * cheaper one, and at the size of a character cell nobody can tell. */
  function noise2(seed) {
    var N = 256, r = new Float32Array(N), p = new Uint8Array(N * 2), rnd = rng(seed), i, j, t;
    for (i = 0; i < N; i++) { r[i] = rnd(); p[i] = i; }
    for (i = 0; i < N; i++) {
      j = (rnd() * N) | 0;
      t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (i = 0; i < N; i++) p[i + N] = p[i];
    return function (x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var tx = x - xi, ty = y - yi;
      var x0 = xi & 255, x1 = (x0 + 1) & 255;
      var y0 = yi & 255, y1 = (y0 + 1) & 255;
      var c00 = r[p[p[x0] + y0]], c10 = r[p[p[x1] + y0]];
      var c01 = r[p[p[x0] + y1]], c11 = r[p[p[x1] + y1]];
      var sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      return mix(mix(c00, c10, sx), mix(c01, c11, sx), sy);
    };
  }

  /* Fractal sum of the above. Four octaves is enough for a background. */
  function fbm2(seed, octaves) {
    var n = noise2(seed), oct = octaves || 4;
    return function (x, y) {
      var sum = 0, amp = 0.5, norm = 0;
      for (var i = 0; i < oct; i++) {
        sum += n(x, y) * amp;
        norm += amp;
        x *= 2; y *= 2; amp *= 0.5;
      }
      return sum / norm;
    };
  }

  /* ---------- charsets ------------------------------------------------ */

  /* A ramp is stored twice: raw for the textContent path, entity-escaped for
   * the innerHTML path. One pass at load, nothing per frame. Array.from
   * rather than split('') so ░▒▓ and the box-drawing glyphs survive; several
   * of the good ramps are outside the BMP-safe naive split. */
  function charset(s) {
    var g = Array.from(String(s));
    if (!g.length) g = [' '];
    var h = new Array(g.length), m = Object.create(null);
    for (var i = 0; i < g.length; i++) {
      var c = g[i];
      h[i] = c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
      if (m[c] === undefined) m[c] = i;
    }
    /* m is glyph -> index. ertdfgcvb's page builds the same map and it is the
     * reason its letter-cycling is cheap: "which index is this character" is
     * asked once per glyph per frame, and indexOf over a hundred-glyph
     * charset would put that on the hot path. */
    return { g: g, h: h, m: m, n: g.length, last: g.length - 1, src: s };
  }

  /* Append a glyph to a charset if it is not already there, and return its
   * index. The one place a charset ever grows. */
  function glyph(cs, c) {
    var k = cs.m[c];
    if (k !== undefined) return k;
    if (cs.n >= 65535) return 0;          /* ch[] is Uint16 */
    k = cs.n;
    cs.g.push(c);
    cs.h.push(c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c);
    cs.m[c] = k;
    cs.n++; cs.last = k;
    return k;
  }

  /* Ramps worth having around. Anything can be passed as a string instead. */
  var RAMPS = {
    standard: ' .:-=+*#%@',
    long:     " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
    block:    ' ░▒▓█',
    binary:   ' 01',
    dots:     ' ·∙•●',
    line:     ' ╴╵└╶─┌┬╷┘│┤┴┼',
    arrow:    ' ↑↗→↘↓↙←↖',
    thin:     ' .·:*+=%@#',
    stroke:   ' /\\|-_+*XY#',
    grade:    ' ▁▂▃▄▅▆▇█'
  };

  /* ---------- the cell buffer ----------------------------------------- */

  /* ch[i]  index into the charset
   * st[i]  index into the style table; 0 means "inherit from the element"
   *
   * Links are sparse and rare, so they live in plain objects keyed by cell
   * index rather than in an array the width of the grid. */
  function Grid() {
    this.cols = 0; this.rows = 0; this.n = 0;
    this.ch = new Uint16Array(0);
    this.st = new Uint8Array(0);
    this.cs = charset(RAMPS.standard);
    this.styles = ['']; this._smap = Object.create(null);
    this.lo = null; this.lc = null; this.links = 0;
  }

  Grid.prototype.resize = function (cols, rows) {
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols; this.rows = rows; this.n = cols * rows;
    this.ch = new Uint16Array(this.n);
    this.st = new Uint8Array(this.n);
    return true;
  };

  /* A style is a CSS declaration fragment: 'color:#888' or 'font-weight:700'.
   * Interned, so a program may call this in a loop without thinking. The
   * table is a Uint8Array index, so 255 distinct styles per page; past that
   * the cell simply inherits, which degrades quietly rather than corrupting. */
  Grid.prototype.style = function (css) {
    if (!css) return 0;
    var s = this._smap[css];
    if (s !== undefined) return s;
    if (this.styles.length > 255) return 0;
    s = this.styles.length;
    this.styles.push(css);
    this._smap[css] = s;
    return s;
  };

  Grid.prototype.clear = function (chIdx) {
    this.ch.fill(chIdx || 0);
    this.st.fill(0);
    if (this.links) { this.lo = null; this.lc = null; this.links = 0; }
  };

  Grid.prototype.put = function (x, y, ch, st) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    var i = y * this.cols + x;
    this.ch[i] = ch;
    this.st[i] = st || 0;
  };

  /* Write a string, one glyph per cell, mapping through the charset by
   * codepoint. Unknown glyphs are appended to the charset on the spot — that
   * is how arbitrary page text ends up in a field whose ramp is ' .:-=+*#%@'.
   * Bounded: the charset is a Uint16 index, so we stop at 65535. */
  Grid.prototype.text = function (x, y, str, st) {
    var cs = this.cs, g = Array.from(str), i;
    for (i = 0; i < g.length; i++) this.put(x + i, y, glyph(cs, g[i]), st);
    return g.length;
  };

  /* An anchor opened before cell `i` and closed after cell `j`. This is
   * ertdfgcvb's beginHTML/endHTML: it is how the text field can contain a
   * link you can actually click. The href is escaped here and nowhere else. */
  Grid.prototype.link = function (i, j, href, cls) {
    if (!this.lo) { this.lo = Object.create(null); this.lc = Object.create(null); }
    this.lo[i] = '<a href="' + esc(href) + '"' + (cls ? ' class="' + esc(cls) + '"' : '') + '>';
    this.lc[j] = '</a>';
    this.links++;
  };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- metrics -------------------------------------------------- */

  /* Measured, not assumed. A hundred X's give a fractional cell width that
   * survives letter-spacing and font fallback; two stacked blocks give a line
   * height that does not depend on `line-height: normal` resolving. */
  function measure(el) {
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;' +
      'top:0;left:0;pointer-events:none;padding:0;border:0';
    var a = document.createElement('span');
    var b = document.createElement('span');
    a.style.display = b.style.display = 'block';
    a.textContent = b.textContent = ''.padEnd(100, 'X');
    probe.appendChild(a); probe.appendChild(b);
    el.appendChild(probe);
    var w = a.getBoundingClientRect().width / 100;
    var h = probe.getBoundingClientRect().height / 2;
    el.removeChild(probe);
    if (!(w > 0)) w = 8;
    if (!(h > 0)) h = 14;
    return { w: w, h: h, aspect: w / h };
  }

  /* ---------- the renderer --------------------------------------------- */

  /* Rows are compared as integers and only changed rows are written. Two
   * paths: monochrome, where the whole frame is one string and one write; and
   * styled, where each dirty row becomes a line of spans. The path is chosen
   * per frame and a switch resets both the element and the back buffer. */
  function Renderer(el) {
    this.el = el;
    this.bch = new Uint16Array(0);
    this.bst = new Uint8Array(0);
    this.rowstr = [];
    this.mono = null;
    this.cols = 0; this.rows = 0;
    this.dirtyRows = 0;
  }

  Renderer.prototype.reset = function (grid) {
    this.bch = new Uint16Array(grid.n);
    this.bst = new Uint8Array(grid.n);
    /* -1 is not a valid glyph index, so the first frame is entirely dirty */
    this.bch.fill(65535);
    this.rowstr = new Array(grid.rows);
    this.cols = grid.cols; this.rows = grid.rows;
    this.el.textContent = '';
    this.mono = null;
  };

  Renderer.prototype.render = function (grid) {
    if (grid.cols !== this.cols || grid.rows !== this.rows) this.reset(grid);

    var mono = grid.links === 0 && grid.styles.length === 1;
    if (mono !== this.mono) {
      this.mono = mono;
      this.bch.fill(65535);
      this.el.textContent = '';
      if (!mono) {
        for (var r = 0; r < this.rows; r++) {
          var span = document.createElement('span');
          span.style.display = 'block';
          this.el.appendChild(span);
        }
      }
    }
    return mono ? this.renderMono(grid) : this.renderStyled(grid);
  };

  Renderer.prototype.renderMono = function (grid) {
    var cols = this.cols, rows = this.rows, ch = grid.ch, bch = this.bch,
        g = grid.cs.g, rowstr = this.rowstr, any = false, dirty = 0;

    for (var j = 0; j < rows; j++) {
      var offs = j * cols, changed = false, i;
      for (i = 0; i < cols; i++) {
        if (ch[offs + i] !== bch[offs + i]) { changed = true; break; }
      }
      if (!changed) continue;
      dirty++;
      var s = '';
      for (i = 0; i < cols; i++) {
        var c = ch[offs + i];
        bch[offs + i] = c;
        s += g[c];
      }
      rowstr[j] = s;
      any = true;
    }
    /* One write for the whole frame. The join is cheap next to the DOM. */
    if (any) this.el.textContent = rowstr.join('\n');
    this.dirtyRows = dirty;
    return dirty;
  };

  Renderer.prototype.renderStyled = function (grid) {
    var cols = this.cols, rows = this.rows;
    var ch = grid.ch, st = grid.st, bch = this.bch, bst = this.bst;
    var h = grid.cs.h, styles = grid.styles, lo = grid.lo, lc = grid.lc;
    var nodes = this.el.childNodes, dirty = 0;

    for (var j = 0; j < rows; j++) {
      var offs = j * cols, changed = false, i, idx;

      for (i = 0; i < cols; i++) {
        idx = offs + i;
        if (ch[idx] !== bch[idx] || st[idx] !== bst[idx]) { changed = true; break; }
        /* a link can appear or vanish without either array moving */
        if (lo && (lo[idx] || lc[idx])) { changed = true; break; }
      }
      if (!changed) continue;
      dirty++;

      var html = '', cur = -1, open = false;
      for (i = 0; i < cols; i++) {
        idx = offs + i;
        bch[idx] = ch[idx]; bst[idx] = st[idx];

        if (lo && lo[idx] !== undefined) {
          if (open) { html += '</span>'; open = false; cur = -1; }
          html += lo[idx];
        }
        var s = st[idx];
        if (s !== cur) {
          if (open) html += '</span>';
          if (s) { html += '<span style="' + styles[s] + '">'; open = true; }
          else open = false;
          cur = s;
        }
        html += h[ch[idx]];
        if (lc && lc[idx] !== undefined) {
          if (open) { html += '</span>'; open = false; cur = -1; }
          html += lc[idx];
        }
      }
      if (open) html += '</span>';
      nodes[j].innerHTML = html;
    }
    this.dirtyRows = dirty;
    return dirty;
  };

  /* ---------- the canvas renderer -------------------------------------- */

  /* play.core ships one and it earns its place at very high cell counts,
   * where the DOM stops being the right shape for the problem. Same buffer,
   * same programs; the element is a <canvas> instead of a <pre>. Links do
   * not exist here, for the obvious reason. */
  function CanvasRenderer(el) {
    this.el = el;
    this.ctx = el.getContext('2d', { alpha: true });
    this.cols = 0; this.rows = 0;
    this.font = ''; this.ink = '';
  }

  CanvasRenderer.prototype.reset = function () { this.cols = 0; };

  CanvasRenderer.prototype.render = function (grid, view) {
    var c = this.ctx, dpr = Math.min(devicePixelRatio || 1, 2);
    var w = view.width, h = view.height;
    if (this.el.width !== Math.round(w * dpr) || this.el.height !== Math.round(h * dpr)) {
      this.el.width = Math.round(w * dpr);
      this.el.height = Math.round(h * dpr);
      this.el.style.width = w + 'px';
      this.el.style.height = h + 'px';
      this.cols = 0;
    }
    var cs2 = getComputedStyle(this.el);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.font = cs2.fontSize + ' ' + cs2.fontFamily;
    c.textBaseline = 'top';
    c.fillStyle = cs2.color;

    var g = grid.cs.g, cw = view.cell.w, chh = view.cell.h, cur = '';
    /* Baseline nudge: text sits high in the box, this centres it. */
    var pad = (chh - parseFloat(cs2.fontSize)) * 0.5;
    for (var j = 0; j < grid.rows; j++) {
      var offs = j * grid.cols, y = j * chh + pad;
      for (var i = 0; i < grid.cols; i++) {
        var idx = offs + i, gi = grid.ch[idx];
        if (gi === 0) continue;
        var s = grid.styles[grid.st[idx]];
        if (s !== cur) {
          cur = s;
          var m = /color\s*:\s*([^;]+)/.exec(s);
          c.fillStyle = m ? m[1] : cs2.color;
        }
        c.fillText(g[gi], i * cw, y);
      }
    }
    this.cols = grid.cols; this.rows = grid.rows;
    return grid.rows;
  };

  /* ---------- the runner ----------------------------------------------- */

  var REDUCED = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  var DEFAULTS = {
    fps: 30,          /* cap. the field is a background, not a game */
    cols: 0,          /* 0 = derive from the element */
    rows: 0,
    chars: null,      /* ramp name or literal string */
    seed: null,
    once: false,
    renderer: 'text', /* or 'canvas' */
    pointer: true,    /* track the pointer over the window */
    scale: 1,         /* multiplies the program's own idea of size */
    speed: 1,         /* multiplies time */
    pause: true       /* pause off-screen and on a hidden tab */
  };

  /* Returns a handle. `.stop()` is the only thing you must remember. */
  function run(el, program, opts) {
    if (typeof program === 'string') program = root.Textmode.programs[program];
    if (!program) throw new Error('textmode: no such program');
    /* Copy into a fresh object at every step. Folding opts into
     * program.settings directly would write one run's configuration onto the
     * shared program object, and the next panel on the page would inherit it. */
    opts = assign(assign(assign({}, DEFAULTS), program.settings || {}), opts || {});

    var canvas = opts.renderer === 'canvas' && el.nodeName === 'CANVAS';
    var grid = new Grid();
    var renderer = canvas ? new CanvasRenderer(el) : new Renderer(el);

    grid.cs = charset(opts.chars ? (RAMPS[opts.chars] || opts.chars)
                                 : (RAMPS[program.chars] || program.chars || RAMPS.standard));

    /* The view: measured once, and again only when the element resizes.
     * play.core asks the layout engine for this on every frame. */
    var view = { width: 0, height: 0, cell: { w: 8, h: 14 }, aspect: 0.5 };

    var ctx = {
      frame: 0, time: 0, dt: 0, fps: 0,
      cols: 0, rows: 0, width: 0, height: 0,
      cell: view.cell, aspect: 0.5,
      scale: opts.scale, speed: opts.speed,
      settings: opts,
      cursor: { x: 0, y: 0, px: 0, py: 0, pressed: false, inside: false },
      /* handed to programs so they need not import anything */
      noise: noise2, fbm: fbm2, rng: rng,
      clamp: clamp, mix: mix, fract: fract, map: map, step: step,
      smoothstep: smoothstep, smootherstep: smootherstep
    };

    var booted = false, running = false, visible = true, raf = 0;
    var last = 0, acc = 0, interval = 1000 / Math.max(1, opts.fps);
    var frames = 0, fpsAt = 0;

    function layout() {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      view.width = r.width; view.height = r.height;
      var m = canvas ? measureCanvas(el) : measure(el);
      view.cell.w = m.w; view.cell.h = m.h; view.aspect = m.aspect;
      var cols = opts.cols || Math.max(1, Math.floor(r.width / m.w));
      var rows = opts.rows || Math.max(1, Math.floor(r.height / m.h));
      ctx.width = r.width; ctx.height = r.height; ctx.aspect = m.aspect;
      if (grid.resize(cols, rows)) {
        ctx.cols = cols; ctx.rows = rows;
        renderer.reset(grid);
        if (booted && program.resize) program.resize(ctx, grid);
        return true;
      }
      ctx.cols = cols; ctx.rows = rows;
      return true;
    }

    function measureCanvas(c) {
      var s = getComputedStyle(c), g = c.getContext('2d');
      var fs = parseFloat(s.fontSize) || 12;
      g.font = s.fontSize + ' ' + s.fontFamily;
      var w = g.measureText(''.padEnd(50, 'X')).width / 50 || fs * 0.6;
      var h = parseFloat(s.lineHeight) || fs * 1.2;
      return { w: w, h: h, aspect: w / h };
    }

    /* One frame, start to finish. Programs may fill the grid in bulk with
     * frame(), or a cell at a time with main() returning a glyph index. */
    function tick(t) {
      ctx.dt = last ? t - last : 16.7;
      last = t;
      ctx.time += ctx.dt * opts.speed;
      ctx.frame++;

      frames++;
      if (t - fpsAt >= 1000) { ctx.fps = frames * 1000 / (t - fpsAt); fpsAt = t; frames = 0; }

      if (program.frame) {
        program.frame(ctx, grid);
      } else if (program.main) {
        var cols = grid.cols, rows = grid.rows, ch = grid.ch, main = program.main;
        /* Clamped here rather than trusted: a program written against a ten
         * glyph ramp will be handed a three glyph one the moment somebody
         * sets `bgchars`, and an index past the end renders as the literal
         * word "undefined" across the page. */
        var top = grid.cs.last;
        for (var j = 0; j < rows; j++) {
          var offs = j * cols;
          for (var i = 0; i < cols; i++) {
            var v = main(i, j, offs + i, ctx, grid);
            ch[offs + i] = v > 0 ? (v < top ? v | 0 : top) : 0;
          }
        }
      }
      if (program.post) program.post(ctx, grid);
      renderer.render(grid, view);
    }

    function loop(t) {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      var delta = t - acc;
      if (delta < interval) return;      /* fps cap: skip, don't sleep */
      acc = t - (delta % interval);
      tick(t);
    }

    function start() {
      if (running || !visible) return;
      if (REDUCED.matches || opts.once) { still(); return; }
      running = true; last = 0; acc = 0;
      raf = requestAnimationFrame(loop);
    }

    function stopLoop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    /* Under prefers-reduced-motion the field is composed once and then left
     * alone. A still frame of a noise field is a texture; an animated one is
     * a hazard. Same rule the wasm pieces follow. */
    function still() {
      stopLoop();
      ctx.time = 8000;   /* not zero: t=0 is degenerate in most programs */
      tick(performance.now());
    }

    /* --- input. Listening on the window rather than the element means a
       backdrop with pointer-events:none still gets a cursor. --- */
    var cur = ctx.cursor;
    function onMove(e) {
      var r = el.getBoundingClientRect();
      cur.px = cur.x; cur.py = cur.y;
      cur.x = (e.clientX - r.left) / view.cell.w;
      cur.y = (e.clientY - r.top) / view.cell.h;
      cur.inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top && e.clientY <= r.bottom;
    }
    function onDown() { cur.pressed = true; }
    function onUp() { cur.pressed = false; }
    if (opts.pointer) {
      root.addEventListener('pointermove', onMove, { passive: true });
      root.addEventListener('pointerdown', onDown, { passive: true });
      root.addEventListener('pointerup', onUp, { passive: true });
    }

    /* --- pause when it cannot be seen. A background that keeps running in a
       tab you are not looking at is a battery bug with an aesthetic. --- */
    var io = null;
    function onVis() {
      if (document.hidden) { visible = false; stopLoop(); }
      else { visible = true; start(); }
    }
    if (opts.pause) {
      document.addEventListener('visibilitychange', onVis);
      if (root.IntersectionObserver) {
        io = new root.IntersectionObserver(function (es) {
          visible = es[0].isIntersecting && !document.hidden;
          if (visible) start(); else stopLoop();
        });
        io.observe(el);
      }
    }

    var ro = null;
    if (root.ResizeObserver) {
      ro = new root.ResizeObserver(function () {
        if (layout() && (REDUCED.matches || opts.once)) still();
      });
      ro.observe(el);
    }
    if (REDUCED.addEventListener) REDUCED.addEventListener('change', function () {
      if (REDUCED.matches) still(); else start();
    });

    var handle = {
      el: el, ctx: ctx, grid: grid, program: program, settings: opts,
      start: start, stop: stop, still: still, layout: layout,
      get running() { return running; },
      setSpeed: function (v) { opts.speed = ctx.speed = v; },
      setFps: function (v) { opts.fps = v; interval = 1000 / Math.max(1, v); },
      setChars: function (s) {
        grid.cs = charset(RAMPS[s] || s);
        renderer.reset(grid);
        if (!running) still();
      }
    };

    function stop() {
      stopLoop();
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      if (opts.pointer) {
        root.removeEventListener('pointermove', onMove);
        root.removeEventListener('pointerdown', onDown);
        root.removeEventListener('pointerup', onUp);
      }
    }

    /* Fonts change metrics, and metrics change everything. Wait for them. */
    var go = function () {
      if (!layout()) { requestAnimationFrame(go); return; }
      if (program.boot) program.boot(ctx, grid);
      booted = true;
      start();
      if (!running) still();
    };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(go);
    else requestAnimationFrame(go);

    return handle;
  }

  function assign(a, b) { for (var k in b) if (b[k] !== undefined) a[k] = b[k]; return a; }

  root.Textmode = {
    run: run,
    charset: charset,
    ramps: RAMPS,
    programs: {},
    glyph: glyph,
    noise: noise2, fbm: fbm2, rng: rng,
    clamp: clamp, mix: mix, fract: fract, map: map, step: step,
    smoothstep: smoothstep, smootherstep: smootherstep,
    esc: esc,
    reduced: REDUCED
  };

  /* so the pure parts can be exercised under node, where there is no DOM */
  if (typeof module === 'object' && module.exports) module.exports = root.Textmode;

})(typeof window !== 'undefined' ? window : globalThis);
