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

  /* Pictures to point the character programs at, and what an empty slot
   * falls back to.
   *
   * Drawn for the job rather than borrowed from elsewhere on the site. The
   * borrowed ones did not work: a frame of life is sparse dots that average
   * to near-black at twenty rows, and the phyllotaxis is thin lines on
   * white. Neither put a single cell above the mask threshold. These
   * programs need large shapes and a tonal range, not fine detail.
   *
   *   sphere   every tone between black and white inside one shape. what
   *            `ascii` wants: a subject that uses the whole ramp.
   *   tree     one hard-edged silhouette. what `mask` wants: an outline
   *            still recognisable when it is twenty rows tall.
   */
  var SAMPLES = [
    { url: '/media/sphere.svg', name: 'sphere' },
    { url: '/media/tree.svg', name: 'tree' }
  ];
  /* The fallback is named rather than taken from SAMPLES[0], so reordering
   * the buttons cannot quietly change what an empty slot renders. */
  var SAMPLE_URL = '/media/sphere.svg';

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
  function fetchBlob(url, cb) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.responseType = 'blob';
    x.onload = function () { cb(x.status === 200 ? x.response : null); };
    x.onerror = function () { cb(null); };
    x.send();
  }

  function decode(blob, slot, then) {
    var done = function (bitmap) {
      loading = null;
      forget();
      cache.slot = slot;
      cache.bitmap = bitmap;
      cache.url = URL.createObjectURL(blob);
      if (then) then(true, true);
    };

    /* An <img> decodes SVG, which createImageBitmap refuses in some browsers
     * because a bare SVG has no intrinsic size. So it is both the fallback
     * for old browsers and the retry when the fast path rejects — otherwise
     * choosing the vector sample would silently render nothing. */
    function viaImage() {
      var img = new Image();
      var url = URL.createObjectURL(blob);
      img.onload = function () { done(img); };
      img.onerror = function () { loading = null; URL.revokeObjectURL(url); };
      img.src = url;
    }

    if (window.createImageBitmap) createImageBitmap(blob).then(done, viaImage);
    else viaImage();
  }

  function ensure(slot, then) {
    slot = String(slot);
    if (cache.slot === slot && cache.bitmap) { if (then) then(true, false); return; }
    if (loading === slot) return;
    loading = slot;

    getImage(slot, function (blob) {
      if (blob) { decode(blob, slot, then); return; }

      /* An empty slot falls back to a picture that ships with the site,
       * rather than to nothing. A program whose whole job is to transform an
       * image has no honest way to render "no image", and a blank panel
       * reads as broken rather than as empty. */
      fetchBlob(SAMPLE_URL, function (sample) {
        if (!sample) {
          loading = null;
          forget();
          if (then) then(false, false);
          return;
        }
        decode(sample, slot, then);
      });
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
    desc: 'a photograph quantised to ten shades of punctuation',
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
    desc: 'a picture used as a stencil — drawing happens only inside it',
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

  /* Which entries this browser posted. The server hands back a token once,
   * on creation, and stores only its hash — so this is the only copy, and
   * losing it means losing the ability to delete, which is the correct
   * trade for a gallery that asks nobody to have an account. */
  var MINE_KEY = 'garden.gallery.mine';

  function readMine() {
    try { return JSON.parse(localStorage.getItem(MINE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function writeMine(m) {
    try { localStorage.setItem(MINE_KEY, JSON.stringify(m)); } catch (e) { /* ok */ }
  }

  function optsLine(cfg) {
    var o = cfg.opts || {}, parts = [];
    for (var k in o) if (o[k] !== '' && o[k] !== undefined) parts.push(k + '=' + o[k]);
    return parts.join(' ');
  }

  function share(name, cfg, cb) {
    var body = 'name=' + encodeURIComponent(name || 'untitled') +
               '&bg=' + encodeURIComponent(cfg.bg || 'none') +
               '&chars=' + encodeURIComponent(cfg.chars || '') +
               '&opts=' + encodeURIComponent(optsLine(cfg));

    var x = new XMLHttpRequest();
    x.open('POST', '/api/gallery', true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    x.onload = function () {
      var data = null;
      try { data = JSON.parse(x.responseText); } catch (e) { data = null; }
      if (x.status === 201 && data && data.id && data.token) {
        var mine = readMine();
        mine[data.id] = data.token;
        writeMine(mine);
      }
      cb(x.status === 201, data, x.status);
    };
    x.onerror = function () { cb(false, null, 0); };
    x.send(body);
  }

  function unshare(id, cb) {
    var mine = readMine();
    var token = mine[id];
    if (!token) { cb(false, 403); return; }

    var x = new XMLHttpRequest();
    x.open('DELETE', '/api/gallery', true);
    x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    x.onload = function () {
      if (x.status === 200 || x.status === 404) {
        delete mine[id];              /* gone either way; stop offering it */
        writeMine(mine);
      }
      cb(x.status === 200, x.status);
    };
    x.onerror = function () { cb(false, 0); };
    x.send('id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(token));
  }

  /* ---------- the gallery, as a list you can put anywhere ----------------
   * Built here rather than in the two pages that show it, so /b/background
   * and /b/ascii cannot drift apart. Everything a stranger wrote is set with
   * textContent.
   */
  function galleryUI(host, onLoad) {
    function draw() {
      host.textContent = 'loading…';
      gallery(function (entries) {
        var mine = readMine();
        host.textContent = '';

        if (!entries.length) {
          host.textContent = 'nothing shared yet. be the first.';
          return;
        }

        entries.forEach(function (e) {
          var line = document.createElement('div');
          line.className = 'row shared';

          var who = document.createElement('span');
          who.textContent = e.name;

          var what = document.createElement('code');
          what.textContent = e.bg + (e.opts ? '  ' + e.opts : '');

          var use = document.createElement('button');
          use.type = 'button';
          use.textContent = 'load';
          use.addEventListener('click', function () {
            var opts = {};
            (e.opts || '').split(/\s+/).forEach(function (pair) {
              var i = pair.indexOf('=');
              if (i > 0) opts[pair.slice(0, i)] = pair.slice(i + 1);
            });
            var cfg = { bg: e.bg, chars: e.chars || '', opts: opts };
            if (window.Backdrop) window.Backdrop.save(cfg);
            if (onLoad) onLoad(cfg);
          });

          line.appendChild(who);
          line.appendChild(what);
          line.appendChild(use);

          /* Only what this browser posted can be withdrawn, and only this
           * browser knows which those are. */
          if (mine[e.id]) {
            var del = document.createElement('button');
            del.type = 'button';
            del.textContent = 'delete';
            del.title = 'you posted this one';
            del.addEventListener('click', function () {
              del.disabled = true;
              unshare(e.id, function (ok) {
                if (ok) draw();
                else { del.disabled = false; del.textContent = 'failed'; }
              });
            });
            line.appendChild(del);
          }

          host.appendChild(line);
        });
      });
    }

    draw();
    return draw;
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

    /* Put one of the site's own pictures into a slot, so there is something
     * to point the picture programs at without hunting for a file. */
    samples: SAMPLES,
    putSample: function (n, url, cb) {
      fetchBlob(url, function (blob) {
        if (!blob) { cb(false, 'could not fetch it'); return; }
        putImage(n + 1, blob, function (ok) {
          if (ok && cache.slot === String(n + 1)) forget();
          cb(ok, ok ? null : 'could not store');
        });
      });
    },

    layer: layer,
    preload: preload,
    gallery: gallery,
    galleryUI: galleryUI,
    share: share,
    unshare: unshare,
    optsLine: optsLine
  };
})();
