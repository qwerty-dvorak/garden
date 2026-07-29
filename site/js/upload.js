/* upload.js — a picture, and the three things that can be done to it.
 *
 * This page used to carry a five-slot grid, which was the same grid the
 * knobs page already had and twice the machinery for choosing between
 * pictures nobody had put there yet. The slots still exist and still live on
 * /b/background; here there is one picture, and buttons that show you what
 * the programs make of it.
 *
 * Nothing is uploaded. The word is kept because it is the word people look
 * for. A file chosen here is read into a blob and written to IndexedDB on
 * this machine; the server has no route that would accept one.
 */
(function () {
  'use strict';

  var S = window.BgSlots;
  var host = document.getElementById('upload');
  if (!S || !host) return;

  var SLOT = 0;                    /* this page only ever uses the first */

  var msg = document.createElement('p');
  msg.className = 'stage full';
  function say(s) { msg.textContent = s; }

  function row(label, node) {
    var l = document.createElement('label');
    l.textContent = label;
    host.appendChild(l);
    host.appendChild(node);
  }

  /* --- which picture ------------------------------------------------------ */

  var pick = document.createElement('div');
  pick.className = 'row';

  S.samples.forEach(function (s) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.name;
    b.addEventListener('click', function () {
      S.putSample(SLOT, s.url, function (ok, why) {
        say(ok ? s.name + ' it is. now press one of the three below.'
               : 'could not load it: ' + why + '.');
        if (ok) show();
      });
    });
    pick.appendChild(b);
  });

  var file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/*';
  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (!f) return;
    S.put(SLOT, f, function (ok, why) {
      say(ok ? f.name + ' is on this machine and nowhere else. ' +
               'now press one of the three below.'
             : 'could not store it: ' + why + '.');
      if (ok) show();
    });
  });
  pick.appendChild(file);

  row('a picture', pick);

  /* --- what to do with it -------------------------------------------------
     Each of these is a link to the demo page, which is a page with nothing
     on it but the background — because a background shown behind an essay
     is a background you cannot see. */

  var TRY = [
    ['image', 'as itself'],
    ['ascii', 'as characters'],
    ['mask', 'as a stencil']
  ];

  var tries = document.createElement('div');
  tries.className = 'row';
  var links = {};

  TRY.forEach(function (t) {
    var a = document.createElement('a');
    a.className = 'btn';
    a.textContent = t[0] + ' — ' + t[1];
    links[t[0]] = a;
    tries.appendChild(a);
  });

  function show() {
    TRY.forEach(function (t) {
      var opts = { img: String(SLOT + 1), fade: '0.9' };
      if (t[0] === 'mask') { opts.masktext = 'garden'; opts.maskthr = '0.45'; }
      if (t[0] === 'ascii') opts.gain = '1.8';
      links[t[0]].href = S.demoUrl({ bg: t[0], chars: '', opts: opts });
    });
  }
  show();

  row('see it', tries);

  var thumb = document.createElement('span');
  thumb.className = 'stage';
  S.has(SLOT, function (had) {
    thumb.textContent = had
      ? 'using your picture.'
      : 'nothing chosen yet — the programs fall back to the sphere.';
  });
  row('right now', thumb);

  host.appendChild(msg);
})();
