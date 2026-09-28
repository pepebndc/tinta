/* Runs in <head> before the first paint. It selects whether the intro plays. */
(function () {
  var root = document.documentElement;
  root.classList.add("js");

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;

  var force = /[?&]intro(=|&|$)/.test(window.location.search);
  var seen = false;
  try {
    seen = window.sessionStorage.getItem("tinta-intro") === "1";
  } catch (e) {}
  if (seen && !force) return;
  try {
    window.sessionStorage.setItem("tinta-intro", "1");
  } catch (e) {}

  root.classList.add("intro-on");
  window.tintaIntroAt = window.performance.now();

  // If main.js does not start the intro in time, show the page. main.js clears this timer when it starts.
  window.tintaIntroFallback = window.setTimeout(function () {
    if (root.classList.contains("intro-on")) {
      root.classList.remove("intro-on");
      root.classList.add("intro-done");
    }
  }, 1500);
})();
