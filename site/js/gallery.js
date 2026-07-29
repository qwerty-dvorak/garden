/* gallery.js — every registered program, running at once.
 *
 * The page ships an empty <div id="gallery">; this fills it from whatever is
 * in Textmode.programs, so adding a program to programs.js adds a panel here
 * and nowhere else needs editing.
 *
 * Each panel is its own runner on its own <pre>. They pause when scrolled off
 * screen, which is the only reason running fourteen of them is reasonable —
 * at any moment two or three are actually consuming frames.
 */
(function () {
  'use strict';

  var T = window.Textmode;
  var host = document.getElementById('gallery');
  if (!T || !host) return;

  var running = [];

  Object.keys(T.programs).forEach(function (name) {
    var p = T.programs[name];

    var fig = document.createElement('figure');
    fig.className = 'tm';
    fig.id = 'p-' + name;

    var pre = document.createElement('pre');
    pre.setAttribute('aria-hidden', 'true');
    fig.appendChild(pre);

    var cap = document.createElement('figcaption');
    cap.className = 'stage';
    var b = document.createElement('b');
    b.textContent = name;
    cap.appendChild(b);
    cap.appendChild(document.createTextNode(p.desc || ''));

    var ms = document.createElement('span');
    ms.className = 'ms';
    cap.appendChild(ms);
    fig.appendChild(cap);

    host.appendChild(fig);

    var h = T.run(pre, p, {});
    running.push({ h: h, ms: ms, name: name });
  });

  /* One timer for all of them rather than one each: the numbers are a debug
   * aid, not part of the piece, and they should cost about nothing. */
  setInterval(function () {
    for (var i = 0; i < running.length; i++) {
      var r = running[i];
      var c = r.h.ctx;
      r.ms.textContent = r.h.running
        ? c.cols + '×' + c.rows + '  ' + c.fps.toFixed(0) + 'fps'
        : 'paused';
    }
  }, 500);

  /* Clicking a panel makes it the page background, so a program can be tried
   * against real prose before it is committed to. */
  host.addEventListener('click', function (e) {
    var fig = e.target.closest('.tm');
    if (!fig || !window.Backdrop) return;
    var name = fig.id.replace(/^p-/, '');
    var cfg = window.Backdrop.config();
    window.Backdrop.save({ bg: name, chars: cfg.chars, opts: cfg.opts });
    note(name);
  });

  function note(name) {
    var el = document.getElementById('gallery-note');
    if (el) el.textContent = 'background is now ' + name +
      ' — it will stay that way on every page until you change it.';
  }
})();
