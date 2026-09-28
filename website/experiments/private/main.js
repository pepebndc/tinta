/* Tinta landing page: the intro choreography, copy buttons, and scroll reveal. */
(function () {
  "use strict";

  var root = document.documentElement;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  initCopy();
  initReveal();
  if (root.classList.contains("intro-on")) runIntro();

  /* Copy buttons */

  function initCopy() {
    var status = document.getElementById("copy-status");
    var buttons = document.querySelectorAll(".copy[data-copy-target]");
    Array.prototype.forEach.call(buttons, function (button) {
      var timer = 0;
      button.addEventListener("click", function () {
        var source = document.getElementById(button.getAttribute("data-copy-target"));
        if (!source) return;
        copyText(source.textContent, source).then(function (ok) {
          button.textContent = ok ? "Copied" : "Press Cmd+C";
          button.classList.toggle("is-done", ok);
          if (status) status.textContent = ok ? "Copied to the clipboard." : "Select the text and press Command C.";
          window.clearTimeout(timer);
          timer = window.setTimeout(function () {
            button.textContent = "Copy";
            button.classList.remove("is-done");
          }, 1800);
        });
      });
    });
  }

  function copyText(text, source) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return selectAndCopy(source); }
      );
    }
    return Promise.resolve(selectAndCopy(source));
  }

  function selectAndCopy(source) {
    var range = document.createRange();
    range.selectNodeContents(source);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    if (ok) selection.removeAllRanges();
    return ok;
  }

  /* Scroll reveal */

  function initReveal() {
    if (reduce || !("IntersectionObserver" in window)) return;
    var items = document.querySelectorAll(".reveal");
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
    Array.prototype.forEach.call(items, function (item) { observer.observe(item); });
    root.classList.add("reveal-ready");
  }

  /* Intro */

  function runIntro() {
    var intro = document.getElementById("intro");
    var svg = document.getElementById("intro-lines");
    var skip = document.getElementById("intro-skip");
    var icon = document.getElementById("intro-icon");
    var brandIcon = document.getElementById("brand-icon");
    var startedAt = typeof window.tintaIntroAt === "number" ? window.tintaIntroAt : 0;

    // If the page loads slowly, show the final state. The intro must not delay the page.
    if (!intro || !svg || !icon || !brandIcon || !intro.animate || window.performance.now() - startedAt > 400) {
      root.classList.remove("intro-on");
      root.classList.add("intro-done");
      return;
    }

    // main.js runs the intro, so the fallback timer of intro-gate.js is not necessary.
    window.clearTimeout(window.tintaIntroFallback);

    var anims = [];
    var heroAnims = [];
    var timer = 0;
    var W = window.innerWidth;
    var H = window.innerHeight;
    var cx = W / 2;
    var cy = H / 2;
    var S = icon.getBoundingClientRect().width || 112;
    var small = W < 720;
    var styles = window.getComputedStyle(root);
    var color = function (name) { return styles.getPropertyValue(name).trim(); };

    svg.setAttribute("viewBox", "0 0 " + W + " " + H);

    // A track is one animation of one property, with points in ms from the intro start.
    function track(el, prop, points, fill, list) {
      var t0 = points[0][0];
      var dur = Math.max(1, points[points.length - 1][0] - t0);
      var frames = points.map(function (p) {
        var frame = { offset: (p[0] - t0) / dur };
        frame[prop] = p[1];
        if (p[2]) frame.easing = p[2];
        return frame;
      });
      var anim = el.animate(frames, { delay: t0, duration: dur, fill: fill || "both" });
      (list || anims).push(anim);
      return anim;
    }

    function make(tag, attrs, parent) {
      var el = document.createElementNS(SVG_NS, tag);
      Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
      (parent || svg).appendChild(el);
      return el;
    }

    var ease = "cubic-bezier(.45,0,.2,1)";
    var easeOut = "cubic-bezier(.2,.7,.2,1)";

    /* Phase 1: lines of sound come in from the edges and converge on the center. */

    var sources = [
      { label: "Microsoft Teams", x: cx, y: 0, lx: cx + 26, ly: 30, anchor: "start", c: "--s5" },
      { label: "Microphone", x: cx, y: H, lx: cx - 26, ly: H - 24, anchor: "end", c: "--s3" },
      { label: "Google Meet", x: 0, y: cy, lx: 20, ly: cy - 26, anchor: "start", c: "--s1" },
      { label: "Zoom", x: W, y: cy, lx: W - 20, ly: cy - 26, anchor: "end", c: "--s2" }
    ];
    var amp = small ? 11 : 16;

    sources.forEach(function (src, i) {
      var dx = cx - src.x;
      var dy = cy - src.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      var ux = dx / len;
      var uy = dy / len;
      var seed = i * 1.7 + 0.4;
      var d = "";
      for (var s = 0; s <= len; s += 1.5) {
        var t = s / len;
        var envelope = Math.pow(1 - t, 1.15) * (0.35 + 0.65 * Math.abs(Math.sin(t * 6.1 + seed)));
        var offset = amp * envelope * Math.sin(s / 3.3 + seed);
        var px = src.x + ux * s - uy * offset;
        var py = src.y + uy * s + ux * offset;
        d += (s === 0 ? "M" : "L") + px.toFixed(1) + " " + py.toFixed(1);
      }
      d += "L" + cx + " " + cy;
      var wave = make("path", { d: d, "class": "wave", stroke: color(src.c) });
      var L = wave.getTotalLength();
      wave.setAttribute("stroke-dasharray", L + " " + L);
      wave.setAttribute("stroke-dashoffset", L);

      var label = make("text", { x: src.lx, y: src.ly, "class": "wave-label", "text-anchor": src.anchor });
      label.textContent = src.label;

      var t0 = i * 150;
      track(wave, "strokeDashoffset", [[t0, L, "cubic-bezier(.3,0,.4,1)"], [t0 + 1300, 0, "cubic-bezier(.5,0,.8,.6)"], [t0 + 2300, -L]]);
      track(wave, "opacity", [[t0, 0.9], [t0 + 2300, 0.9]]);
      track(label, "opacity", [[t0 + 200, 0], [t0 + 500, 1], [2200, 1], [2500, 0]]);
      track(label, "transform", [[t0 + 200, "translateY(4px)", easeOut], [t0 + 500, "translateY(0px)"]]);
    });

    var dot = intro.querySelector(".intro-dot");
    track(dot, "opacity", [[1300, 0], [1450, 1], [2100, 1], [2400, 0]]);
    track(dot, "transform", [[1300, "scale(0)", easeOut], [1500, "scale(1.6)"], [2400, "scale(1)"]]);

    /* Phase 2: the square draws itself. The sound becomes text, then the ink mark. */

    var stroke = icon.querySelector(".ii-stroke");
    var fillRect = icon.querySelector(".ii-fill");
    var mark = icon.querySelector(".ii-mark");
    track(stroke, "strokeDashoffset", [[1900, 100, "cubic-bezier(.6,0,.2,1)"], [2700, 0]]);
    track(stroke, "opacity", [[4450, 1], [4850, 0.45]]);
    track(fillRect, "opacity", [[4400, 0], [4800, 1]]);
    track(mark, "opacity", [[4450, 0], [4700, 1]]);
    track(mark, "transform", [[4450, "scale(.3)", "cubic-bezier(.2,.9,.3,1.12)"], [4950, "scale(1)"]]);

    var lines = intro.querySelectorAll(".tl");
    Array.prototype.forEach.call(lines, function (line, i) {
      var t = 2500 + i * 220;
      var tc = 4000 + i * 80;
      var toCenter = -(line.offsetTop + line.offsetHeight / 2);
      track(line, "opacity", [[t, 0], [t + 80, 0.9], [t + 150, 0.15], [t + 240, 1], [tc, 1], [tc + 400, 0]]);
      track(line, "transform", [
        [t, "translate(-50%, 4px) scale(1)", easeOut],
        [t + 240, "translate(-50%, 0px) scale(1)"],
        [tc, "translate(-50%, 0px) scale(1)", "cubic-bezier(.55,0,.9,.4)"],
        [tc + 400, "translate(-50%, " + toCenter + "px) scale(.08)"]
      ]);
    });

    /* Phase 3: lines try to reach out, and each line is cut. The lock closes. */

    var corners = [
      { x: 0, y: 0, label: "cloud" },
      { x: W, y: 0, label: "analytics" },
      { x: 0, y: H, label: "crash reports" },
      { x: W, y: H, label: "updates" }
    ];
    var defs = make("defs", {});
    corners.forEach(function (corner, i) {
      var dx = corner.x - cx;
      var dy = corner.y - cy;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var ux = dx / dist;
      var uy = dy / dist;
      var r0 = S * 0.74;
      var r1 = Math.max(r0 + 60, dist * (small ? 0.42 : 0.46));
      var x0 = cx + ux * r0, y0 = cy + uy * r0;
      var x1 = cx + ux * r1, y1 = cy + uy * r1;
      var d = "M" + x0.toFixed(1) + " " + y0.toFixed(1) + "L" + x1.toFixed(1) + " " + y1.toFixed(1);
      var L = r1 - r0;

      var mask = make("mask", { id: "dm" + i, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: W, height: H }, defs);
      var reveal = make("path", { d: d, fill: "none", stroke: "#fff", "stroke-width": 8, "stroke-dasharray": L + " " + L, "stroke-dashoffset": L }, mask);
      var dash = make("path", { d: d, "class": "dash", mask: "url(#dm" + i + ")" });

      var tick = make("line", {
        "class": "cut-tick",
        x1: (x1 - uy * 6).toFixed(1), y1: (y1 + ux * 6).toFixed(1),
        x2: (x1 + uy * 6).toFixed(1), y2: (y1 - ux * 6).toFixed(1)
      });

      var right = ux > 0;
      var lx = x1 + ux * 14;
      var ly = y1 + uy * 14 + (uy > 0 ? 12 : -2);
      var label = make("text", { x: lx.toFixed(1), y: ly.toFixed(1), "class": "cut-label", "text-anchor": right ? "start" : "end" });
      label.textContent = corner.label;
      var w = label.getComputedTextLength();
      var sx = right ? lx : lx - w;
      var strike = make("line", {
        "class": "strike",
        x1: (sx - 2).toFixed(1), y1: (ly - 4).toFixed(1), x2: (sx + w + 2).toFixed(1), y2: (ly - 4).toFixed(1),
        "stroke-dasharray": (w + 4) + " " + (w + 4), "stroke-dashoffset": w + 4
      });

      var t = 5000 + i * 120;
      track(reveal, "strokeDashoffset", [[t, L, "cubic-bezier(.3,0,.2,1)"], [t + 450, 0]]);
      track(dash, "opacity", [[t + 1150, 1], [t + 1450, 0]]);
      track(tick, "opacity", [[t + 430, 0], [t + 460, 1], [t + 1200, 1], [t + 1500, 0]]);
      track(label, "opacity", [[t + 250, 0], [t + 450, 1], [t + 1200, 1], [t + 1500, 0]]);
      track(strike, "strokeDashoffset", [[t + 800, w + 4, ease], [t + 1000, 0]]);
      track(strike, "opacity", [[t + 1200, 1], [t + 1500, 0]]);
    });

    var lock = intro.querySelector(".intro-lock");
    var shackle = intro.querySelector(".lock-shackle");
    var zero = intro.querySelector(".intro-zero");
    track(lock, "opacity", [[6300, 0], [6450, 1], [7600, 1], [7750, 0]]);
    track(lock, "transform", [[6300, "translate(-50%, 4px)", easeOut], [6450, "translate(-50%, 0px)"]]);
    track(shackle, "transform", [[6450, "translateY(-3.5px)", "cubic-bezier(.6,0,.9,.5)"], [6600, "translateY(0px)"]]);
    track(zero, "clipPath", [[6550, "inset(0 100% 0 0)", "steps(18, end)"], [6950, "inset(0 0% 0 0)"]]);

    /* Phase 4: the icon moves to the header, the curtain opens, and the hero rises. */

    // Measure the FLIP positions when the move starts, so that they match the current layout.
    var flipTimer = window.setTimeout(function () {
      var a = icon.getBoundingClientRect();
      var b = brandIcon.getBoundingClientRect();
      var fx = b.left + b.width / 2 - (a.left + a.width / 2);
      var fy = b.top + b.height / 2 - (a.top + a.height / 2);
      var k = b.width / a.width;
      track(icon, "transform", [[0, "translate(0px, 0px) scale(1)", "cubic-bezier(.65,0,.25,1)"], [600, "translate(" + fx + "px, " + fy + "px) scale(" + k + ")"]]);
    }, 7600);
    track(svg, "opacity", [[7600, 1], [7750, 0]]);
    track(intro.querySelector(".intro-curtain--l"), "transform", [[7650, "translateX(0%)", "cubic-bezier(.7,0,.2,1)"], [8250, "translateX(-101%)"]]);
    track(intro.querySelector(".intro-curtain--r"), "transform", [[7650, "translateX(0%)", "cubic-bezier(.7,0,.2,1)"], [8250, "translateX(101%)"]]);
    if (skip) track(skip, "opacity", [[0, 0], [400, 1], [7600, 1], [7800, 0]]);

    var delays = [7710, 7750, 7810, 7870, 7920, 7950, 7970];
    var rise = document.querySelectorAll(".hero-rise");
    Array.prototype.forEach.call(rise, function (el, i) {
      var t = delays[Math.min(i, delays.length - 1)];
      track(el, "opacity", [[t, 0, "ease-out"], [t + 480, 1]], "backwards", heroAnims);
      track(el, "transform", [[t, "translateY(28px)", easeOut], [t + 480, "translateY(0px)"]], "backwards", heroAnims);
    });

    timer = window.setTimeout(end, 8250);

    var events = ["keydown", "pointerdown", "wheel", "touchstart"];
    events.forEach(function (name) { window.addEventListener(name, interrupt, { passive: true }); });
    window.addEventListener("resize", onResize);
    if (skip) skip.addEventListener("click", interrupt);

    // Mobile browsers resize the viewport when the toolbar moves. Only a real resize ends the intro.
    function onResize() {
      if (Math.abs(window.innerWidth - W) > 40 || Math.abs(window.innerHeight - H) > 160) interrupt();
    }

    function interrupt() {
      heroAnims.forEach(function (anim) { anim.cancel(); });
      end();
    }

    function end() {
      window.clearTimeout(timer);
      window.clearTimeout(flipTimer);
      events.forEach(function (name) { window.removeEventListener(name, interrupt, { passive: true }); });
      window.removeEventListener("resize", onResize);
      if (skip) skip.removeEventListener("click", interrupt);
      anims.forEach(function (anim) { anim.cancel(); });
      anims = [];
      root.classList.remove("intro-on");
      root.classList.add("intro-done");
      if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
    }
  }
})();
