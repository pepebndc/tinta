"use strict";

const HOST_NAME = "com.usetinta.tinta";
const MEET_ORIGIN = "https://meet.google.com";
const MEETING_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
// The limits of the content script. The service worker applies them again, because the page is untrusted.
const MAX_STRING = 200;
const MAX_PARTICIPANTS = 100;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
// While the popup is open, the service worker tries to connect at this interval.
const POPUP_RETRY_MS = 2000;
// After this number of connections that end at once, the popup shows that Tinta does not accept the connection.
const FAILURES_MAX = 3;
// A Meet tab in a call sends a message every 5 seconds. A tab that is silent for this time is not in the call.
const SILENT_TAB_MS = 20000;
const SILENT_CHECK_MS = 5000;
// While Tinta records, the service worker asks for the state, so that the badge shows an automatic stop.
const RECORDING_PING_MS = 5000;
// The maximum number of messages that wait for the host. The oldest message goes first when the queue is full.
const PENDING_MAX = 200;

let port = null;
let retryMs = RETRY_MIN_MS;
let retryTimer = null;
let nextAttemptAt = 0;
let pingTimer = null;
let failures = 0;
let silentTimer = null;
let lastSilentCheck = 0;
// Messages wait here until the host answers them. The host answers each message with one status, in order.
// The first `sent` messages are on the current port. After a disconnection, they go again on the next port.
const pending = [];
let sent = 0;

// What the popup shows. "host" is "connecting", "connected", "missing", or "failing".
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

// A "hello" belongs to one connection. The next connection sends its own.
function dropHello() {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i].type === "hello") pending.splice(i, 1);
  }
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
  const connectedAt = Date.now();
  sent = 0;
  pending.unshift({ type: "hello", version: chrome.runtime.getManifest().version, t: connectedAt });
  flush();

  p.onMessage.addListener((msg) => {
    retryMs = RETRY_MIN_MS;
    failures = 0;
    // The host state stays "missing" or "failing" until the host answers, so the popup does not change at each attempt.
    status.host = "connected";
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
    dropHello();
    status.app = false;
    status.appKnown = false;
    status.error = null;
    status.recording = false;
    status.recordingSince = null;
    showStatus();
    // Chrome cannot start a host that is not installed, or a host whose app moved.
    const hostMissing = error && /not found|forbidden|failed to start/i.test(error.message || "");
    const quickFailure = Date.now() - connectedAt < 1000;
    failures = quickFailure ? failures + 1 : 0;
    status.host = hostMissing ? "missing" : failures >= FAILURES_MAX ? "failing" : "connecting";
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
      dropHello();
      scheduleRetry(retryMs);
    }
  }
}

function text(value) {
  return typeof value === "string" ? value.slice(0, MAX_STRING) : null;
}

function time(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flag(value) {
  return typeof value === "boolean" ? value : null;
}

// Builds the message for the host from the known fields of a content script message.
// Returns null for a message of the wrong shape. Other fields of the message do not go to the host.
function messageForHost(msg) {
  if (typeof msg.meeting_code !== "string" || !MEETING_CODE.test(msg.meeting_code)) return null;
  const base = { type: msg.type, meeting_code: msg.meeting_code, t: time(msg.t, Date.now()) };
  if (msg.type === "meet_state") {
    if (!Array.isArray(msg.participants)) return null;
    const participants = [];
    for (const p of msg.participants.slice(0, MAX_PARTICIPANTS)) {
      if (!p || typeof p.id !== "string" || !p.id) return null;
      participants.push({ id: text(p.id), name: text(p.name) || "", is_self: p.is_self === true });
    }
    return { ...base, title: text(msg.title), self_name: text(msg.self_name), participants, mic_muted: flag(msg.mic_muted) };
  }
  if (msg.type === "active_speakers") {
    if (!Array.isArray(msg.speaking) || !msg.speaking.every((id) => typeof id === "string")) return null;
    return { ...base, speaking: msg.speaking.slice(0, MAX_PARTICIPANTS).map(text) };
  }
  if (msg.type === "mic_state") return { ...base, muted: flag(msg.muted) };
  if (msg.type === "meeting_ended") return { ...base, left_at: time(msg.left_at, base.t) };
  return null;
}

// True when another Meet tab is in the call with this meeting code.
function inOtherTab(tabId, code) {
  for (const [id, call] of calls) {
    if (id !== tabId && call.meeting_code === code) return true;
  }
  return false;
}

// The call of a tab ended. The app gets the end only when no other tab is in the same call.
function endCall(tabId, code, t, leftAt) {
  calls.delete(tabId);
  watchSilentTabs();
  if (!inOtherTab(tabId, code)) forward({ type: "meeting_ended", meeting_code: code, t, left_at: leftAt });
}

// A tab that crashes or reloads sends no end message. Its call ends at its last message.
function checkSilentTabs() {
  const now = Date.now();
  // After a pause of the service worker or of the computer, the tabs get time to send a message.
  const paused = now - lastSilentCheck > 2 * SILENT_CHECK_MS;
  lastSilentCheck = now;
  for (const [tabId, call] of [...calls]) {
    if (paused) call.updated = now;
    else if (now - call.updated >= SILENT_TAB_MS) endCall(tabId, call.meeting_code, now, call.updated);
  }
}

function watchSilentTabs() {
  if (calls.size > 0 && !silentTimer) {
    lastSilentCheck = Date.now();
    silentTimer = setInterval(checkSilentTabs, SILENT_CHECK_MS);
  } else if (calls.size === 0 && silentTimer) {
    clearInterval(silentTimer);
    silentTimer = null;
  }
}

function remember(tabId, msg) {
  const call = calls.get(tabId) || { meeting_code: msg.meeting_code, title: null, participants: [], speaking: [], mic_muted: null };
  if (msg.type === "meet_state") {
    call.title = msg.title;
    call.participants = msg.participants;
    call.mic_muted = msg.mic_muted;
  } else if (msg.type === "mic_state") {
    call.mic_muted = msg.muted;
  } else if (msg.type === "active_speakers") {
    call.speaking = msg.speaking;
  }
  call.meeting_code = msg.meeting_code;
  call.updated = Date.now();
  calls.set(tabId, call);
  watchSilentTabs();
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object") return;

  // Messages from the content script on a Meet tab.
  if (sender.tab && sender.origin === MEET_ORIGIN) {
    const clean = messageForHost(msg);
    if (!clean) return;
    if (clean.type === "meeting_ended") {
      endCall(sender.tab.id, clean.meeting_code, clean.t, clean.left_at);
    } else {
      remember(sender.tab.id, clean);
      forward(clean);
    }
    return;
  }

  // Requests from the popup. The popup has no tab.
  if (!sender.tab && msg.type === "popup_state") {
    if (port) forward({ type: "ping", t: Date.now() });
    else if (Date.now() >= nextAttemptAt) connect();
    else if (nextAttemptAt - Date.now() > POPUP_RETRY_MS) scheduleRetry(POPUP_RETRY_MS);
    reply({ status, call: calls.get(msg.tabId) || null });
  }
});

// A closed tab cannot send its own end message.
chrome.tabs.onRemoved.addListener((tabId) => {
  const call = calls.get(tabId);
  if (call) endCall(tabId, call.meeting_code, Date.now(), Date.now());
});

showStatus();
connect();
