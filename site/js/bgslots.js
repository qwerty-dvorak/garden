/* bgslots.js — five backgrounds you keep, and pictures turned into glyphs.
 *
 * Three things live here, and they share a file because they share a store:
 *
 *   slots     five saved backgrounds. yours, on your machine, for good.
 *   image     a picture as the background — flat, or as ascii, or as a mask
 *             that a moving field is only allowed to draw inside.
 *   gallery   backgrounds other people have shared. read here, written by
 *             the control panel.
 *
 * Where things live, and why:
 *
 *   localStorage   slot names and their dials. small, synchronous, and the
 *                  same place backdrop.js already keeps the live config.
 *   IndexedDB      the pictures. localStorage is a five-megabyte string
 *                  store; one photograph as a data URI can be most of it.
 *
 * Pictures never leave the machine they were dropped on. That is not a
 * limitation that was worked around, it is the reason the slots are
 * client-side at all — and it is why a shared link can carry a set of dials
 * but not a photograph. A permalink to `ascii` with `img=2` renders whatever
 * is in *your* slot two, which is either delightful or nothing at all.
 */
(function () {
  'use strict';

  var T = window.Textmode;
  if (!T) return;

  var SLOT_KEY = 'garden.bg.slots';
  var SLOTS = 5;
  var DB_NAME = 'garden-bg';
  var STORE = 'images';
  var MAX_BYTES = 8 * 1024 * 1024;

  /* ---------- slot metadata (localStorage) ------------------------------ */

  function readSlots() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(SLOT_KEY) || 'null'); } catch (e) { raw = null; }
    var out = [];
    for (var i = 0; i < SLOTS; i++) {
      var s = raw && raw[i];
      out.push(s && typeof s === 'object' ? s : null);
    }
    return out;
  }

  function writeSlots(list) {
    try { localStorage.setItem(SLOT_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
  }

  /* ---------- pictures (IndexedDB) --------------------------------------
   *
   * Everything here is written as "ask, and call back when it arrives".
   * There is no await because the rest of the site is ES5 in classic script
   * tags, and one file reaching for modules would drag the whole page's
   * loading model along with it.
   */

  var dbp = null;

  function db(cb) {
    if (!window.indexedDB) { cb(null); return; }
    if (dbp) { dbp(cb); return; }

    var waiting = [], handle = null, failed = false;
    dbp = function (fn) {
      if (failed) { fn(null); return; }
      if (handle) { fn(handle); return; }
      waiting.push(fn);
    };

    var req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { failed = true; cb(null); return; }

    req.onupgradeneeded = function () {
      var d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess = function () {
      handle = req.result;
      waiting.splice(0).forEach(function (fn) { fn(handle); });
      cb(handle);
    };
    req.onerror = function () {
      failed = true;
      waiting.splice(0).forEach(function (fn) { fn(null); });
      cb(null);
    };
  }

  function putImage(slot, blob, cb) {
    db(function (d) {
      if (!d) { cb(false); return; }
      try {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(blob, String(slot));
        tx.oncomplete = function () { cb(true); };
        tx.onerror = function () { cb(false); };
      } catch (e) { cb(false); }
    });
  }

  function getImage(slot, cb) {
    db(function (d) {
      if (!d) { cb(null); return; }
      try {
        var req = d.transaction(STORE, 'readonly').objectStore(STORE).get(String(slot));
        req.onsuccess = function () { cb(req.result || null); };
        req.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  }

  function delImage(slot, cb) {
    db(function (d) {
      if (!d) { if (cb) cb(); return; }
      try {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(String(slot));
        tx.oncomplete = function () { if (cb) cb(); };
        tx.onerror = function () { if (cb) cb(); };
      } catch (e) { if (cb) cb(); }
    });
  }

  /* ---------- a picture, sampled onto the grid ---------------------------
   *
   * The expensive part of an image background is decoding it, and that
   * happens once. What happens per resize is drawing the decoded bitmap into
   * a canvas the size of the character grid — twenty thousand pixels, not
   * twenty million — and reading the luminance back. The browser's own
   * downscaler does the averaging, which is both faster and better than
   * doing it a pixel at a time here.
   */

  var cache = { slot: null, bitmap: null, url: null, lum: null, cols: 0, rows: 0 };
  var loading = null;

  function luminance(bitmap, cols, rows) {
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, cols);
    cv.height = Math.max(1, rows);
    var cx = cv.getContext('2d', { willReadFrequently: true });
    if (!cx) return null;

    /* Cells are about twice as tall as they are wide, so a grid drawn at
     * cols x rows is already the right shape for the page. Stretching the
     * picture to it is correct, not a compromise: the alternative is
     * letterboxing a background nobody asked to be letterboxed. */
    cx.drawImage(bitmap, 0, 0, cv.width, cv.height);

    var data;
    try { data = cx.getImageData(0, 0, cv.width, cv.height).data; }
    catch (e) { return null; }          /* tainted canvas, cannot happen here */

    var out = new Float32Array(cv.width * cv.height);
    for (var i = 0, p = 0; i < out.length; i++, p += 4) {
      /* Rec. 601 luma. The eye is not a photometer and green carries most
       * of the brightness; an unweighted mean turns skies into mud. */
      out[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
    }
    return out;
  }

  /* Sample cache for the current grid. Null until a picture is decoded. */
  function lumFor(cols, rows) {
    if (!cache.bitmap) return null;
    if (cache.lum && cache.cols === cols && cache.rows === rows) return cache.lum;
    cache.lum = luminance(cache.bitmap, cols, rows);
    cache.cols = cols;
    cache.rows = rows;
    return cache.lum;
  }

  function forget() {
    if (cache.url) { URL.revokeObjectURL(cache.url); cache.url = null; }
    if (cache.bitmap && cache.bitmap.close) { try { cache.bitmap.close(); } catch (e) { /* ok */ } }
    cache = { slot: null, bitmap: null, url: null, lum: null, cols: 0, rows: 0 };
  }

  /* Decode slot `n`, then call back with (ok, fresh).
   *
   * `fresh` is only true when a decode actually happened. It has to be,
   * because the caller's response to a picture arriving is to rebuild the
   * backdrop — and build() asks for the picture again. Without the
   * distinction between "decoded just now" and "already had it", that is an
   * unbounded recursion that renders one frame and then hangs the tab. */
  function ensure(slot, then) {
    slot = String(slot);
    if (cache.slot === slot && cache.bitmap) { if (then) then(true, false); return; }
    if (loading === slot) return;
    loading = slot;

    getImage(slot, function (blob) {
      if (!blob) {
        loading = null;
        forget();
        if (then) then(false, false);
        return;
      }

      var done = function (bitmap) {
        loading = null;
        forget();
        cache.slot = slot;
        cache.bitmap = bitmap;
        cache.url = URL.createObjectURL(blob);
        if (then) then(true, true);
      };

      if (window.createImageBitmap) {
        createImageBitmap(blob).then(done, function () { loading = null; });
      } else {
        var img = new Image();
        var url = URL.createObjectURL(blob);
        img.onload = function () { done(img); };
        img.onerror = function () { loading = null; URL.revokeObjectURL(url); };
        img.src = url;
      }
    });
  }

  /* ---------- the programs ---------------------------------------------- */

  function ramp(v, cs) { return v <= 0 ? 0 : v >= 1 ? cs.last : (v * cs.last) | 0; }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }

  /* Which slot's picture a config is talking about. */
  function slotOf(opts) {
    var n = parseInt(opts && opts.img, 10);
    return (n >= 1 && n <= SLOTS) ? n : 1;
  }

  /* --- ascii: the picture, as glyphs ------------------------------------
   *
   * The whole program is one lookup and one ramp. That it works at all is a
   * property of the charset, not of the code: a ramp ordered dark to light
   * *is* a greyscale palette with about ten steps, and a photograph
   * quantised to ten steps is still recognisably the photograph.
   */
  T.programs.ascii = {
    desc: 'a picture from a slot, as characters',
    chars: ' .:-=+*#%@',
    settings: { fps: 4 },          /* a still image does not need sixty */

    main: function (x, y, i, ctx, g) {
      var lum = lumFor(ctx.cols, ctx.rows);
      if (!lum) return 0;
      var v = lum[y * ctx.cols + x];
      if (v === undefined) return 0;
      if (this.invert) v = 1 - v;
      /* contrast around the midpoint, so a flat photograph can be pushed
       * into a range the ramp actually distinguishes */
      v = T.clamp((v - 0.5) * this.gain + 0.5, 0, 1);
      return ramp(v, g.cs);
    }
  };

  /* --- mask: text, but only where the picture is --------------------------
   *
   * The picture stops being something you look at and becomes a stencil.
   * Inside it, glyphs; outside it, nothing. What fills the inside is either
   * a word repeating or a moving field, and in both cases the image is doing
   * no drawing of its own — it only decides where drawing is allowed.
   *
   * This is the one that looks least like its inputs. A photograph of a face
   * and the word "rot" produce neither a face nor the word.
   */
  T.programs.mask = {
    desc: 'text and motion, clipped to the shape of a picture',
    chars: ' .:-=+*#%@',
    settings: { fps: 20 },

    main: function (x, y, i, ctx, g) {
      var lum = lumFor(ctx.cols, ctx.rows);
      if (!lum) return 0;

      var v = lum[y * ctx.cols + x];
      if (v === undefined) return 0;
      if (this.invert) v = 1 - v;
      if (v < this.thr) return 0;               /* outside the stencil */

      if (this.text) {
        /* The text runs continuously across the grid rather than restarting
         * each row, so the letters do not line up into columns and the shape
         * reads before the words do. */
        var n = this.text.length;
        var k = ((y * ctx.cols + x) + ((ctx.time * 0.004 * this.speed) | 0)) % n;
        if (k < 0) k += n;
        return T.glyph(g.cs, this.text.charAt(k));
      }

      /* No word: a slow field, so the stencil has something moving in it. */
      var t = ctx.time * 0.0004 * this.speed;
      var a = x * ctx.aspect * 0.18;
      var f = Math.sin(a + t) + Math.sin(y * 0.21 - t * 1.3) +
              Math.sin((a + y) * 0.11 + t * 0.7);
      return ramp((f + 3) / 6 * (this.soft ? v : 1), g.cs);
    }
  };

  /* Programs are shared objects, so per-run settings are read at boot from
   * the config rather than left on the program where a second run would
   * inherit them. */
  function bootOpts(prog) {
    var prev = prog.boot;
    prog.boot = function (ctx, g) {
      var o = (window.Backdrop && window.Backdrop.config().opts) || {};
      this.invert = o.maskinv === '1' || o.maskinv === 'true';
      this.gain = num(o.gain, 1.6);
      this.thr = T.clamp(num(o.maskthr, 0.45), 0, 1);
      this.speed = num(o.maskspeed, 1);
      this.soft = o.masksoft === '1' || o.masksoft === 'true';
      this.text = typeof o.masktext === 'string' ? o.masktext : '';
      if (prev) prev.call(this, ctx, g);
    };
  }
  bootOpts(T.programs.ascii);
  bootOpts(T.programs.mask);

  /* ---------- the flat image layer ---------------------------------------
   *
   * `bg image` is not a program: a photograph shown as a photograph is a CSS
   * background, and rendering it through a grid of characters would be an
   * elaborate way of making it worse. backdrop.js calls this from build()
   * with the same config the programs get, and it owns exactly one element.
   */

  var layerEl = null;

  function dropLayer() {
    if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
    layerEl = null;
  }

  function layer(c) {
    var name = c && c.bg;
    var opts = (c && c.opts) || {};

    if (name !== 'image') { dropLayer(); return; }

    ensure(slotOf(opts), function (ok) {
      if (!ok) { dropLayer(); return; }
      if (!layerEl) {
        layerEl = document.createElement('div');
        layerEl.className = 'bg-image';
        layerEl.setAttribute('aria-hidden', 'true');
        document.body.insertBefore(layerEl, document.body.firstChild);
      }
      layerEl.style.backgroundImage = 'url("' + cache.url + '")';
      layerEl.style.opacity = String(T.clamp(num(opts.fade, 0.5), 0, 1));
      layerEl.style.backgroundSize = opts.fit === 'contain' ? 'contain'
                                   : opts.fit === 'tile' ? 'auto' : 'cover';
      layerEl.style.backgroundRepeat = opts.fit === 'tile' ? 'repeat' : 'no-repeat';
    });
  }

  /* A program needs its picture before it can draw anything. Called from
   * build() so the decode happens once per config change rather than once
   * per frame. */
  function preload(c) {
    if (!c || (c.bg !== 'ascii' && c.bg !== 'mask')) return;
    ensure(slotOf(c.opts || {}), function (ok, fresh) {
      /* Only on the transition from "no picture" to "picture". build() calls
       * preload(), so rebuilding on a cache hit would never terminate. */
      if (ok && fresh && window.Backdrop) window.Backdrop.build();
    });
  }

  /* ---------- the gallery ------------------------------------------------ */

  function gallery(cb) {
    var x = new XMLHttpRequest();
    x.open('GET', '/api/gallery', true);
    x.onload = function () {
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { data = null; }
      cb((data && data.entries) || []);
    };
    x.onerror = function () { cb([]); };
    x.send();
  }

  function share(name, cfg, cb) {
    var o = cfg.opts || {}, parts = [];
    for (var k in o) if (o[k] !== '' && o[k] !== undefined) parts.push(k + '=' + o[k]);

    var body = 'name=' + encodeURIComponent(name || 'untitled') +
               '&bg=' + encodeURIComponent(cfg.bg || 'none') +
               '&chars=' + encodeURIComponent(cfg.chars || '') +
               '&opts=' + encodeURIComponent(parts.join(' '));

    var x = new XMLHttpRequest();
    x.open('POST', '/api/gallery', true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    x.onload = function () {
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { data = null; }
      cb(x.status === 201, data, x.status);
    };
    x.onerror = function () { cb(false, null, 0); };
    x.send(body);
  }

  /* ---------- public ----------------------------------------------------- */

  window.BgSlots = {
    SLOTS: SLOTS,
    MAX_BYTES: MAX_BYTES,

    read: readSlots,

    /* Save the live background into a slot. The picture, if the config uses
     * one, is already in IndexedDB under that slot number — a slot is a name
     * plus dials plus, sometimes, the picture those dials point at. */
    save: function (n, name, cfg) {
      var list = readSlots();
      list[n] = {
        name: name || ('slot ' + (n + 1)),
        config: { bg: cfg.bg, chars: cfg.chars, opts: cfg.opts },
        at: new Date().toISOString().slice(0, 10)
      };
      writeSlots(list);
    },

    clear: function (n, cb) {
      var list = readSlots();
      list[n] = null;
      writeSlots(list);
      delImage(n + 1, cb);
    },

    /* A picture goes into a slot, not into "the background": that is what
     * makes five of them possible and what keeps `img=3` meaning something
     * stable while you fiddle with the dials. */
    put: function (n, blob, cb) {
      if (blob.size > MAX_BYTES) { cb(false, 'too big'); return; }
      if (!/^image\//.test(blob.type)) { cb(false, 'not an image'); return; }
      putImage(n + 1, blob, function (ok) {
        if (ok && cache.slot === String(n + 1)) forget();   /* re-decode */
        cb(ok, ok ? null : 'could not store');
      });
    },

    has: function (n, cb) { getImage(n + 1, function (b) { cb(!!b); }); },

    layer: layer,
    preload: preload,
    gallery: gallery,
    share: share
  };
})();
