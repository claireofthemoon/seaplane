// Synth-style controls: knob, lit switch, segmented selector and stepper.
// Each factory returns { el, set(value), state(name) } and calls spec.onCommit(value)
// once per deliberate change (end of a drag, a click, or a pause after wheel/keys),
// so the keyboard isn't flooded with writes while a knob is moving.

(function (root) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var COMMIT_DELAY = 350; // ms after the last wheel/key step

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function svg(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function cell(spec) {
    var el = document.createElement('div');
    el.className = 'ctl';
    if (spec.help) el.dataset.help = spec.help;
    return el;
  }

  function caption(el, text) {
    var c = document.createElement('div');
    c.className = 'cap';
    c.textContent = text;
    el.appendChild(c);
    return c;
  }

  function stateSetter(el) {
    var timer = null;
    return function (name) {
      el.classList.remove('sending', 'saved', 'unconfirmed');
      clearTimeout(timer);
      if (!name) return;
      el.classList.add(name);
      if (name === 'saved') timer = setTimeout(function () { el.classList.remove('saved'); }, 1400);
    };
  }

  // A pending commit, flushed after a pause or immediately on demand.
  function committer(spec) {
    var timer = null, pending = null;
    return {
      later: function (v) { pending = v; clearTimeout(timer); timer = setTimeout(this.now, COMMIT_DELAY); },
      now: function () { clearTimeout(timer); if (pending !== null) { var v = pending; pending = null; spec.onCommit(v); } },
      set: function (v) { pending = v; }
    };
  }

  // ------------------------------------------------------------------ knob

  function knob(spec) {
    var el = cell(spec);
    var min = spec.min, max = spec.max, value = spec.value != null ? spec.value : spec.def;
    var fmt = spec.format || String;
    var wrap = document.createElement('div');
    wrap.className = 'knob' + (spec.small ? ' small' : '');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'slider');
    wrap.setAttribute('aria-label', spec.label);
    wrap.setAttribute('aria-valuemin', min);
    wrap.setAttribute('aria-valuemax', max);
    el.appendChild(wrap);

    var s = svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' }, wrap);
    var R = 40, C = 2 * Math.PI * R, SWEEP = 0.75;
    var ticks = svg('g', { class: 'ticks' }, s);
    for (var i = 0; i <= 10; i++) {
      var a = (135 + i * 27) * Math.PI / 180;
      svg('line', { x1: 50 + 46 * Math.cos(a), y1: 50 + 46 * Math.sin(a), x2: 50 + 49 * Math.cos(a), y2: 50 + 49 * Math.sin(a), 'stroke-width': i % 5 ? 1 : 1.6 }, ticks);
    }
    svg('circle', { class: 'track', cx: 50, cy: 50, r: R, fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round',
      'stroke-dasharray': (C * SWEEP) + ' ' + C, transform: 'rotate(135 50 50)' }, s);
    var arc = svg('circle', { class: 'arc', cx: 50, cy: 50, r: R, fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round',
      'stroke-dasharray': '0 ' + C, transform: 'rotate(135 50 50)' }, s);
    svg('circle', { class: 'cap-face', cx: 50, cy: 50, r: 29 }, s);
    var pointer = svg('line', { class: 'pointer', x1: 50, y1: 50, x2: 50, y2: 50, 'stroke-width': 3.2 }, s);

    var readout = document.createElement('div');
    readout.className = 'readout lcd';
    el.appendChild(readout);
    caption(el, spec.label);

    function draw(v) {
      var f = max === min ? 0 : (v - min) / (max - min);
      arc.setAttribute('stroke-dasharray', (Math.max(0.001, f * C * SWEEP)) + ' ' + C);
      var a = (135 + f * 270) * Math.PI / 180;
      pointer.setAttribute('x1', 50 + 12 * Math.cos(a)); pointer.setAttribute('y1', 50 + 12 * Math.sin(a));
      pointer.setAttribute('x2', 50 + 24 * Math.cos(a)); pointer.setAttribute('y2', 50 + 24 * Math.sin(a));
      readout.textContent = fmt(v);
      wrap.setAttribute('aria-valuenow', v);
      wrap.setAttribute('aria-valuetext', fmt(v));
    }

    var commit = committer(spec);
    function change(v, how) {
      v = clamp(Math.round(v), min, max);
      if (v === value) return;
      value = v;
      draw(v);
      if (how === 'later') commit.later(v); else commit.set(v);
    }

    // Drag up/down. 220px covers the whole range; hold Shift for fine control.
    var drag = null;
    wrap.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      wrap.focus();
      wrap.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, start: value, acc: 0 };
      wrap.classList.add('dragging');
      e.preventDefault();
    });
    wrap.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var px = drag.y - e.clientY;
      var range = max - min;
      var perPx = range / (e.shiftKey ? 880 : 220);
      change(drag.start + px * perPx, 'set');
    });
    function endDrag() {
      if (!drag) return;
      drag = null;
      wrap.classList.remove('dragging');
      commit.now();
    }
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);
    wrap.addEventListener('lostpointercapture', endDrag);

    wrap.addEventListener('wheel', function (e) {
      e.preventDefault();
      var step = Math.max(1, Math.round((max - min) / 64));
      change(value + (e.deltaY < 0 ? step : -step) * (e.shiftKey ? 1 / step : 1), 'later');
    }, { passive: false });

    wrap.addEventListener('keydown', function (e) {
      var big = Math.max(1, Math.round((max - min) / 10));
      var map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: big, PageDown: -big };
      if (map[e.key] != null) { change(value + map[e.key], 'later'); e.preventDefault(); }
      else if (e.key === 'Home') { change(min, 'later'); e.preventDefault(); }
      else if (e.key === 'End') { change(max, 'later'); e.preventDefault(); }
    });

    // Double-click returns to the factory value, like many hardware synths.
    wrap.addEventListener('dblclick', function () {
      if (spec.def == null) return;
      change(spec.def, 'set');
      commit.now();
    });

    draw(value);
    return {
      el: el,
      set: function (v) { if (drag) return; value = v; draw(v); },
      state: stateSetter(el)
    };
  }

  // ------------------------------------------------------------------ lit switch

  function toggle(spec) {
    var el = cell(spec);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'switch-btn';
    b.setAttribute('aria-label', spec.label);
    b.innerHTML = '<span class="led"></span><span class="txt">OFF</span>';
    el.appendChild(b);
    caption(el, spec.label);
    var value = spec.value ? 1 : 0;
    function draw() {
      b.setAttribute('aria-pressed', value ? 'true' : 'false');
      b.querySelector('.txt').textContent = value ? 'ON' : 'OFF';
    }
    b.addEventListener('click', function () { value = value ? 0 : 1; draw(); spec.onCommit(value); });
    draw();
    return { el: el, set: function (v) { value = v ? 1 : 0; draw(); }, state: stateSetter(el) };
  }

  // ------------------------------------------------------------------ segmented selector

  function segments(spec) {
    var el = cell(spec);
    var group = document.createElement('div');
    group.className = 'segments';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', spec.label);
    var buttons = [];
    var value = spec.value;
    for (var v = spec.min; v <= spec.max; v++) {
      (function (v) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.textContent = spec.labels(v);
        b.addEventListener('click', function () {
          if (v === value) return;
          value = v; draw(); spec.onCommit(v);
        });
        b.addEventListener('keydown', function (e) {
          var d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
          if (!d) return;
          e.preventDefault();
          var nv = clamp(value + d, spec.min, spec.max);
          if (nv !== value) { value = nv; draw(); spec.onCommit(nv); buttons[nv - spec.min].focus(); }
        });
        buttons.push(b);
        group.appendChild(b);
      })(v);
    }
    el.appendChild(group);
    caption(el, spec.label);
    function draw() {
      buttons.forEach(function (b, i) {
        var on = i + spec.min === value;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    }
    draw();
    return { el: el, set: function (v) { value = v; draw(); }, state: stateSetter(el) };
  }

  // ------------------------------------------------------------------ stepper (LCD with arrows)

  function stepper(spec) {
    var el = cell(spec);
    var min = spec.min, max = spec.max, value = spec.value;
    var fmt = spec.format || String;
    var wrap = document.createElement('div');
    wrap.className = 'stepper';
    var down = document.createElement('button');
    down.type = 'button'; down.textContent = '◂'; down.setAttribute('aria-label', 'Decrease ' + spec.label);
    var lcd = document.createElement('div');
    lcd.className = 'readout lcd';
    lcd.tabIndex = 0;
    lcd.setAttribute('role', 'spinbutton');
    lcd.setAttribute('aria-label', spec.label);
    lcd.setAttribute('aria-valuemin', min);
    lcd.setAttribute('aria-valuemax', max);
    var up = document.createElement('button');
    up.type = 'button'; up.textContent = '▸'; up.setAttribute('aria-label', 'Increase ' + spec.label);
    wrap.appendChild(down); wrap.appendChild(lcd); wrap.appendChild(up);
    el.appendChild(wrap);
    caption(el, spec.label);

    var commit = committer(spec);
    function draw() {
      lcd.textContent = fmt(value);
      lcd.setAttribute('aria-valuenow', value);
      lcd.setAttribute('aria-valuetext', fmt(value));
    }
    function change(v) {
      v = clamp(Math.round(v), min, max);
      if (v === value) return;
      value = v; draw(); commit.later(v);
    }

    // Hold an arrow to keep stepping, like a hardware encoder button.
    function holdable(btn, d) {
      var t = null, r = null;
      function stop() { clearTimeout(t); clearInterval(r); t = r = null; }
      btn.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        change(value + d);
        t = setTimeout(function () { r = setInterval(function () { change(value + d); }, 70); }, 380);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { btn.addEventListener(ev, stop); });
      btn.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); change(value + d); } });
    }
    holdable(down, -1);
    holdable(up, 1);

    lcd.addEventListener('wheel', function (e) { e.preventDefault(); change(value + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
    lcd.addEventListener('keydown', function (e) {
      var d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (d) { e.preventDefault(); change(value + d); }
      else if (e.key === 'Home') { e.preventDefault(); change(min); }
      else if (e.key === 'End') { e.preventDefault(); change(max); }
    });
    // Drag on the display, like a knob: 12px per step.
    var drag = null;
    lcd.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      lcd.setPointerCapture(e.pointerId);
      drag = { y: e.clientY, start: value };
    });
    lcd.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var v = clamp(Math.round(drag.start + (drag.y - e.clientY) / 12), min, max);
      if (v !== value) { value = v; draw(); commit.set(v); }
    });
    function endDrag() { if (drag) { drag = null; commit.now(); } }
    lcd.addEventListener('pointerup', endDrag);
    lcd.addEventListener('pointercancel', endDrag);
    lcd.addEventListener('dblclick', function () { if (spec.def != null && spec.def >= min && spec.def <= max) { value = spec.def; draw(); commit.set(value); commit.now(); } });

    draw();
    return { el: el, set: function (v) { if (drag) return; value = v; draw(); }, state: stateSetter(el) };
  }

  root.SynthControls = { knob: knob, toggle: toggle, segments: segments, stepper: stepper };
})(this);
