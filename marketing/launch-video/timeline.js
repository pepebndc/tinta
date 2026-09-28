// Shared timeline for the picture (index.html) and the soundtrack (music.mjs). 120 BPM: one bar is 2 s.
var TL = (function () {
  const rand = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  const NOTES = "Make the first screen feel calm.\n\n• Keep the transcript easy to scan.\n• Give notes their own space.\n\n[00:46] Next: review the icon at small sizes.";
  // Human typing: short gaps between characters, longer gaps at line breaks.
  function typing(text, t0, t1) {
    const gaps = [...text].map((c, i) => (c === "\n" ? 0.16 : c === " " ? 0.05 : 0.026 + rand(i) * 0.03));
    const total = gaps.reduce((a, b) => a + b, 0);
    let acc = 0;
    return gaps.map((g) => (acc += g) / total * (t1 - t0) + t0);
  }

  return {
    DUR: 38,
    // Scene windows [show, hide].
    scenes: { hook: [0, 3.6], logo: [3.6, 8.0], app: [6.9, 16.0], sum: [15.3, 20.0], priv: [20.0, 28.0], mcp: [28.0, 32.0], end: [32.0, 38.0] },
    // Organic color floods that cover a cut.
    floods: [
      { t0: 2.95, t1: 3.6, x: 960, y: 540, vx: 540, vy: 960, color: "#faf9f6", seed: 3 },
      { t0: 19.5, t1: 20.0, x: 1340, y: 560, vx: 540, vy: 1200, color: "#292456", seed: 7 },
      { t0: 27.5, t1: 28.0, x: 480, y: 540, vx: 540, vy: 560, color: "#faf9f6", seed: 11 },
      { t0: 31.5, t1: 32.0, x: 960, y: 540, vx: 540, vy: 960, color: "#292456", seed: 5 },
    ],
    hook: { in: 0.25, roll: [0.85, 1.45], out: 2.1, q: 2.3 },
    logo: { drop: 4.0, glyph: 4.42, dot: 4.6, slide: 4.8, word: 4.85, tag: 5.45, tagOut: 6.7, fly: [6.95, 7.85] },
    app: {
      heads: [[8.15, 9.35], [9.5, 11.95], [12.1, 15.25]],
      cursor: [8.2, 8.85], click: 8.95, swap: 9.1,
      rec: 9.4, notes: NOTES, noteTimes: typing(NOTES, 9.9, 12.4),
      turns: [9.9, 10.5, 11.1, 11.7],
      zoom: [12.0, 13.0], meet: 12.55, speak: 13.0, rename: 13.7, out: [15.25, 16.0],
    },
    sum: { head: 15.75, panel: 16.1, sections: [16.5, 16.95, 17.4, 17.85], check: 18.7 },
    priv: { head: 20.15, draw: 20.1, labels: 20.9, push: [22.2, 22.9], zero: 22.7, count: [22.75, 23.35], zeroOut: 24.55, lock: 24.7, click: 25.3, lines: [25.5, 25.75, 26.0, 26.25] },
    mcp: { head: 28.05, src: 28.15, chat: 28.2, q: [28.55, 29.05], tool: 29.15, packets: 29.2, done: 30.0, answer: [30.1, 30.9], cites: 30.95, pills: 31.05 },
    end: { mark: 32.1, glyph: 32.3, dot: 32.45, slide: 32.55, word: 32.6, tag: 33.15, cta: 33.6, url: [33.8, 34.5], shine: 34.75, sub: 34.6, fade: [37.4, 38.0] },
  };
})();
if (typeof module !== "undefined") module.exports = TL;
