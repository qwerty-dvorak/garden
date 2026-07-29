/* bgconfig.js — the knobs, with the field itself as the preview.
 *
 * There is no preview pane. The control panel edits the actual page
 * background, live, and saves to localStorage, so what you are looking at
 * while you drag a slider is the thing you are configuring. Every change
 * rebuilds the backdrop, which is cheap: the old runners are stopped and two
 * <pre>s are replaced.
 *
 * The page ships an empty <form id="bg-form">. Everything below is built from
 * Textmode.programs and Backdrop.sources, so this file does not need to know
 * what programs exist.
 */
(function () {
  'use strict';

  var T = window.Textmode, B = window.Backdrop;
  var form = document.getElementById('bg-form');
  if (!T || !B || !form) return;

  var cfg = B.config();
  var o = cfg.opts;

  function row(label, node) {
    var l = document.createElement('label');
    l.textContent = label;
    form.appendChild(l);
    form.appendChild(node);
    return node;
  }

  function apply() {
    B.save({ bg: cfg.bg, chars: cfg.chars, opts: cfg.opts });
    link.value = permalink();
  }

  /* --- program ---------------------------------------------------------- */
  var sel = document.createElement('select');
  var off = document.createElement('option');
  off.value = 'none'; off.textContent = 'none — no background';
  sel.appendChild(off);
  Object.keys(T.programs).forEach(function (n) {
    var opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n + ' — ' + (T.programs[n].desc || '');
    sel.appendChild(opt);
  });
  /* `image` is the one option here that is not a program. It shows a picture
   * as a picture — a CSS layer, not a grid of glyphs — so it never registers
   * itself on Textmode.programs and has to be named explicitly. `ascii` and
   * `mask` are real programs and arrive with the loop above. */
  if (window.BgSlots) {
    var iopt = document.createElement('option');
    iopt.value = 'image';
    iopt.textContent = 'image — a picture from a slot, as itself';
    sel.appendChild(iopt);
  }

  sel.value = (cfg.bg === 'image' || (cfg.bg && T.programs[cfg.bg])) ? cfg.bg : 'none';
  sel.addEventListener('change', function () { cfg.bg = sel.value; apply(); });
  row('program', sel);

  /* --- charset ---------------------------------------------------------- */
  var charsWrap = document.createElement('div');
  charsWrap.className = 'row';
  var ramp = document.createElement('select');
  var dflt = document.createElement('option');
  dflt.value = ''; dflt.textContent = "the program's own";
  ramp.appendChild(dflt);
  Object.keys(T.ramps).forEach(function (n) {
    var opt = document.createElement('option');
    opt.value = T.ramps[n];
    opt.textContent = n;
    ramp.appendChild(opt);
  });
  var chars = document.createElement('input');
  chars.type = 'text';
  chars.value = cfg.chars || '';
  chars.placeholder = 'or type a ramp: dark to light';
  chars.setAttribute('spellcheck', 'false');
  ramp.addEventListener('change', function () {
    chars.value = ramp.value;
    cfg.chars = ramp.value;
    apply();
  });
  chars.addEventListener('input', function () { cfg.chars = chars.value; apply(); });
  charsWrap.appendChild(ramp);
  charsWrap.appendChild(chars);
  row('charset', charsWrap);

  /* --- the numeric dials ------------------------------------------------ */
  function slider(key, label, lo, hi, stepv, dflt, fmt) {
    var wrap = document.createElement('div');
    wrap.className = 'row';
    var r = document.createElement('input');
    r.type = 'range';
    r.min = lo; r.max = hi; r.step = stepv;
    r.value = o[key] !== undefined ? o[key] : dflt;
    var out = document.createElement('output');
    out.textContent = (fmt || String)(r.value);
    r.addEventListener('input', function () {
      o[key] = r.value;
      out.textContent = (fmt || String)(r.value);
      apply();
    });
    wrap.appendChild(r);
    wrap.appendChild(out);
    row(label, wrap);
  }

  slider('fps',   'frame rate', 1, 60, 1, 30, function (v) { return v + ' fps'; });
  slider('speed', 'speed',      0, 4, 0.05, 1);
  slider('scale', 'scale',      0.2, 4, 0.05, 1);
  slider('size',  'cell size',  4, 24, 1, 10, function (v) { return v + ' px'; });
  slider('fade',  'contrast',   0.05, 1, 0.05, 1);

  /* --- program-specific ---------------------------------------------------
     One knob so far. It belongs here rather than in the program because the
     whole point of reaction–diffusion is that these two numbers decide the
     image, and a claim like that should be something you can turn. */
  var rd = document.createElement('select');
  Object.keys(T.programs.rd.regimes).forEach(function (n) {
    var opt = document.createElement('option');
    var c = T.programs.rd.regimes[n];
    opt.value = n;
    opt.textContent = n + '  (feed ' + c[0] + ', kill ' + c[1] + ')';
    rd.appendChild(opt);
  });
  rd.value = o.rd || 'worms';
  rd.addEventListener('change', function () { o.rd = rd.value; apply(); });
  row('rd regime', rd);

  /* --- floating content -------------------------------------------------- */
  var drift = document.createElement('select');
  [['nav', 'nav and backlinks'], ['body', 'links in the article'],
   ['all', 'everything on the page'], ['none', 'nothing']].forEach(function (p) {
    var opt = document.createElement('option');
    opt.value = p[0]; opt.textContent = p[1];
    drift.appendChild(opt);
  });
  drift.value = o.drift || 'nav';
  drift.addEventListener('change', function () { o.drift = drift.value; apply(); });
  row('floating', drift);

  slider('driftspeed', 'float speed', 0, 5, 0.1, 1);

  /* --- seed and word ----------------------------------------------------- */
  var seed = document.createElement('input');
  seed.type = 'text';
  seed.value = o.seed || '';
  seed.placeholder = 'blank for a new field each reload';
  seed.setAttribute('spellcheck', 'false');
  seed.addEventListener('input', function () { o.seed = seed.value; apply(); });
  row('seed', seed);

  var word = document.createElement('input');
  word.type = 'text';
  word.value = o.word || '';
  word.placeholder = 'the word warp dissolves — try three letters';
  word.setAttribute('spellcheck', 'false');
  word.addEventListener('input', function () { o.word = word.value; apply(); });
  row('word', word);

  /* --- pictures -----------------------------------------------------------
     Three of the programs read a picture instead of a formula: `image` shows
     it, `ascii` redraws it out of the charset, and `mask` uses it as a
     stencil that a word or a field is only allowed to appear inside. All
     three take the picture from a slot, so these dials are about which slot
     and how hard to read it. */

  var S = window.BgSlots;

  if (S) {
    var img = document.createElement('select');
    for (var si = 1; si <= S.SLOTS; si++) {
      var sopt = document.createElement('option');
      sopt.value = String(si);
      sopt.textContent = 'slot ' + si;
      img.appendChild(sopt);
    }
    img.value = String(parseInt(o.img, 10) >= 1 ? parseInt(o.img, 10) : 1);
    img.addEventListener('change', function () { o.img = img.value; apply(); });
    row('picture from', img);

    var fit = document.createElement('select');
    [['cover', 'cover — fill, crop the overflow'],
     ['contain', 'contain — fit, leave the gaps'],
     ['tile', 'tile — repeat at its own size']].forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p[0]; opt.textContent = p[1];
      fit.appendChild(opt);
    });
    fit.value = o.fit || 'cover';
    fit.addEventListener('change', function () { o.fit = fit.value; apply(); });
    row('picture fit', fit);

    slider('gain', 'ascii contrast', 0.4, 4, 0.1, 1.6);
    slider('maskthr', 'mask threshold', 0, 1, 0.02, 0.45);
    slider('maskspeed', 'mask speed', 0, 4, 0.1, 1);

    var mtext = document.createElement('input');
    mtext.type = 'text';
    mtext.value = o.masktext || '';
    mtext.placeholder = 'one word — no spaces. blank for a field';
    mtext.setAttribute('spellcheck', 'false');
    /* `bgopts` is one line of space-separated k=v pairs, so a value with a
     * space in it does not survive its own permalink, its own block header,
     * or the gallery. `word` has the same constraint and answers it the same
     * way. Stripping here rather than at read time means what you see in the
     * box is what actually travels. */
    mtext.addEventListener('input', function () {
      var clean = mtext.value.replace(/\s+/g, '');
      if (clean !== mtext.value) {
        var at = mtext.selectionStart;
        mtext.value = clean;
        try { mtext.setSelectionRange(at - 1, at - 1); } catch (e) { /* ok */ }
      }
      o.masktext = clean;
      apply();
    });
    row('mask text', mtext);

    var flags = document.createElement('div');
    flags.className = 'row';
    [['maskinv', 'invert'], ['masksoft', 'soft edges']].forEach(function (p) {
      var lab = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = o[p[0]] === '1';
      cb.addEventListener('change', function () {
        o[p[0]] = cb.checked ? '1' : '';
        apply();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + p[1]));
      flags.appendChild(lab);
    });
    row('mask', flags);
  }

  /* --- the five slots -----------------------------------------------------
     A slot is a name, a set of dials, and sometimes a picture. The dials go
     in localStorage next to the live config; the picture goes in IndexedDB,
     because one photograph as a data URI is most of localStorage's budget.

     Neither ever leaves the machine. That is the whole reason the slots are
     client-side, and it is also why the gallery below can only carry dials —
     a shared link to `ascii` renders whatever is in *your* slot, which is
     either a happy accident or nothing at all. */

  if (S) {
    var slotsWrap = document.createElement('div');
    slotsWrap.className = 'full slots';

    var drawSlots = function () {
      var list = S.read();
      slotsWrap.textContent = '';

      list.forEach(function (slot, n) {
        var line = document.createElement('div');
        line.className = 'row slot';

        var nm = document.createElement('input');
        nm.type = 'text';
        nm.value = slot ? slot.name : '';
        nm.placeholder = 'slot ' + (n + 1) + ' — empty';
        nm.setAttribute('spellcheck', 'false');

        var save = document.createElement('button');
        save.type = 'button';
        save.textContent = 'save here';
        save.title = 'put the background you are looking at into this slot';
        save.addEventListener('click', function () {
          S.save(n, nm.value || ('slot ' + (n + 1)), cfg);
          drawSlots();
        });

        var load = document.createElement('button');
        load.type = 'button';
        load.textContent = 'load';
        load.disabled = !slot;
        load.addEventListener('click', function () {
          if (!slot) return;
          B.save(slot.config);
          location.reload();      /* the panel is built from the config */
        });

        var pick = document.createElement('input');
        pick.type = 'file';
        pick.accept = 'image/*';
        pick.addEventListener('change', function () {
          var f = pick.files && pick.files[0];
          if (!f) return;
          S.put(n, f, function (ok, why) {
            note.textContent = ok
              ? 'picture stored in slot ' + (n + 1) + '. set "picture from" to it.'
              : 'could not store: ' + why;
            if (ok) { o.img = String(n + 1); apply(); }
          });
        });

        var drop = document.createElement('button');
        drop.type = 'button';
        drop.textContent = 'clear';
        drop.addEventListener('click', function () {
          S.clear(n, function () { drawSlots(); });
          note.textContent = 'slot ' + (n + 1) + ' cleared, picture and all.';
        });

        line.appendChild(nm);
        line.appendChild(save);
        line.appendChild(load);
        line.appendChild(pick);
        line.appendChild(drop);
        slotsWrap.appendChild(line);
      });
    };

    var note = document.createElement('p');
    note.className = 'stage full';

    row('slots', slotsWrap);
    form.appendChild(note);
    drawSlots();
  }

  /* --- the gallery --------------------------------------------------------
     Backgrounds other people have shared. Dials only: the server takes a
     program name, a charset and one line of k=v pairs, rebuilds them field by
     field against a whitelist, and stores the result in a text file. Nothing
     submitted is executed, nothing submitted is a path, and no picture is
     accepted at all. */

  if (S) {
    var galleryWrap = document.createElement('div');
    galleryWrap.className = 'full gallery';

    /* The list itself is built by bgslots, so this page and /b/ascii cannot
     * drift apart. Loading one here reloads, because the whole panel is
     * built from the config it just replaced. */
    var showGallery = S.galleryUI(galleryWrap, function () { location.reload(); });

    var shareRow = document.createElement('div');
    shareRow.className = 'full row';

    var shareName = document.createElement('input');
    shareName.type = 'text';
    shareName.placeholder = 'call it something';
    shareName.setAttribute('spellcheck', 'false');

    var shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.textContent = 'share this background';
    shareBtn.addEventListener('click', function () {
      S.share(shareName.value, cfg, function (ok, data, status) {
        shareStatus.textContent = ok
          ? 'shared.'
          : status === 429 ? 'too many just now — wait a minute.'
          : status === 400 ? 'the server would not take that one.'
          : 'could not share.';
        if (ok) showGallery();
      });
    });

    var shareStatus = document.createElement('span');
    shareStatus.className = 'stage';

    shareRow.appendChild(shareName);
    shareRow.appendChild(shareBtn);
    shareRow.appendChild(shareStatus);

    row('shared', galleryWrap);
    form.appendChild(shareRow);
    showGallery();
  }

  /* --- permalink and reset ------------------------------------------------ */
  function permalink() {
    var parts = [];
    for (var k in o) if (o[k] !== '' && o[k] !== undefined) parts.push(k + '=' + o[k]);
    var q = '?bg=' + encodeURIComponent(cfg.bg || 'none');
    if (cfg.chars) q += '&bgchars=' + encodeURIComponent(cfg.chars);
    if (parts.length) q += '&bgopts=' + encodeURIComponent(parts.join(' '));
    return location.origin + '/' + q;
  }

  var link = document.createElement('input');
  link.type = 'text';
  link.readOnly = true;
  link.value = permalink();
  link.addEventListener('focus', function () { link.select(); });
  row('link', link);

  var buttons = document.createElement('div');
  buttons.className = 'full row';
  var reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'forget my settings';
  reset.addEventListener('click', function () {
    B.reset();
    location.reload();
  });
  var header = document.createElement('button');
  header.type = 'button';
  header.textContent = 'copy as block header';
  header.addEventListener('click', function () {
    var parts = [];
    for (var k in o) if (o[k] !== '' && o[k] !== undefined) parts.push(k + '=' + o[k]);
    var lines = ['bg      ' + (cfg.bg || 'none')];
    if (cfg.chars) lines.push('bgchars ' + cfg.chars);
    if (parts.length) lines.push('bgopts  ' + parts.join(' '));
    var out = lines.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(out);
    var pre = document.getElementById('bg-header');
    if (pre) pre.textContent = out;
  });
  buttons.appendChild(header);
  buttons.appendChild(reset);
  form.appendChild(buttons);

  form.addEventListener('submit', function (e) { e.preventDefault(); });

  /* show the header form for the current settings straight away */
  var pre = document.getElementById('bg-header');
  if (pre) header.click();
})();
