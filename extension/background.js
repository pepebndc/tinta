"use strict";

const HOST_NAME = "com.usetinta.tinta";
const MEET_ORIGIN = "https://meet.google.com";
const MESSAGE_TYPES = new Set(["meet_state", "active_speakers", "mic_state", "meeting_ended"]);
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
// While Tinta records, the service worker asks for the state, so that the badge shows an automatic stop.
const RECORDING_PING_MS = 5000;
// The maximum number of messages that wait for the host. The oldest message goes first when the queue is full.
const PENDING_MAX = 200;

let port = null;
let retryMs = RETRY_MIN_MS;
let retryTimer = null;
let nextAttemptAt = 0;
let pingTimer = null;
// Messages wait here until the host answers them. The host answers each message with one status, in order.
// The first `sent` messages are on the current port. After a disconnection, they go again on the next port.
const pending = [];
let sent = 0;

// What the popup shows. "host" is "connecting", "connected", or "missing".
// "error" is the error text from the app, or null.
const status = { host: "connecting", app: false, appKnown: false, error: null, recording: false, recordingSince: null };
// The latest call state for each Meet tab.
const calls = new Map();

function showStatus() {
  const paused = !status.recording && status.recordingSince !== null;
  chrome.action.setBadgeText({ text: status.recording ? "REC" : paused ? "II" : "" });
  chrome.action.setBadgeBackgroundColor({ color: status.recording ? "#c2413b" : "#292456" });
  // The badge shows a recording and a paused recording.
  const active = status.recordingSince !== null;
  if (active && !pingTimer) {
    pingTimer = setInterval(() => forward({ type: "ping", t: Date.now() }), RECORDING_PING_MS);
  } else if (!active && pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleRetry(delayMs) {
  if (retryTimer) clearTimeout(retryTimer);
  nextAttemptAt = Date.now() + delayMs;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delayMs);
}

function connect() {
  if (port) return;
  let p;
  try {
    p = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    status.host = "missing";
    scheduleRetry(RETRY_MAX_MS);
    return;
  }
  port = p;
  status.host = "connected";
  const connectedAt = Date.now();
  sent = 0;
  pending.unshift({ type: "hello", version: chrome.runtime.getManifest().version, t: connectedAt });
  flush();

  p.onMessage.addListener((msg) => {
    retryMs = RETRY_MIN_MS;
    if (!msg || msg.type !== "status") return;
    // The host answered the oldest message on this port. Without the app, the message has no receiver,
    // and the next start of the app gets the current call state from the next messages.
    if (sent > 0) {
      pending.shift();
      sent -= 1;
    }
    status.app = msg.app !== false;
    status.appKnown = true;
    status.error = typeof msg.error === "string" ? msg.error : null;
    // An app error does not give the recording state. The last known state stays.
    if (typeof msg.recording === "boolean") {
      status.recording = msg.recording;
      status.recordingSince = typeof msg.recording_since === "number" ? msg.recording_since : null;
    }
    showStatus();
  });

  p.onDisconnect.addListener(() => {
    // Read lastError so that Chrome does not log it as unchecked. A missing host is expected.
    const error = chrome.runtime.lastError;
    // A port that forward() dropped can disconnect after a new port connects.
    if (port !== p) return;
    port = null;
    sent = 0;
    status.app = false;
    status.appKnown = false;
    status.error = null;
    status.recording = false;
    status.recordingSince = null;
    showStatus();
    const hostMissing = error && /not found|forbidden/i.test(error.message || "");
    status.host = hostMissing ? "missing" : "connecting";
    const quickFailure = Date.now() - connectedAt < 1000;
    if (hostMissing || retryMs >= RETRY_MAX_MS) {
      scheduleRetry(RETRY_MAX_MS);
    } else {
      scheduleRetry(retryMs);
      retryMs = quickFailure ? Math.min(retryMs * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
    }
  });
}

// Sends a message to the host. A message waits for the next connection when the host does not answer it,
// because the app misses a call end that the extension sends only once.
function forward(msg) {
  // A ping is only useful now.
  if (msg.type === "ping" && !port) return;
  pending.push(msg);
  if (pending.length > PENDING_MAX) {
    pending.shift();
    if (sent > 0) sent -= 1;
  }
  if (!port && Date.now() >= nextAttemptAt) connect();
  flush();
}

function flush() {
  while (port && sent < pending.length) {
    try {
      port.postMessage(pending[sent]);
      sent += 1;
    } catch (e) {
      port = null;
      sent = 0;
      scheduleRetry(retryMs);
    }
  }
}

function remember(tabId, msg) {
  if (msg.type === "meeting_ended") {
    calls.delete(tabId);
    return;
  }
  const call = calls.get(tabId) || { meeting_code: msg.meeting_code, title: null, participants: [], speaking: [], mic_muted: null };
  if (msg.type === "meet_state") {
    call.meeting_code = msg.meeting_code;
    call.title = msg.title;
    call.participants = msg.participants;
    call.mic_muted = msg.mic_muted;
  } else if (msg.type === "mic_state") {
    call.mic_muted = msg.muted;
  } else if (msg.type === "active_speakers") {
    call.speaking = msg.speaking;
  }
  call.updated = Date.now();
  calls.set(tabId, call);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object") return;

  // Messages from the content script on a Meet tab.
  if (sender.tab && sender.origin === MEET_ORIGIN && MESSAGE_TYPES.has(msg.type)) {
    remember(sender.tab.id, msg);
    forward(msg);
    return;
  }

  // Requests from the popup. The popup has no tab.
  if (!sender.tab && msg.type === "popup_state") {
    if (status.host === "connected") forward({ type: "ping", t: Date.now() });
    reply({ status, call: calls.get(msg.tabId) || null });
  }
});

// A closed tab cannot send its own end message.
chrome.tabs.onRemoved.addListener((tabId) => {
  const call = calls.get(tabId);
  calls.delete(tabId);
  if (call) forward({ type: "meeting_ended", meeting_code: call.meeting_code, t: Date.now(), left_at: Date.now() });
});

showStatus();
connect();
