/* Runs in the head, before the page paints.
   It adds the "intro" class when the intro plays, so the final content does not show before the intro starts.
   The intro plays once per session. The "?intro" query parameter plays it again. Reduced motion always skips it. */
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  try {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var forced = /[?&]intro(=|&|$)/.test(window.location.search);
    var seen = window.sessionStorage.getItem('tinta-intro') === 'seen';
    if (reduce || window.location.hash || (seen && !forced)) return;
    root.classList.add('intro');
    /* main.js clears this timer when it starts the intro, and then main.js ends the intro itself (after about 6.7 s).
       The timer shows the page only when main.js does not start. */
    window.tintaIntroFailsafe = window.setTimeout(function () {
      root.classList.remove('intro');
    }, 2500);
  } catch (e) {
    root.classList.remove('intro');
  }
})();
