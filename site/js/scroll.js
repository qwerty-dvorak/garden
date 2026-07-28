/* scroll.js — inverts or rotates the scroll axis for pages that ask for it.
   Loaded only when a block sets `scroll  reverse` or `scroll  horizontal`.
   Both bail out under prefers-reduced-motion: messing with someone's scroll
   is exactly the kind of thing that setting exists to stop. */
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var b = document.body;

  if (b.classList.contains('scroll-reverse')) {
    addEventListener('wheel', function (e) {
      if (e.ctrlKey) return;              // leave zoom alone
      e.preventDefault();
      scrollBy({ top: -e.deltaY, behavior: 'instant' });
    }, { passive: false });
    addEventListener('keydown', function (e) {
      var d = { ArrowDown: -1, ArrowUp: 1, PageDown: -1, PageUp: 1 }[e.key];
      if (!d) return;
      e.preventDefault();
      scrollBy({ top: d * (e.key.indexOf('Page') === 0 ? innerHeight * 0.9 : 60) });
    });
  }

  if (b.classList.contains('scroll-horizontal')) {
    addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.deltaY === 0) return;
      e.preventDefault();
      scrollBy({ left: e.deltaY, behavior: 'instant' });
    }, { passive: false });
  }
})();
