/* programs.js — things to run on a grid of characters.
 *
 * A program is an object. It may define any of:
 *
 *   chars           default ramp: a name from Textmode.ramps, or a literal
 *   settings        defaults for the runner (fps, speed, …)
 *   boot(ctx, g)    once, after the first layout
 *   resize(ctx, g)  whenever the grid changes shape
 *   main(x,y,i,ctx,g)  per cell, returns a glyph index. the readable path.
 *   frame(ctx, g)   the whole grid at once. the fast path.
 *   post(ctx, g)    after either, for overlays
 *
 * Per-run state hangs off the grid, not off the program, so the same program
 * can run twice on one page without the two instances fighting.
 *
 * The first four are ports from ertdfgcvb's play.core, kept close to the
 * original so the lineage is legible. The rest are not in that repo: they are
 * the same machine pointed at something more abstract — fields and processes
 * rather than pictures of things.
 */
(function (T) {
  'use strict';

  var P = T.programs;
  var sin = Math.sin, cos = Math.cos, floor = Math.floor, sqrt = Math.sqrt,
      abs = Math.abs, min = Math.min, max = Math.max, PI = Math.PI;

  /* value in 0..1 -> glyph index in the current ramp */
  function ramp(v, cs) { return v <= 0 ? 0 : v >= 1 ? cs.last : (v * cs.last) | 0; }

  /* Make sure specific glyphs exist in the ramp and hand back their indices.
   * Programs that need a box corner rather than a shade do this once at boot
   * instead of looking it up per cell. */
  function glyphs(g, str) {
    var out = [], a = Array.from(str);
    for (var i = 0; i < a.length; i++) out.push(T.glyph(g.cs, a[i]));
    return out;
  }

  /* state that must be thrown away when the grid changes shape */
  function state(g, key, make) {
    var s = g['_' + key];
    if (!s || s.cols !== g.cols || s.rows !== g.rows) {
      s = make();
      s.cols = g.cols; s.rows = g.rows;
      g['_' + key] = s;
    }
    return s;
  }

  var rndi = function (a, b) { return floor(a + Math.random() * (b - a + 1)); };

  /* ==================================================================== */
  /* ports                                                                */
  /* ==================================================================== */

  /* --- warp ----------------------------------------------------------- */
  /* The ertdfgcvb.xyz front page, deobfuscated from its shipped bundle and
   * rewritten. A word is drawn to an offscreen canvas, the canvas is sampled
   * through a domain warp driven by value noise, and the result is written
   * with two different ramps interleaved on a checkerboard — which is the
   * trick that gives the field its grain. Brightness rises instantly and
   * falls at 0.95 per frame, so the letters smear as the warp moves them.
   * The pointer pushes a ripple through it. */
  P.warp = {
    desc: 'a word, dissolved through a noise warp. after ertdfgcvb.xyz',
    chars: ' .·•-+=:;*ABC0123!',
    settings: { fps: 30 },

    boot: function (ctx, g) {
      /* Two ramps, concatenated into one charset; the checkerboard picks a
       * half. The original uses ' .·•-+=:;*ABC0123!' and ' ·-•~+:*abcXYZ*'. */
      var a = ctx.settings.chars ? String(ctx.settings.chars) : ' .·•-+=:;*ABC0123!';
      var b = ctx.settings.chars ? String(ctx.settings.chars) : ' ·-•~+:*abcXYZ*';
      g.cs = T.charset(a + b);
      var s = g._warp = { off: [0, Array.from(a).length], len: [Array.from(a).length, Array.from(b).length] };
      s.noise = T.noise(ctx.settings.seed);
      s.word = word(String(ctx.settings.word || 'gdn'));
      s.val = null; s.ripple = 0;
    },

    frame: function (ctx, g) {
      var s = g._warp, cols = g.cols, rows = g.rows, cs = g.cs;
      if (!s.val || s.val.length !== g.n) s.val = new Float32Array(g.n);

      var t = ctx.time * 0.0004;
      var freq = T.mix(1.2, 0.5, (cos(t) + 1) * 0.5);
      var scale = ctx.scale * (cols < 80 ? 1.3 : 0.8);

      /* pointer ripple: radius grows with pointer speed, decays every frame */
      var cur = ctx.cursor;
      var dx = cur.x - cur.px, dy = cur.y - cur.py;
      var speed = sqrt(dx * dx + dy * dy);
      s.ripple = min(s.ripple * 0.75 + speed * 0.4, 20);
      var r2 = s.ripple * s.ripple;

      var ax = ctx.aspect, W = cols * ax;
      var k = W / scale, wa = s.word.w / s.word.h;
      var val = s.val, noise = s.noise, ch = g.ch;

      for (var j = 0; j < rows; j++) {
        var offs = j * cols, fy = j - rows * 0.5;
        for (var i = 0; i < cols; i++) {
          var idx = offs + i, fx = (i - cols * 0.5) * ax;
          var u = fx / k + 0.5;
          var v = fy / k * wa + 0.5;
          /* domain warp: displace the lookup by noise, in both axes, with
             the two fields sliding past each other in time */
          var du = u + 0.5 * (noise(u * freq + t, v * freq) - 0.5);
          var dv = v + 1.8 * (noise(u * freq, v * freq + t) - 0.5);
          var target = sample(s.word, du, dv);

          /* the ripple lights cells near the pointer */
          var ox = (i - cur.x) * ax, oy = j - cur.y;
          var d2 = ox * ox + oy * oy;
          if (d2 < r2) target = 1;

          var prev = val[idx];
          var lit = target > prev ? target : prev;
          val[idx] = lit * 0.95;

          var half = ((i + j) & 1);
          ch[idx] = s.off[half] + ramp2(lit, s.len[half]);
        }
      }
      function ramp2(x, n) { return x <= 0 ? 0 : x >= 1 ? n - 1 : (x * (n - 1)) | 0; }
    }
  };

  /* A word, rasterised once. Returns a grayscale field we can sample. */
  function word(str) {
    var w = 256, h = 96;
    var out = { w: w, h: h, d: new Float32Array(w * h) };
    if (typeof document === 'undefined') return out;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d', { willReadFrequently: true });
    if (!x) return out;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#fff';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    /* shrink until it fits: a four-letter word must not run off the edge */
    var size = h;
    do {
      x.font = '700 ' + size + 'px ui-monospace, monospace';
      size -= 2;
    } while (x.measureText(str).width > w * 0.92 && size > 8);
    x.fillText(str, w / 2, h / 2);
    var px = x.getImageData(0, 0, w, h).data;
    for (var i = 0; i < w * h; i++) out.d[i] = px[i * 4] / 255;
    return out;
  }

  /* bilinear sample, u/v in 0..1, outside is black */
  function sample(b, u, v) {
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return 0;
    var x = u * (b.w - 1), y = v * (b.h - 1);
    var x0 = x | 0, y0 = y | 0, x1 = min(x0 + 1, b.w - 1), y1 = min(y0 + 1, b.h - 1);
    var fx = x - x0, fy = y - y0, d = b.d;
    var a = d[y0 * b.w + x0], c = d[y0 * b.w + x1];
    var e = d[y1 * b.w + x0], f = d[y1 * b.w + x1];
    return (a + (c - a) * fx) + ((e + (f - e) * fx) - (a + (c - a) * fx)) * fy;
  }

  /* --- plasma --------------------------------------------------------- */
  P.plasma = {
    desc: 'four sine fields summed. the oldest trick there is',
    chars: 'long',
    settings: { fps: 30 },
    main: function (x, y, i, ctx, g) {
      var t = ctx.time * 0.0008;
      var a = x * ctx.aspect;
      var v = sin(a * 0.22 + t) +
              sin(y * 0.25 - t * 1.3) +
              sin((a + y) * 0.14 + t * 0.7) +
              sin(sqrt((a - ctx.cols * 0.5 * ctx.aspect) * (a - ctx.cols * 0.5 * ctx.aspect) +
                       (y - ctx.rows * 0.5) * (y - ctx.rows * 0.5)) * 0.3 - t * 2);
      return ramp((v + 4) / 8, g.cs);
    }
  };

  /* --- flame ---------------------------------------------------------- */
  /* The Doom fire, ported from play.core's demo. Heat is seeded along the
   * bottom row from a noise field and propagated upward with a random
   * horizontal wobble; the cooling rate is what makes the tongues. */
  P.flame = {
    desc: 'oldschool fire. heat rises, cools, wanders sideways',
    chars: " .·:/\\|=+*abcdef01XYZ#",
    settings: { fps: 30 },
    frame: function (ctx, g) {
      var cols = g.cols, rows = g.rows;
      var s = state(g, 'flame', function () {
        return { d: new Uint8Array(cols * rows), n: T.noise(ctx.settings.seed) };
      });
      var d = s.d, last = cols * (rows - 1), t = ctx.time * 0.0015, i;

      if (ctx.cursor.pressed && ctx.cursor.inside) {
        var cx = clampi(floor(ctx.cursor.x), 0, cols - 1);
        var cy = clampi(floor(ctx.cursor.y), 0, rows - 1);
        d[cx + cy * cols] = rndi(20, 50);
      }
      for (i = 0; i < cols; i++) {
        var v = floor(T.map(s.n(i * 0.05, t), 0, 1, 5, 40));
        d[last + i] = min(v, d[last + i] + 2);
      }
      for (i = 0; i < d.length; i++) {
        var row = (i / cols) | 0, col = i % cols;
        var dst = row * cols + clampi(col + rndi(-1, 1), 0, cols - 1);
        var src = min(rows - 1, row + 1) * cols + col;
        d[dst] = max(0, d[src] - rndi(0, 2));
      }
      var lastGlyph = g.cs.last;
      for (i = 0; i < d.length; i++) g.ch[i] = min(d[i], lastGlyph);
    }
  };

  function clampi(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* --- tenprint ------------------------------------------------------- */
  /* 10 PRINT CHR$(205.5+RND(1)); : GOTO 10
   * The Commodore 64 one-liner. Here it scrolls, so the maze is generated
   * forever rather than once. */
  P.tenprint = {
    desc: 'the C64 one-liner, scrolling upward forever',
    chars: ' ╱╲',
    settings: { fps: 12 },
    frame: function (ctx, g) {
      var cols = g.cols, rows = g.rows;
      var s = state(g, 'tenprint', function () {
        var st = { d: new Uint8Array(cols * rows), t: 0 };
        for (var i = 0; i < st.d.length; i++) st.d[i] = 1 + (Math.random() * 2 | 0);
        return st;
      });
      var gl = glyphs(g, ' ╱╲');
      /* scroll up one row per frame, generate a new bottom row */
      s.d.copyWithin(0, cols);
      for (var i = 0; i < cols; i++) s.d[(rows - 1) * cols + i] = 1 + (Math.random() * 2 | 0);
      for (var k = 0; k < s.d.length; k++) g.ch[k] = gl[s.d[k]];
    }
  };

  /* --- life ----------------------------------------------------------- */
  P.life = {
    desc: 'conway, wrapping at the edges, reseeded when it stalls',
    chars: ' ·+#',
    settings: { fps: 10 },
    frame: function (ctx, g) {
      var cols = g.cols, rows = g.rows;
      var s = state(g, 'life', function () {
        var st = { a: new Uint8Array(cols * rows), b: new Uint8Array(cols * rows), age: null, gen: 0, pop: 0 };
        st.age = new Uint8Array(cols * rows);
        for (var i = 0; i < st.a.length; i++) st.a[i] = Math.random() < 0.28 ? 1 : 0;
        return st;
      });
      var a = s.a, b = s.b, age = s.age, pop = 0;
      for (var y = 0; y < rows; y++) {
        var up = ((y + rows - 1) % rows) * cols, mid = y * cols, dn = ((y + 1) % rows) * cols;
        for (var x = 0; x < cols; x++) {
          var l = (x + cols - 1) % cols, r = (x + 1) % cols;
          var n = a[up + l] + a[up + x] + a[up + r] +
                  a[mid + l] + a[mid + r] +
                  a[dn + l] + a[dn + x] + a[dn + r];
          var i = mid + x, alive = a[i];
          var next = (alive && (n === 2 || n === 3)) || (!alive && n === 3) ? 1 : 0;
          b[i] = next;
          age[i] = next ? min(age[i] + 1, 3) : 0;
          pop += next;
        }
      }
      s.a = b; s.b = a; s.gen++;
      /* a dead or frozen field is not interesting. start again. */
      if (pop === 0 || (s.gen > 400 && Math.abs(pop - s.pop) < 2)) {
        for (var k = 0; k < s.a.length; k++) s.a[k] = Math.random() < 0.28 ? 1 : 0;
        s.gen = 0;
      }
      s.pop = pop;
      var cs = g.cs, lastG = cs.last;
      for (var m = 0; m < s.a.length; m++) g.ch[m] = s.a[m] ? min(age[m], lastG) : 0;
    }
  };

  /* ==================================================================== */
  /* the more abstract half — fields and processes, not pictures          */
  /* ==================================================================== */

  /* --- rd: gray-scott reaction–diffusion ------------------------------ */
  /* Two chemicals, one feeding on the other. Nothing is drawn; a rule is
   * iterated and the pattern is a consequence. Coral, mitosis and worms all
   * fall out of the same four constants — feed, kill, and the two diffusion
   * rates. Four iterations per frame keeps it moving without tearing. */
  P.rd = {
    desc: 'gray-scott reaction–diffusion. two chemicals, four constants',
    chars: 'block',
    settings: { fps: 30 },
    frame: function (ctx, g) {
      var cols = g.cols, rows = g.rows, n = cols * rows;
      var self = this;
      var s = state(g, 'rd', function () {
        var st = { a: new Float32Array(n), b: new Float32Array(n),
                   a2: new Float32Array(n), b2: new Float32Array(n) };
        var reg = self.regimes[ctx.settings.rd] || self.regimes.worms;
        st.feed = reg[0]; st.kill = reg[1];
        st.a.fill(1);
        /* Seeds, scaled to the grid. A fixed twelve 5×5 patches is 3% of a
         * large field and 62% of a small one, and a small wrapping field that
         * starts more than half seeded has no gradient anywhere — the
         * reaction term walks it straight to the trivial b = 0 and the panel
         * stays blank forever. Both the count and the patch shrink. */
        var seeds = clampi((cols * rows / 1800) | 0, 2, 14);
        var rad = clampi(((min(cols, rows) / 8) | 0), 1, 2);
        for (var k = 0; k < seeds; k++) {
          var cx = (Math.random() * cols) | 0, cy = (Math.random() * rows) | 0;
          for (var y = -rad; y <= rad; y++) for (var x = -rad; x <= rad; x++) {
            var i = ((cy + y + rows) % rows) * cols + ((cx + x + cols) % cols);
            st.b[i] = 1;
          }
        }
        /* Warm up, so the page opens onto a pattern rather than onto three
         * minutes of nothing. This is the only blocking work in any program
         * here and it happens once per grid size. */
        for (var w = 0; w < 900; w++) step2(st, cols, rows);
        return st;
      });

      for (var it = 0; it < 6; it++) step2(s, cols, rows);

      var cs = g.cs, bb = s.b;
      for (var i2 = 0; i2 < n; i2++) g.ch[i2] = ramp(bb[i2] * 3.6, cs);
    }
  };

  /* One Gray-Scott step, wrapping at the edges.
   *
   * The laplacian is the nine-point weighted kernel — 0.05 on the diagonals,
   * 0.2 on the orthogonals, -1 in the centre — and not the obvious five-point
   * one. With a five-point kernel the largest eigenvalue is -8, so `DA·dt·|λ|`
   * is 8 with these constants, the integration is unstable, and the field
   * oscillates itself flat inside a few hundred steps. It looks like the
   * seeds simply died. This kernel sums to a magnitude of 1 and is stable at
   * dt = 1, which is why every working implementation of this uses it. */
  /* Named corners of the feed/kill plane. The whole claim of the piece is
   * that these two numbers decide everything, so they are a knob —
   * `bgopts rd=worms` — rather than a constant somebody has to go and edit.
   *
   * `mitosis` and `solitons` are in the list and are not the default for a
   * reason worth writing down: their pattern wavelength is longer than a
   * short grid, so on a wrapping field under about twenty rows the pattern
   * meets its own wrapped copy, annihilates, and the panel goes blank and
   * stays blank. Measured across 40×12 up to 300×90, `worms` is the only one
   * alive at every size, and at 13–29% coverage it is also the only one
   * sparse enough to put behind prose. Hence the default. */
  P.rd.regimes = {
    coral:    [0.0545, 0.0620],
    worms:    [0.0780, 0.0610],
    spots:    [0.0980, 0.0570],
    holes:    [0.0390, 0.0580],
    uskate:   [0.0620, 0.0609],
    mitosis:  [0.0367, 0.0649],
    solitons: [0.0300, 0.0620]
  };

  function step2(s, cols, rows) {
    var a = s.a, b = s.b, a2 = s.a2, b2 = s.b2;
    var DA = 1.0, DB = 0.5, feed = s.feed, kill = s.kill;
    for (var y = 0; y < rows; y++) {
      var u = ((y + rows - 1) % rows) * cols, m = y * cols, d = ((y + 1) % rows) * cols;
      for (var x = 0; x < cols; x++) {
        var l = (x + cols - 1) % cols, r = (x + 1) % cols, i = m + x;
        var la = (a[u + l] + a[u + r] + a[d + l] + a[d + r]) * 0.05 +
                 (a[u + x] + a[d + x] + a[m + l] + a[m + r]) * 0.2 - a[i];
        var lb = (b[u + l] + b[u + r] + b[d + l] + b[d + r]) * 0.05 +
                 (b[u + x] + b[d + x] + b[m + l] + b[m + r]) * 0.2 - b[i];
        var ab2 = a[i] * b[i] * b[i];
        a2[i] = a[i] + DA * la - ab2 + feed * (1 - a[i]);
        b2[i] = b[i] + DB * lb + ab2 - (kill + feed) * b[i];
      }
    }
    s.a = a2; s.a2 = a; s.b = b2; s.b2 = b;
  }

  /* --- strata: layered noise, read as contours ------------------------ */
  /* A topographic map of a landscape that is not anywhere. The field is
   * fractal noise; what you see is the banding, not the noise — quantising a
   * smooth field into a ramp is what draws the contour lines. */
  P.strata = {
    desc: 'fractal noise quantised into contour bands. a map of nowhere',
    chars: ' ─═≡▬█',
    settings: { fps: 20 },
    boot: function (ctx, g) { g._strata = { n: T.fbm(ctx.settings.seed, 5) }; },
    main: function (x, y, i, ctx, g) {
      var s = g._strata, t = ctx.time * 0.00006;
      var f = 0.045 / ctx.scale;
      var v = s.n(x * f * ctx.aspect + t, y * f - t * 0.4);
      /* fract of a scaled field: the bands. 7 of them. */
      var band = T.fract(v * 7);
      return ramp(1 - band, g.cs);
    }
  };

  /* --- moire ----------------------------------------------------------- */
  /* Two identical grids, one rotated. Everything visible here is
   * interference: neither grid contains the pattern that appears. */
  P.moire = {
    desc: 'two grids, one rotated. the pattern is in neither of them',
    chars: ' ·:+*#',
    settings: { fps: 30 },
    main: function (x, y, i, ctx, g) {
      var t = ctx.time * 0.0002;
      var cx = ctx.cols * 0.5, cy = ctx.rows * 0.5;
      var ax = (x - cx) * ctx.aspect, ay = y - cy;
      var s1 = sin(t * 0.7), c1 = cos(t * 0.7);
      var s2 = sin(-t), c2 = cos(-t);
      var f = 0.9 / ctx.scale;
      var g1 = sin((ax * c1 - ay * s1) * f) * sin((ax * s1 + ay * c1) * f);
      var g2 = sin((ax * c2 - ay * s2) * f * 1.06) * sin((ax * s2 + ay * c2) * f * 1.06);
      return ramp(abs(g1 - g2) * 0.9, g.cs);
    }
  };

  /* --- sdf: a solid, raymarched --------------------------------------- */
  /* No geometry, no triangles. A function returns the distance from a point
   * to the nearest surface, and a ray walks that distance repeatedly until it
   * arrives. The shading is the surface normal against one light, quantised
   * to a ramp — which is the whole of what an ASCII renderer can say. */
  P.sdf = {
    desc: 'a torus and a cube, raymarched. distance functions, no geometry',
    chars: ' .:-=+*#%@',
    settings: { fps: 24 },
    main: function (x, y, i, ctx, g) {
      var t = ctx.time * 0.0004;
      var span = ctx.rows * 0.95 * ctx.scale;
      var u = ((x - ctx.cols * 0.5) * ctx.aspect) / span;
      var v = (y - ctx.rows * 0.5) / span;

      var ox = 0, oy = 0, oz = -3.2;         /* eye */
      var dx = u, dy = v, dz = 1;
      var il = 1 / sqrt(dx * dx + dy * dy + dz * dz);
      dx *= il; dy *= il; dz *= il;

      /* The bounding sphere is radius ~1.5 about the origin. A ray that
       * cannot reach it is abandoned before a single scene() call, which is
       * most of the screen and most of the cost. */
      var tca = -oz * dz;
      var d2 = oz * oz - tca * tca;
      if (d2 > 2.6) return 0;

      var d = tca - sqrt(2.6 - d2), px, py, pz, dist = 0, hit = 0;
      /* 24 steps and a loose threshold. A ramp has ten levels; refining a
       * surface past the point where the tenth level changes is work nobody
       * can see. This is the one program here that is not cheap enough for a
       * backdrop — it is meant to be looked at, on a grid of its own. */
      for (var k = 0; k < 24; k++) {
        px = ox + dx * d; py = oy + dy * d; pz = oz + dz * d;
        dist = scene(px, py, pz, t);
        if (dist < 0.01) { hit = 1; break; }
        d += dist;
        if (d > 6) break;
      }
      if (!hit) return 0;

      /* normal by central difference, then lambert */
      var e = 0.01;
      var nx = scene(px + e, py, pz, t) - scene(px - e, py, pz, t);
      var ny = scene(px, py + e, pz, t) - scene(px, py - e, pz, t);
      var nz = scene(px, py, pz + e, t) - scene(px, py, pz - e, t);
      var nl = 1 / (sqrt(nx * nx + ny * ny + nz * nz) || 1);
      var lam = (nx * nl * 0.45 + ny * nl * 0.6 + nz * nl * -0.66);
      return ramp(0.15 + max(0, lam) * 1.1, g.cs);
    }
  };

  function scene(x, y, z, t) {
    /* rotate the world instead of the camera: cheaper and equivalent */
    var c = cos(t), s = sin(t);
    var rx = x * c - z * s, rz = x * s + z * c;
    var c2 = cos(t * 0.7), s2 = sin(t * 0.7);
    var ry = y * c2 - rz * s2; rz = y * s2 + rz * c2;

    /* torus */
    var q = sqrt(rx * rx + rz * rz) - 1.0;
    var torus = sqrt(q * q + ry * ry) - 0.35;

    /* cube, rounded, pulsing */
    var h = 0.55 + sin(t * 2) * 0.08;
    var bx = abs(rx) - h, by = abs(ry) - h, bz = abs(rz) - h;
    var mx = max(bx, 0), my = max(by, 0), mz = max(bz, 0);
    var box = sqrt(mx * mx + my * my + mz * mz) + min(max(bx, max(by, bz)), 0) - 0.06;

    /* smooth union, so the two read as one solid */
    var k = 0.35;
    var hh = Math.max(0, Math.min(1, 0.5 + 0.5 * (box - torus) / k));
    return T.mix(box, torus, hh) - k * hh * (1 - hh);
  }

  /* --- subdiv --------------------------------------------------------- */
  /* A rectangle splits, and its halves split, until they are small. Drawn as
   * rules rather than fills, so what accumulates is a plan of a building that
   * was never designed. Recomputed on a slow cycle; between recomputes the
   * frame is free. */
  P.subdiv = {
    desc: 'a rectangle, split until it stops. drawn as rules',
    chars: ' ─│┌┐└┘├┤┬┴┼·',
    settings: { fps: 12 },
    frame: function (ctx, g) {
      var cols = g.cols, rows = g.rows;
      var s = state(g, 'subdiv', function () { return { at: -1e9, cells: [] }; });
      var period = 6000;
      if (ctx.time - s.at > period) {
        s.at = ctx.time;
        s.cells = [];
        split(0, 0, cols - 1, rows - 1, 0, s.cells);
      }
      var gl = glyphs(g, ' ─│┌┐└┘├┤┬┴┼·');
      g.clear(0);
      /* a wipe reveals the new plan left to right instead of cutting */
      var reveal = T.smoothstep(0, period * 0.3, ctx.time - s.at) * cols;
      for (var k = 0; k < s.cells.length; k++) {
        var r = s.cells[k];
        if (r.x0 > reveal) continue;
        box(g, gl, r.x0, r.y0, r.x1, r.y1, min(r.x1, reveal | 0));
      }
    }
  };

  function split(x0, y0, x1, y1, depth, out) {
    var w = x1 - x0, h = y1 - y0;
    /* depth > 1 before the random stop, so the plan always has more than one
     * room in it. Otherwise one unlucky draw in ten shows an empty rectangle
     * for six seconds. */
    if (depth > 6 || (w < 10 && h < 5) || (depth > 1 && Math.random() < 0.1 * depth)) {
      out.push({ x0: x0, y0: y0, x1: x1, y1: y1 });
      return;
    }
    /* split the long side, near the middle but never at it */
    var r = 0.35 + Math.random() * 0.3;
    if (w * 0.45 > h) {
      var xm = x0 + max(2, floor(w * r));
      split(x0, y0, xm, y1, depth + 1, out);
      split(xm, y0, x1, y1, depth + 1, out);
    } else {
      var ym = y0 + max(1, floor(h * r));
      split(x0, y0, x1, ym, depth + 1, out);
      split(x0, ym, x1, y1, depth + 1, out);
    }
  }

  /* draw a rectangle's rules, clipped at `xmax`, merging where lines meet */
  function box(g, gl, x0, y0, x1, y1, xmax) {
    var H = gl[1], V = gl[2], X = gl[11], x, y;
    for (x = x0; x <= min(x1, xmax); x++) { mergeAt(g, x, y0, H, gl); mergeAt(g, x, y1, H, gl); }
    for (y = y0; y <= y1; y++) {
      if (x0 <= xmax) mergeAt(g, x0, y, V, gl);
      if (x1 <= xmax) mergeAt(g, x1, y, V, gl);
    }
    void X;
  }

  /* where a horizontal meets a vertical, put a cross rather than overwrite */
  function mergeAt(g, x, y, want, gl) {
    if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return;
    var i = y * g.cols + x, has = g.ch[i];
    if (has === 0 || has === want) { g.ch[i] = want; return; }
    if ((has === gl[1] && want === gl[2]) || (has === gl[2] && want === gl[1])) g.ch[i] = gl[11];
  }

  /* --- rain ------------------------------------------------------------ */
  /* Columns falling at different speeds. Each has a bright head and a tail
   * that fades; the glyphs under the head keep changing, which is the only
   * part that matters. */
  P.rain = {
    desc: 'columns falling at their own speeds, glyphs churning behind',
    chars: ' .:-=+*#%@',
    settings: { fps: 24 },
    frame: function (ctx, g) {
      var cols = g.cols, rows = g.rows;
      var s = state(g, 'rain', function () {
        var st = { y: new Float32Array(cols), v: new Float32Array(cols), ch: new Uint16Array(cols * rows) };
        for (var i = 0; i < cols; i++) {
          st.y[i] = -Math.random() * rows * 2;
          st.v[i] = 0.25 + Math.random() * 0.75;
        }
        return st;
      });
      var pool = glyphs(g, '01·+*=<>[]{}/\\|abcdefXYZ#@%$');
      g.clear(0);
      var trail = max(4, rows * 0.5) | 0;
      for (var x = 0; x < cols; x++) {
        s.y[x] += s.v[x] * ctx.speed;
        if (s.y[x] - trail > rows) {
          s.y[x] = -Math.random() * rows * 0.5;
          s.v[x] = 0.25 + Math.random() * 0.75;
        }
        var head = s.y[x] | 0;
        for (var k = 0; k < trail; k++) {
          var y = head - k;
          if (y < 0 || y >= rows) continue;
          var i = y * cols + x;
          /* the head is a fixed bright glyph, the tail churns and fades */
          if (k === 0) g.ch[i] = pool[(Math.random() * pool.length) | 0];
          else if (Math.random() < 0.06) g.ch[i] = pool[(Math.random() * pool.length) | 0];
          else g.ch[i] = s.ch[i] || pool[(Math.random() * pool.length) | 0];
          s.ch[i] = g.ch[i];
          if (k > trail * 0.55 && Math.random() < 0.3) g.ch[i] = 0;
        }
      }
    }
  };

  /* --- spiral ---------------------------------------------------------- */
  P.spiral = {
    desc: 'polar coordinates, wound. an argument about aspect ratio',
    chars: ' ·-=+*#%@',
    settings: { fps: 30 },
    main: function (x, y, i, ctx, g) {
      var ax = (x - ctx.cols * 0.5) * ctx.aspect, ay = y - ctx.rows * 0.5;
      var r = sqrt(ax * ax + ay * ay), a = Math.atan2(ay, ax);
      var t = ctx.time * 0.0006;
      var v = sin(a * 3 + r * 0.35 / ctx.scale - t * 3);
      return ramp((v + 1) * 0.5 * T.smoothstep(0, 4, r), g.cs);
    }
  };

  /* --- drift ----------------------------------------------------------- */
  /* The quietest one, and the default behind text. A slow fractal field with
   * almost no contrast, so that words placed on top of it stay readable.
   * Nothing happens. That is the specification. */
  P.drift = {
    desc: 'a slow field with almost no contrast. made to be ignored',
    chars: ' ·:∙',
    settings: { fps: 8 },
    boot: function (ctx, g) { g._drift = { n: T.fbm(ctx.settings.seed, 3) }; },
    main: function (x, y, i, ctx, g) {
      var t = ctx.time * 0.00004;
      var f = 0.06 / ctx.scale;
      var v = g._drift.n(x * f * ctx.aspect + t, y * f + t * 0.6);
      return ramp((v - 0.42) * 3.4, g.cs);
    }
  };

  /* --- grid ------------------------------------------------------------ */
  /* A ruled sheet that breathes. Structural rather than pictorial; good
   * behind a page of prose, where noise would be busy. */
  P.grid = {
    desc: 'a ruled sheet, breathing. structure rather than picture',
    chars: ' ·+',
    settings: { fps: 10 },
    main: function (x, y, i, ctx, g) {
      var t = ctx.time * 0.0002;
      var sx = 6 + sin(t) * 1.5, sy = 3 + cos(t * 0.8) * 0.8;
      var onx = abs(T.fract(x / sx) - 0.5) > 0.44;
      var ony = abs(T.fract(y / sy) - 0.5) > 0.44;
      if (onx && ony) return 2;
      if (onx || ony) return 1;
      return 0;
    }
  };

})(window.Textmode);
