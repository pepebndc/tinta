// Chat message logic. It has no DOM access, so Node tests can load it.
(function (root) {
  "use strict";

  const DEFAULTS = {
    // The longest message text, in characters. The service worker and the app apply the same limit.
    maxTextLength: 2000,
    // A message that the page shows with a time this much before the first read is an older message,
    // for example a message that arrived while the chat panel was closed. It keeps the time of the page.
    lateMs: 120000,
    // The maximum number of messages that the log remembers in one call.
    maxSeen: 5000,
  };

  // Removes control characters except line breaks, and extra spaces. Keeps at most one empty line.
  function cleanText(value, maxLength) {
    if (typeof value !== "string") return null;
    const lines = value
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, " ")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim());
    const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    return text ? text.slice(0, maxLength) : null;
  }

  // Reads a time of day that the page shows, such as "10:32", "22:05", "10:32 PM", or "10:32 p. m.".
  // Returns the epoch milliseconds of that minute on the day of `now`, or of the day before when the time is later than `now`.
  function parseClock(text, now) {
    if (typeof text !== "string") return null;
    const m = /^(\d{1,2})[:.h](\d{2})\s*(?:([ap])\.?\s?m\.?)?$/i.exec(text.trim());
    if (!m) return null;
    let hours = Number(m[1]);
    const minutes = Number(m[2]);
    if (minutes > 59) return null;
    if (m[3]) {
      if (hours < 1 || hours > 12) return null;
      hours = (hours % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
    } else if (hours > 23) {
      return null;
    }
    const date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
    let t = date.getTime();
    if (t > now + 60000) t -= 86400000;
    return t;
  }

  // Remembers the messages of one call, and returns the messages that are new or changed.
  class ChatLog {
    constructor(options) {
      this.options = Object.assign({}, DEFAULTS, options || {});
      this.seen = new Map();
    }

    // `entries` are the messages on the page: { id, sender, is_self, text, shown_at }.
    // `shown_at` is the time that the page shows for the message, or null.
    update(entries, now) {
      const out = [];
      for (const e of entries) {
        const text = cleanText(e.text, this.options.maxTextLength);
        if (typeof e.id !== "string" || !e.id || !text) continue;
        const sender = typeof e.sender === "string" ? e.sender : "";
        const isSelf = e.is_self === true;
        const prev = this.seen.get(e.id);
        if (prev && prev.text === text && prev.sender === sender && prev.is_self === isSelf) continue;
        const late = typeof e.shown_at === "number" && now - e.shown_at >= this.options.lateMs;
        const message = { id: e.id, sender, is_self: isSelf, text, sent_at: prev ? prev.sent_at : late ? e.shown_at : now };
        this.seen.delete(e.id);
        this.seen.set(e.id, message);
        out.push(message);
      }
      while (this.seen.size > this.options.maxSeen) this.seen.delete(this.seen.keys().next().value);
      return out;
    }

    clear() {
      this.seen.clear();
    }
  }

  // Splits a list into groups of at most `size` items.
  function batches(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  const api = { ChatLog, DEFAULTS, cleanText, parseClock, batches };
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.TintaChat = api;
  }
})(globalThis);
