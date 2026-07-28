/* wasm.js — the only glue.
 *
 * A block sets `wasm  name` in its header. That emits <div class="wasm"
 * data-wasm="name">, and this file instantiates /wasm/name.wasm and hands it
 * to the matching handler below. No bundler, no imports, no dependencies.
 *
 * Reading C memory: exported functions return pointers into the module's
 * linear memory, which is just an ArrayBuffer on this side. A char* becomes a
 * Uint8Array view at that offset. Nothing is copied unless we ask for it.
 */
(function () {
  var dec = new TextDecoder();

  function cstr(mem, ptr, len) {
    return dec.decode(new Uint8Array(mem.buffer, ptr, len));
  }

  var handlers = {};

  // ---- ascii: mandelbrot, drawn in text -------------------------------
  handlers.ascii = function (x, el, mem) {
    var pre = document.createElement('pre');
    pre.className = 'ascii';
    el.appendChild(pre);

    var bar = document.createElement('p');
    bar.className = 'stage';
    el.appendChild(bar);

    var t = 0, running = false, raf = 0;
    var still = matchMedia('(prefers-reduced-motion: reduce)').matches;

    function draw() {
      x.render(t);
      pre.textContent = cstr(mem, x.buffer(), x.buflen());
      bar.textContent = 'zoom ' + t.toFixed(0) + '  ·  ' +
        x.cols() + '×' + x.rows() + '  ·  ' + 'press space to ' +
        (running ? 'pause' : 'run') + ', r to reset';
    }
    function loop() {
      if (!running) return;
      t += 0.25;
      if (t > 120) t = 0;
      draw();
      raf = requestAnimationFrame(loop);
    }
    function toggle(on) {
      running = on;
      cancelAnimationFrame(raf);
      if (running) loop(); else draw();
    }

    draw();
    // never animate off-screen, and never animate at all if asked not to
    new IntersectionObserver(function (es) {
      if (still) return;
      toggle(es[0].isIntersecting && running);
    }).observe(el);

    el.tabIndex = 0;
    el.addEventListener('keydown', function (e) {
      if (e.key === ' ') { e.preventDefault(); toggle(!running); }
      if (e.key === 'r') { t = 0; draw(); }
    });
  };

  // ---- life: conway, in text ------------------------------------------
  handlers.life = function (x, el, mem) {
    var pre = document.createElement('pre');
    pre.className = 'ascii';
    el.appendChild(pre);
    var bar = document.createElement('p');
    bar.className = 'stage';
    el.appendChild(bar);

    var still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    var running = false, gen = 0, timer = 0;

    x.init(0, 28);

    function draw() {
      x.render();
      pre.textContent = cstr(mem, x.buffer(), x.buflen());
      bar.textContent = 'generation ' + gen + '  ·  population ' + x.population() +
        '  ·  space to ' + (running ? 'pause' : 'run') + ', n to step, r to reseed';
    }
    function tick() { x.step(); gen++; draw(); }
    function toggle(on) {
      running = on;
      clearInterval(timer);
      if (running) timer = setInterval(tick, 90); else draw();
    }

    draw();
    new IntersectionObserver(function (es) {
      if (still) return;
      if (!es[0].isIntersecting) toggle(false);
    }).observe(el);

    el.tabIndex = 0;
    el.addEventListener('keydown', function (e) {
      if (e.key === ' ') { e.preventDefault(); toggle(!running); }
      if (e.key === 'n') { toggle(false); tick(); }
      if (e.key === 'r') { toggle(false); gen = 0; x.init(Date.now() >>> 0, 28); draw(); }
    });
  };

  // ---- crossword: C owns the grid, the numbering and the answers ------
  handlers.crossword = function (x, el, mem) {
    x.init();
    var N = x.size(), CELLS = x.cells();
    var nums = new Int32Array(mem.buffer, x.numbers(), CELLS);
    var cur = 0, dir = 'across';

    var table = document.createElement('table');
    table.className = 'xword';
    var cellEls = [];
    for (var r = 0; r < N; r++) {
      var tr = table.insertRow();
      for (var c = 0; c < N; c++) {
        var i = r * N + c;
        var td = tr.insertCell();
        td.dataset.i = i;
        if (nums[i]) { var s = document.createElement('b'); s.textContent = nums[i]; td.appendChild(s); }
        var span = document.createElement('span');
        td.appendChild(span);
        cellEls.push({ td: td, span: span });
      }
    }
    el.appendChild(table);

    var bar = document.createElement('p');
    bar.className = 'stage';
    el.appendChild(bar);

    function paint(showVerdict) {
      for (var i = 0; i < CELLS; i++) {
        var ch = x.get(i);
        cellEls[i].span.textContent = ch ? String.fromCharCode(ch) : '';
        cellEls[i].td.classList.toggle('cur', i === cur);
        cellEls[i].td.classList.remove('right', 'wrong');
        if (showVerdict) {
          var v = x.verdict(i);
          if (v === 1) cellEls[i].td.classList.add('right');
          if (v === 2) cellEls[i].td.classList.add('wrong');
        }
      }
      bar.textContent = x.filled() + '/' + CELLS + ' filled  ·  ' + dir +
        '  ·  arrows move, tab flips direction, ? checks, ! reveals a letter' +
        (x.solved() ? '  ·  solved.' : '');
      el.classList.toggle('solved', !!x.solved());
    }

    function move(d) {
      var r = Math.floor(cur / N), c = cur % N;
      if (d === 'l') c = (c + N - 1) % N;
      if (d === 'r') c = (c + 1) % N;
      if (d === 'u') r = (r + N - 1) % N;
      if (d === 'd') r = (r + 1) % N;
      cur = r * N + c;
    }
    function advance() { move(dir === 'across' ? 'r' : 'd'); }

    table.tabIndex = 0;
    table.addEventListener('click', function (e) {
      var td = e.target.closest('td');
      if (td) { cur = +td.dataset.i; paint(false); table.focus(); }
    });
    table.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'Tab')       { e.preventDefault(); dir = dir === 'across' ? 'down' : 'across'; }
      else if (k === 'ArrowLeft')  { e.preventDefault(); move('l'); }
      else if (k === 'ArrowRight') { e.preventDefault(); move('r'); }
      else if (k === 'ArrowUp')    { e.preventDefault(); move('u'); }
      else if (k === 'ArrowDown')  { e.preventDefault(); move('d'); }
      else if (k === 'Backspace')  { e.preventDefault(); x.set(cur, 0); move(dir === 'across' ? 'l' : 'u'); }
      else if (k === '?')          { paint(true); return; }
      else if (k === '!')          { x.reveal(cur); advance(); }
      else if (/^[a-zA-Z]$/.test(k)) { x.set(cur, k.charCodeAt(0)); advance(); }
      else return;
      paint(false);
    });

    paint(false);
  };

  // ---- loader ---------------------------------------------------------
  document.querySelectorAll('.wasm[data-wasm]').forEach(function (el) {
    var name = el.dataset.wasm;
    var fn = handlers[name];
    if (!fn) return;
    WebAssembly.instantiateStreaming(fetch('/wasm/' + name + '.wasm'), {})
      .then(function (res) {
        var x = res.instance.exports;
        fn(x, el, x.memory);
      })
      .catch(function (err) {
        el.textContent = 'wasm failed: ' + err;
        el.className = 'wasm stage';
      });
  });
})();
