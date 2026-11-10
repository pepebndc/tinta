import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SpeakingTracker } = require("../speaking.js");

const OPTIONS = { windowMs: 400, minMutationsPerWindow: 3, startMs: 600, endQuietMs: 800 };
// The content script evaluates the tracker every 200 ms.
const TICK = 200;

function burst(tracker, id, from, to, stepMs) {
  for (let t = from; t < to; t += stepMs) tracker.record(id, t);
}

/** Ticks from `from` to `to`, both included. Returns the times at which the speaking state changed. */
function run(tracker, from, to, stepMs = TICK) {
  const changes = [];
  for (let t = from; t <= to; t += stepMs) {
    if (tracker.tick(t).changed) changes.push(t);
  }
  return changes;
}

test("one burst of mutations does not start speaking", () => {
  const s = new SpeakingTracker(OPTIONS);
  s.record("a", 1000, 3);
  assert.deepEqual(run(s, 1200, 4000), []);
  assert.deepEqual(s.speaking(), []);
});

test("a short animation does not start speaking", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 1000, 1300, 25);
  assert.deepEqual(run(s, 1200, 4000), []);
});

test("continuous activity starts speaking after the start time", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 1000, 4000, 50);
  assert.deepEqual(run(s, 1200, 1600), []);
  const r = s.tick(1800);
  assert.equal(r.changed, true);
  assert.deepEqual(r.speaking, ["a"]);
});

test("the start does not depend on the tick rate", () => {
  for (const step of [100, 200, 400, 1000]) {
    const s = new SpeakingTracker(OPTIONS);
    burst(s, "a", 1000, 6000, 50);
    const changes = run(s, 1000 + step, 6000, step);
    assert.equal(changes.length, 1, `tick ${step} ms`);
    assert.ok(changes[0] - 1000 >= OPTIONS.startMs && changes[0] - 1000 <= OPTIONS.startMs + 2 * step, `tick ${step} ms`);

    const single = new SpeakingTracker(OPTIONS);
    single.record("a", 1000, 3);
    assert.deepEqual(run(single, 1000 + step, 6000, step), [], `tick ${step} ms`);
  }
});

test("a rate below the threshold does not start speaking", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 4000, 200);
  assert.deepEqual(run(s, 200, 4000), []);
});

test("speaking ends only after the quiet period", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 2000, 50);
  run(s, 200, 2200);
  // The last tick above the threshold is at 2200.
  assert.deepEqual(run(s, 2400, 2800), []);
  assert.deepEqual(s.speaking(), ["a"]);
  const r = s.tick(3000);
  assert.equal(r.changed, true);
  assert.deepEqual(r.speaking, []);
});

test("a short pause does not end speaking", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 2000, 50);
  burst(s, "a", 2600, 4000, 50);
  assert.deepEqual(run(s, 200, 4000), [800]);
  assert.deepEqual(s.speaking(), ["a"]);
});

test("a gap resets the start time", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 400, 50);
  burst(s, "a", 800, 1200, 50);
  assert.deepEqual(run(s, 200, 1600), []);
});

test("the secondary hint counts as activity above the threshold", () => {
  const s = new SpeakingTracker(OPTIONS);
  s.setHint("b", true);
  assert.deepEqual(run(s, 200, 800), [800]);
  assert.deepEqual(s.speaking(), ["b"]);
  s.setHint("b", false);
  assert.deepEqual(run(s, 1000, 1600), [1600]);
  assert.deepEqual(s.speaking(), []);
});

test("a cleared hint ends speaking, and it adds no participant", () => {
  const s = new SpeakingTracker(OPTIONS);
  s.setHint("b", true);
  run(s, 200, 800);
  s.clearHint("b");
  s.clearHint("unknown");
  run(s, 1000, 60000);
  assert.deepEqual(s.speaking(), []);
  assert.equal(s.entries.has("unknown"), false);
});

test("participants are independent and the result is sorted", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "z", 0, 2000, 50);
  burst(s, "a", 0, 2000, 50);
  burst(s, "m", 0, 2000, 300);
  run(s, 200, 2000);
  assert.deepEqual(s.speaking(), ["a", "z"]);
});

test("remove drops a speaking participant", () => {
  const s = new SpeakingTracker(OPTIONS);
  burst(s, "a", 0, 2000, 50);
  run(s, 200, 2000);
  assert.deepEqual(s.speaking(), ["a"]);
  s.remove("a");
  assert.deepEqual(s.speaking(), []);
});
