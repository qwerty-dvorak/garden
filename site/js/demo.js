/* demo.js — one background, on a page with nothing else on it.
 *
 * Where a shared background goes to be looked at. The query string already
 * beats everything else in backdrop.js's precedence, so this page needs no
 * state of its own: the link *is* the background, and this file only puts
 * the controls under it.
 *
 * Nothing here is stored unless the reader presses `use`. Following a link
 * to somebody else's background should not change yours.
 */
(function () {
  'use strict';

  var S = window.BgSlots, B = window.Backdrop;
  var host = document.getElementById('demo');
  if (!S || !B || !host) return;

  var cfg = S.fromQuery();
  var what = document.getElementById('demo-what');

  function row(label, node) {
    var l = document.createElement('label');
    l.textContent = label;
    host.appendChild(l);
    host.appendChild(node);
    return node;
  }

  var msg = document.createElement('p');
  msg.className = 'stage full';
  function say(s) { msg.textContent = s; }

  if (!cfg.bg || cfg.bg === 'none') {
    what.textContent = 'This link carries no background. ' +
      'Pick one on the playground, or turn the knobs.';
    var back = document.createElement('div');
    back.className = 'row full';
    ['/b/ascii', '/b/background'].forEach(function (href) {
      var a = document.createElement('a');
      a.className = 'btn';
      a.href = href;
      a.textContent = href === '/b/ascii' ? 'the playground' : 'the knobs';
      back.appendChild(a);
    });
    host.appendChild(back);
    return;
  }

  what.textContent = 'This is ' + cfg.bg +
    (S.optsLine(cfg) ? ', set to ' + S.optsLine(cfg) : '') +
    '. It is running behind this page and nowhere else — nothing has been ' +
    'saved to your machine.';

  /* --- what to do with it ------------------------------------------------ */

  var actions = document.createElement('div');
  actions.className = 'row full';

  var use = document.createElement('button');
  use.type = 'button';
  use.textContent = 'use it everywhere';
  use.addEventListener('click', function () {
    B.save(cfg);
    say('saved. it is the background of every page here now, until you ' +
        'change it on the knobs page.');
  });

  var link = document.createElement('button');
  link.type = 'button';
  link.textContent = 'copy the link';
  link.addEventListener('click', function () {
    S.copyText(S.permalink(cfg), field, function (ok) {
      say(ok ? 'link copied.' : 'copy did not work — the link is selected, press copy.');
    });
  });

  var head = document.createElement('button');
  head.type = 'button';
  head.textContent = 'copy as block header';
  head.addEventListener('click', function () {
    var text = S.headerLines(cfg);
    pre.textContent = text;
    S.copyText(text, null, function (ok) {
      say(ok ? 'header copied — paste it above the --- in a block.'
             : 'copy did not work. the header is shown below; select it.');
    });
  });

  actions.appendChild(use);
  actions.appendChild(link);
  actions.appendChild(head);
  row('this one', actions);

  /* --- the link itself, always visible ----------------------------------- */

  var field = document.createElement('input');
  field.type = 'text';
  field.readOnly = true;
  field.value = S.permalink(cfg);
  field.addEventListener('focus', function () { field.select(); });
  row('link', field);

  var pre = document.createElement('pre');
  pre.className = 'verse full';
  pre.textContent = S.headerLines(cfg);
  host.appendChild(pre);

  /* --- share it onward --------------------------------------------------- */

  var name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'call it something';
  name.setAttribute('spellcheck', 'false');

  var send = document.createElement('button');
  send.type = 'button';
  send.textContent = 'add to the gallery';
  send.addEventListener('click', function () {
    send.disabled = true;
    S.share(name.value, cfg, function (ok, data, status) {
      send.disabled = false;
      say(ok ? 'shared. it is yours to delete, from the playground.'
             : status === 429 ? 'too many just now — wait a minute.'
             : status === 400 ? 'the server would not take that one.'
             : 'could not share.');
    });
  });

  var shareRow = document.createElement('div');
  shareRow.className = 'row full';
  shareRow.appendChild(name);
  shareRow.appendChild(send);
  row('share it', shareRow);

  var nav = document.createElement('div');
  nav.className = 'row full';
  [['/b/ascii', 'what other people left'],
   ['/b/background', 'turn the knobs'],
   ['/b/upload', 'pictures']].forEach(function (p) {
    var a = document.createElement('a');
    a.className = 'btn';
    a.href = p[0];
    a.textContent = p[1];
    nav.appendChild(a);
  });
  host.appendChild(nav);
  host.appendChild(msg);
})();
