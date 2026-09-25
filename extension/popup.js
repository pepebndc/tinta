"use strict";

const find = (id) => document.getElementById(id);
const MEET_ORIGIN = "https://meet.google.com";
let tabId = null;
let meetTab = false;
// The participant list changes only when this key changes, so that the list keeps its scroll position.
let peopleKey = null;

// The same name has the same color as in the Tinta app.
function nameTone(name) {
  let hash = 0;
  for (const c of String(name)) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return "name-tone-" + (hash % 6);
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
}

function renderApp(status) {
  const dot = find("app-dot");
  if (status.host === "missing") {
    dot.className = "dot off";
    find("app-title").textContent = "Tinta is not installed";
    find("app-detail").textContent = "Install Tinta and open it once. Then restart Chrome.";
  } else if (status.appKnown && status.app) {
    dot.className = "dot ok";
    find("app-title").textContent = "Connected to Tinta";
    find("app-detail").textContent = status.error ? "Tinta reports an error: " + status.error : "";
  } else if (status.appKnown) {
    dot.className = "dot off";
    find("app-title").textContent = "Tinta is not running";
    find("app-detail").textContent = "Open Tinta on this Mac.";
  } else {
    dot.className = "dot";
    find("app-title").textContent = "Connecting to Tinta…";
    find("app-detail").textContent = "";
  }

  const since = status.recordingSince;
  find("rec-row").hidden = since === null;
  if (since !== null) {
    find("rec-dot").className = status.recording ? "dot rec" : "dot rec paused";
    find("rec-title").textContent = status.recording ? "Recording in Tinta" : "Recording paused";
    find("rec-detail").textContent = "Tell everyone in the call that you record and transcribe it.";
    find("rec-timer").textContent = clock(Date.now() - since);
  }
}

function renderPeople(call) {
  const key = call ? JSON.stringify([call.participants, call.speaking]) : null;
  if (key === peopleKey) return;
  peopleKey = key;
  const people = find("people");
  people.replaceChildren();
  if (!call) return;
  const speaking = new Set(call.speaking);
  const sorted = [...call.participants].sort((a, b) => Number(speaking.has(b.id)) - Number(speaking.has(a.id)));
  for (const p of sorted) {
    const item = document.createElement("li");
    if (speaking.has(p.id)) item.className = "speaking";
    const name = document.createElement("span");
    name.className = "person " + nameTone(p.name);
    name.textContent = (p.name || "Unknown participant") + (p.is_self ? " (you)" : "");
    const state = document.createElement("span");
    state.className = "state";
    state.textContent = speaking.has(p.id) ? "speaking" : "";
    item.append(name, state);
    people.append(item);
  }
}

function renderCall(call, status) {
  renderPeople(call);
  find("debug").hidden = !call;
  const mic = find("mic-state");
  mic.hidden = !call || typeof call.mic_muted !== "boolean";
  if (!mic.hidden) {
    mic.className = call.mic_muted ? "mic-state muted" : "mic-state";
    mic.textContent = call.mic_muted
      ? "Your microphone is muted in Meet." + (status.recording ? " Tinta does not record it." : "")
      : "Your microphone is on in Meet.";
  }
  if (!call) {
    find("call-title").textContent = "No Google Meet call in this tab.";
    find("call-detail").textContent = meetTab
      ? "Join the call to see the participants."
      : "Open this popup in the tab of a Meet call.";
    return;
  }
  find("call-title").textContent = call.title || call.meeting_code;
  const count = call.participants.length;
  const canStart = status.appKnown && status.app && status.recordingSince === null;
  find("call-detail").textContent =
    count + (count === 1 ? " person" : " people") + (canStart ? ". Start the recording in Tinta." : ".");
}

async function refresh() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "popup_state", tabId });
    if (!result) return;
    renderApp(result.status);
    renderCall(result.call, result.status);
  } catch (e) {
    // The service worker restarts after a pause. The next refresh reaches it.
  }
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  // The content script match gives the extension access to the URL of a Meet tab.
  meetTab = Boolean(tab && tab.url && tab.url.startsWith(MEET_ORIGIN + "/"));
  const outline = find("outline");
  if (tabId !== null) {
    chrome.tabs
      .sendMessage(tabId, { type: "tinta_debug" })
      .then((reply) => {
        if (reply) outline.checked = reply.debug;
      })
      .catch(() => {});
  }
  outline.addEventListener("change", () => {
    if (tabId !== null) chrome.tabs.sendMessage(tabId, { type: "tinta_debug", on: outline.checked }).catch(() => {});
  });
  await refresh();
  setInterval(refresh, 1000);
}

start();
