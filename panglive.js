// Name: PangLive
// ID: panglive
// Description: Real-time collaboration for Scratch projects.
// By: PangLive
// License: MIT

(function (Scratch) {
  "use strict";

  if (!Scratch.extensions.unsandboxed) {
    throw new Error("PangLive must run unsandboxed");
  }

  const PEERJS_CDN =
    "https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js";
  const PEER_ID_PREFIX = "panglive-";
  const STAGE_NAME = "__PangLiveStage__";
  const CHUNK_SIZE = 12000;
  const PROJECT_CHUNK_YIELD_EVERY = 1;
  const CURSOR_ICON =
    "https://logise1.github.io/static/790c78d39fd853ae72167411aa11d727.svg";
  const ASSET_BASE = "https://logise1.github.io/extensions/assets/";
  const CURSOR_THROTTLE_MS = 50;
  const TYPING_IDLE_MS = 1500;
  const CHAT_HISTORY = 50;
  const KEEP_ALIVE_MS = 4000;
  const GHOST_TIMEOUT_MS = 14000;
  const SPRITE_STATE_FLUSH_MS = 100;
  const vm = Scratch.vm;
  const runtime = vm.runtime;

  const sfxCache = Object.create(null);

  function playSfx(name) {
    try {
      let base = sfxCache[name];
      if (!base) {
        base = new Audio(ASSET_BASE + name + ".ogg");
        sfxCache[name] = base;
      }
      var a = base.cloneNode();
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  function warmSfx() {
    ["join", "leave", "msg"].forEach(function (name) {
      if (!sfxCache[name]) {
        try {
          sfxCache[name] = new Audio(ASSET_BASE + name + ".ogg");
        } catch (e) {}
      }
    });
  }

  const sanitize = (s) =>
    String(s || "")
      .replace(/\//g, "_")
      .trim() || "user";

  const USER_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
  const ROOM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  function randomFrom(chars, len) {
    let s = "";
    for (let i = 0; i < len; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }

  function randomUsername() {
    return randomFrom(USER_CHARS, 8);
  }

  function randomRoomCode() {
    return randomFrom(ROOM_CHARS, 4);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function targetName(target) {
    if (!target) return STAGE_NAME;
    return target.isStage ? STAGE_NAME : target.sprite.name;
  }

  function nameToTarget(name) {
    return name === STAGE_NAME
      ? runtime.getTargetForStage()
      : runtime.getSpriteTargetByName(name);
  }

  function getScratchBlocks() {
    if (typeof ScratchBlocks !== "undefined") return ScratchBlocks;
    const wrap = document.querySelector(
      '[class*="blocks_blocks_"], [class^="gui_blocks-wrapper"]'
    );
    if (!wrap) return null;
    const reactKey = Object.keys(wrap).find((k) => k.startsWith("__reactFiber"));
    if (!reactKey) return null;
    let node = wrap[reactKey];
    while (node) {
      if (node.stateNode && node.stateNode.ScratchBlocks) {
        return node.stateNode.ScratchBlocks;
      }
      node = node.child;
    }
    return null;
  }

  function getWorkspace() {
    const SB = getScratchBlocks();
    if (SB && SB.Workspace && SB.Workspace.WorkspaceDB_) {
      for (const [, ws] of Object.entries(SB.Workspace.WorkspaceDB_)) {
        if (!ws.isFlyout) return ws;
      }
    }
    if (typeof Blockly !== "undefined" && Blockly.getMainWorkspace) {
      return Blockly.getMainWorkspace();
    }
    return null;
  }

  function hashColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
      h = (h << 5) - h + name.charCodeAt(i);
      h |= 0;
    }
    const hue = Math.abs(h) % 360;
    return `hsl(${hue}, 65%, 45%)`;
  }

  const remoteCursors = new Map();
  let cursorLayer = null;
  let cursorTracking = false;
  let lastCursorSend = 0;
  let cursorWasOverBlocks = false;
  let lastLocalCursorTarget = "";

  function getBlocksEl() {
    return document.querySelector(
      '[class*="blocks_blocks_"], [class^="gui_blocks-wrapper"]'
    );
  }

  function currentCursorTarget() {
    return targetName(vm.editingTarget);
  }

  function getBlockCanvas() {
    const ws = getWorkspace();
    if (!ws) return null;
    if (typeof ws.getCanvas === "function") return ws.getCanvas();
    return ws.svgBlockCanvas_ || null;
  }

  function pointerToWorkspace(clientX, clientY) {
    const blocks = getBlocksEl();
    if (!blocks) return null;
    const rect = blocks.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      return null;
    }
    const canvas = getBlockCanvas();
    const svg = canvas && canvas.ownerSVGElement;
    if (canvas && svg && canvas.getScreenCTM) {
      try {
        const ctm = canvas.getScreenCTM();
        if (ctm) {
          const pt = svg.createSVGPoint();
          pt.x = clientX;
          pt.y = clientY;
          const local = pt.matrixTransform(ctm.inverse());
          return { x: local.x, y: local.y };
        }
      } catch {
        
      }
    }
    const ws = getWorkspace();
    if (ws && typeof ws.scale === "number") {
      return {
        x: (clientX - rect.left - (ws.scrollX || 0)) / (ws.scale || 1),
        y: (clientY - rect.top - (ws.scrollY || 0)) / (ws.scale || 1),
      };
    }
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  function workspaceToScreen(x, y) {
    const canvas = getBlockCanvas();
    const svg = canvas && canvas.ownerSVGElement;
    if (canvas && svg && canvas.getScreenCTM) {
      try {
        const ctm = canvas.getScreenCTM();
        if (ctm) {
          const pt = svg.createSVGPoint();
          pt.x = x;
          pt.y = y;
          const screen = pt.matrixTransform(ctm);
          return { x: screen.x, y: screen.y };
        }
      } catch {
        
      }
    }
    const blocks = getBlocksEl();
    const ws = getWorkspace();
    if (!blocks) return null;
    const rect = blocks.getBoundingClientRect();
    if (ws && typeof ws.scale === "number") {
      return {
        x: rect.left + x * (ws.scale || 1) + (ws.scrollX || 0),
        y: rect.top + y * (ws.scale || 1) + (ws.scrollY || 0),
      };
    }
    return { x: rect.left + x, y: rect.top + y };
  }

  function ensureCursorLayer() {
    if (cursorLayer && cursorLayer.isConnected) return cursorLayer;
    cursorLayer = document.createElement("div");
    cursorLayer.id = "panglive-cursors";
    document.body.appendChild(cursorLayer);
    return cursorLayer;
  }

  function syncRemoteCursorEl(user) {
    const entry = remoteCursors.get(user);
    if (!entry) return;
    const mine = currentCursorTarget();
    const show =
      entry.on && entry.target && entry.target === mine && getBlocksEl();
    if (!show) {
      entry.el.style.display = "none";
      return;
    }
    const screen = workspaceToScreen(entry.x, entry.y);
    if (!screen) {
      entry.el.style.display = "none";
      return;
    }
    const blocks = getBlocksEl();
    const rect = blocks.getBoundingClientRect();
    if (
      screen.x < rect.left - 40 ||
      screen.x > rect.right + 40 ||
      screen.y < rect.top - 40 ||
      screen.y > rect.bottom + 40
    ) {
      entry.el.style.display = "none";
      return;
    }
    entry.el.style.display = "block";
    entry.el.style.left = screen.x + "px";
    entry.el.style.top = screen.y + "px";
  }

  function refreshAllRemoteCursors() {
    for (const user of remoteCursors.keys()) syncRemoteCursorEl(user);
  }

  function upsertRemoteCursor(user, payload) {
    if (!user) return;
    const on = payload.on !== false;
    if (!on) {
      const existing = remoteCursors.get(user);
      if (existing) {
        existing.on = false;
        syncRemoteCursorEl(user);
      }
      return;
    }

    const layer = ensureCursorLayer();
    let entry = remoteCursors.get(user);
    if (!entry) {
      const el = document.createElement("div");
      el.className = "pl-cur";
      el.style.display = "none";
      const img = document.createElement("img");
      img.src = CURSOR_ICON;
      const nameEl = document.createElement("span");
      nameEl.textContent = user;
      nameEl.style.background = hashColor(user);
      el.appendChild(img);
      el.appendChild(nameEl);
      layer.appendChild(el);
      entry = { el, on: true, target: "", x: 0, y: 0 };
      remoteCursors.set(user, entry);
    }
    entry.on = true;
    entry.target = String(payload.target || "");
    entry.x = Number(payload.x) || 0;
    entry.y = Number(payload.y) || 0;
    syncRemoteCursorEl(user);
  }

  function removeRemoteCursor(user) {
    const entry = remoteCursors.get(user);
    if (!entry) return;
    entry.el.remove();
    remoteCursors.delete(user);
  }

  function clearRemoteCursors() {
    for (const entry of remoteCursors.values()) entry.el.remove();
    remoteCursors.clear();
    cursorWasOverBlocks = false;
    lastLocalCursorTarget = "";
  }

  function pruneRemoteCursors(users) {
    const alive = new Set(users);
    for (const user of [...remoteCursors.keys()]) {
      if (!alive.has(user)) removeRemoteCursor(user);
    }
  }

  function sendCursorOff() {
    if (!transport || !transport.connected) return;
    transport.broadcast({
      bc: "cursor",
      user: transport.username,
      target: lastLocalCursorTarget || currentCursorTarget(),
      on: false,
    });
  }

  function onLocalPointerMove(e) {
    if (!transport || !transport.connected) return;
    const target = currentCursorTarget();
    if (target !== lastLocalCursorTarget) {
      if (cursorWasOverBlocks) sendCursorOff();
      cursorWasOverBlocks = false;
      lastLocalCursorTarget = target;
      refreshAllRemoteCursors();
    }

    const now = Date.now();
    const wsPoint = pointerToWorkspace(e.clientX, e.clientY);

    if (!wsPoint) {
      if (cursorWasOverBlocks && now - lastCursorSend >= CURSOR_THROTTLE_MS) {
        cursorWasOverBlocks = false;
        lastCursorSend = now;
        sendCursorOff();
      }
      return;
    }

    if (now - lastCursorSend < CURSOR_THROTTLE_MS) return;
    cursorWasOverBlocks = true;
    lastCursorSend = now;
    transport.broadcast({
      bc: "cursor",
      user: transport.username,
      target,
      on: true,
      x: wsPoint.x,
      y: wsPoint.y,
    });
  }

  function onBlocksViewportMaybeChanged() {
    if (!cursorTracking) return;
    refreshAllRemoteCursors();
  }

  function onCursorTargetMaybeChanged() {
    const target = currentCursorTarget();
    if (target === lastLocalCursorTarget) return;
    if (cursorWasOverBlocks) {
      sendCursorOff();
      cursorWasOverBlocks = false;
    }
    lastLocalCursorTarget = target;
    refreshAllRemoteCursors();
  }

  function startCursorTracking() {
    if (cursorTracking) return;
    cursorTracking = true;
    ensureCursorLayer();
    lastLocalCursorTarget = currentCursorTarget();
    document.addEventListener("pointermove", onLocalPointerMove, {
      passive: true,
    });
    document.addEventListener("pointerleave", onLocalPointerLeave);
    window.addEventListener("blur", onLocalPointerLeave);
    window.addEventListener("resize", onBlocksViewportMaybeChanged);
    document.addEventListener("wheel", onBlocksViewportMaybeChanged, {
      passive: true,
      capture: true,
    });
    try {
      vm.on("targetsUpdate", onCursorTargetMaybeChanged);
    } catch {
      
    }
  }

  function onLocalPointerLeave() {
    if (!cursorWasOverBlocks) return;
    cursorWasOverBlocks = false;
    lastCursorSend = Date.now();
    sendCursorOff();
  }

  function stopCursorTracking() {
    if (!cursorTracking) return;
    cursorTracking = false;
    document.removeEventListener("pointermove", onLocalPointerMove);
    document.removeEventListener("pointerleave", onLocalPointerLeave);
    window.removeEventListener("blur", onLocalPointerLeave);
    window.removeEventListener("resize", onBlocksViewportMaybeChanged);
    document.removeEventListener("wheel", onBlocksViewportMaybeChanged, true);
    try {
      vm.removeListener("targetsUpdate", onCursorTargetMaybeChanged);
    } catch {
      
    }
    if (cursorWasOverBlocks) sendCursorOff();
    clearRemoteCursors();
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  async function bufToBase64Async(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      if (i > 0 && i % 0x100000 === 0) await sleep(0);
    }
    return btoa(bin);
  }

  function base64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  
  
  

  let pauseEventHandling = false;
  let hooksInstalled = false;
  let sendLocalFn = null;
  const proxyActions = {};
  const projectChunks = new Map();
  const snapChunks = new Map();
  const extChunks = new Map();
  const spriteChunks = new Map();
  let workspaceHookTimer = null;
  const dirtyTargets = new Set();
  let snapTimer = null;
  let idleFlushTimer = null;
  let projectSyncTimer = null;
  let projectSyncBusy = false;
  let pendingImportBuffer = null;
  let spriteStateTimer = null;
  const pendingSpriteStates = new Set();
  let localSeq = 0;
  const lastApplied = new Map();
  const lastSentHash = new Map(); 
  const lastLocalSendTs = new Map(); 
  const playAfterDrag = [];
  let dragFlushTimer = null;
  const remoteSpriteInbox = [];
  let remoteSpriteBusy = false;
  let blockListenerWrapped = false;
  let suppressSendUntil = 0; 
  const DEBUG = false;

  const BLOCK_EVENT_TYPES = new Set([
    "create",
    "delete",
    "move",
    "change",
    "var_create",
    "var_delete",
    "var_rename",
    "comment_create",
    "comment_change",
    "comment_delete",
    "comment_move",
  ]);

  function log(...args) {
    if (DEBUG) console.log("[PangLive]", ...args);
  }

  function logWarn(...args) {
    console.warn("[PangLive]", ...args);
  }

  function logErr(...args) {
    console.error("[PangLive]", ...args);
  }

  function cloneJson(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function isDragging() {
    const ws = getWorkspace();
    return !!(ws && typeof ws.isDragging === "function" && ws.isDragging());
  }

  function serializeTarget(target) {
    return {
      blocks: cloneJson(target.blocks._blocks) || {},
      scripts: Array.isArray(target.blocks._scripts)
        ? target.blocks._scripts.slice()
        : [],
      comments: cloneJson(target.comments) || {},
      variables: cloneJson(target.variables) || {},
    };
  }

  function contentHash(blocks, comments) {
    try {
      return JSON.stringify({ b: blocks || {}, c: comments || {} });
    } catch {
      return "";
    }
  }

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function snapContentKey(payload) {
    return simpleHash(contentHash(payload.blocks, payload.comments));
  }

  function canSendSync() {
    return (
      !pauseEventHandling &&
      transport &&
      transport.connected &&
      Date.now() >= suppressSendUntil
    );
  }

  function silenceOutbound(ms) {
    suppressSendUntil = Math.max(suppressSendUntil, Date.now() + (ms || 900));
    dirtyTargets.clear();
    clearTimeout(snapTimer);
  }

  function clearOutboundSilence() {
    suppressSendUntil = 0;
  }

  function mergeVariables(target, variables) {
    if (!target || !variables) return;
    for (const [id, v] of Object.entries(variables)) {
      if (!v || !v.name) continue;
      const existing = target.variables[id];
      if (existing) {
        existing.name = v.name;
        existing.value = v.value;
        if (typeof v.type !== "undefined") existing.type = v.type;
      } else if (typeof target.createVariable === "function") {
        try {
          target.createVariable(id, v.name, v.type || "", !!v.isCloud);
          if (target.variables[id] && typeof v.value !== "undefined") {
            target.variables[id].value = v.value;
          }
        } catch (e) {
          logWarn("createVariable failed", id, e);
        }
      }
    }
  }

  function replaceTargetFromSnap(payload) {
    const target = nameToTarget(payload.target);
    if (!target || !target.blocks) {
      logWarn("snap target missing", payload.target);
      return false;
    }

    const stamp = {
      ts: payload.ts || 0,
      seq: payload.seq || 0,
      user: payload.user || "",
    };
    const prev = lastApplied.get(payload.target);
    if (prev) {
      if (stamp.ts < prev.ts) return false;
      if (stamp.ts === prev.ts) {
        if (stamp.seq < prev.seq) return false;
        if (stamp.seq === prev.seq && stamp.user <= prev.user) return false;
      }
    }

    const incomingKey = snapContentKey(payload);
    const localKey = simpleHash(
      contentHash(target.blocks._blocks, target.comments)
    );
    if (incomingKey && incomingKey === localKey) {
      lastApplied.set(payload.target, stamp);
      lastSentHash.set(payload.target, incomingKey);
      return true;
    }

    
    silenceOutbound(1200);
    pauseEventHandling = true;
    try {
      const blocks = target.blocks;
      const ids = Object.keys(blocks._blocks);
      for (let i = 0; i < ids.length; i++) {
        try {
          blocks.deleteBlock(ids[i]);
        } catch {
          
        }
      }

      const incoming = payload.blocks || {};
      const blockList = Array.isArray(incoming)
        ? incoming
        : Object.values(incoming);
      for (let i = 0; i < blockList.length; i++) {
        try {
          blocks.createBlock(blockList[i]);
        } catch (e) {
          logErr("createBlock failed", e);
        }
      }

      mergeVariables(target, payload.variables);
      if (payload.comments && typeof payload.comments === "object") {
        target.comments = cloneJson(payload.comments);
      }
      if (payload.stageVariables) {
        mergeVariables(runtime.getTargetForStage(), payload.stageVariables);
      }

      lastApplied.set(payload.target, stamp);
      lastSentHash.set(payload.target, incomingKey);
      if (targetName(vm.editingTarget) === payload.target) {
        vm.emitWorkspaceUpdate();
      }
      log("applied snap", payload.target, "blocks:", blockList.length);
      return true;
    } catch (e) {
      logErr("replaceTargetFromSnap failed", payload.target, e);
      return false;
    } finally {
      pauseEventHandling = false;
      silenceOutbound(1200);
      setTimeout(() => {
        dirtyTargets.delete(payload.target);
        silenceOutbound(400);
      }, 50);
    }
  }

  function ensureDragFlush() {
    if (dragFlushTimer) return;
    dragFlushTimer = setInterval(() => {
      if (isDragging()) return;
      clearInterval(dragFlushTimer);
      dragFlushTimer = null;
      const queued = playAfterDrag.splice(0, playAfterDrag.length);
      for (let i = 0; i < queued.length; i++) {
        handleRemoteSnap(queued[i]);
      }
    }, 80);
  }

  function handleRemoteSnap(payload) {
    if (!payload || !payload.target) return;

    
    const key = snapContentKey(payload);
    if (key && key === lastSentHash.get(payload.target)) {
      log("skip echo snap", payload.target);
      return;
    }

    const ourTs = lastLocalSendTs.get(payload.target) || 0;
    if (payload.ts && ourTs && payload.ts < ourTs) {
      log("skip stale snap", payload.target, payload.ts, "<", ourTs);
      return;
    }

    
    if (isDragging() || dirtyTargets.has(payload.target)) {
      playAfterDrag.push(payload);
      ensureDragFlush();
      return;
    }

    replaceTargetFromSnap(payload);
  }

  function broadcastRaw(obj) {
    if (!sendLocalFn || !transport || !transport.connected) return;
    try {
      sendLocalFn(obj);
    } catch (e) {
      logErr("broadcast failed", obj && obj.bc, e);
    }
  }

  function sendSnapPayload(payload) {
    const json = JSON.stringify(payload);
    if (json.length <= CHUNK_SIZE) {
      broadcastRaw(payload);
      return;
    }
    const id =
      Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    const parts = Math.ceil(json.length / CHUNK_SIZE);
    broadcastRaw({ bc: "s-start", id, parts });
    for (let i = 0; i < parts; i++) {
      broadcastRaw({
        bc: "s-part",
        id,
        i,
        data: json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      });
    }
    broadcastRaw({ bc: "s-end", id });
    log("sent chunked snap", payload.target, parts, "parts");
  }

  function handleSnapPart(payload) {
    if (payload.bc === "s-start") {
      snapChunks.set(payload.id, { parts: payload.parts, chunks: [] });
    } else if (payload.bc === "s-part") {
      const entry = snapChunks.get(payload.id);
      if (entry) entry.chunks[payload.i] = payload.data;
    } else if (payload.bc === "s-end") {
      const entry = snapChunks.get(payload.id);
      snapChunks.delete(payload.id);
      if (!entry) return;
      try {
        handleRemoteSnap(JSON.parse(entry.chunks.join("")));
      } catch (e) {
        logErr("parse chunked snap failed", e);
      }
    }
  }

  function markDirty(name) {
    if (!name) return;
    if (Date.now() < suppressSendUntil) return;
    dirtyTargets.add(name);
  }

  function scheduleSnapshotFlush(delayMs) {
    if (Date.now() < suppressSendUntil) return;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(
      flushDirtySnapshots,
      delayMs == null ? 280 : delayMs
    );
  }

  
  function ensureIdleFlush() {
    if (idleFlushTimer) return;
    idleFlushTimer = setInterval(() => {
      if (!canSendSync()) return;
      if (isDragging()) return;
      clearInterval(idleFlushTimer);
      idleFlushTimer = null;
      if (dirtyTargets.size > 0) flushDirtySnapshots();
      
      if (playAfterDrag.length > 0) {
        const queued = playAfterDrag.splice(0, playAfterDrag.length);
        for (let i = 0; i < queued.length; i++) {
          handleRemoteSnap(queued[i]);
        }
      }
    }, 100);
  }

  function scheduleProjectSync(delayMs, force) {
    if (!transport || !transport.connected) return;
    if (!force && Date.now() < suppressSendUntil) return;
    if (projectSyncBusy) {
      clearTimeout(projectSyncTimer);
      projectSyncTimer = setTimeout(
        () => scheduleProjectSync(delayMs == null ? 700 : delayMs, force),
        500
      );
      return;
    }
    clearTimeout(projectSyncTimer);
    projectSyncTimer = setTimeout(() => {
      if (!transport || !transport.connected) return;
      if (projectSyncBusy) {
        scheduleProjectSync(400, force);
        return;
      }
      if (!force) {
        if (!canSendSync()) return;
        if (isDragging()) {
          scheduleProjectSync(250, false);
          return;
        }
      } else {
        clearOutboundSilence();
        pauseEventHandling = false;
      }
      log("project sync send", force ? "(forced)" : "");
      sendProjectTo(transport);
    }, delayMs == null ? 700 : delayMs);
  }

  function scheduleSpriteStateFlush(name, delayMs) {
    if (!transport || !transport.connected) return;
    if (pauseEventHandling || Date.now() < suppressSendUntil) return;
    const targetNameStr =
      typeof name === "string" && name
        ? name
        : targetName(vm.editingTarget);
    if (!targetNameStr || targetNameStr === STAGE_NAME) return;
    pendingSpriteStates.add(targetNameStr);
    clearTimeout(spriteStateTimer);
    spriteStateTimer = setTimeout(
      flushSpriteStates,
      delayMs == null ? SPRITE_STATE_FLUSH_MS : delayMs
    );
  }

  function flushSpriteStates() {
    spriteStateTimer = null;
    if (!transport || !transport.connected || pauseEventHandling) {
      pendingSpriteStates.clear();
      return;
    }
    const names = [...pendingSpriteStates];
    pendingSpriteStates.clear();
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const target = nameToTarget(name);
      if (!target || target.isStage) continue;
      broadcastRaw({
        bc: "spos",
        user: transport.username,
        target: name,
        x: target.x,
        y: target.y,
        direction: target.direction,
        size: target.size,
        visible: !!target.visible,
        draggable: !!target.draggable,
        rotationStyle: target.rotationStyle,
      });
    }
  }

  function applySpriteState(payload) {
    if (!payload || !payload.target) return;
    const target = nameToTarget(payload.target);
    if (!target || target.isStage) return;
    pauseEventHandling = true;
    try {
      const x = Number(payload.x);
      const y = Number(payload.y);
      if (typeof target.setXY === "function") {
        target.setXY(
          Number.isFinite(x) ? x : target.x,
          Number.isFinite(y) ? y : target.y,
          true
        );
      } else {
        if (Number.isFinite(x)) target.x = x;
        if (Number.isFinite(y)) target.y = y;
      }
      if (
        typeof payload.direction === "number" &&
        typeof target.setDirection === "function"
      ) {
        target.setDirection(payload.direction);
      }
      if (typeof payload.size === "number" && typeof target.setSize === "function") {
        target.setSize(payload.size);
      }
      if (
        typeof payload.visible === "boolean" &&
        typeof target.setVisible === "function"
      ) {
        target.setVisible(payload.visible);
      }
      if (typeof payload.draggable === "boolean") {
        if (typeof target.setDraggable === "function") {
          target.setDraggable(payload.draggable);
        } else {
          target.draggable = payload.draggable;
        }
      }
      if (
        payload.rotationStyle &&
        typeof target.setRotationStyle === "function"
      ) {
        target.setRotationStyle(payload.rotationStyle);
      }
      if (typeof runtime.requestRedraw === "function") runtime.requestRedraw();
      refreshSpritePosFinger();
    } catch (e) {
      logWarn("applySpriteState failed", e);
    } finally {
      pauseEventHandling = false;
    }
  }

  let spritePosFinger = "";
  let spritePosPollTimer = null;

  function refreshSpritePosFinger() {
    const parts = [];
    const targets = runtime.targets || [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || t.isStage) continue;
      parts.push(
        `${targetName(t)}:${t.x},${t.y},${t.direction},${t.size},${!!t.visible},${t.rotationStyle}`
      );
    }
    spritePosFinger = parts.join("|");
  }

  function pollSpritePositions() {
    if (!transport || !transport.connected || pauseEventHandling) return;
    if (Date.now() < suppressSendUntil) return;
    const parts = [];
    const targets = runtime.targets || [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || t.isStage) continue;
      parts.push(
        `${targetName(t)}:${t.x},${t.y},${t.direction},${t.size},${!!t.visible},${t.rotationStyle}`
      );
    }
    const finger = parts.join("|");
    if (finger === spritePosFinger) return;
    const prevMap = new Map();
    if (spritePosFinger) {
      const prevParts = spritePosFinger.split("|");
      for (let i = 0; i < prevParts.length; i++) {
        const part = prevParts[i];
        const idx = part.indexOf(":");
        if (idx > 0) prevMap.set(part.slice(0, idx), part);
      }
    }
    spritePosFinger = finger;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t || t.isStage) continue;
      const name = targetName(t);
      const token = `${name}:${t.x},${t.y},${t.direction},${t.size},${!!t.visible},${t.rotationStyle}`;
      if (prevMap.get(name) !== token) {
        scheduleSpriteStateFlush(name, SPRITE_STATE_FLUSH_MS);
      }
    }
  }

  function startSpritePosPolling() {
    if (spritePosPollTimer) return;
    refreshSpritePosFinger();
    spritePosPollTimer = setInterval(pollSpritePositions, 250);
  }

  function stopSpritePosPolling() {
    if (!spritePosPollTimer) return;
    clearInterval(spritePosPollTimer);
    spritePosPollTimer = null;
    pendingSpriteStates.clear();
    clearTimeout(spriteStateTimer);
    spriteStateTimer = null;
  }

  function flushDirtySnapshots() {
    if (!canSendSync()) return;
    if (isDragging()) {
      ensureIdleFlush();
      return;
    }
    if (dirtyTargets.size === 0) return;

    const names = Array.from(dirtyTargets);
    dirtyTargets.clear();

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const target = nameToTarget(name);
      if (!target || !target.blocks) continue;

      const ser = serializeTarget(target);
      const key = simpleHash(contentHash(ser.blocks, ser.comments));
      if (key && key === lastSentHash.get(name)) {
        log("skip unchanged snap", name);
        continue;
      }

      localSeq += 1;
      const stage = runtime.getTargetForStage();
      const payload = {
        bc: "snap",
        seq: localSeq,
        ts: Date.now(),
        user: transport.username,
        target: name,
        ...ser,
      };
      if (stage && name !== STAGE_NAME) {
        payload.stageVariables = cloneJson(stage.variables) || {};
      }

      lastApplied.set(name, {
        ts: payload.ts,
        seq: payload.seq,
        user: payload.user,
      });
      lastSentHash.set(name, key);
      lastLocalSendTs.set(name, payload.ts);

      log("send snap", name, "blocks:", Object.keys(payload.blocks || {}).length);
      sendSnapPayload(payload);
    }
  }

  function noteLocalEdit(e) {
    if (!canSendSync()) return;
    if (e && e.isPangLive) return;

    const name = targetName(vm.editingTarget);
    if (!name) return;

    const type = e && e.type;
    if (
      type &&
      ["ui", "dragOutside", "stackclick", "selected", "finishedLoading"].includes(
        type
      )
    ) {
      return;
    }
    if (e && e.element === "stackclick") return;
    if (
      type === "change" &&
      e.element === "field" &&
      e.name === "FIELDNAME"
    ) {
      return;
    }

    if (
      type &&
      !BLOCK_EVENT_TYPES.has(type) &&
      type !== "endDrag" &&
      type !== "drag"
    ) {
      return;
    }

    if (type === "create" && e.xml && e.xml.nodeName === "SHADOW") return;
    if (type === "delete" && e.oldXml && e.oldXml.nodeName === "SHADOW") return;

    markDirty(name);
    if (isDragging() || type === "drag") {
      ensureIdleFlush();
      return;
    }
    
    scheduleSnapshotFlush(
      type === "create" || type === "endDrag"
        ? 320
        : type === "change" || (type && type.indexOf("comment") === 0)
          ? 200
          : 280
    );
  }

  function onLocalBlockEvent(e) {
    noteLocalEdit(e);
  }

  function hookWorkspaceListener() {
    const ws = getWorkspace();
    if (!ws) return false;
    if (!ws.__pangliveHooked) {
      ws.__pangliveHooked = true;
      ws.addChangeListener(onLocalBlockEvent);
      log("workspace listener hooked", ws.id);
    }
    return true;
  }

  function wrapBlockListener() {
    if (blockListenerWrapped || !vm.blockListener) return;
    blockListenerWrapped = true;
    const original = vm.blockListener.bind(vm);
    vm.blockListener = function (e) {
      const ret = original(e);
      try {
        noteLocalEdit(e);
      } catch (err) {
        logErr("noteLocalEdit", err);
      }
      return ret;
    };
    log("vm.blockListener wrapped");
  }

  function startWorkspaceHookPolling() {
    if (workspaceHookTimer) return;
    hookWorkspaceListener();
    wrapBlockListener();
    installExtensionHooks();
    workspaceHookTimer = setInterval(() => {
      hookWorkspaceListener();
      wrapBlockListener();
      installExtensionHooks();
    }, 400);
  }

  function sendSpriteProxy(msg) {
    if (pauseEventHandling || !transport || !transport.connected) return;
    broadcastRaw({ bc: "sync", msg });
  }

  function bufferFromArg(arg) {
    if (!arg) return null;
    if (arg instanceof ArrayBuffer) return arg;
    if (ArrayBuffer.isView(arg)) {
      return arg.buffer.slice(arg.byteOffset, arg.byteOffset + arg.byteLength);
    }
    if (arg && typeof arg === "object" && typeof arg.__pangBuf === "string") {
      return base64ToBuf(arg.__pangBuf);
    }
    return null;
  }

  async function sendSpriteBuffer(name, buf) {
    if (!transport || !transport.connected || !buf) return;
    const b64 = bufToBase64(buf);
    const id =
      Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    const parts = Math.ceil(b64.length / CHUNK_SIZE);
    broadcastRaw({ bc: "sp-start", id, parts, name });
    for (let i = 0; i < parts; i++) {
      broadcastRaw({
        bc: "sp-part",
        id,
        i,
        data: b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      });
      if (i % 4 === 3) await sleep(8);
    }
    broadcastRaw({ bc: "sp-end", id });
    log("sent chunked sprite", name, parts, "parts");
  }

  async function handleSpritePart(payload) {
    if (payload.bc === "sp-start") {
      spriteChunks.set(payload.id, {
        parts: payload.parts,
        chunks: [],
        name: payload.name || "addsprite",
      });
      return;
    }
    if (payload.bc === "sp-part") {
      const entry = spriteChunks.get(payload.id);
      if (entry) entry.chunks[payload.i] = payload.data;
      return;
    }
    if (payload.bc !== "sp-end") return;
    const entry = spriteChunks.get(payload.id);
    spriteChunks.delete(payload.id);
    if (!entry) return;
    const b64 = entry.chunks.join("");
    if (!b64) return;
    const buf = base64ToBuf(b64);
    const action = proxyActions[entry.name];
    if (!action) return;
    pauseEventHandling = true;
    const savedEdit = rememberEditingTarget();
    try {
      await action("linguini", { args: [buf] });
      restoreEditingTarget(savedEdit);
      vm.emitTargetsUpdate();
    } catch (e) {
      logErr("remote sprite buffer apply failed", e);
    } finally {
      pauseEventHandling = false;
    }
  }

  function proxyMethod(original, name, serializeArgs) {
    proxyActions[name] = function (...args) {
      if (args[0] === "linguini") {
        const data = args[1];
        const callArgs = (data.args || []).map((a) => {
          const buf = bufferFromArg(a);
          return buf || a;
        });
        return original.apply(vm, callArgs);
      }
      if (pauseEventHandling) return original.apply(vm, args);
      const result = original.apply(vm, args);
      const rawBuf = bufferFromArg(args[0]);
      if (rawBuf && name === "addsprite") {
        Promise.resolve(result)
          .then(() => sendSpriteBuffer("addsprite", rawBuf))
          .catch((e) => logErr("send sprite buffer", e))
          .finally(() => {
            markDirty(targetName(vm.editingTarget));
            scheduleSnapshotFlush(400);
            scheduleProjectSync(900);
          });
        return result;
      }
      sendSpriteProxy({
        meta: "sprite.proxy",
        data: { name, args: serializeArgs ? serializeArgs(args) : args },
      });
      Promise.resolve(result).finally(() => {
        markDirty(targetName(vm.editingTarget));
        scheduleSnapshotFlush(200);
      });
      return result;
    };
    return proxyActions[name];
  }

  function proxyProjectOp(original, label) {
    return function (...args) {
      const result = original.apply(vm, args);
      if (!pauseEventHandling) {
        Promise.resolve(result).finally(() => scheduleProjectSync(700));
      }
      return result;
    };
  }

  async function resolveExtensionForShare(urlOrFile) {
    try {
      if (urlOrFile && typeof urlOrFile === "object") {
        if (typeof urlOrFile.text === "function") {
          const text = await urlOrFile.text();
          if (!text) return null;
          return { kind: "source", source: text };
        }
        if (urlOrFile instanceof ArrayBuffer) {
          const text = new TextDecoder("utf-8").decode(urlOrFile);
          if (!text) return null;
          return { kind: "source", source: text };
        }
      }
      const u = String(urlOrFile || "").trim();
      if (!u) return null;
      if (/^https?:\/\//i.test(u) || u.startsWith("data:")) {
        return { kind: "url", url: u };
      }
      if (u.startsWith("blob:")) {
        const res = await fetch(u);
        const text = await res.text();
        if (!text) return null;
        return { kind: "source", source: text };
      }
      return { kind: "url", url: u };
    } catch (e) {
      logWarn("resolve extension failed", e);
      return null;
    }
  }

  async function sendExtensionChunks(text, mode) {
    const body = String(text || "");
    if (!body) return;
    const id =
      Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    const parts = Math.ceil(body.length / CHUNK_SIZE);
    broadcastRaw({ bc: "ext-start", id, parts, mode: mode || "source" });
    for (let i = 0; i < parts; i++) {
      broadcastRaw({
        bc: "ext-part",
        id,
        i,
        data: body.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      });
      if (i % 4 === 3) await sleep(8);
    }
    broadcastRaw({ bc: "ext-end", id });
    log("sent chunked extension", mode || "source", parts, "parts");
  }

  async function shareResolvedExtension(resolved) {
    if (!transport || !transport.connected) return;
    if (!resolved) return;
    try {
      if (resolved.kind === "url") {
        if (resolved.url.length <= CHUNK_SIZE) {
          broadcastRaw({ bc: "ext", url: resolved.url });
        } else {
          await sendExtensionChunks(resolved.url, "url");
        }
        log("shared extension url");
        return;
      }
      if (resolved.source.length <= CHUNK_SIZE) {
        broadcastRaw({ bc: "ext", source: resolved.source });
      } else {
        await sendExtensionChunks(resolved.source, "source");
      }
      log("shared extension source", resolved.source.length);
    } catch (e) {
      logErr("shareResolvedExtension", e);
    }
  }

  async function withExtensionLoadPermissions(run) {
    const em = vm.extensionManager;
    if (!em) return run();
    if (!em.securityManager) em.securityManager = {};
    const sm = em.securityManager;
    const saved = {};
    const stub = (name, fn) => {
      saved[name] = sm[name];
      sm[name] = fn;
    };
    try {
      stub("getSandboxMode", function () {
        return "unsandboxed";
      });
      stub("canLoadExtensionFromProject", function () {
        return Promise.resolve(true);
      });
      if (typeof sm.canFetch === "function") {
        stub("canFetch", function () {
          return Promise.resolve(true);
        });
      }
      return await run();
    } finally {
      for (const key of Object.keys(saved)) {
        try {
          if (typeof saved[key] === "undefined") delete sm[key];
          else sm[key] = saved[key];
        } catch (e) {}
      }
    }
  }

  async function loadRemoteExtension(payload) {
    const em = vm.extensionManager;
    if (!em || typeof em.loadExtensionURL !== "function") return;

    let url = payload && payload.url ? String(payload.url) : "";
    let source = payload && payload.source ? String(payload.source) : "";
    if (!url && source) {
      try {
        url =
          "data:text/javascript;charset=utf-8," + encodeURIComponent(source);
      } catch {
        url = URL.createObjectURL(
          new Blob([source], { type: "application/javascript" })
        );
      }
    }
    if (!url) return;

    pauseEventHandling = true;
    try {
      await withExtensionLoadPermissions(async () => {
        try {
          await em.loadExtensionURL(url);
          log("loaded remote extension");
          return;
        } catch (e) {
          logWarn("remote extension load failed, trying blob", e);
        }
        if (source) {
          const blobUrl = URL.createObjectURL(
            new Blob([source], { type: "application/javascript" })
          );
          await em.loadExtensionURL(blobUrl);
          log("loaded remote extension via blob");
        } else {
          throw new Error("extension load failed");
        }
      });
    } catch (e) {
      logErr("remote extension load failed", e);
    } finally {
      pauseEventHandling = false;
    }
  }

  async function shareLoadedCustomExtensions() {
    if (!transport || !transport.connected) return;
    const em = vm.extensionManager;
    if (!em) return;
    const urls = [];
    try {
      if (em.extensionURLs && typeof em.extensionURLs.forEach === "function") {
        em.extensionURLs.forEach((url) => {
          if (url) urls.push(String(url));
        });
      } else if (em.extensionURLs && typeof em.extensionURLs === "object") {
        for (const url of Object.values(em.extensionURLs)) {
          if (url) urls.push(String(url));
        }
      }
    } catch (e) {
      logWarn("read extensionURLs failed", e);
    }
    const seen = new Set();
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (
        !/^https?:\/\//i.test(url) &&
        !url.startsWith("data:") &&
        !url.startsWith("blob:")
      ) {
        continue;
      }
      const resolved = await resolveExtensionForShare(url);
      if (resolved) await shareResolvedExtension(resolved);
    }
  }

  function handleExtPart(payload) {
    if (payload.bc === "ext-start") {
      extChunks.set(payload.id, {
        parts: payload.parts,
        chunks: [],
        mode: payload.mode === "url" ? "url" : "source",
      });
    } else if (payload.bc === "ext-part") {
      const entry = extChunks.get(payload.id);
      if (entry) entry.chunks[payload.i] = payload.data;
    } else if (payload.bc === "ext-end") {
      const entry = extChunks.get(payload.id);
      extChunks.delete(payload.id);
      if (!entry) return;
      const body = entry.chunks.join("");
      if (!body) return;
      if (entry.mode === "url") loadRemoteExtension({ url: body });
      else loadRemoteExtension({ source: body });
    }
  }

  function installExtensionHooks() {
    const em = vm.extensionManager;
    if (!em || em.__pangliveExtHooked) return false;
    if (typeof em.loadExtensionURL !== "function") return false;
    em.__pangliveExtHooked = true;
    const original = em.loadExtensionURL.bind(em);
    em.loadExtensionURL = function (url) {
      const shouldShare = !pauseEventHandling;
      const resolvedPromise = shouldShare
        ? resolveExtensionForShare(url)
        : null;
      const result = original(url);
      if (resolvedPromise) {
        Promise.all([Promise.resolve(result), resolvedPromise])
          .then(async ([, resolved]) => {
            await shareResolvedExtension(resolved);
          })
          .catch((e) => logWarn("extension load/share failed", e));
      }
      return result;
    };
    log("extensionManager.loadExtensionURL hooked");
    return true;
  }

  function captureProjectInput(input) {
    try {
      if (!input) return null;
      if (input instanceof ArrayBuffer) return input.slice(0);
      if (ArrayBuffer.isView(input)) {
        return input.buffer.slice(
          input.byteOffset,
          input.byteOffset + input.byteLength
        );
      }
      if (typeof Blob !== "undefined" && input instanceof Blob) {
        return { __blob: input };
      }
      return null;
    } catch (e) {
      logWarn("captureProjectInput failed", e);
      return null;
    }
  }

  async function resolveCapturedProject(captured) {
    if (!captured) return null;
    if (captured instanceof ArrayBuffer) return captured;
    if (captured && captured.__blob) {
      return await captured.__blob.arrayBuffer();
    }
    return null;
  }

  function isProjectFileName(name) {
    return /\.(pmp|sb3|sb2|pmps)$/i.test(String(name || ""));
  }

  function installProjectFileCapture() {
    if (window.__pangliveFileCapture) return;
    window.__pangliveFileCapture = true;
    document.addEventListener(
      "change",
      (e) => {
        const el = e.target;
        if (!el || el.tagName !== "INPUT" || el.type !== "file") return;
        const file = el.files && el.files[0];
        if (!file || !isProjectFileName(file.name)) return;
        if (!transport || !transport.connected) return;
        file
          .arrayBuffer()
          .then((buf) => {
            pendingImportBuffer = buf.slice(0);
            log("captured project file", file.name, buf.byteLength);
          })
          .catch((err) => logWarn("project file capture failed", err));
      },
      true
    );
  }

  async function sharePendingOrSavedProject() {
    if (!transport || !transport.connected) return;
    clearOutboundSilence();
    try {
      await shareLoadedCustomExtensions();
    } catch (e) {
      logWarn("share extensions before project", e);
    }
    const raw = await resolveCapturedProject(pendingImportBuffer);
    pendingImportBuffer = null;
    if (raw && raw.byteLength > 0) {
      log("sharing project bytes", raw.byteLength);
      await sendProjectTo(transport, raw);
    } else {
      log("sharing via saveProjectSb3 fallback");
      await sendProjectTo(transport, null);
    }
    try {
      await shareLoadedCustomExtensions();
    } catch (e) {
      logWarn("share extensions after project", e);
    }
  }

  function installLoadProjectHook() {
    if (vm.__pangliveLoadProjectHooked) return;
    if (typeof vm.loadProject !== "function") return;
    vm.__pangliveLoadProjectHooked = true;
    installProjectFileCapture();
    const original = vm.loadProject.bind(vm);
    vm.loadProject = function (input) {
      const wasPaused = pauseEventHandling;
      pauseEventHandling = true;
      silenceOutbound(4000);
      clearTimeout(projectSyncTimer);
      stopSpritePosPolling();

      const captured = wasPaused ? null : captureProjectInput(input);
      if (!wasPaused && captured && !pendingImportBuffer) {
        pendingImportBuffer = captured;
      } else if (!wasPaused && captured) {
        Promise.resolve(resolveCapturedProject(captured)).then((buf) => {
          if (
            buf &&
            (!pendingImportBuffer ||
              (pendingImportBuffer instanceof ArrayBuffer &&
                buf.byteLength >= pendingImportBuffer.byteLength))
          ) {
            pendingImportBuffer = buf;
          }
        });
      }

      const finish = (ok) => {
        pauseEventHandling = wasPaused;
        refreshSpritePosFinger();
        if (transport && transport.connected) startSpritePosPolling();
        if (ok && !wasPaused && transport && transport.connected) {
          setTimeout(() => {
            sharePendingOrSavedProject().catch((e) => {
              logErr("post-import project share failed", e);
              scheduleProjectSync(800, true);
            });
          }, 1600);
        } else {
          if (!wasPaused) pendingImportBuffer = null;
          silenceOutbound(800);
        }
      };

      let result;
      try {
        result = original(input);
      } catch (e) {
        finish(false);
        throw e;
      }
      if (result && typeof result.then === "function") {
        return result.then(
          (v) => {
            finish(true);
            return v;
          },
          (err) => {
            finish(false);
            throw err;
          }
        );
      }
      finish(true);
      return result;
    };
    log("vm.loadProject hooked");
  }

  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    log("installHooks");

    startWorkspaceHookPolling();
    installExtensionHooks();
    installLoadProjectHook();
    installProjectFileCapture();
    vm.on("workspaceUpdate", hookWorkspaceListener);
    vm.on("PROJECT_LOADED", () => {
      hookWorkspaceListener();
      installExtensionHooks();
      if (!projectSyncBusy && !projectSyncTimer) {
        silenceOutbound(800);
      }
      refreshSpritePosFinger();
    });

    vm.addSprite = proxyMethod(vm.addSprite.bind(vm), "addsprite", (a) => a);
    vm.deleteSprite = proxyMethod(
      vm.deleteSprite.bind(vm),
      "deletesprite",
      (a) => a
    );
    vm.duplicateSprite = proxyMethod(
      vm.duplicateSprite.bind(vm),
      "duplicatesprite",
      (a) => a
    );
    vm.renameSprite = proxyMethod(
      vm.renameSprite.bind(vm),
      "renamesprite",
      (a) => a
    );

    
    const assetOps = [
      "addCostume",
      "addCostumeFromLibrary",
      "duplicateCostume",
      "deleteCostume",
      "renameCostume",
      "reorderCostume",
      "addSound",
      "addSoundFromLibrary",
      "duplicateSound",
      "deleteSound",
      "renameSound",
      "reorderSound",
      "updateBitmap",
      "updateSvg",
    ];
    for (let i = 0; i < assetOps.length; i++) {
      const key = assetOps[i];
      if (typeof vm[key] === "function") {
        vm[key] = proxyProjectOp(vm[key].bind(vm), key);
      }
    }

    if (typeof vm.postSpriteInfo === "function" && !vm.__panglivePostSprite) {
      vm.__panglivePostSprite = true;
      const origPost = vm.postSpriteInfo.bind(vm);
      vm.postSpriteInfo = function (data) {
        const ret = origPost(data);
        if (!pauseEventHandling) {
          scheduleSpriteStateFlush(targetName(vm.editingTarget), 80);
        }
        return ret;
      };
    }

    if (typeof vm.reorderTarget === "function" && !proxyActions.reordertarget) {
      vm.reorderTarget = proxyMethod(
        vm.reorderTarget.bind(vm),
        "reordertarget",
        (a) => a
      );
    }

    if (!runtime.__pangliveTargetMoved) {
      runtime.__pangliveTargetMoved = true;
      const onTargetMoved = (target) => {
        if (pauseEventHandling) return;
        scheduleSpriteStateFlush(targetName(target), SPRITE_STATE_FLUSH_MS);
      };
      try {
        runtime.on("TARGET_MOVED", onTargetMoved);
      } catch {
        
      }
    }

    let workspaceUpdateQueued = false;
    const origEmitWorkspaceUpdate = vm.emitWorkspaceUpdate.bind(vm);
    vm.emitWorkspaceUpdate = function () {
      if (pauseEventHandling) {
        if (!workspaceUpdateQueued) {
          workspaceUpdateQueued = true;
          requestAnimationFrame(() => {
            workspaceUpdateQueued = false;
            if (!pauseEventHandling) origEmitWorkspaceUpdate();
          });
        }
        return;
      }
      origEmitWorkspaceUpdate();
    };
  }

  async function saveProjectBytes() {
    if (typeof vm.saveProjectSb3 !== "function") {
      throw new Error("saveProjectSb3 unavailable");
    }
    let out = await vm.saveProjectSb3("arraybuffer");
    if (out instanceof Blob) out = await out.arrayBuffer();
    return out;
  }

  function rememberEditingTarget() {
    const t = vm.editingTarget;
    if (!t) return null;
    return { id: t.id, name: targetName(t) };
  }

  function restoreEditingTarget(saved) {
    if (!saved) return;
    let t = saved.id ? runtime.getTargetById(saved.id) : null;
    if (!t && saved.name) t = nameToTarget(saved.name);
    if (!t) return;
    if (vm.editingTarget === t) return;
    try {
      if (typeof vm.setEditingTarget === "function") {
        vm.setEditingTarget(t.id);
      } else {
        vm.editingTarget = t;
        runtime._editingTarget = t;
      }
    } catch (e) {
      logWarn("restoreEditingTarget failed", e);
    }
  }

  async function loadProjectBytes(buf) {
    pauseEventHandling = true;
    silenceOutbound(4000);
    dirtyTargets.clear();
    playAfterDrag.length = 0;
    lastApplied.clear();
    clearTimeout(projectSyncTimer);
    const savedEdit = rememberEditingTarget();
    try {
      await withExtensionLoadPermissions(async () => {
        await vm.loadProject(buf);
      });
      restoreEditingTarget(savedEdit);
      vm.emitTargetsUpdate();
      vm.emitWorkspaceUpdate();
      hookWorkspaceListener();
      refreshSpritePosFinger();
    } catch (e) {
      logErr("loadProjectBytes failed", e);
    } finally {
      await sleep(120);
      pauseEventHandling = false;
      silenceOutbound(1500);
    }
  }

  async function drainSpriteInbox() {
    if (remoteSpriteBusy) return;
    remoteSpriteBusy = true;
    try {
      while (remoteSpriteInbox.length > 0) {
        const msg = remoteSpriteInbox.shift();
        if (msg.meta === "sprite.proxy" && proxyActions[msg.data.name]) {
          pauseEventHandling = true;
          const savedEdit = rememberEditingTarget();
          try {
            await proxyActions[msg.data.name]("linguini", msg.data);
            restoreEditingTarget(savedEdit);
            vm.emitTargetsUpdate();
            if (
              savedEdit &&
              vm.editingTarget &&
              targetName(vm.editingTarget) === savedEdit.name
            ) {
              vm.emitWorkspaceUpdate();
            }
          } finally {
            pauseEventHandling = false;
          }
        }
      }
    } finally {
      remoteSpriteBusy = false;
      if (remoteSpriteInbox.length > 0) drainSpriteInbox();
    }
  }

  function applyRemote(payload) {
    if (!payload || !payload.msg) return;
    if (payload.msg.meta === "vm.blockListen") return;
    if (payload.msg.meta === "sprite.proxy") {
      remoteSpriteInbox.push(payload.msg);
      drainSpriteInbox();
    }
  }

  async function waitPeerBuffers(t) {
    if (!t) return;
    for (let n = 0; n < 120; n++) {
      const conns = [];
      if (t.isHost) {
        for (const c of t._conns.values()) conns.push(c);
      } else if (t._hostConn) {
        conns.push(t._hostConn);
      }
      let overloaded = false;
      for (let i = 0; i < conns.length; i++) {
        const c = conns[i];
        if (!c || !c.open) continue;
        const buffered =
          typeof c.bufferSize === "number"
            ? c.bufferSize
            : c.dataChannel && typeof c.dataChannel.bufferedAmount === "number"
              ? c.dataChannel.bufferedAmount
              : 0;
        if (buffered > 512 * 1024) {
          overloaded = true;
          break;
        }
      }
      if (!overloaded) return;
      await sleep(40);
    }
  }

  async function sendProjectTo(t, preBuf) {
    if (projectSyncBusy) {
      logWarn("project sync already in progress");
      return;
    }
    if (!t || !t.connected) {
      logWarn("project sync skipped: not connected");
      return;
    }
    projectSyncBusy = true;
    silenceOutbound(8000);
    try {
      let buf = preBuf;
      if (!buf || !(buf instanceof ArrayBuffer) || buf.byteLength < 1) {
        buf = await saveProjectBytes();
      }
      if (!buf || buf.byteLength < 1) {
        throw new Error("empty project buffer");
      }
      const bytes = new Uint8Array(buf);
      const id =
        Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
      const parts = Math.ceil(bytes.length / CHUNK_SIZE);
      log("sendProjectTo", bytes.length, "bytes", parts, "parts");
      t.broadcast({
        bc: "p-start",
        id,
        parts,
        bytes: bytes.length,
        ver: 2,
      });
      for (let i = 0; i < parts; i++) {
        const slice = bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const chunk = new Uint8Array(slice.length);
        chunk.set(slice);
        const ok = t.broadcast({
          bc: "p-part",
          id,
          i,
          ver: 2,
          bin: chunk,
        });
        if (!ok) {
          await sleep(80);
          t.broadcast({
            bc: "p-part",
            id,
            i,
            ver: 2,
            bin: chunk,
          });
        }
        await waitPeerBuffers(t);
        await sleep(20);
      }
      await waitPeerBuffers(t);
      await sleep(60);
      t.broadcast({ bc: "p-end", id, parts, ver: 2, bytes: bytes.length });
      log("sendProjectTo done", id, parts, "parts");
    } catch (e) {
      logErr("send project", e);
    } finally {
      projectSyncBusy = false;
      silenceOutbound(1000);
    }
  }

  function chunkToUint8(data) {
    if (!data) return null;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (Array.isArray(data)) return new Uint8Array(data);
    if (typeof data === "string") {
      try {
        return new Uint8Array(base64ToBuf(data));
      } catch {
        return null;
      }
    }
    if (typeof data === "object" && data !== null) {
      if (typeof data.length === "number") {
        try {
          return new Uint8Array(data);
        } catch {
          
        }
      }
    }
    return null;
  }

  function handleProjectPart(payload, onReady) {
    if (payload.bc === "p-start") {
      log(
        "recv project start",
        payload.id,
        payload.parts,
        "parts",
        payload.bytes || "?",
        "bytes",
        "ver",
        payload.ver || 1
      );
      projectChunks.set(payload.id, {
        parts: payload.parts,
        chunks: [],
        got: 0,
        bytes: payload.bytes || 0,
        ver: payload.ver || 1,
      });
    } else if (payload.bc === "p-part") {
      const entry = projectChunks.get(payload.id);
      if (!entry) return;
      const piece = chunkToUint8(payload.bin != null ? payload.bin : payload.data);
      if (!piece) {
        logWarn("bad project chunk", payload.id, payload.i);
        return;
      }
      if (!entry.chunks[payload.i]) entry.got += 1;
      entry.chunks[payload.i] = piece;
    } else if (payload.bc === "p-end") {
      const entry = projectChunks.get(payload.id);
      if (!entry) return;
      const expectedParts = entry.parts || payload.parts || 0;
      const tryAssemble = (attempt) => {
        let missing = 0;
        let total = 0;
        for (let i = 0; i < expectedParts; i++) {
          const c = entry.chunks[i];
          if (!c) missing += 1;
          else total += c.byteLength || c.length || 0;
        }
        if (missing > 0) {
          if (attempt < 50) {
            setTimeout(() => tryAssemble(attempt + 1), 100);
            return;
          }
          logWarn(
            "project chunks incomplete",
            payload.id,
            "missing",
            missing,
            "/",
            expectedParts
          );
          projectChunks.delete(payload.id);
          return;
        }
        projectChunks.delete(payload.id);
        const out = new Uint8Array(total);
        let offset = 0;
        for (let i = 0; i < expectedParts; i++) {
          const c = entry.chunks[i];
          out.set(c, offset);
          offset += c.byteLength || c.length;
        }
        log("recv project end", payload.id, out.byteLength, "bytes");
        setTimeout(() => {
          try {
            onReady(out.buffer);
          } catch (e) {
            logErr("project decode/load", e);
          }
        }, 0);
      };
      tryAssemble(0);
    }
  }

  

  let transport;
  let peerJsLoading = null;

  function roomPeerId(room) {
    return PEER_ID_PREFIX + String(room || "").toUpperCase();
  }

  function loadPeerJS() {
    if (typeof window.Peer !== "undefined") return Promise.resolve();
    if (peerJsLoading) return peerJsLoading;
    peerJsLoading = (async () => {
      const allowed = await Scratch.canFetch(PEERJS_CDN);
      if (!allowed) throw new Error("PeerJS CDN not allowed");
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-panglive-peerjs="1"]');
        if (existing) {
          if (typeof window.Peer !== "undefined") {
            resolve();
            return;
          }
          existing.addEventListener("load", () => resolve());
          existing.addEventListener("error", () =>
            reject(new Error("PeerJS failed to load"))
          );
          return;
        }
        const script = document.createElement("script");
        script.src = PEERJS_CDN;
        script.async = true;
        script.dataset.panglivePeerjs = "1";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("PeerJS failed to load"));
        document.head.appendChild(script);
      });
      if (typeof window.Peer === "undefined") {
        throw new Error("PeerJS not available");
      }
    })().catch((e) => {
      peerJsLoading = null;
      throw e;
    });
    return peerJsLoading;
  }

  class P2PTransport {
    constructor() {
      this.peer = null;
      this.room = "";
      this.username = "";
      this.isHost = false;
      this.connected = false;
      this.onlineUsers = new Set();
      this.onPresence = null;
      this.onPayload = null;
      this.onStatus = null;
      this.onChat = null;
      this.onTyping = null;
      this._projectTimer = null;
      this._projectRequested = false;
      this._conns = new Map();
      this._connUsers = new Map();
      this._hostConn = null;
      this._gen = 0;
      this._typingOn = false;
      this._lastSeen = new Map();
      this._hostLastSeen = 0;
      this._kaTimer = null;
    }

    setHandlers({ onPresence, onPayload, onStatus, onChat, onTyping }) {
      this.onPresence = onPresence;
      this.onPayload = onPayload;
      this.onStatus = onStatus;
      this.onChat = onChat;
      this.onTyping = onTyping;
    }

    sendChat(text) {
      const msg = String(text || "").trim().slice(0, 200);
      if (!msg || !this.connected) return null;
      this.sendTyping(false);
      const payload = { bc: "msg", user: this.username, text: msg };
      this.broadcast(payload);
      return payload;
    }

    sendTyping(on) {
      if (!this.connected) return;
      const next = !!on;
      if (this._typingOn === next) return;
      this._typingOn = next;
      this.broadcast({
        bc: "typing",
        user: this.username,
        on: next,
      });
    }

    announceBye() {
      if (!this.username) return;
      try {
        this.broadcast({ bc: "bye", user: this.username });
      } catch {
        
      }
    }

    _touchUser(user) {
      if (!user) return;
      this._lastSeen.set(user, Date.now());
    }

    _startKeepAlive() {
      this._stopKeepAlive();
      this._touchUser(this.username);
      this._hostLastSeen = Date.now();
      this._kaTimer = setInterval(() => this._keepAliveTick(), KEEP_ALIVE_MS);
    }

    _stopKeepAlive() {
      if (this._kaTimer) {
        clearInterval(this._kaTimer);
        this._kaTimer = null;
      }
      this._lastSeen.clear();
      this._hostLastSeen = 0;
    }

    _dropGhost(user) {
      if (!user || user === this.username) return;
      this.onlineUsers.delete(user);
      this._lastSeen.delete(user);
      removeRemoteCursor(user);
      for (const [peerId, u] of [...this._connUsers.entries()]) {
        if (u !== user) continue;
        const conn = this._conns.get(peerId);
        this._conns.delete(peerId);
        this._connUsers.delete(peerId);
        try {
          conn?.close();
        } catch {
          
        }
      }
      this._emitPresence();
      if (this.isHost) {
        this.broadcast({ bc: "bye", user });
      }
    }

    _keepAliveTick() {
      if (!this.connected) return;
      this.broadcast({ bc: "ping", user: this.username, t: Date.now() });
      const now = Date.now();

      if (!this.isHost) {
        if (this._hostLastSeen && now - this._hostLastSeen > GHOST_TIMEOUT_MS) {
          logWarn("host keepalive timeout");
          stopCursorTracking();
          stopSpritePosPolling();
          this._stopKeepAlive();
          this.connected = false;
          this._status("idle", "Host disconnected");
          this.disconnect(true);
          return;
        }
      }

      for (const user of [...this.onlineUsers]) {
        if (user === this.username) continue;
        const last = this._lastSeen.get(user);
        if (last == null) {
          this._touchUser(user);
          continue;
        }
        if (now - last > GHOST_TIMEOUT_MS) {
          logWarn("ghost timeout", user);
          this._dropGhost(user);
        }
      }
    }

    _status(state, detail) {
      this.onStatus?.(state, detail);
    }

    _emitPresence() {
      this.onPresence?.([...this.onlineUsers].sort());
    }

    _sendConn(conn, obj) {
      if (!conn || !conn.open) return false;
      try {
        conn.send(obj);
        return true;
      } catch (e) {
        logErr("peer send failed", obj && obj.bc, e);
        return false;
      }
    }

    broadcast(obj, exceptConn) {
      if (!this.connected) {
        logWarn("broadcast blocked not connected", obj && obj.bc);
        return false;
      }
      let any = false;
      if (this.isHost) {
        for (const conn of this._conns.values()) {
          if (conn === exceptConn) continue;
          if (this._sendConn(conn, obj)) any = true;
        }
        return any;
      }
      return this._sendConn(this._hostConn, obj);
    }

    _wireConn(conn, asHostSide) {
      const peerId = conn.peer;
      conn.on("data", (data) => {
        this._onPeerData(data, conn);
      });
      conn.on("close", () => {
        this._onConnClosed(conn);
      });
      conn.on("error", (err) => {
        logErr("data connection error", peerId, err);
      });

      const onOpen = () => {
        if (asHostSide) {
          this._conns.set(peerId, conn);
          this.broadcast({ bc: "here", user: this.username }, conn);
          this._sendConn(conn, { bc: "here", user: this.username });
          clearTimeout(this._projectTimer);
          this._projectTimer = setTimeout(() => sendProjectTo(this), 500);
          log("guest connected", peerId);
        } else {
          this._hostConn = conn;
          this.connected = true;
          this._projectRequested = true;
          this._hostLastSeen = Date.now();
          this._status("connected", "Connected");
          this.broadcast({ bc: "here", user: this.username });
          setTimeout(() => this.broadcast({ bc: "need-project" }), 400);
          installHooks();
          startCursorTracking();
          startSpritePosPolling();
          installProjectFileCapture();
          this._startKeepAlive();
          this._emitPresence();
          log("connected to host", peerId);
        }
      };

      if (conn.open) onOpen();
      else conn.on("open", onOpen);
    }

    _onConnClosed(conn) {
      const peerId = conn.peer;
      const user = this._connUsers.get(peerId);
      this._conns.delete(peerId);
      this._connUsers.delete(peerId);
      if (this._hostConn === conn) this._hostConn = null;

      if (user) {
        this.onlineUsers.delete(user);
        this._lastSeen.delete(user);
        removeRemoteCursor(user);
        this._emitPresence();
        if (this.isHost) {
          this.broadcast({ bc: "bye", user });
        }
      }

      if (!this.isHost && !this._hostConn) {
        this.connected = false;
        stopCursorTracking();
        this._status("idle", "Disconnected");
        this._emitPresence();
      }
    }

    _markUser(user, conn) {
      if (!user || user === this.username) return;
      if (conn) this._connUsers.set(conn.peer, user);
      this._touchUser(user);
      if (!this.onlineUsers.has(user)) {
        this.onlineUsers.add(user);
        this._emitPresence();
      }
    }

    _handlePayload(payload, fromConn) {
      if (!payload || !payload.bc) return;
      if (payload.bc === "hello") return;

      if (payload.user) this._touchUser(sanitize(payload.user));

      if (payload.bc === "ping") {
        const user = sanitize(payload.user);
        this._touchUser(user);
        return;
      }

      if (payload.bc === "msg") {
        const user = sanitize(payload.user);
        const text = String(payload.text || "").trim().slice(0, 200);
        this._markUser(user, fromConn);
        if (user && text) this.onChat?.({ user, text });
        return;
      }

      if (payload.bc === "here") {
        const user = sanitize(payload.user);
        this._markUser(user, fromConn);
        return;
      }

      if (payload.bc === "bye") {
        const user = sanitize(payload.user);
        if (user && user !== this.username) {
          this.onlineUsers.delete(user);
          this._lastSeen.delete(user);
          removeRemoteCursor(user);
          this._emitPresence();
        }
        return;
      }

      if (payload.bc === "spos") {
        applySpriteState(payload);
        return;
      }

      if (payload.bc === "cursor") {
        const user = sanitize(payload.user);
        if (!user || user === this.username) return;
        this._markUser(user, fromConn);
        upsertRemoteCursor(user, payload);
        return;
      }

      if (payload.bc === "ext") {
        loadRemoteExtension(payload);
        return;
      }

      if (
        payload.bc === "ext-start" ||
        payload.bc === "ext-part" ||
        payload.bc === "ext-end"
      ) {
        handleExtPart(payload);
        return;
      }

      if (
        payload.bc === "sp-start" ||
        payload.bc === "sp-part" ||
        payload.bc === "sp-end"
      ) {
        handleSpritePart(payload);
        return;
      }

      if (payload.bc === "typing") {
        const user = sanitize(payload.user);
        if (!user || user === this.username) return;
        this._markUser(user, fromConn);
        this.onTyping?.({ user, on: payload.on !== false });
        return;
      }

      if (payload.bc === "need-project" && this.isHost) {
        clearTimeout(this._projectTimer);
        this._projectTimer = setTimeout(() => sendProjectTo(this), 300);
        return;
      }

      if (
        payload.bc === "p-start" ||
        payload.bc === "p-part" ||
        payload.bc === "p-end"
      ) {
        handleProjectPart(payload, (buf) => loadProjectBytes(buf));
        return;
      }

      if (payload.bc === "snap") {
        handleRemoteSnap(payload);
        return;
      }

      if (
        payload.bc === "s-start" ||
        payload.bc === "s-part" ||
        payload.bc === "s-end"
      ) {
        handleSnapPart(payload);
        return;
      }

      if (payload.bc === "sync") {
        applyRemote(payload);
      }
    }

    _onPeerData(data, fromConn) {
      if (!this.isHost && fromConn && fromConn === this._hostConn) {
        this._hostLastSeen = Date.now();
      }
      let payload = data;
      if (typeof data === "string") {
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!payload || typeof payload !== "object") return;

      this._handlePayload(payload, fromConn);

      if (this.isHost && fromConn) {
        this.broadcast(payload, fromConn);
      }
    }

    async connect(room, username, isHost) {
      this.disconnect(true);
      const gen = ++this._gen;
      this.room = sanitize(room).toUpperCase();
      this.username = sanitize(username);
      this.isHost = isHost;
      this.onlineUsers = new Set([this.username]);
      this._projectRequested = false;

      log("connect p2p", {
        room: this.room,
        username: this.username,
        isHost,
      });
      this._status("connecting", "Loading PeerJS...");

      try {
        await loadPeerJS();
      } catch (e) {
        logErr("PeerJS load", e);
        this._status("error", "Could not load PeerJS.");
        return;
      }
      if (gen !== this._gen) return;

      this._status("connecting", "Connecting...");
      const hostId = roomPeerId(this.room);

      let peer;
      try {
        peer = isHost
          ? new window.Peer(hostId, { debug: 0 })
          : new window.Peer({ debug: 0 });
      } catch (e) {
        logErr("Peer create", e);
        this._status("error", "Could not start peer.");
        return;
      }
      this.peer = peer;

      peer.on("open", (id) => {
        if (gen !== this._gen || this.peer !== peer) return;
        log("peer open", id, isHost ? "host" : "guest");

        if (isHost) {
          this.connected = true;
          this._status("connected", `Room ${this.room}`);
          installHooks();
          startCursorTracking();
          startSpritePosPolling();
          installProjectFileCapture();
          this._startKeepAlive();
          this._emitPresence();
          return;
        }

        this._status("connecting", "Joining host...");
        const conn = peer.connect(hostId, {
          reliable: true,
          serialization: "binary",
        });
        this._wireConn(conn, false);
      });

      peer.on("connection", (conn) => {
        if (gen !== this._gen || this.peer !== peer || !this.isHost) return;
        this._wireConn(conn, true);
      });

      peer.on("error", (err) => {
        if (gen !== this._gen || this.peer !== peer) return;
        const type = err && err.type;
        logErr("peer error", type || err);
        if (type === "unavailable-id") {
          this._status("error", "Room code already in use.");
          this.disconnect(true);
          return;
        }
        if (type === "peer-unavailable") {
          this._status("error", "Host not found. Is the room open?");
          this.disconnect(true);
          return;
        }
        if (type === "network" || type === "server-error") {
          this._status("error", "PeerJS network error.");
          return;
        }
        if (type === "disconnected") {
          this._status("error", "Disconnected from PeerJS.");
          return;
        }
        this._status("error", "Peer connection error.");
      });

      peer.on("disconnected", () => {
        if (gen !== this._gen || this.peer !== peer) return;
        try {
          peer.reconnect();
        } catch {
          
        }
      });

      peer.on("close", () => {
        if (gen !== this._gen || this.peer !== peer) return;
        this.connected = false;
        stopCursorTracking();
        this._status("idle", "Disconnected");
        this._emitPresence();
      });
    }

    disconnect(silent) {
      if (!silent && this.connected) {
        this.announceBye();
      }
      this._gen += 1;
      stopCursorTracking();
      stopSpritePosPolling();
      this._stopKeepAlive();
      clearTimeout(this._projectTimer);
      this._projectTimer = null;

      for (const conn of this._conns.values()) {
        try {
          conn.close();
        } catch {
          
        }
      }
      this._conns.clear();
      this._connUsers.clear();

      if (this._hostConn) {
        try {
          this._hostConn.close();
        } catch {
          
        }
      }
      this._hostConn = null;

      if (this.peer) {
        try {
          this.peer.destroy();
        } catch {
          
        }
      }
      this.peer = null;
      this.connected = false;
      this.onlineUsers = new Set();
      if (!silent) this._status("idle", "Disconnected");
    }
  }

  transport = new P2PTransport();
  sendLocalFn = (payload) => transport.broadcast(payload);

  function installPageLeaveHooks() {
    if (window.__pangliveLeaveHooked) return;
    window.__pangliveLeaveHooked = true;
    const leave = () => {
      try {
        if (transport && transport.connected) transport.announceBye();
      } catch {
        
      }
      try {
        if (transport && transport.peer) transport.peer.destroy();
      } catch {
        
      }
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("beforeunload", leave);
  }
  installPageLeaveHooks();

  function injectStyles() {
    if (document.getElementById("panglive-styles")) return;
    var style = document.createElement("style");
    style.id = "panglive-styles";
    style.textContent = `
#panglive-window {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 10050;
  width: 220px;
  background: #fff !important;
  border: 1px solid #888;
  font: 12px Arial, sans-serif;
  color: #111 !important;
}
#panglive-window * {
  color: inherit;
}
#panglive-window .pl-bar {
  background: #4C97FF !important;
  color: #fff !important;
  padding: 6px 8px;
  cursor: move;
  user-select: none;
}
#panglive-window .pl-bar button {
  float: right;
  border: 1px solid #ccc;
  background: #fff !important;
  color: #111 !important;
  font-size: 11px;
  padding: 0 5px;
  cursor: pointer;
}
#panglive-window .pl-body {
  padding: 8px;
  background: #fff !important;
  color: #111 !important;
}
#panglive-window label {
  display: block;
  margin: 4px 0 2px;
  color: #111 !important;
}
#panglive-window input,
#panglive-window textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 4px;
  border: 1px solid #999;
  background: #fff !important;
  color: #111 !important;
  caret-color: #111 !important;
  font: 12px Arial, sans-serif;
  -webkit-text-fill-color: #111 !important;
}
#panglive-window input::placeholder {
  color: #777 !important;
  -webkit-text-fill-color: #777 !important;
  opacity: 1;
}
#panglive-window button.pl-btn {
  width: 100%;
  margin-top: 5px;
  padding: 5px;
  border: 1px solid #777;
  background: #eee !important;
  color: #111 !important;
  font: 12px Arial, sans-serif;
  cursor: pointer;
}
#panglive-window button.pl-btn:hover {
  background: #ddd !important;
}
#panglive-window .pl-status {
  margin-top: 5px;
  color: #444 !important;
  min-height: 14px;
}
#panglive-window .pl-status.err {
  color: #c00 !important;
}
#panglive-window .pl-who {
  margin-bottom: 6px;
  word-break: break-word;
  color: #111 !important;
}
#panglive-window .pl-room {
  font: bold 18px Consolas, monospace;
  letter-spacing: 2px;
  text-align: center;
  margin: 4px 0;
  color: #111 !important;
}
#panglive-window .pl-leave {
  border: none;
  background: transparent !important;
  color: #c00 !important;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
  margin-top: 4px;
}
#panglive-window .pl-chat {
  margin-top: 6px;
  border-top: 1px solid #ccc;
  padding-top: 6px;
}
#panglive-window #pl-log {
  height: 110px;
  font: 11px Consolas, monospace;
  resize: vertical;
}
#panglive-window .pl-sendrow {
  margin-top: 4px;
}
#panglive-window .pl-sendrow input {
  width: 70%;
}
#panglive-window .pl-sendrow button {
  width: auto;
  margin-top: 0;
  margin-left: 4px;
  padding: 4px 8px;
}
#panglive-window #pl-typing {
  display: block;
  height: 14px;
  color: #555 !important;
  font-size: 11px;
}
#panglive-cursors {
  position: fixed;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  z-index: 10040;
  pointer-events: none;
}
.pl-cur {
  position: absolute;
  left: 0;
  top: 0;
}
.pl-cur img {
  display: block;
  width: 22px;
  height: 22px;
}
.pl-cur span {
  display: inline-block;
  margin-top: 1px;
  padding: 1px 4px;
  color: #fff !important;
  font: 10px Arial, sans-serif;
  max-width: 90px;
  overflow: hidden;
  white-space: nowrap;
}
`;
    document.head.appendChild(style);
  }

  function makeDraggable(bar, win) {
    var drag = false;
    var ox = 0;
    var oy = 0;
    bar.onmousedown = function (e) {
      if (e.target.tagName === "BUTTON") return;
      drag = true;
      var r = win.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      win.style.left = r.left + "px";
      win.style.top = r.top + "px";
      win.style.right = "auto";
      win.style.bottom = "auto";
      e.preventDefault();
    };
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var x = Math.max(0, Math.min(e.clientX - ox, window.innerWidth - 80));
      var y = Math.max(0, Math.min(e.clientY - oy, window.innerHeight - 40));
      win.style.left = x + "px";
      win.style.top = y + "px";
    });
    document.addEventListener("mouseup", function () {
      drag = false;
    });
  }

  function createUI() {
    injectStyles();

    var win = document.createElement("div");
    win.id = "panglive-window";
    win.innerHTML =
      '<div class="pl-bar" id="pl-bar">PangLive' +
      '<button type="button" id="pl-close">x</button></div>' +
      '<div class="pl-body">' +
      '<div class="pl-who" id="pl-who" style="display:none">' +
      "<label>Room</label>" +
      '<div class="pl-room" id="pl-room">----</div>' +
      "Online: <span id=\"pl-users\"></span><br>" +
      '<button type="button" class="pl-leave" id="pl-leave">Leave</button></div>' +
      '<div class="pl-chat" id="pl-chat" style="display:none">' +
      "<label>Chat</label>" +
      '<textarea id="pl-log" readonly></textarea>' +
      '<span id="pl-typing"></span>' +
      '<div class="pl-sendrow">' +
      '<input id="pl-msg" type="text" maxlength="200" placeholder="message">' +
      '<button type="button" class="pl-btn" id="pl-send">Send</button></div></div>' +
      '<div id="pl-form">' +
      '<div id="pl-home">' +
      "<label>Username</label>" +
      '<input id="pl-user" type="text" maxlength="16">' +
      '<button type="button" class="pl-btn" id="pl-create">Create room</button>' +
      '<button type="button" class="pl-btn" id="pl-join">Join room</button></div>' +
      '<div id="pl-joinbox" style="display:none">' +
      "<label>Room code</label>" +
      '<input id="pl-code" type="text" maxlength="4" placeholder="A1B2">' +
      '<button type="button" class="pl-btn" id="pl-join-go">Join</button>' +
      '<button type="button" class="pl-btn" id="pl-back">Back</button></div>' +
      '<div class="pl-status" id="pl-status"></div></div></div>';

    document.body.appendChild(win);

    var home = win.querySelector("#pl-home");
    var joinbox = win.querySelector("#pl-joinbox");
    var statusEl = win.querySelector("#pl-status");
    var userInput = win.querySelector("#pl-user");
    var codeInput = win.querySelector("#pl-code");
    var roomEl = win.querySelector("#pl-room");
    var usersEl = win.querySelector("#pl-users");
    var who = win.querySelector("#pl-who");
    var chat = win.querySelector("#pl-chat");
    var form = win.querySelector("#pl-form");
    var logEl = win.querySelector("#pl-log");
    var msgInput = win.querySelector("#pl-msg");
    var typingEl = win.querySelector("#pl-typing");
    var lines = [];
    var typingUsers = new Map();
    var typingTimer = null;
    var knownUsers = new Set();
    var presenceSeeded = false;

    userInput.value = randomUsername();
    makeDraggable(win.querySelector("#pl-bar"), win);
    warmSfx();

    function setConnected(on) {
      who.style.display = on ? "block" : "none";
      chat.style.display = on ? "block" : "none";
      form.style.display = on ? "none" : "block";
    }

    function renderTyping() {
      var names = Array.from(typingUsers.keys());
      typingEl.textContent = names.length ? names.join(", ") + " typing..." : "";
    }

    function setRemoteTyping(user, on) {
      if (!user) return;
      if (on) typingUsers.set(user, Date.now());
      else typingUsers.delete(user);
      renderTyping();
    }

    function clearTyping() {
      typingUsers.clear();
      renderTyping();
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
      transport.sendTyping(false);
    }

    function renderChat() {
      var t = "";
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].system) t += "* " + lines[i].text + "\n";
        else t += lines[i].user + ": " + lines[i].text + "\n";
      }
      logEl.value = t;
      logEl.scrollTop = logEl.scrollHeight;
    }

    function pushChat(user, text) {
      typingUsers.delete(user);
      renderTyping();
      lines.push({ user: user, text: text });
      while (lines.length > CHAT_HISTORY) lines.shift();
      renderChat();
      playSfx("msg");
    }

    function pushSystem(text) {
      lines.push({ system: true, text: text });
      while (lines.length > CHAT_HISTORY) lines.shift();
      renderChat();
    }

    function clearChat() {
      lines.length = 0;
      clearTyping();
      renderChat();
    }

    function getUsername() {
      var name = sanitize(userInput.value).replace(/\s+/g, "").slice(0, 16);
      if (name && name !== "user") return name;
      userInput.value = randomUsername();
      return userInput.value;
    }

    function sendChatMessage() {
      var payload = transport.sendChat(msgInput.value);
      if (!payload) return;
      pushChat(payload.user, payload.text);
      msgInput.value = "";
    }

    function noteLocalTyping() {
      if (!transport.connected) return;
      transport.sendTyping(true);
      if (typingTimer) clearTimeout(typingTimer);
      typingTimer = setTimeout(function () {
        typingTimer = null;
        transport.sendTyping(false);
      }, TYPING_IDLE_MS);
    }

    win.querySelector("#pl-close").onclick = function () {
      win.style.display = "none";
    };

    win.querySelector("#pl-create").onclick = function () {
      warmSfx();
      var code = randomRoomCode();
      roomEl.textContent = code;
      statusEl.className = "pl-status";
      statusEl.textContent = "creating...";
      transport.connect(code, getUsername(), true);
    };

    win.querySelector("#pl-join").onclick = function () {
      home.style.display = "none";
      joinbox.style.display = "block";
      codeInput.value = "";
      codeInput.focus();
    };

    win.querySelector("#pl-back").onclick = function () {
      joinbox.style.display = "none";
      home.style.display = "block";
      statusEl.textContent = "";
      statusEl.className = "pl-status";
    };

    codeInput.oninput = function () {
      codeInput.value = codeInput.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 4);
    };

    win.querySelector("#pl-join-go").onclick = function () {
      var code = sanitize(codeInput.value).toUpperCase();
      if (code.length !== 4) {
        statusEl.textContent = "need 4 chars";
        statusEl.className = "pl-status err";
        return;
      }
      warmSfx();
      statusEl.className = "pl-status";
      statusEl.textContent = "joining...";
      transport.connect(code, getUsername(), false);
    };

    win.querySelector("#pl-leave").onclick = function () {
      transport.disconnect();
      setConnected(false);
      joinbox.style.display = "none";
      home.style.display = "block";
      statusEl.textContent = "";
      usersEl.textContent = "";
      clearChat();
    };

    win.querySelector("#pl-send").onclick = sendChatMessage;
    msgInput.onkeydown = function (e) {
      if (e.key === "Enter") sendChatMessage();
    };
    msgInput.oninput = noteLocalTyping;

    transport.setHandlers({
      onPresence: function (users) {
        usersEl.textContent = users.join(", ") || "-";
        Array.from(typingUsers.keys()).forEach(function (name) {
          if (users.indexOf(name) === -1) typingUsers.delete(name);
        });
        renderTyping();
        pruneRemoteCursors(users);
        if (!presenceSeeded) {
          knownUsers = new Set(users);
          presenceSeeded = true;
          return;
        }
        for (var i = 0; i < users.length; i++) {
          if (!knownUsers.has(users[i]) && users[i] !== transport.username) {
            playSfx("join");
            pushSystem(users[i] + " joined");
          }
        }
        knownUsers.forEach(function (name) {
          if (users.indexOf(name) === -1 && name !== transport.username) {
            playSfx("leave");
            pushSystem(name + " left");
          }
        });
        knownUsers = new Set(users);
      },
      onChat: function (m) {
        pushChat(m.user, m.text);
      },
      onTyping: function (m) {
        setRemoteTyping(m.user, m.on);
      },
      onStatus: function (state, detail) {
        statusEl.textContent = detail || "";
        statusEl.className = "pl-status" + (state === "error" ? " err" : "");
        if (state === "connected") {
          setConnected(true);
          roomEl.textContent = transport.room.toUpperCase();
          presenceSeeded = false;
          knownUsers = new Set();
        } else if (state === "idle" || state === "error") {
          setConnected(false);
          clearChat();
          clearRemoteCursors();
          presenceSeeded = false;
          knownUsers = new Set();
        }
      },
    });

    return {
      show: function () {
        win.style.display = "block";
      },
    };
  }

  class PangLiveExtension {
    getInfo() {
      return {
        id: "panglive",
        name: "PangLive",
        color1: "#4C97FF",
        color2: "#3373CC",
        blocks: [
          {
            opcode: "open",
            blockType: Scratch.BlockType.COMMAND,
            text: "open PangLive",
          },
        ],
      };
    }
    open() {
      ui.show();
    }
  }

  var ui = createUI();
  Scratch.extensions.register(new PangLiveExtension());
  setTimeout(function () {
    ui.show();
  }, 1500);
  installHooks();
})(Scratch);
