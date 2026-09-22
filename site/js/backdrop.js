/* backdrop.js — put one character field behind a page.
 *
 * A block may choose a field with bg/bgchars/bgopts. A URL may override it:
 *   ?bg=plasma&bgchars=.-+#&bgopts=speed=0.7 fade=0.35
 * The URL is the sharing system. Nothing is saved or posted anywhere.
 */
(function () {
  'use strict';
  var T = window.Textmode;
  if (!T) return;
  var running = null;

  function parseOpts(value) {
    var out = {};
    String(value || '').slice(0, 512).split(/[\s;]+/).forEach(function (pair) {
      var at = pair.indexOf('=');
      if (at > 0) out[pair.slice(0, at).toLowerCase()] = pair.slice(at + 1);
    });
    return out;
  }

  function number(value, fallback, low, high) {
    var n = parseFloat(value);
    if (!isFinite(n)) return fallback;
    return Math.max(low, Math.min(high, n));
  }

  function config() {
    var data = document.body.dataset;
    var cfg = { bg: data.bg || '', chars: data.bgchars || '', opts: parseOpts(data.bgopts) };
    var query = new URLSearchParams(location.search);
    if (query.has('bg')) cfg.bg = query.get('bg');
    if (query.has('bgchars')) cfg.chars = query.get('bgchars').slice(0, 128);
    if (query.has('bgopts')) cfg.opts = parseOpts(query.get('bgopts'));
    return cfg;
  }

  function clean(cfg) {
    cfg = cfg || {};
    return {
      bg: /^[\w-]+$/.test(cfg.bg || '') ? cfg.bg : '',
      chars: String(cfg.chars || '').slice(0, 128),
      opts: cfg.opts || {}
    };
  }

  function stop() {
    if (!running) return;
    running.handle.stop();
    running.element.remove();
    running = null;
  }

  function show(next) {
    stop();
    var cfg = clean(next || config());
    if (!cfg.bg || cfg.bg === 'none' || !T.programs[cfg.bg]) return cfg;
    var field = document.createElement('pre');
    field.className = 'bg-field';
    field.setAttribute('aria-hidden', 'true');
    field.style.fontSize = number(cfg.opts.size, 10, 5, 24) + 'px';
    field.style.opacity = number(cfg.opts.fade, 0.35, 0, 1);
    document.body.insertBefore(field, document.body.firstChild);
    if (getComputedStyle(field).position !== 'fixed') {
      field.remove();
      return cfg;
    }
    var opts = {
      chars: cfg.chars || undefined,
      fps: number(cfg.opts.fps, 24, 1, 60),
      speed: number(cfg.opts.speed, 1, 0, 4),
      scale: number(cfg.opts.scale, 1, 0.2, 4),
      seed: String(cfg.opts.seed || '').slice(0, 64),
      word: String(cfg.opts.word || '').slice(0, 24),
      rd: cfg.opts.rd
    };
    running = { element: field, handle: T.run(field, T.programs[cfg.bg], opts) };
    return cfg;
  }

  window.Backdrop = { config: config, parseOpts: parseOpts, show: show, stop: stop };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { show(); });
  } else show();
})();
