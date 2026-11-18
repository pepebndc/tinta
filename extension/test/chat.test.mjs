import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ChatLog, cleanText, parseClock, batches } = require("../chat.js");

const NOW = new Date(2026, 10, 18, 15, 30, 20).getTime();
const at = (h, m, dayOffset = 0) => new Date(2026, 10, 18 + dayOffset, h, m, 0, 0).getTime();

test("the log returns only new and changed messages", () => {
  const log = new ChatLog();
  const first = log.update([{ id: "a", sender: "Ana", text: "Hello" }], NOW);
  assert.deepEqual(first, [{ id: "a", sender: "Ana", is_self: false, text: "Hello", sent_at: NOW }]);
  assert.deepEqual(log.update([{ id: "a", sender: "Ana", text: "Hello" }], NOW + 1000), []);
  const edited = log.update([{ id: "a", sender: "Ana", text: "Hello all" }], NOW + 2000);
  assert.equal(edited.length, 1);
  assert.equal(edited[0].sent_at, NOW, "a changed message keeps its first time");
  log.clear();
  assert.equal(log.update([{ id: "a", sender: "Ana", text: "Hello all" }], NOW).length, 1);
});

test("an older message keeps the time that the page shows", () => {
  const log = new ChatLog();
  const [late, recent] = log.update(
    [
      { id: "a", sender: "Ana", text: "Earlier", shown_at: at(15, 20) },
      { id: "b", sender: "Bo", text: "Now", shown_at: at(15, 30) },
    ],
    NOW,
  );
  assert.equal(late.sent_at, at(15, 20));
  assert.equal(recent.sent_at, NOW);
});

test("messages without an ID or text are skipped", () => {
  const log = new ChatLog();
  assert.deepEqual(log.update([{ id: "", text: "Hi" }, { id: "a", text: "  \n " }, { id: "b" }], NOW), []);
});

test("the text keeps line breaks and loses control characters", () => {
  assert.equal(cleanText("  one\u0007two  \r\n\n\n\nthree   four ", 100), "one two\n\nthree four");
  assert.equal(cleanText("abcdef", 3), "abc");
  assert.equal(cleanText(" ", 3), null);
  assert.equal(cleanText(5, 3), null);
});

test("the page time reads 24-hour and 12-hour forms", () => {
  assert.equal(parseClock("15:20", NOW), at(15, 20));
  assert.equal(parseClock("3:20 PM", NOW), at(15, 20));
  assert.equal(parseClock("3:20 p. m.", NOW), at(15, 20));
  assert.equal(parseClock("12:05 AM", NOW), at(0, 5));
  assert.equal(parseClock("23:50", NOW), at(23, 50, -1), "a time later than now is from the day before");
  assert.equal(parseClock("Ana", NOW), null);
  assert.equal(parseClock("25:00", NOW), null);
  assert.equal(parseClock("13:00 PM", NOW), null);
});

test("batches split a list", () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batches([], 2), []);
});
