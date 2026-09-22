/* bgconfig.js — a small, stateless set of knobs.
 * Changes live only on this page. The link carries them elsewhere. */
(function () {
  'use strict';
  var T = window.Textmode, B = window.Backdrop;
  var form = document.getElementById('bg-form');
  if (!T || !B || !form) return;
  var cfg = B.config();
  var status = document.getElementById('bg-status');
  var link;

  function row(name, control) {
    var label = document.createElement('label');
    label.textContent = name;
    form.appendChild(label);
    form.appendChild(control);
  }

  function encodeOpts(opts) {
    return Object.keys(opts).filter(function (key) {
      return opts[key] !== '' && opts[key] !== undefined;
    }).map(function (key) {
      return key + '=' + String(opts[key]).replace(/[\s;=]+/g, '');
    }).join(' ');
  }

  function url() {
    var out = new URL('/b/background', location.origin);
    if (cfg.bg && cfg.bg !== 'none') out.searchParams.set('bg', cfg.bg);
    if (cfg.chars) out.searchParams.set('bgchars', cfg.chars);
    var opts = encodeOpts(cfg.opts);
    if (opts) out.searchParams.set('bgopts', opts);
    return out.href;
  }

  function header() {
    var lines = ['bg       ' + (cfg.bg || 'none')];
    if (cfg.chars) lines.push('bgchars  ' + cfg.chars);
    var opts = encodeOpts(cfg.opts);
    if (opts) lines.push('bgopts   ' + opts);
    return lines.join('\n');
  }

  function apply() {
    B.show(cfg);
    link.value = url();
    var output = document.getElementById('bg-header');
    if (output) output.textContent = header();
  }

  var program = document.createElement('select');
  var none = document.createElement('option');
  none.value = 'none'; none.textContent = 'none';
  program.appendChild(none);
  Object.keys(T.programs).forEach(function (name) {
    var option = document.createElement('option');
    option.value = name;
    option.textContent = name + ' — ' + (T.programs[name].desc || '');
    program.appendChild(option);
  });
  program.value = T.programs[cfg.bg] ? cfg.bg : 'none';
  program.addEventListener('change', function () { cfg.bg = program.value; apply(); });
  row('field', program);

  function slider(key, name, min, max, step, fallback) {
    var wrap = document.createElement('div');
    wrap.className = 'row';
    var input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = cfg.opts[key] === undefined ? fallback : cfg.opts[key];
    var value = document.createElement('output');
    value.textContent = input.value;
    input.addEventListener('input', function () {
      cfg.opts[key] = input.value;
      value.textContent = input.value;
      apply();
    });
    wrap.appendChild(input); wrap.appendChild(value); row(name, wrap);
  }
  slider('speed', 'speed', 0, 4, 0.1, 1);
  slider('scale', 'scale', 0.2, 4, 0.1, 1);
  slider('fade', 'presence', 0.05, 0.8, 0.05, 0.35);

  var chars = document.createElement('input');
  chars.type = 'text'; chars.value = cfg.chars;
  chars.placeholder = 'blank lets the program choose'; chars.maxLength = 128;
  chars.spellcheck = false;
  chars.addEventListener('input', function () { cfg.chars = chars.value; apply(); });
  row('characters', chars);

  link = document.createElement('input');
  link.type = 'text'; link.readOnly = true;
  link.addEventListener('focus', function () { link.select(); });
  row('share', link);

  var actions = document.createElement('div');
  actions.className = 'full row';
  function copyButton(text, getValue) {
    var button = document.createElement('button');
    button.type = 'button'; button.textContent = text;
    button.addEventListener('click', function () {
      var value = getValue();
      function done(ok) { status.textContent = ok === false ? 'copy failed; select it above.' : 'copied.'; }
      function fallback() {
        var area = document.createElement('textarea');
        area.value = value; document.body.appendChild(area); area.select();
        var ok = document.execCommand('copy'); area.remove(); done(ok);
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(done, fallback);
      } else fallback();
    });
    actions.appendChild(button);
  }
  copyButton('copy link', url);
  copyButton('copy block header', header);
  form.appendChild(actions);
  form.addEventListener('submit', function (event) { event.preventDefault(); });
  apply();
})();
