// Speaking-state logic with hysteresis. It has no DOM access, so Node tests can load it.
(function (root) {
  "use strict";

  const DEFAULTS = {
    windowMs: 400,
    minMutationsPerWindow: 3,
    startWindows: 2,
    endQuietMs: 800,
  };

  class SpeakingTracker {
    constructor(options) {
      this.options = Object.assign({}, DEFAULTS, options || {});
      this.entries = new Map();
    }

    entry(id) {
      let e = this.entries.get(id);
      if (!e) {
        e = { events: [], hint: false, aboveCount: 0, lastAboveAt: -Infinity, speaking: false };
        this.entries.set(id, e);
      }
      return e;
    }

    // Records attribute mutations for a participant at time t (ms). Each event is [t, count].
    record(id, t, count) {
      this.entry(id).events.push([t, count === undefined ? 1 : count]);
    }

    // Sets a secondary speaking signal (for example an aria-label) for a participant.
    setHint(id, active) {
      this.entry(id).hint = Boolean(active);
    }

    remove(id) {
      this.entries.delete(id);
    }

    // Evaluates one window that ends at t. Returns { speaking, changed }.
    tick(t) {
      const o = this.options;
      let changed = false;
      for (const e of this.entries.values()) {
        const from = t - o.windowMs;
        let old = 0;
        while (old < e.events.length && e.events[old][0] <= from) old += 1;
        if (old > 0) e.events.splice(0, old);
        let count = 0;
        for (const [et, n] of e.events) if (et <= t) count += n;
        const above = e.hint || count >= o.minMutationsPerWindow;
        if (above) {
          e.aboveCount += 1;
          e.lastAboveAt = t;
          if (!e.speaking && e.aboveCount >= o.startWindows) {
            e.speaking = true;
            changed = true;
          }
        } else {
          e.aboveCount = 0;
          if (e.speaking && t - e.lastAboveAt >= o.endQuietMs) {
            e.speaking = false;
            changed = true;
          }
        }
      }
      return { speaking: this.speaking(), changed };
    }

    speaking() {
      const ids = [];
      for (const [id, e] of this.entries) if (e.speaking) ids.push(id);
      return ids.sort();
    }
  }

  const api = { SpeakingTracker, DEFAULTS };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.TintaSpeaking = api;
  }
})(globalThis);
