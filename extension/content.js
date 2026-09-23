// Reads only the meeting code, the meeting title, the participant list, and speaking state.
// It does not read captions, chat, or other page content, and it does not capture audio.
(function () {
  "use strict";

  const CONFIG = {
    meetingCodePattern: /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/,
    titlePrefixPattern: /^Meet\s*[-\u2013\u2014:]\s*/,
    titleSelectors: ["[data-meeting-title]"],
    participantSelector: "[data-participant-id]",
    participantIdAttribute: "data-participant-id",
    peoplePanelItemSelector: '[role="listitem"][data-participant-id]',
    selfNameAttribute: "data-self-name",
    nameSelectors: ["[data-self-name]", "[data-name]"],
    nameAttributes: ["data-self-name", "data-name"],
    selfAttributes: ["data-is-self", "data-is-local", "data-self"],
    selfMarkers: ["(You)", "You", "(Tú)", "Tú", "(Tu)", "Tu", "(Vous)", "Vous", "(Du)", "Du"],
    presentationPattern: /presentation|presenting|presentaci[oó]n|presentando|pr[ée]sentation/i,
    skipSubtreeSelector: "video, canvas, svg, button, i, style, script, .material-icons, .material-icons-extended, .google-material-icons, .google-symbols",
    iconTextPattern: /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/,
    uiTexts: ["more_vert", "mic", "mic_off", "keep", "push_pin", "pin", "Pin", "Unpin", "More options", "Presentation"],
    speakingIndicatorSelectors: [],
    speakingLabelPattern: /\b(is speaking|speaking|est[aá] hablando|hablando|parle)\b/i,
    ignoreMutationSelector: "video, canvas",
    maxNameLength: 80,
    maxStringLength: 200,
    maxParticipants: 100,
    speaking: { windowMs: 400, minMutationsPerWindow: 3, startWindows: 2, endQuietMs: 800 },
    tickMs: 200,
    rescanDelayMs: 250,
    rescanIntervalMs: 2000,
    stateHeartbeatMs: 10000,
    speakersHeartbeatMs: 5000,
    leaveGraceMs: 3000,
    debugStorageKey: "tinta-debug",
    debugAttribute: "data-tinta-speaking",
  };

  let debug = (() => {
    try {
      return window.localStorage.getItem(CONFIG.debugStorageKey) === "1";
    } catch (e) {
      return false;
    }
  })();

  function log(...args) {
    if (debug) console.log("[tinta]", ...args);
  }

  function clean(value) {
    if (typeof value !== "string") return null;
    const s = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
    return s ? s.slice(0, CONFIG.maxStringLength) : null;
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      // The extension context is not available, for example after an update.
    }
  }

  function meetingCode() {
    const m = CONFIG.meetingCodePattern.exec(location.pathname);
    return m ? m[1] : null;
  }

  function meetingTitle(code) {
    for (const sel of CONFIG.titleSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = clean(el.getAttribute("data-meeting-title")) || clean(el.textContent);
      if (t && t !== code) return t;
    }
    const t = clean(document.title.replace(CONFIG.titlePrefixPattern, ""));
    if (!t || t === code || t === "Meet" || t === "Google Meet") return null;
    return t;
  }

  // Name extraction.

  function isSelfMarker(text) {
    return CONFIG.selfMarkers.includes(text);
  }

  function stripSelfMarker(text) {
    for (const marker of CONFIG.selfMarkers) {
      if (marker.startsWith("(") && text.endsWith(" " + marker)) {
        return { name: text.slice(0, -marker.length).trim(), self: true };
      }
    }
    return { name: text, self: false };
  }

  function plausibleName(text) {
    if (!text || text.length > CONFIG.maxNameLength) return false;
    if (!/\p{L}/u.test(text)) return false;
    if (CONFIG.iconTextPattern.test(text)) return false;
    if (CONFIG.uiTexts.includes(text) || isSelfMarker(text)) return false;
    return true;
  }

  function textNodes(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return node.matches(CONFIG.skipSubtreeSelector) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode()) && out.length < 50) {
      const t = clean(node.nodeValue);
      if (t) out.push(t);
    }
    return out;
  }

  // Returns { name, self, presentation } for a tile or a People panel item.
  function describe(el, preferAriaLabel) {
    const candidates = [];
    const add = (value, weight) => {
      const t = clean(value);
      if (!t) return;
      const s = stripSelfMarker(t);
      if (plausibleName(s.name)) candidates.push({ name: s.name, weight, self: s.self });
    };

    for (const attr of CONFIG.nameAttributes) add(el.getAttribute(attr), 100);
    for (const sel of CONFIG.nameSelectors) {
      for (const node of el.querySelectorAll(sel)) {
        for (const attr of CONFIG.nameAttributes) add(node.getAttribute(attr), 100);
      }
    }
    if (preferAriaLabel) add(el.getAttribute("aria-label"), 50);

    const texts = textNodes(el);
    let self = CONFIG.selfAttributes.some((a) => el.hasAttribute(a) || el.querySelector("[" + a + "]"));
    for (const t of texts) {
      if (isSelfMarker(t)) self = true;
      add(t, 1);
    }

    // Meet often renders the name more than once in a tile, so repeated strings score higher.
    const score = new Map();
    for (const c of candidates) {
      const prev = score.get(c.name) || { name: c.name, weight: 0, order: score.size, self: false };
      prev.weight += c.weight;
      prev.self = prev.self || c.self;
      score.set(c.name, prev);
    }
    let best = null;
    for (const s of score.values()) {
      if (!best || s.weight > best.weight || (s.weight === best.weight && s.order < best.order)) best = s;
    }

    const presentation =
      texts.some((t) => CONFIG.presentationPattern.test(t)) ||
      (best !== null && CONFIG.presentationPattern.test(best.name));
    return { name: best ? best.name : null, self: self || Boolean(best && best.self), presentation };
  }

  function pageSelfName() {
    for (const el of document.querySelectorAll("[" + CONFIG.selfNameAttribute + "]")) {
      if (el.closest(CONFIG.participantSelector)) continue;
      const n = clean(el.getAttribute(CONFIG.selfNameAttribute));
      if (n && plausibleName(n)) return n;
    }
    return null;
  }

  // Tile tracking.

  const tracker = new globalThis.TintaSpeaking.SpeakingTracker(CONFIG.speaking);
  const tiles = new Map();
  let participants = new Map();

  function participantId(el) {
    return clean(el.getAttribute(CONFIG.participantIdAttribute));
  }

  function isOutermostTile(el) {
    const parent = el.parentElement && el.parentElement.closest(CONFIG.participantSelector);
    return !parent && !el.matches(CONFIG.peoplePanelItemSelector);
  }

  function onTileMutations(tile, records) {
    const info = tiles.get(tile);
    if (!info || info.presentation || !inCall) return;
    let n = 0;
    for (const r of records) {
      const target = r.target;
      if (target.nodeType !== Node.ELEMENT_NODE) continue;
      if (target.closest(CONFIG.ignoreMutationSelector)) continue;
      n += 1;
    }
    if (n > 0) tracker.record(info.id, performance.now(), n);
  }

  function attachTile(tile, id) {
    const observer = new MutationObserver((records) => onTileMutations(tile, records));
    observer.observe(tile, { attributes: true, attributeFilter: ["class", "style"], subtree: true });
    tiles.set(tile, { id, observer, presentation: false });
  }

  function detachTile(tile) {
    const info = tiles.get(tile);
    if (!info) return;
    info.observer.disconnect();
    tiles.delete(tile);
    if (debug) tile.removeAttribute(CONFIG.debugAttribute);
  }

  function hasSpeakingHint(tile) {
    for (const sel of CONFIG.speakingIndicatorSelectors) {
      if (tile.querySelector(sel)) return true;
    }
    for (const el of tile.querySelectorAll("[aria-label], [data-tooltip]")) {
      const label = el.getAttribute("aria-label") || el.getAttribute("data-tooltip") || "";
      if (CONFIG.speakingLabelPattern.test(label)) return true;
    }
    return false;
  }

  function scan() {
    const seen = new Set();
    for (const el of document.querySelectorAll(CONFIG.participantSelector)) {
      if (!isOutermostTile(el)) continue;
      const id = participantId(el);
      if (!id) continue;
      seen.add(el);
      const info = tiles.get(el);
      if (!info) attachTile(el, id);
      else if (info.id !== id) {
        detachTile(el);
        attachTile(el, id);
      }
    }
    for (const tile of [...tiles.keys()]) {
      if (!seen.has(tile) || !tile.isConnected) detachTile(tile);
    }

    const next = new Map();
    const presentationIds = new Set();
    for (const [tile, info] of tiles) {
      const d = describe(tile, false);
      info.presentation = d.presentation;
      if (d.presentation) {
        presentationIds.add(info.id);
        continue;
      }
      const prev = next.get(info.id);
      next.set(info.id, {
        id: info.id,
        name: (prev && prev.name) || d.name,
        is_self: Boolean(prev && prev.is_self) || d.self,
      });
    }

    for (const item of document.querySelectorAll(CONFIG.peoplePanelItemSelector)) {
      const id = participantId(item);
      if (!id) continue;
      const d = describe(item, true);
      if (d.presentation) continue;
      const prev = next.get(id);
      next.set(id, {
        id,
        name: d.name || (prev && prev.name) || null,
        is_self: d.self || Boolean(prev && prev.is_self),
      });
    }

    // A presentation tile can share the participant id of the presenter.
    for (const id of presentationIds) {
      if (!next.has(id)) tracker.remove(id);
    }

    const selfName = pageSelfName();
    if (selfName) {
      for (const p of next.values()) if (p.name === selfName) p.is_self = true;
    }

    for (const id of participants.keys()) if (!next.has(id)) tracker.remove(id);
    participants = next;
    updateCallState();
  }

  let rescanTimer = null;
  function scheduleScan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scan();
    }, CONFIG.rescanDelayMs);
  }

  // Call state and messages.

  let inCall = false;
  let code = null;
  let lastTileSeenAt = 0;
  let lastStateKey = null;
  let lastSpeakersKey = null;
  let tickTimer = null;
  let stateTimer = null;
  let speakersTimer = null;

  function stateMessage() {
    const list = [...participants.values()].slice(0, CONFIG.maxParticipants).map((p) => ({
      id: p.id,
      name: clean(p.name) || "",
      is_self: p.is_self,
    }));
    const self = list.find((p) => p.is_self && p.name);
    return {
      type: "meet_state",
      meeting_code: code,
      title: meetingTitle(code),
      t: Date.now(),
      self_name: self ? self.name : pageSelfName(),
      participants: list,
    };
  }

  function sendState(force) {
    const msg = stateMessage();
    const key = JSON.stringify([msg.title, msg.self_name, msg.participants]);
    if (!force && key === lastStateKey) return;
    lastStateKey = key;
    send(msg);
    log("participants", msg.participants, "title", msg.title);
  }

  function currentSpeakers() {
    return tracker
      .speaking()
      .filter((id) => participants.has(id))
      .slice(0, CONFIG.maxParticipants);
  }

  function sendSpeakers(force) {
    const speaking = currentSpeakers();
    const key = speaking.join("\n");
    const changed = key !== lastSpeakersKey;
    if (!force && !changed) return;
    lastSpeakersKey = key;
    send({ type: "active_speakers", meeting_code: code, t: Date.now(), speaking });
    if (changed) {
      log("speaking", speaking.map((id) => (participants.get(id) || {}).name || id));
      if (debug) paintSpeaking(new Set(speaking));
    }
  }

  function tick() {
    for (const [tile, info] of tiles) {
      if (!info.presentation) tracker.setHint(info.id, hasSpeakingHint(tile));
    }
    tracker.tick(performance.now());
    sendSpeakers(false);
  }

  function startCall(newCode) {
    code = newCode;
    inCall = true;
    lastStateKey = null;
    lastSpeakersKey = null;
    log("joined", code);
    sendState(true);
    sendSpeakers(true);
    tickTimer = setInterval(tick, CONFIG.tickMs);
    stateTimer = setInterval(() => sendState(true), CONFIG.stateHeartbeatMs);
    speakersTimer = setInterval(() => sendSpeakers(true), CONFIG.speakersHeartbeatMs);
  }

  function endCall() {
    if (!inCall) return;
    send({ type: "meeting_ended", meeting_code: code, t: Date.now() });
    log("ended", code);
    inCall = false;
    clearInterval(tickTimer);
    clearInterval(stateTimer);
    clearInterval(speakersTimer);
    for (const id of participants.keys()) tracker.remove(id);
    if (debug) paintSpeaking(new Set());
    code = null;
  }

  function updateCallState() {
    const c = meetingCode();
    const now = Date.now();
    if (participants.size > 0) lastTileSeenAt = now;
    if (inCall && c !== code) endCall();
    if (!inCall) {
      if (c && participants.size > 0) startCall(c);
      return;
    }
    if (participants.size === 0 && now - lastTileSeenAt >= CONFIG.leaveGraceMs) {
      endCall();
      return;
    }
    sendState(false);
  }

  // Debug outline.

  function paintSpeaking(ids) {
    for (const [tile, info] of tiles) {
      if (ids.has(info.id)) tile.setAttribute(CONFIG.debugAttribute, "");
      else tile.removeAttribute(CONFIG.debugAttribute);
    }
  }

  let debugStyle = null;

  function setDebug(on) {
    debug = on;
    if (on && !debugStyle) {
      debugStyle = document.createElement("style");
      debugStyle.textContent = "[" + CONFIG.debugAttribute + "] { outline: 3px solid #8174dc !important; outline-offset: -3px; }";
      (document.head || document.documentElement).appendChild(debugStyle);
    } else if (!on && debugStyle) {
      debugStyle.remove();
      debugStyle = null;
    }
    paintSpeaking(new Set(on ? currentSpeakers() : []));
    log("debug mode", on ? "on" : "off");
  }

  setDebug(debug);

  // The popup turns the outline on and off. Only this extension can send these messages.
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !msg || msg.type !== "tinta_debug") return;
    if (typeof msg.on === "boolean") setDebug(msg.on);
    reply({ debug });
  });

  // Start.

  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(scan, CONFIG.rescanIntervalMs);
  window.addEventListener("pagehide", endCall);
  scan();
})();
