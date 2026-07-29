/* backdrop.js — the field behind the page, and the things floating in it.
 *
 * Two stacked <pre> elements, fixed to the viewport, behind everything:
 *
 *   .bg-field   the program. one glyph per cell, one colour, no markup —
 *               which keeps it on the renderer's monochrome path, where a
 *               frame is one string and one textContent write.
 *   .bg-drift   page links, floating. sparse, styled, and containing real
 *               anchors, so it takes the slow path — but almost every row of
 *               it is empty and unchanged, so almost every row is skipped.
 *
 * Splitting them is the whole trick. A single layer carrying both would put
 * the entire field on the span-building path for the sake of six links.
 *
 * Configuration, lowest priority first:
 *
 *   1. the block header      bg / bgchars / bgopts  ->  data-* on <body>
 *   2. localStorage          whatever /b/background last saved
 *   3. the query string      ?bg=plasma&bgopts=speed%3D2
 *
 * The reader's stored preference beats the page's, and a link beats both.
 * `bg  none` in a header turns it off for that page whatever else says.
 */
(function () {
  'use strict';

  var T = window.Textmode;
  if (!T) return;

  var KEY = 'garden.bg';

  /* ---------- reading the knobs ---------------------------------------- */

  /* `bgopts` is one line of `k=v` pairs, in the spirit of the existing `css`
   * knob: one header field rather than ten. Blocks only get 32 fields. */
  function parseOpts(s) {
    var o = {};
    if (!s) return o;
    String(s).split(/[\s;]+/).forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i > 0) o[pair.slice(0, i).toLowerCase()] = pair.slice(i + 1);
    });
    return o;
  }

  function num(v, dflt) {
    var n = parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  function config() {
    var d = document.body.dataset;
    var c = {
      bg: d.bg || '',
      chars: d.bgchars || '',
      opts: parseOpts(d.bgopts)
    };

    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { stored = null; }
    if (stored && typeof stored === 'object') {
      if (stored.bg) c.bg = stored.bg;
      if (stored.chars !== undefined) c.chars = stored.chars;
      if (stored.opts) for (var k in stored.opts) c.opts[k] = stored.opts[k];
    }

    var q = new URLSearchParams(location.search);
    if (q.get('bg')) c.bg = q.get('bg');
    if (q.get('bgchars') !== null) c.chars = q.get('bgchars');
    if (q.get('bgopts')) {
      var qo = parseOpts(q.get('bgopts'));
      for (var k2 in qo) c.opts[k2] = qo[k2];
    }
    return c;
  }

  /* A program name is an id, same rule the server applies to `skin`. */
  function safeName(s) { return /^[\w-]+$/.test(s || '') ? s : ''; }

  /* ---------- the drift layer ------------------------------------------ */

  /* Links already on the page, floating behind it. Harvested rather than
   * emitted: ertdfgcvb's post() composites the page's own <main> into the
   * field and adds no markup, and that is the right call here too. Nothing
   * in the drift layer is reachable only from the drift layer, so marking it
   * aria-hidden costs a reader nothing and lynx sees no duplicate list.
   */
  var SOURCES = {
    nav: 'nav a, .incoming a',
    body: 'article a[href^="/b/"]',
    all: 'nav a, .incoming a, article a[href^="/b/"], footer a',
    none: ''
  };

  function harvest(which) {
    var sel = SOURCES[which] !== undefined ? SOURCES[which] : SOURCES.nav;
    if (!sel) return [];
    var out = [], seen = Object.create(null);
    document.querySelectorAll(sel).forEach(function (a) {
      var text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      var href = a.getAttribute('href');
      if (!text || !href || seen[href + text]) return;
      if (text.length > 28) text = text.slice(0, 27) + '…';
      seen[href + text] = 1;
      out.push({ text: text, href: href });
    });
    return out;
  }

  /* True while the pointer is over one of the drifting links. Module level
   * because the program that draws them and the handlers that watch for the
   * pointer are on opposite sides of the runner. */
  var reaching = false;

  /* One floater per link. Position in cells, velocity in cells per frame.
   *
   * `flap` is ertdfgcvb's split-flap: a character does not appear, it counts
   * up through the charset until it reaches the one it wants. The charset has
   * grown by then to hold the ramp plus every letter any link needs, so the
   * count is over the same pool the field is drawn from and the letters
   * arrive out of the texture rather than on top of it.
   */
  function driftProgram(items, opts) {
    var speed = num(opts.driftspeed, 1);
    return {
      chars: ' ',
      settings: { fps: num(opts.fps, 20), pointer: false },

      boot: function (ctx, g) {
        this.lit = g.style('color:var(--bg-lit,currentColor)');
        this.f = items.map(function (it, n) {
          var a = (n / Math.max(1, items.length)) * Math.PI * 2;
          return {
            text: it.text, href: it.href,
            x: Math.random() * ctx.cols,
            y: Math.random() * ctx.rows,
            vx: Math.cos(a) * 0.035 * speed + (Math.random() - 0.5) * 0.02,
            vy: Math.sin(a) * 0.018 * speed + (Math.random() - 0.5) * 0.01,
            cur: null, target: null
          };
        });
      },

      frame: function (ctx, g) {
        g.clear(0);
        var cols = g.cols, rows = g.rows, cs = g.cs, lit = this.lit;
        /* Half rate, like the original's `frame % 2` overlay. Nobody reads a
         * word that is drifting at a fortieth of a cell per frame. */
        /* Hold still while somebody is reaching for a link. A word that
         * moves out from under the pointer between deciding to click it and
         * clicking it is not a link, it is a joke about one. */
        var advance = (ctx.frame & 1) === 0 && !reaching;

        for (var n = 0; n < this.f.length; n++) {
          var f = this.f[n];

          if (!f.target) {
            f.target = Array.from(f.text).map(function (c) { return T.glyph(cs, c); });
            f.cur = f.target.map(function () { return (Math.random() * cs.n) | 0; });
          }

          if (advance) {
            f.x += f.vx; f.y += f.vy;
            /* wrap, and re-scramble so the word flaps back into being */
            var w = f.target.length;
            if (f.x > cols) { f.x = -w; scramble(f, cs); }
            if (f.x < -w) { f.x = cols; scramble(f, cs); }
            if (f.y > rows) { f.y = -1; scramble(f, cs); }
            if (f.y < -1) { f.y = rows; scramble(f, cs); }
          }

          var y = Math.round(f.y);
          if (y < 0 || y >= rows) continue;
          var x0 = Math.round(f.x);

          var first = -1, last = -1;
          for (var i = 0; i < f.target.length; i++) {
            if (advance && f.cur[i] !== f.target[i]) f.cur[i] = (f.cur[i] + 1) % cs.n;
            var x = x0 + i;
            if (x < 0 || x >= cols) continue;
            var idx = y * cols + x;
            g.ch[idx] = f.cur[i];
            g.st[idx] = lit;
            if (first < 0) first = idx;
            last = idx;
          }
          /* Only anchor it once it has stopped flapping — a link whose text
           * is still churning is not a link anyone can decide to click. */
          if (first >= 0 && settled(f)) g.link(first, last, f.href, 'drift');
        }
      }
    };
  }

  function scramble(f, cs) {
    for (var i = 0; i < f.cur.length; i++) f.cur[i] = (Math.random() * cs.n) | 0;
  }

  function settled(f) {
    for (var i = 0; i < f.cur.length; i++) if (f.cur[i] !== f.target[i]) return false;
    return true;
  }

  /* ---------- assembly -------------------------------------------------- */

  /* Make the drifting words behave like the links they are.
   *
   * They already were anchors, and the layer already sat above the page, so
   * hovering one lit up — but clicking did nothing, and the reason is that a
   * click is not an event the browser sends. It is an inference from a
   * mousedown and a mouseup landing on the same element, and this layer
   * rewrites the row a word lives on as the word moves. By mouseup the
   * anchor is a different element, so the inference never gets made.
   *
   * So: freeze while the pointer is on one, and navigate on pointerdown,
   * which is a real event about a real element and needs nothing to survive
   * until the button comes back up. Delegated, because the anchors are
   * replaced constantly and listeners on them would go with them. */
  function wire(layer) {
    function anchor(e) {
      /* the glyphs are spans inside the anchor on the styled path */
      var a = e.target && e.target.closest && e.target.closest('a');
      return a && layer.contains(a) ? a : null;
    }

    layer.addEventListener('pointerover', function (e) {
      if (anchor(e)) reaching = true;
    });
    layer.addEventListener('pointerout', function (e) {
      var a = anchor(e);
      /* pointerout also fires moving from the anchor onto a span inside it,
       * and on the styled path the glyphs are exactly that. Without this the
       * word unfreezes while the pointer is still sitting on it. */
      if (a && !(e.relatedTarget && a.contains(e.relatedTarget))) reaching = false;
    });
    layer.addEventListener('pointerdown', function (e) {
      /* Only the plain primary press. Middle click, ctrl or cmd click and
       * the context menu all belong to the anchor, which carries the href
       * and knows what those mean; taking them here would break opening a
       * link in a new tab in order to fix opening it in this one. */
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      var a = anchor(e);
      var href = a && a.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      window.location.href = href;
    });
  }

  var running = { field: null, drift: null, els: [] };

  function teardown() {
    if (running.field) running.field.stop();
    if (running.drift) running.drift.stop();
    running.els.forEach(function (e) { if (e.parentNode) e.parentNode.removeChild(e); });
    running = { field: null, drift: null, els: [] };
    /* A rebuild while the pointer was on a word would otherwise leave the
     * next layer frozen from birth, with nothing left to send the pointerout
     * that would release it. */
    reaching = false;
  }

  function build() {
    teardown();
    var c = config();
    var name = safeName(c.bg);

    /* A picture is not a program. `bg image` is a CSS layer, and the two
     * character programs that draw from a picture need it decoded before
     * their first frame. bgslots.js owns both, and is handed the same config
     * everything else here reads — so a background that comes from a slot
     * obeys the same precedence as one that comes from a header. */
    if (window.BgSlots) {
      window.BgSlots.layer(c);
      window.BgSlots.preload(c);
    }

    if (!name || name === 'none' || !T.programs[name]) return;

    var o = c.opts;

    var field = document.createElement('pre');
    field.className = 'bg-field';
    field.setAttribute('aria-hidden', 'true');
    if (o.size) field.style.fontSize = num(o.size, 10) + 'px';
    if (o.fade) field.style.opacity = String(T.clamp(num(o.fade, 0.5), 0, 1));
    document.body.insertBefore(field, document.body.firstChild);
    running.els.push(field);

    /* With CSS disabled this <pre> is a normal block element at the top of
     * the document, and filling it would push the entire page down behind a
     * screenful of punctuation. If it did not become fixed, leave it empty. */
    if (getComputedStyle(field).position !== 'fixed') {
      field.parentNode.removeChild(field);
      running.els.pop();
      return;
    }

    var common = {
      chars: c.chars || undefined,
      fps: num(o.fps, undefined),
      speed: num(o.speed, undefined),
      scale: num(o.scale, undefined),
      seed: o.seed,
      word: o.word
    };

    running.field = T.run(field, T.programs[name], common);

    var items = harvest(o.drift || 'nav');
    if (items.length) {
      var layer = document.createElement('pre');
      layer.className = 'bg-drift';
      layer.setAttribute('aria-hidden', 'true');
      if (o.size) layer.style.fontSize = num(o.size, 10) + 'px';
      wire(layer);
      document.body.insertBefore(layer, field.nextSibling);
      running.els.push(layer);
      running.drift = T.run(layer, driftProgram(items, o), { chars: c.chars || undefined });
    }
  }

  /* Exposed so /b/background can re-run without a reload. */
  window.Backdrop = {
    build: build,
    teardown: teardown,
    config: config,
    key: KEY,
    save: function (cfg) {
      try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
      build();
    },
    reset: function () {
      try { localStorage.removeItem(KEY); } catch (e) { /* private mode */ }
      build();
    },
    sources: SOURCES,
    get current() { return running; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();

})();
