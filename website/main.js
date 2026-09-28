/* Tinta landing page: copy buttons, scroll reveal, and the intro.
   All content is in the HTML. This script only adds motion and the copy buttons. */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* Copy buttons */
  function initCopy() {
    var status = document.getElementById('copy-status');
    document.querySelectorAll('.copy[data-copy]').forEach(function (button) {
      var source = document.getElementById(button.getAttribute('data-copy'));
      if (!source) return;
      button.hidden = false;
      var resetTimer = 0;
      button.addEventListener('click', function () {
        var text = source.textContent;
        copyText(text).then(function (ok) {
          button.textContent = ok ? 'Copied' : 'Select and copy';
          button.classList.toggle('done', ok);
          if (status) status.textContent = ok ? 'Copied to the clipboard.' : 'Copy failed. Select the text and copy it.';
          window.clearTimeout(resetTimer);
          resetTimer = window.setTimeout(function () {
            button.textContent = 'Copy';
            button.classList.remove('done');
          }, 1800);
          if (!ok) selectText(source);
        });
      });
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.className = 'sr-only';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    area.remove();
    return ok;
  }

  function selectText(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /* Scroll reveal */
  function initReveal() {
    var items = document.querySelectorAll('.reveal');
    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      items.forEach(function (item) { item.classList.add('in'); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (item) { observer.observe(item); });
  }

  /* Intro: a short meeting plays in the window, then the window settles into the hero.
     Each element gets one animation. The keyframes use absolute times in seconds.
     The final state is the normal CSS, so to end the intro, the script cancels all animations. */
  function initIntro() {
    if (!root.classList.contains('intro')) return;
    window.clearTimeout(window.tintaIntroFailsafe);

    var flip = document.querySelector('.sim-flip');
    if (reduceMotion.matches || !flip || !flip.animate || window.scrollY > 0 || window.innerHeight < 480) {
      root.classList.remove('intro');
      return;
    }
    try { window.sessionStorage.setItem('tinta-intro', 'seen'); } catch (e) { /* Private mode: the intro plays again. */ }

    var q = function (selector, scope) { return (scope || document).querySelector(selector); };
    var qa = function (selector, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(selector)); };
    var EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
    var animations = [];
    var finite = [];
    var ended = false;

    /* One animation from a list of [time, keyframe] stops. */
    function track(el, stops, easing) {
      if (!el) return null;
      var start = stops[0][0];
      var end = stops[stops.length - 1][0];
      var span = Math.max(end - start, 0.001);
      var frames = stops.map(function (stop) {
        var frame = Object.assign({}, stop[1]);
        frame.offset = (stop[0] - start) / span;
        if (!frame.easing) frame.easing = easing || EASE;
        return frame;
      });
      var animation = el.animate(frames, { delay: start * 1000, duration: span * 1000, fill: 'both' });
      animations.push(animation);
      finite.push(animation);
      return animation;
    }

    /* A repeating animation, for the pulse and the level bars. */
    function loop(el, frames, start, duration) {
      var animation = el.animate(frames, { delay: start * 1000, duration: duration * 1000, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', fill: 'both' });
      animations.push(animation);
    }

    function fadeUp(el, t0, t1, distance) {
      var d = distance || 8;
      return track(el, [[t0, { opacity: 0, transform: 'translateY(' + d + 'px)' }], [t1, { opacity: 1, transform: 'none' }]]);
    }

    /* Split the transcript text into words, so that the words can stream in. */
    qa('.sim-transcript .turn-text').forEach(function (p) {
      var words = p.textContent.trim().split(/\s+/);
      p.textContent = '';
      words.forEach(function (word, i) {
        var span = document.createElement('span');
        span.className = 'w';
        span.textContent = word;
        p.appendChild(span);
        if (i < words.length - 1) p.appendChild(document.createTextNode(' '));
      });
    });

    /* Measure the final layout. */
    var rect = flip.getBoundingClientRect();
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var scale = Math.min(1.12, (vw - 24) / rect.width, (vh - 40) / rect.height);
    scale = Math.max(scale, 0.6);
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var dx = vw / 2 - cx;
    var dy = vh / 2 - cy;
    var introTransform = 'translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px) scale(' + scale.toFixed(3) + ')';

    var summary = q('.sim-summary');
    var rec = q('.sim-rec');
    var lift = summary.offsetHeight - rec.offsetHeight;
    var recRect = rec.getBoundingClientRect();
    var toRecX = scale * (recRect.left + recRect.width / 2 - cx);
    var toRecY = scale * (recRect.top + recRect.height / 2 - cy);

    /* Deterministic level bars. */
    var seed = 7;
    function rand() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
    function waveBars(wave, start) {
      qa('i', wave).forEach(function (bar) {
        var a = 0.35 + rand() * 0.65;
        var b = 0.15 + rand() * 0.35;
        loop(bar, [{ transform: 'scaleY(' + b.toFixed(2) + ')' }, { transform: 'scaleY(' + a.toFixed(2) + ')' }], start + rand() * 0.2, 0.22 + rand() * 0.3);
      });
    }

    /* The timeline, in seconds. Typed and streamed text shows at 170 ms per word.
       Each finished stage stays still for 500 ms before the next stage moves its text. */
    var WORD = 0.17;
    var HOLD = 0.5;
    var words = function (el) { return el.textContent.trim().split(/\s+/).length; };
    var T = {};
    T.pillIn = 0.1;
    T.click = 0.85;                       /* The pill text shows for about 0.75 s before the click. */
    T.recording = T.click + 0.12;         /* The pill changes to the recording state. */
    T.build = T.recording + 0.12 + HOLD;  /* The window builds itself. */
    T.built = T.build + 0.35;

    /* 1. The call pill, the cursor, and the click. */
    var pill = q('.intro-pill');
    track(pill, [
      [T.pillIn, { opacity: 0, transform: 'translateY(12px) scale(0.96)' }],
      [T.pillIn + 0.3, { opacity: 1, transform: 'none' }],
      [T.build, { opacity: 1, transform: 'none' }],
      [T.build + 0.32, { opacity: 0, transform: 'translate(' + toRecX.toFixed(1) + 'px, ' + toRecY.toFixed(1) + 'px) scale(0.9)', easing: 'cubic-bezier(0.5, 0, 0.3, 1)' }]
    ]);
    track(q('.intro-pill .cursor'), [
      [T.click - 0.55, { opacity: 0, transform: 'translate(120px, 70px)' }],
      [T.click - 0.42, { opacity: 1, transform: 'translate(92px, 54px)' }],
      [T.click - 0.06, { opacity: 1, transform: 'translate(0px, 0px) scale(1)' }],
      [T.click, { opacity: 1, transform: 'translate(0px, 0px) scale(0.86)' }],
      [T.click + 0.1, { opacity: 1, transform: 'translate(0px, 0px) scale(1)' }],
      [T.click + 0.3, { opacity: 0, transform: 'translate(4px, 8px) scale(1)' }]
    ]);
    track(q('.pill-btn'), [
      [T.click - 0.06, { transform: 'scale(1)' }],
      [T.click, { transform: 'scale(0.94)' }],
      [T.click + 0.12, { transform: 'scale(1)' }]
    ]);
    track(q('.pill-a'), [[T.recording - 0.02, { opacity: 1 }], [T.recording + 0.12, { opacity: 0 }]]);
    track(q('.pill-b'), [[T.recording - 0.02, { opacity: 0 }], [T.recording + 0.12, { opacity: 1 }]]);
    loop(q('.pill-b .rec-dot'), [{ opacity: 1 }, { opacity: 0.3 }], T.recording, 0.5);
    waveBars(q('.pill-b .wave'), T.recording);

    /* 2. The window builds itself. Your notes type themselves, and the transcript streams in, word by word. */
    track(q('.sim-window'), [
      [T.build, { opacity: 0, transform: 'translateY(16px) scale(0.975)' }],
      [T.built, { opacity: 1, transform: 'none' }]
    ]);
    fadeUp(q('.sim-head'), T.build + 0.08, T.built, 6);
    fadeUp(q('.sim-notes'), T.build + 0.14, T.built + 0.06);
    fadeUp(q('.sim-transcript'), T.build + 0.2, T.built + 0.12);
    loop(q('.rec-live .rec-dot'), [{ opacity: 1 }, { opacity: 0.3 }], T.build, 0.5);
    waveBars(q('.rec-live .wave'), T.build);

    var streamEnd = T.built;
    var turnHeads = [];
    var cursor = T.built + 0.1;
    qa('.sim-transcript .turn').forEach(function (turn) {
      var head = cursor;
      turnHeads.push(head);
      fadeUp(q('.turn-head', turn), head, head + 0.14, 4);
      qa('.w', turn).forEach(function (word, i) {
        var w0 = head + 0.1 + i * WORD;
        track(word, [[w0, { opacity: 0 }], [w0 + 0.12, { opacity: 1 }]], 'linear');
        cursor = w0 + WORD;
      });
      cursor += 0.1;
      streamEnd = Math.max(streamEnd, cursor);
    });

    /* A note line types while the first turns stream. The timestamp goes in when the last speaker starts. */
    var lines = qa('.sim-notes .ty');
    var stampAt = turnHeads[turnHeads.length - 1] || T.built + 1;
    var lineStarts = [T.built + 0.3, stampAt + 0.15];
    lines.forEach(function (line, i) {
      var t0 = lineStarts[i] !== undefined ? lineStarts[i] : lineStarts[lineStarts.length - 1] + i;
      var t1 = t0 + words(line) * WORD;
      var steps = Math.max(8, Math.round(line.textContent.length * 0.8));
      track(line, [
        [t0, { clipPath: 'inset(0 100% 0 0)', easing: 'steps(' + steps + ', end)' }],
        [t1, { clipPath: 'inset(0 0% 0 0)' }]
      ]);
      streamEnd = Math.max(streamEnd, t1);
    });
    track(q('.ins-btn .press'), [[stampAt - 0.1, { opacity: 0 }], [stampAt - 0.04, { opacity: 1 }], [stampAt + 0.16, { opacity: 0 }]]);
    track(q('.sim-notes .stamp'), [
      [stampAt, { opacity: 0, transform: 'scale(0.7)' }],
      [stampAt + 0.12, { opacity: 1, transform: 'scale(1)', easing: 'cubic-bezier(0.3, 1.6, 0.5, 1)' }],
      [stampAt + 0.2, { opacity: 1, transform: 'scale(1)' }]
    ]);

    /* 3. The call ends. Processing runs in the bar, and then the summary unfolds.
       The notes and the transcript stay still for 500 ms after the last word, until the summary moves them. */
    T.callEnd = streamEnd + 0.05;
    T.proc = T.callEnd + 0.12;
    T.procFull = T.proc + 0.62;
    T.summary = Math.max(streamEnd + HOLD, T.procFull + 0.08);
    T.summaryDone = T.summary + 0.4;
    T.settle = T.summaryDone + HOLD;
    T.done = T.settle + 0.5;

    /* The recording bar opens from the pill, and later rolls up into the top of the summary. */
    var recOpen = 'inset(-6px -6px -6px -6px round 12px)';
    track(rec, [
      [T.build + 0.05, { clipPath: 'inset(0px 40% 0px 40% round 26px)' }],
      [T.built, { clipPath: recOpen }],
      [T.summary, { clipPath: recOpen, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }],
      [T.summary + 0.25, { clipPath: 'inset(0px 0px 100% 0px round 12px)' }]
    ]);
    /* The grey dot covers the red dot when the call ends. */
    track(q('.rec-dot.off'), [[T.callEnd, { opacity: 0 }], [T.callEnd + 0.1, { opacity: 1 }]]);
    track(q('.lbl-rec'), [[T.callEnd, { opacity: 1 }], [T.callEnd + 0.1, { opacity: 0 }]]);
    track(q('.lbl-end'), [[T.callEnd, { opacity: 0 }], [T.callEnd + 0.1, { opacity: 1 }]]);
    track(q('.rec-live .wave'), [[T.callEnd, { transform: 'scaleY(1)', opacity: 1 }], [T.callEnd + 0.14, { transform: 'scaleY(0.1)', opacity: 0.45 }]]);
    track(q('.rec-live'), [[T.proc, { opacity: 1 }], [T.proc + 0.12, { opacity: 0 }]]);
    track(q('.rec-proc'), [[T.proc, { opacity: 0 }], [T.proc + 0.12, { opacity: 1 }]]);
    track(q('.proc-fill'), [[T.proc + 0.12, { transform: 'scaleX(0)' }], [T.procFull, { transform: 'scaleX(1)' }]], 'cubic-bezier(0.4, 0, 0.3, 1)');
    track(summary, [
      [T.summary, { clipPath: 'inset(0 0 100% 0 round 10px)' }],
      [T.summary + 0.35, { clipPath: 'inset(0 0 0% 0 round 10px)' }]
    ], 'cubic-bezier(0.4, 0, 0.2, 1)');
    track(q('.sim-work'), [[T.summary, { transform: 'translateY(' + -lift + 'px)' }], [T.summary + 0.35, { transform: 'none' }]], 'cubic-bezier(0.4, 0, 0.2, 1)');
    qa('.sum-head, .sum-overview, .sum-grid > div', summary).forEach(function (part, i) {
      fadeUp(part, T.summary + 0.05 + i * 0.04, T.summary + 0.3 + i * 0.04, 4);
    });

    /* The timer follows the timestamps of the turns: 00:12, 00:28, and 00:46. */
    var timer = q('.rec-timer');
    var marks = [[T.build, 4]];
    qa('.sim-transcript .turn').forEach(function (turn, i) {
      marks.push([turnHeads[i], Number(turn.getAttribute('data-at')) || 0]);
    });
    marks.push([T.callEnd, marks[marks.length - 1][1] + 9]);
    var clock = performance.now();
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var timerId = window.setInterval(function () {
      var t = (performance.now() - clock) / 1000;
      var value = marks[0][1];
      for (var i = 1; i < marks.length; i++) {
        var a = marks[i - 1];
        var b = marks[i];
        if (t >= b[0]) { value = b[1]; continue; }
        if (t > a[0]) value = a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
        break;
      }
      var seconds = Math.floor(value);
      timer.textContent = pad(Math.floor(seconds / 60)) + ':' + pad(seconds % 60);
    }, 40);

    /* 4. The window settles into the hero, and the page appears around it. */
    var settle = track(flip, [[T.settle, { transform: introTransform }], [T.done, { transform: 'none' }]], 'cubic-bezier(0.65, 0, 0.25, 1)');
    track(q('.site-header'), [[T.settle + 0.1, { opacity: 0 }], [T.done, { opacity: 1 }]]);
    qa('.hero-copy > *').forEach(function (part, i) {
      fadeUp(part, T.settle + 0.1 + i * 0.04, T.settle + 0.42 + i * 0.04, 12);
    });
    track(q('.rest'), [[T.settle + 0.15, { opacity: 0 }], [T.done + 0.05, { opacity: 1 }]]);
    track(q('.site-footer'), [[T.settle + 0.15, { opacity: 0 }], [T.done + 0.05, { opacity: 1 }]]);
    var skip = q('.intro-skip');
    track(skip, [[T.settle - 0.2, { transform: 'none' }], [T.settle + 0.05, { transform: 'translateY(90px)' }]], 'cubic-bezier(0.5, 0, 0.75, 0)');

    function end() {
      if (ended) return;
      ended = true;
      var hadFocus = document.activeElement === skip;
      window.clearInterval(timerId);
      animations.forEach(function (animation) { animation.cancel(); });
      root.classList.remove('intro');
      ['keydown', 'pointerdown', 'wheel', 'touchmove', 'scroll'].forEach(function (type) {
        window.removeEventListener(type, end, true);
      });
      if (hadFocus) {
        var heading = q('#hero-title');
        if (heading) heading.focus({ preventScroll: true });
      }
    }

    skip.addEventListener('click', end);
    ['keydown', 'pointerdown', 'wheel', 'touchmove', 'scroll'].forEach(function (type) {
      window.addEventListener(type, end, { capture: true, passive: true });
    });
    Promise.all(finite.map(function (animation) { return animation.finished; })).then(end, function () { /* Cancelled: the intro ended early. */ });
    /* A second check that follows the animation clock, in case a promise does not settle. */
    var TOTAL = Math.round((T.done + 0.15) * 1000);
    function checkEnd() {
      if (ended) return;
      var remaining = TOTAL - (settle.currentTime || 0);
      if (remaining <= 16) end();
      else window.setTimeout(checkEnd, remaining);
    }
    window.setTimeout(checkEnd, TOTAL);
  }

  initCopy();
  initReveal();
  initIntro();
})();
