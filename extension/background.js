"use strict";

const HOST_NAME = "app.tinta";
const MEET_ORIGIN = "https://meet.google.com";
const MESSAGE_TYPES = new Set(["meet_state", "active_speakers", "mic_state", "meeting_ended"]);
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;

let port = null;
let retryMs = RETRY_MIN_MS;
let retryTimer = null;
let nextAttemptAt = 0;

// What the popup shows. "host" is "connecting", "connected", or "missing".
const status = { host: "connecting", app: false, appKnown: false, recording: false, recordingSince: null };
// The latest call state for each Meet tab.
const calls = new Map();

function showStatus() {
  const paused = !status.recording && status.recordingSince !== null;
  chrome.action.setBadgeText({ text: status.recording ? "REC" : paused ? "II" : "" });
  chrome.action.setBadgeBackgroundColor({ color: status.recording ? "#c2413b" : "#292456" });
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

  p.onMessage.addListener((msg) => {
    retryMs = RETRY_MIN_MS;
    if (msg && msg.type === "status" && typeof msg.recording === "boolean") {
      status.app = msg.app !== false;
      status.appKnown = true;
      status.recording = msg.recording;
      status.recordingSince = typeof msg.recording_since === "number" ? msg.recording_since : null;
      showStatus();
    }
  });

  p.onDisconnect.addListener(() => {
    // Read lastError so that Chrome does not log it as unchecked. A missing host is expected.
    const error = chrome.runtime.lastError;
    port = null;
    status.app = false;
    status.appKnown = false;
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

function forward(msg) {
  if (!port && Date.now() >= nextAttemptAt) connect();
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch (e) {
    port = null;
    scheduleRetry(retryMs);
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
