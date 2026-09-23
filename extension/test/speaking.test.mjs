import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SpeakingTracker } = require("../speaking.js");

const OPTIONS = { windowMs: 400, minMutationsPerWindow: 3, startWindows: 2, endQuietMs: 800 };

function burst(tracker, id, from, to, stepMs) {
  for (let t = from; t < to; t += stepMs) tracker.record(id, t);
}

test("one window above the threshold does not start speaking", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 400, 50);
  assert.deepEqual(s.tick(400).speaking, []);
  assert.deepEqual(s.tick(800).speaking, []);
});

test("two consecutive windows above the threshold start speaking", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 800, 50);
  assert.equal(s.tick(400).changed, false);
  const r = s.tick(800);
  assert.equal(r.changed, true);
  assert.deepEqual(r.speaking, ["a"]);
});

test("a rate below the threshold does not start speaking", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 2000, 200);
  for (let t = 400; t <= 2000; t += 400) assert.deepEqual(s.tick(t).speaking, []);
});

test("speaking ends only after the quiet period", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 800, 50);
  s.tick(400);
  s.tick(800);
  assert.deepEqual(s.tick(1200).speaking, ["a"]);
  assert.deepEqual(s.tick(1400).speaking, ["a"]);
  const r = s.tick(1600);
  assert.equal(r.changed, true);
  assert.deepEqual(r.speaking, []);
});

test("a short pause does not end speaking", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 800, 50);
  s.tick(400);
  s.tick(800);
  s.tick(1200);
  burst(s, "a", 1300, 1600, 50);
  assert.deepEqual(s.tick(1600).speaking, ["a"]);
  assert.deepEqual(s.tick(2000).speaking, ["a"]);
});

test("a gap resets the start count", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 400, 50);
  s.tick(400);
  s.tick(800);
  burst(s, "a", 800, 1200, 50);
  assert.deepEqual(s.tick(1200).speaking, []);
});

test("the secondary hint counts as a window above the threshold", () => {
  const s = new SpeakingTracker(OPTIONS);
  s.setHint("b", true);
  s.tick(400);
  assert.deepEqual(s.tick(800).speaking, ["b"]);
  s.setHint("b", false);
  s.tick(1200);
  assert.deepEqual(s.tick(1600).speaking, []);
});

test("participants are independent and the result is sorted", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "z", 0, 800, 50);
  burst(s, "a", 0, 800, 50);
  burst(s, "m", 0, 800, 300);
  s.tick(400);
  assert.deepEqual(s.tick(800).speaking, ["a", "z"]);
});

test("remove drops a speaking participant", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 800, 50);
  s.tick(400);
  s.tick(800);
  s.remove("a");
  assert.deepEqual(s.speaking(), []);
});
