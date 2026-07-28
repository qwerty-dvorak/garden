/* lens.js — drag a magnifier over the page. an interactive piece that is
   about reading rather than decorating: it enlarges the type under it.
   ~40 lines, no dependencies, removes itself under reduced-motion. */
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var lens = document.createElement('div');
  lens.className = 'lens';
  lens.textContent = '·';
  document.body.appendChild(lens);

  var on = false, x = innerWidth / 2, y = innerHeight / 2;

  function place() {
    lens.style.left = x + 'px';
    lens.style.top  = y + 'px';
    var el = document.elementFromPoint(x, y);
    document.querySelectorAll('.lit').forEach(function (n) { n.classList.remove('lit'); });
    if (on && el && el.closest('article')) {
      var p = el.closest('p, li, h1, h2, pre, blockquote');
      if (p) p.classList.add('lit');
    }
  }

  addEventListener('pointermove', function (e) { x = e.clientX; y = e.clientY; place(); });
  addEventListener('keydown', function (e) {
    if (e.key !== 'l') return;
    on = !on;
    lens.classList.toggle('on', on);
    place();
  });

  var hint = document.createElement('p');
  hint.className = 'stage lens-hint';
  hint.textContent = 'press l for the lens';
  document.querySelector('nav').after(hint);
})();
