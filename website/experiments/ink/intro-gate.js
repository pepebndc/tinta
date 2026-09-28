/* Runs in <head> without defer. It adds the classes before the first paint,
   so the page does not show its final state before the intro starts. */
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  try {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    var force = /[?&]intro(=|&|$)/.test(window.location.search);
    var played = window.sessionStorage.getItem('tinta-intro') === '1';
    /* A link to a section (for example #install) goes to that section at once. */
    if (!force && (played || window.location.hash.length > 1)) return;
    window.sessionStorage.setItem('tinta-intro', '1');
    root.classList.add('is-intro');
  } catch (e) {
    /* Storage is not available: show the final state. */
  }
})();
