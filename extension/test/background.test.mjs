import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const MEET = { tab: { id: 7 }, origin: "https://meet.google.com", id: "tinta" };

/** Runs background.js with a fake Chrome API. Each native port records the messages that it receives. */
function load() {
  const ports = [];
  let onMessage = null;
  const timers = [];
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
          disconnect() {
            port.connected = false;
            for (const f of port.disconnectListeners) f();
          },
        };
        ports.push(port);
        return port;
      },
      onMessage: { addListener: (f) => (onMessage = f) },
    },
    tabs: { onRemoved: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  };
  const context = {
    chrome,
    Date,
    Math,
    setTimeout: (f) => timers.push(f),
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  };
  vm.runInNewContext(SOURCE, context);
  return {
    ports,
    fromMeet: (msg) => onMessage(msg, MEET, () => {}),
    runTimers: () => timers.splice(0).forEach((f) => f()),
  };
}

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
