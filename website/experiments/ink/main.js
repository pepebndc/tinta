(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* The intro: measure the header logo for the FLIP move, and end the intro
     on any input. CSS runs the timeline. */
  function setupIntro() {
    if (!root.classList.contains('is-intro')) return;

    var stage = document.querySelector('.intro-stage');
    var lockup = document.querySelector('.intro-lockup');
    var target = document.querySelector('.brand-lockup');
    var skip = document.querySelector('.intro-skip');
    var inputEvents = ['keydown', 'pointerdown', 'wheel', 'touchstart', 'scroll'];
    var finished = false;
    var timer = 0;

    function place() {
      if (!stage || !lockup || !target) return;
      /* offsetLeft and offsetTop ignore transforms, so the start position
         is correct also during the move. */
      var stageBox = stage.getBoundingClientRect();
      var startLeft = stageBox.left + lockup.offsetLeft;
      var startTop = stageBox.top + lockup.offsetTop;
      var startWidth = lockup.offsetWidth;
      var end = target.getBoundingClientRect();
      if (!startWidth || !end.width) return;
      lockup.style.setProperty('--fx', (end.left - startLeft).toFixed(2) + 'px');
      lockup.style.setProperty('--fy', (end.top - startTop).toFixed(2) + 'px');
      lockup.style.setProperty('--fs', (end.width / startWidth).toFixed(5));
    }

    function finish() {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      inputEvents.forEach(function (type) {
        window.removeEventListener(type, finish, true);
      });
      window.removeEventListener('resize', place);
      root.classList.remove('is-intro');
    }

    place();
    window.addEventListener('resize', place);
    inputEvents.forEach(function (type) {
      window.addEventListener(type, finish, { capture: true, passive: true });
    });
    if (skip) skip.addEventListener('click', finish);
    /* The last page animation ends at 3950 ms. */
    timer = window.setTimeout(finish, 4050);
  }

  /* Copy buttons */
  function copyWithSelection(text) {
    var buffer = document.createElement('textarea');
    buffer.value = text;
    buffer.setAttribute('readonly', '');
    buffer.className = 'copy-buffer';
    document.body.appendChild(buffer);
    buffer.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    buffer.remove();
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return copyWithSelection(text); }
      );
    }
    return Promise.resolve(copyWithSelection(text));
  }

  function setupCopy() {
    var live = document.getElementById('live');
    var buttons = document.querySelectorAll('.copy[data-copy]');
    Array.prototype.forEach.call(buttons, function (button) {
      var label = button.textContent;
      var reset = 0;
      button.addEventListener('click', function () {
        var source = document.getElementById(button.getAttribute('data-copy'));
        if (!source) return;
        copyText(source.textContent).then(function (ok) {
          button.textContent = ok ? 'Copied' : 'Press Command-C';
          button.classList.toggle('is-copied', ok);
          if (live) live.textContent = ok ? 'Copied to the clipboard.' : 'Select the text and press Command-C.';
          window.clearTimeout(reset);
          reset = window.setTimeout(function () {
            button.textContent = label;
            button.classList.remove('is-copied');
            if (live) live.textContent = '';
          }, 2000);
        });
      });
    });
  }

  /* Scroll reveal */
  function setupReveal() {
    if (reduceMotion.matches || !('IntersectionObserver' in window)) return;
    var items = document.querySelectorAll('.reveal');
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    Array.prototype.forEach.call(items, function (item) {
      observer.observe(item);
    });
    root.classList.add('reveal-ready');
  }

  setupIntro();
  setupCopy();
  setupReveal();
})();
