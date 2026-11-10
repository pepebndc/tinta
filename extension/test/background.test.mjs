import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const MEET = { tab: { id: 7 }, origin: "https://meet.google.com", id: "tinta" };

/** Runs background.js with a fake Chrome API and a clock that the test moves. Each native port records the messages that it receives. */
function load() {
  const ports = [];
  let onMessage = null;
  let onRemoved = null;
  const timers = [];
  const intervals = new Map();
  let nextInterval = 1;
  const clock = { now: 1_000_000 };
  const chrome = {
    runtime: {
      id: "tinta",
      lastError: null,
      getManifest: () => ({ version: "test" }),
      connectNative() {
        const port = {
          received: [],
          connected: true,
          messageListeners: [],
          disconnectListeners: [],
          postMessage(msg) {
            if (!port.connected) throw new Error("Attempting to use a disconnected port object");
            port.received.push(msg);
          },
          onMessage: { addListener: (f) => port.messageListeners.push(f) },
          onDisconnect: { addListener: (f) => port.disconnectListeners.push(f) },
          reply(fields = {}) {
            for (const f of port.messageListeners) f({ type: "status", app: true, recording: false, ...fields });
          },
          disconnect(error) {
            port.connected = false;
            chrome.runtime.lastError = error ? { message: error } : null;
            for (const f of port.disconnectListeners) f();
            chrome.runtime.lastError = null;
          },
        };
        ports.push(port);
        return port;
      },
      onMessage: { addListener: (f) => (onMessage = f) },
    },
    tabs: { onRemoved: { addListener: (f) => (onRemoved = f) } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  const context = {
    chrome,
    Date: { now: () => clock.now },
    Math,
    setTimeout: (f) => timers.push(f),
    clearTimeout() {},
    setInterval(f, ms) {
      intervals.set(nextInterval, { f, ms, due: clock.now + ms });
      return nextInterval++;
    },
    clearInterval: (id) => intervals.delete(id),
  };
  vm.runInNewContext(SOURCE, context);
  return {
    ports,
    fromMeet: (msg, tabId = MEET.tab.id) => onMessage(msg, { ...MEET, tab: { id: tabId } }, () => {}),
    from: (msg, sender) => onMessage(msg, sender, () => {}),
    popup(tabId = MEET.tab.id) {
      let result = null;
      onMessage({ type: "popup_state", tabId }, { id: "tinta" }, (r) => (result = r));
      return result;
    },
    closeTab: (tabId) => onRemoved(tabId),
    runTimers: () => timers.splice(0).forEach((f) => f()),
    /** Moves the clock in steps of 1 second and runs the intervals that are due. */
    advance(ms) {
      for (const end = clock.now + ms; clock.now < end; ) {
        clock.now += 1000;
        for (const interval of [...intervals.values()]) {
          if (clock.now >= interval.due) {
            interval.due = clock.now + interval.ms;
            interval.f();
          }
        }
      }
    },
    /** Moves the clock without the intervals, as a pause of the service worker does. */
    pause: (ms) => (clock.now += ms),
  };
}

const CODE = "abc-defg-hij";
const state = (extra = {}) => ({ type: "meet_state", meeting_code: CODE, participants: [], ...extra });

const types = (port) => port.received.map((m) => m.type);

test("messages go to the host in order after hello", () => {
  const ext = load();
  ext.fromMeet({ type: "meet_state", meeting_code: "abc-defg-hij", participants: [] });
  ext.fromMeet({ type: "active_speakers", meeting_code: "abc-defg-hij", speaking: [] });
  assert.deepEqual(types(ext.ports[0]), ["hello", "meet_state", "active_speakers"]);
});

test("an unanswered call end goes again on the next port", () => {
  const ext = load();
  const first = ext.ports[0];
  first.reply();
  ext.fromMeet({ type: "meeting_ended", meeting_code: "abc-defg-hij", t: 1 });
  assert.deepEqual(types(first), ["hello", "meeting_ended"]);
  // The host stops before it answers the call end.
  first.disconnect();
  ext.runTimers();
  const second = ext.ports[1];
  assert.deepEqual(types(second), ["hello", "meeting_ended"]);
});

test("answered messages do not go again", () => {
  const ext = load();
  const first = ext.ports[0];
  ext.fromMeet({ type: "meet_state", meeting_code: "abc-defg-hij", participants: [] });
  first.reply();
  first.reply();
  first.disconnect();
  ext.runTimers();
  assert.deepEqual(types(ext.ports[1]), ["hello"]);
});

test("a message that arrives while the host is away waits for the next port", () => {
  const ext = load();
  const first = ext.ports[0];
  first.reply();
  first.disconnect();
  ext.fromMeet({ type: "meeting_ended", meeting_code: "abc-defg-hij", t: 1 });
  assert.equal(ext.ports.length, 1);
  ext.runTimers();
  assert.deepEqual(types(ext.ports[1]), ["hello", "meeting_ended"]);
});

test("each connection sends one hello", () => {
  const ext = load();
  // The host stops three times before it answers.
  for (let i = 0; i < 3; i += 1) {
    ext.ports[i].disconnect();
    ext.runTimers();
  }
  assert.deepEqual(types(ext.ports[3]), ["hello"]);
});

test("a message of the wrong shape does not go to the host", () => {
  const ext = load();
  const port = ext.ports[0];
  ext.fromMeet({ type: "meet_state", meeting_code: "not a code", participants: [] });
  ext.fromMeet({ type: "meet_state", meeting_code: CODE, participants: "all" });
  ext.fromMeet({ type: "meet_state", meeting_code: CODE, participants: [{ name: "No ID" }] });
  ext.fromMeet({ type: "active_speakers", meeting_code: CODE, speaking: [1] });
  ext.fromMeet({ type: "captions", meeting_code: CODE, text: "hello" });
  ext.from(state(), { ...MEET, origin: "https://example.com" });
  ext.from(state(), { ...MEET, id: "other" });
  assert.deepEqual(types(port), ["hello"]);
});

test("only the known fields go to the host, with size limits", () => {
  const ext = load();
  const long = "x".repeat(300000);
  const participants = Array.from({ length: 150 }, (_, i) => ({ id: "p" + i, name: long, is_self: "yes", extra: long }));
  ext.fromMeet({ ...state({ participants }), title: long, self_name: 7, mic_muted: "no", t: 5, extra: long });
  ext.fromMeet({ type: "mic_state", meeting_code: CODE, t: 6, muted: true, extra: long });
  ext.fromMeet({ type: "active_speakers", meeting_code: CODE, t: 7, speaking: ["p1", long] });
  const [, sent, mic, speakers] = ext.ports[0].received;
  assert.deepEqual(Object.keys(sent).sort(), ["meeting_code", "mic_muted", "participants", "self_name", "t", "title", "type"]);
  assert.equal(sent.participants.length, 100);
  assert.deepEqual(Object.keys(sent.participants[0]).sort(), ["id", "is_self", "name"]);
  assert.equal(sent.participants[0].name.length, 200);
  assert.equal(sent.participants[0].is_self, false);
  assert.equal(sent.title.length, 200);
  assert.equal(sent.self_name, null);
  assert.equal(sent.mic_muted, null);
  assert.equal(JSON.stringify(mic), JSON.stringify({ type: "mic_state", meeting_code: CODE, t: 6, muted: true }));
  assert.equal(speakers.speaking[1].length, 200);
  assert.ok(JSON.stringify(sent).length < 256 * 1024);
});

test("a call that is open in two tabs ends when the last tab leaves", () => {
  const ext = load();
  const port = ext.ports[0];
  ext.fromMeet(state(), 1);
  ext.fromMeet(state(), 2);
  ext.fromMeet({ type: "meeting_ended", meeting_code: CODE, t: 1, left_at: 1 }, 1);
  assert.deepEqual(types(port), ["hello", "meet_state", "meet_state"]);
  ext.closeTab(2);
  assert.deepEqual(types(port), ["hello", "meet_state", "meet_state", "meeting_ended"]);
  // A tab that is not in a call sends no end.
  ext.closeTab(3);
  assert.equal(port.received.length, 4);
});

test("the end of one call does not wait for a tab in another call", () => {
  const ext = load();
  ext.fromMeet(state(), 1);
  ext.fromMeet(state({ meeting_code: "xyz-abcd-efg" }), 2);
  ext.closeTab(1);
  assert.equal(ext.ports[0].received.at(-1).type, "meeting_ended");
  assert.equal(ext.ports[0].received.at(-1).meeting_code, CODE);
});

test("a tab that is silent for 20 seconds ends its call at its last message", () => {
  const ext = load();
  const port = ext.ports[0];
  ext.fromMeet(state({ t: 1 }));
  for (let i = 0; i < 6; i += 1) {
    ext.advance(5000);
    ext.fromMeet({ type: "active_speakers", meeting_code: CODE, speaking: [] });
  }
  assert.ok(!types(port).includes("meeting_ended"));
  const lastMessageAt = ext.popup().call.updated;
  ext.advance(25000);
  const end = port.received.at(-1);
  assert.equal(end.type, "meeting_ended");
  assert.equal(end.left_at, lastMessageAt);
  assert.equal(ext.popup().call, null);
});

test("a pause of the service worker does not end a call", () => {
  const ext = load();
  ext.fromMeet(state());
  ext.pause(600000);
  ext.advance(5000);
  assert.ok(!types(ext.ports[0]).includes("meeting_ended"));
  ext.advance(25000);
  assert.equal(ext.ports[0].received.at(-1).type, "meeting_ended");
});

test("a host that Chrome cannot start shows as missing", () => {
  const ext = load();
  ext.ports[0].disconnect("Failed to start native messaging host.");
  assert.equal(ext.popup().status.host, "missing");
});

test("a host that stops at once three times shows as failing until it answers", () => {
  const ext = load();
  for (let i = 0; i < 2; i += 1) {
    ext.ports[i].disconnect("Native host has exited.");
    assert.equal(ext.popup().status.host, "connecting");
    ext.runTimers();
  }
  ext.ports[2].disconnect("Native host has exited.");
  assert.equal(ext.popup().status.host, "failing");
  ext.runTimers();
  assert.equal(ext.popup().status.host, "failing");
  ext.ports[3].reply();
  assert.equal(ext.popup().status.host, "connected");
});

test("the popup starts a connection when no attempt is pending", () => {
  const ext = load();
  ext.ports[0].disconnect("Specified native messaging host not found.");
  // The next attempt is 30 seconds away. The popup moves it to 2 seconds.
  ext.popup();
  assert.equal(ext.ports.length, 1);
  ext.pause(2000);
  ext.popup();
  assert.equal(ext.ports.length, 2);
  assert.equal(ext.popup().status.host, "missing");
});
