/* upload.js — putting a picture into one of the five slots.
 *
 * "Upload" is the wrong word and is kept because it is the word people look
 * for. Nothing leaves the machine: the file is read into a blob, written to
 * IndexedDB, and decoded in this tab. There is no route on the server that
 * would accept a picture.
 *
 * The page ships an empty <div id="upload">; everything below is built from
 * BgSlots, so the number of slots and the list of samples live in one place.
 */
(function () {
  'use strict';

  var S = window.BgSlots;
  var host = document.getElementById('upload');
  if (!S || !host) return;

  var note = document.createElement('p');
  note.className = 'stage full';

  function say(s) { note.textContent = s; }

  function row(label, node) {
    var l = document.createElement('label');
    l.textContent = label;
    host.appendChild(l);
    host.appendChild(node);
  }

  function draw() {
    host.textContent = '';

    var slots = S.read();

    for (var n = 0; n < S.SLOTS; n++) {
      (function (n) {
        var line = document.createElement('div');
        line.className = 'row slot';

        var pick = document.createElement('input');
        pick.type = 'file';
        pick.accept = 'image/*';
        pick.addEventListener('change', function () {
          var f = pick.files && pick.files[0];
          if (!f) return;
          S.put(n, f, function (ok, why) {
            say(ok ? 'slot ' + (n + 1) + ': ' + f.name + ' stored on this machine.'
                   : 'slot ' + (n + 1) + ': ' + why + '.');
            if (ok) use(n);
          });
        });
        line.appendChild(pick);

        S.samples.forEach(function (s) {
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = s.name;
          b.title = 'put ' + s.name + ' in slot ' + (n + 1);
          b.addEventListener('click', function () {
            S.putSample(n, s.url, function (ok, why) {
              say(ok ? 'slot ' + (n + 1) + ': ' + s.name + '.'
                     : 'slot ' + (n + 1) + ': ' + why + '.');
              if (ok) use(n);
            });
          });
          line.appendChild(b);
        });

        var drop = document.createElement('button');
        drop.type = 'button';
        drop.textContent = 'clear';
        drop.addEventListener('click', function () {
          S.clear(n, function () {
            say('slot ' + (n + 1) + ' cleared. it falls back to the sample again.');
            draw();
          });
        });
        line.appendChild(drop);

        var mark = document.createElement('span');
        mark.className = 'stage';
        S.has(n, function (had) { mark.textContent = had ? 'has a picture' : 'empty'; });
        line.appendChild(mark);

        row('slot ' + (n + 1) + (slots[n] ? ' · ' + slots[n].name : ''), line);
      })(n);
    }

    /* Seeing it is the point, so choosing a picture offers the three
     * programs that read one rather than making you go and find them. */
    var tryBar = document.createElement('div');
    tryBar.className = 'row full';
    ['image', 'ascii', 'mask'].forEach(function (name) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.addEventListener('click', function () { apply(name); });
      tryBar.appendChild(b);
    });
    var off = document.createElement('button');
    off.type = 'button';
    off.textContent = 'none';
    off.addEventListener('click', function () { apply('none'); });
    tryBar.appendChild(off);

    row('try it', tryBar);
    host.appendChild(note);
  }

  /* Point the dials at the slot that was just filled, without disturbing
   * anything else the reader has already chosen. */
  var chosen = 0;
  function use(n) { chosen = n; draw(); say('slot ' + (n + 1) + ' is ready — try it below.'); }

  function apply(name) {
    if (!window.Backdrop) return;
    var cfg = window.Backdrop.config();
    cfg.opts.img = String(chosen + 1);
    window.Backdrop.save({ bg: name, chars: cfg.chars, opts: cfg.opts });
    say(name === 'none'
      ? 'background off.'
      : name + ' is now the background of every page here, from slot ' + (chosen + 1) + '.');
  }

  draw();
})();
