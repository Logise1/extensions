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

  const WS_BASE = "wss://logiseonlineservices.arielcapdevila.com";
  const STAGE_NAME = "__PangLiveStage__";
  const CHUNK_SIZE = 12000;
  const vm = Scratch.vm;
  const runtime = vm.runtime;

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

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
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
  let workspaceHookTimer = null;
  const dirtyTargets = new Set();
  let snapTimer = null;
  let idleFlushTimer = null;
  let projectSyncTimer = null;
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

  function scheduleProjectSync(delayMs) {
    if (!transport || !transport.connected) return;
    if (Date.now() < suppressSendUntil) return;
    clearTimeout(projectSyncTimer);
    projectSyncTimer = setTimeout(() => {
      if (!canSendSync()) return;
      if (isDragging()) {
        scheduleProjectSync(200);
        return;
      }
      silenceOutbound(1500);
      log("project sync send");
      sendProjectTo(transport);
    }, delayMs == null ? 700 : delayMs);
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
    workspaceHookTimer = setInterval(() => {
      hookWorkspaceListener();
      wrapBlockListener();
    }, 400);
  }

  function sendSpriteProxy(msg) {
    if (pauseEventHandling || !transport || !transport.connected) return;
    broadcastRaw({ bc: "sync", msg });
  }

  function proxyMethod(original, name, serializeArgs) {
    proxyActions[name] = function (...args) {
      if (args[0] === "linguini") {
        const data = args[1];
        const callArgs = data.args || [];
        return original.apply(vm, callArgs);
      }
      if (pauseEventHandling) return original.apply(vm, args);
      const result = original.apply(vm, args);
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

  function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    log("installHooks");

    startWorkspaceHookPolling();
    vm.on("workspaceUpdate", hookWorkspaceListener);
    vm.on("PROJECT_LOADED", () => {
      hookWorkspaceListener();
      silenceOutbound(500);
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
    let out = await vm.saveProjectSb3("arraybuffer");
    if (out instanceof Blob) out = await out.arrayBuffer();
    return out;
  }

  async function loadProjectBytes(buf) {
    pauseEventHandling = true;
    silenceOutbound(2000);
    dirtyTargets.clear();
    playAfterDrag.length = 0;
    lastApplied.clear();
    clearTimeout(projectSyncTimer);
    try {
      await vm.loadProject(buf);
      vm.emitWorkspaceUpdate();
      vm.emitTargetsUpdate();
      hookWorkspaceListener();
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
          try {
            await proxyActions[msg.data.name]("linguini", msg.data);
            vm.emitTargetsUpdate();
            vm.emitWorkspaceUpdate();
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

  async function sendProjectTo(t) {
    try {
      const buf = await saveProjectBytes();
      log("sendProjectTo", buf.byteLength, "bytes");
      const b64 = bufToBase64(buf);
      const id = Date.now().toString(36);
      const parts = Math.ceil(b64.length / CHUNK_SIZE);
      t.broadcast({ bc: "p-start", id, parts });
      for (let i = 0; i < parts; i++) {
        t.broadcast({
          bc: "p-part",
          id,
          i,
          data: b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        });
      }
      t.broadcast({ bc: "p-end", id });
      log("sendProjectTo done", id, parts, "parts");
    } catch (e) {
      logErr("send project", e);
    }
  }

  function handleProjectPart(payload, onReady) {
    if (payload.bc === "p-start") {
      log("recv project start", payload.id, payload.parts, "parts");
      projectChunks.set(payload.id, { parts: payload.parts, chunks: [] });
    } else if (payload.bc === "p-part") {
      const entry = projectChunks.get(payload.id);
      if (entry) entry.chunks[payload.i] = payload.data;
    } else if (payload.bc === "p-end") {
      const entry = projectChunks.get(payload.id);
      projectChunks.delete(payload.id);
      if (!entry) return;
      const b64 = entry.chunks.join("");
      log("recv project end", payload.id, b64.length, "b64 chars");
      if (b64) onReady(base64ToBuf(b64));
    }
  }

  

  let transport;

  class RelayTransport {
    constructor() {
      this.ws = null;
      this.room = "";
      this.username = "";
      this.isHost = false;
      this.connected = false;
      this.onlineUsers = new Set();
      this.onPresence = null;
      this.onPayload = null;
      this.onStatus = null;
      this.onChat = null;
      this._projectTimer = null;
      this._projectRequested = false;
    }

    setHandlers({ onPresence, onPayload, onStatus, onChat }) {
      this.onPresence = onPresence;
      this.onPayload = onPayload;
      this.onStatus = onStatus;
      this.onChat = onChat;
    }

    sendChat(text) {
      const msg = String(text || "").trim().slice(0, 200);
      if (!msg || !this.connected) return null;
      const payload = { bc: "msg", user: this.username, text: msg };
      this.broadcast(payload);
      return payload;
    }

    _status(state, detail) {
      this.onStatus?.(state, detail);
    }

    _emitPresence() {
      this.onPresence?.([...this.onlineUsers].sort());
    }

    broadcast(obj) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        logWarn("broadcast blocked ws not open", obj.bc);
        return;
      }
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (e) {
        logErr("broadcast failed", obj.bc, e);
      }
    }

    async connect(room, username, isHost) {
      this.disconnect(true);
      this.room = sanitize(room);
      this.username = sanitize(username);
      this.isHost = isHost;
      this.onlineUsers = new Set([this.username]);

      const url = `${WS_BASE}/${encodeURIComponent(this.room)}/${encodeURIComponent(this.username)}`;
      log("connect", { room: this.room, username: this.username, isHost, url });
      this._status("connecting", "Connecting…");

      const allowed = await Scratch.canFetch(url);
      if (!allowed) {
        logErr("canFetch denied", url);
        this._status("error", "Connection not allowed.");
        return;
      }

      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.connected = true;
        this._projectRequested = false;
        log("ws open", this.username, this.room, isHost ? "host" : "guest");
        this._status(
          "connected",
          isHost ? `Room ${this.room.toUpperCase()}` : "Connected"
        );
        
        this.broadcast({ bc: "here", user: this.username });
        if (!isHost) {
          this._projectRequested = true;
          setTimeout(() => this.broadcast({ bc: "need-project" }), 400);
        }
        installHooks();
        this._emitPresence();
      };

      ws.onmessage = (ev) => {
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (data.type === "system") {
          const user = sanitize(data.username);
          if (data.action === "join") {
            this.onlineUsers.add(user);
            this._emitPresence();
            
            if (user !== this.username) {
              this.broadcast({ bc: "here", user: this.username });
            }
            if (this.isHost && user !== this.username) {
              clearTimeout(this._projectTimer);
              this._projectTimer = setTimeout(() => sendProjectTo(this), 500);
            }
          } else if (data.action === "leave") {
            this.onlineUsers.delete(user);
            this._emitPresence();
          }
          return;
        }

        if (data.type !== "chat" || data.username === this.username) return;

        
        const chatUser = sanitize(data.username);
        if (chatUser && !this.onlineUsers.has(chatUser)) {
          this.onlineUsers.add(chatUser);
          this._emitPresence();
        }

        let payload;
        try {
          payload = JSON.parse(data.message);
        } catch {
          return;
        }
        if (!payload.bc) return;

        if (payload.bc === "hello") return;

        if (payload.bc === "msg") {
          const user = sanitize(payload.user || data.username);
          const text = String(payload.text || "").trim().slice(0, 200);
          if (user && text) this.onChat?.({ user, text });
          return;
        }

        if (payload.bc === "here") {
          const user = sanitize(payload.user || data.username);
          if (user && user !== this.username) {
            this.onlineUsers.add(user);
            this._emitPresence();
          }
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
      };

      ws.onerror = () => {
        logErr("ws error");
        this._status("error", "WebSocket error.");
      };

      ws.onclose = () => {
        this.connected = false;
        log("ws close", this.username);
        if (this.ws === ws) {
          this._status("idle", "Disconnected");
          this._emitPresence();
        }
      };
    }

    disconnect(silent) {
      if (this.ws) {
        try {
          this.ws.onclose = null;
          this.ws.close();
        } catch {
          
        }
      }
      this.ws = null;
      this.connected = false;
      if (!silent) this._status("idle", "Disconnected");
    }
  }

  

  transport = new RelayTransport();
  sendLocalFn = (payload) => transport.broadcast(payload);

  function injectStyles() {
    if (document.getElementById("panglive-styles")) return;
    const style = document.createElement("style");
    style.id = "panglive-styles";
    style.textContent = `
      #panglive-window {
        position: fixed; right: 12px; bottom: 12px; z-index: 10050;
        width: 240px; max-width: calc(100vw - 24px);
        font-family: system-ui, sans-serif;
        background: #fff;
        border: 1px solid #ccc;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.12);
        color: #111;
      }
      #panglive-window.hidden { display: none; }
      #panglive-window.collapsed .pl-body { display: none; }
      .pl-bar {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 10px; background: #222; color: #fff;
        cursor: grab; user-select: none; border-radius: 8px 8px 0 0;
      }
      .pl-bar:active { cursor: grabbing; }
      .pl-title { flex: 1; font-size: 13px; font-weight: 600; color: #fff; }
      .pl-x {
        border: none; background: transparent; color: #fff;
        font-size: 16px; line-height: 1; cursor: pointer; padding: 0 2px;
      }
      .pl-body { padding: 12px; color: #111; }
      .pl-row { display: flex; flex-direction: column; gap: 8px; }
      .pl-row.hidden { display: none; }
      .pl-hint { font-size: 12px; color: #333; }
      .pl-label { font-size: 12px; font-weight: 600; color: #111; }
      .pl-code {
        font-size: 28px; font-weight: 700; letter-spacing: 0.18em;
        text-align: center; font-family: ui-monospace, monospace;
        color: #111;
      }
      .pl-input {
        width: 100%; box-sizing: border-box; padding: 8px;
        border: 1px solid #999; border-radius: 6px;
        font-size: 14px; font-weight: 600; text-align: center;
        color: #111; background: #fff;
      }
      .pl-input.pl-room-input {
        font-size: 18px; letter-spacing: 0.2em; text-transform: uppercase;
      }
      .pl-btn {
        width: 100%; padding: 8px; border: none; border-radius: 6px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        background: #222; color: #fff;
      }
      .pl-btn.secondary { background: #e8e8e8; color: #111; }
      .pl-status { font-size: 11px; color: #444; min-height: 14px; }
      .pl-status.error { color: #b00020; }
      .pl-online {
        display: none; align-items: center; gap: 6px; flex-wrap: wrap;
        margin-bottom: 8px; color: #111;
      }
      #panglive-window.connected .pl-online { display: flex; }
      #panglive-window.connected .pl-form { display: none; }
      .pl-online-label { font-size: 12px; font-weight: 700; color: #111; }
      .pl-avatars { display: flex; }
      .pl-avatar {
        width: 22px; height: 22px; border-radius: 50%;
        margin-left: -4px; display: flex; align-items: center;
        justify-content: center; color: #fff; font-size: 10px;
        font-weight: 700; border: 1px solid #fff;
      }
      .pl-avatar:first-child { margin-left: 0; }
      .pl-leave {
        margin-left: auto; border: none; background: transparent;
        color: #b00020; font-size: 12px; font-weight: 600; cursor: pointer;
      }
      .pl-chat {
        display: none; flex-direction: column; gap: 6px;
        margin-top: 10px; border-top: 1px solid #ddd; padding-top: 10px;
      }
      #panglive-window.connected .pl-chat { display: flex; }
      .pl-chat-list {
        display: flex; flex-direction: column; gap: 4px;
        min-height: 72px; max-height: 110px; overflow: hidden;
      }
      .pl-chat-empty { font-size: 11px; color: #666; }
      .pl-chat-line {
        font-size: 11px; line-height: 1.3; color: #111;
        word-break: break-word;
      }
      .pl-chat-line b { color: #222; }
      .pl-chat-send { display: flex; gap: 6px; }
      .pl-chat-send .pl-input {
        flex: 1; font-size: 12px; font-weight: 500; text-align: left;
        letter-spacing: normal; text-transform: none;
      }
      .pl-chat-send .pl-btn {
        width: auto; padding: 8px 10px; flex-shrink: 0;
      }
    `;
    document.head.appendChild(style);
  }

  function makeDraggable(handle, element) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.target.closest(".pl-x")) return;
      dragging = true;
      const rect = element.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      element.style.left = `${rect.left}px`;
      element.style.top = `${rect.top}px`;
      element.style.right = "auto";
      element.style.bottom = "auto";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - 80));
      const y = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - 40));
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function createUI() {
    injectStyles();

    const win = document.createElement("div");
    win.id = "panglive-window";
    win.innerHTML = `
      <div class="pl-bar">
        <span class="pl-title">PangLive</span>
        <button class="pl-x" id="pl-close" title="Close">×</button>
      </div>
      <div class="pl-body">
        <div class="pl-online">
          <span class="pl-online-label">Online</span>
          <div class="pl-avatars" id="pl-avatars"></div>
          <button class="pl-leave" id="pl-leave">Leave</button>
        </div>
        <div class="pl-row hidden" id="pl-room">
          <div class="pl-label">Room code</div>
          <div class="pl-code" id="pl-room-code">----</div>
        </div>
        <div class="pl-chat" id="pl-chat">
          <div class="pl-label">Chat</div>
          <div class="pl-chat-list" id="pl-chat-list">
            <div class="pl-chat-empty">No messages yet</div>
          </div>
          <div class="pl-chat-send">
            <input id="pl-chat-input" class="pl-input" maxlength="200" placeholder="Message…" />
            <button class="pl-btn" id="pl-chat-go">Send</button>
          </div>
        </div>
        <div class="pl-form" id="pl-form">
          <div class="pl-row" id="pl-home">
            <div class="pl-label">Username</div>
            <input id="pl-username" class="pl-input" maxlength="16" placeholder="your name" />
            <button class="pl-btn" id="pl-create">Create room</button>
            <button class="pl-btn secondary" id="pl-join">Join room</button>
          </div>
          <div class="pl-row hidden" id="pl-join-panel">
            <div class="pl-label">Room code</div>
            <input id="pl-code" class="pl-input pl-room-input" maxlength="4" placeholder="A1B2" />
            <button class="pl-btn" id="pl-join-go">Join</button>
            <button class="pl-btn secondary" id="pl-back">Back</button>
          </div>
          <div class="pl-status" id="pl-status"></div>
        </div>
      </div>
    `;

    document.body.appendChild(win);

    const home = win.querySelector("#pl-home");
    const joinPanel = win.querySelector("#pl-join-panel");
    const statusEl = win.querySelector("#pl-status");
    const usernameInput = win.querySelector("#pl-username");
    const codeInput = win.querySelector("#pl-code");
    const roomCodeEl = win.querySelector("#pl-room-code");
    const roomBlock = win.querySelector("#pl-room");
    const chatList = win.querySelector("#pl-chat-list");
    const chatInput = win.querySelector("#pl-chat-input");
    const titlebar = win.querySelector(".pl-bar");
    const chatMessages = [];

    usernameInput.value = randomUsername();
    makeDraggable(titlebar, win);

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function renderChat() {
      if (chatMessages.length === 0) {
        chatList.innerHTML = `<div class="pl-chat-empty">No messages yet</div>`;
        return;
      }
      chatList.innerHTML = chatMessages
        .map(
          (m) =>
            `<div class="pl-chat-line"><b>${escapeHtml(m.user)}</b>: ${escapeHtml(m.text)}</div>`
        )
        .join("");
    }

    function pushChat(user, text) {
      chatMessages.push({ user, text });
      while (chatMessages.length > 5) chatMessages.shift();
      renderChat();
    }

    function clearChat() {
      chatMessages.length = 0;
      renderChat();
    }

    function getUsername() {
      const name = sanitize(usernameInput.value).replace(/\s+/g, "").slice(0, 16);
      if (name && name !== "user") return name;
      const fallback = randomUsername();
      usernameInput.value = fallback;
      return fallback;
    }

    function sendChatMessage() {
      const payload = transport.sendChat(chatInput.value);
      if (!payload) return;
      pushChat(payload.user, payload.text);
      chatInput.value = "";
      chatInput.focus();
    }

    win.querySelector("#pl-close").addEventListener("click", () => {
      win.classList.add("hidden");
    });

    win.querySelector("#pl-create").addEventListener("click", () => {
      const code = randomRoomCode();
      roomCodeEl.textContent = code;
      statusEl.className = "pl-status";
      statusEl.textContent = "Creating…";
      transport.connect(code, getUsername(), true);
    });

    win.querySelector("#pl-join").addEventListener("click", () => {
      home.classList.add("hidden");
      joinPanel.classList.remove("hidden");
      codeInput.value = "";
      codeInput.focus();
    });

    win.querySelector("#pl-back").addEventListener("click", () => {
      joinPanel.classList.add("hidden");
      home.classList.remove("hidden");
      statusEl.textContent = "";
      statusEl.className = "pl-status";
    });

    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 4);
    });

    codeInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") win.querySelector("#pl-join-go").click();
    });

    win.querySelector("#pl-join-go").addEventListener("click", () => {
      const code = sanitize(codeInput.value).toUpperCase();
      if (code.length !== 4) {
        statusEl.textContent = "Code must be 4 characters.";
        statusEl.className = "pl-status error";
        return;
      }
      statusEl.className = "pl-status";
      statusEl.textContent = "Joining…";
      transport.connect(code, getUsername(), false);
    });

    win.querySelector("#pl-leave").addEventListener("click", () => {
      transport.disconnect();
      win.classList.remove("connected", "collapsed");
      roomBlock.classList.add("hidden");
      joinPanel.classList.add("hidden");
      home.classList.remove("hidden");
      statusEl.textContent = "";
      statusEl.className = "pl-status";
      clearChat();
    });

    win.querySelector("#pl-chat-go").addEventListener("click", sendChatMessage);
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChatMessage();
    });

    transport.setHandlers({
      onPresence: (users) => {
        const avatars = win.querySelector("#pl-avatars");
        avatars.innerHTML = "";
        users.slice(0, 8).forEach((name) => {
          const el = document.createElement("div");
          el.className = "pl-avatar";
          el.title = name;
          el.style.background = hashColor(name);
          el.textContent = name.slice(0, 1);
          avatars.appendChild(el);
        });
      },
      onChat: ({ user, text }) => {
        pushChat(user, text);
      },
      onStatus: (state, detail) => {
        statusEl.textContent = detail || "";
        statusEl.className = "pl-status" + (state === "error" ? " error" : "");
        if (state === "connected") {
          win.classList.add("connected");
          roomCodeEl.textContent = transport.room.toUpperCase();
          roomBlock.classList.remove("hidden");
        } else if (state === "idle" || state === "error") {
          win.classList.remove("connected");
          roomBlock.classList.add("hidden");
          clearChat();
        }
      },
    });

    return {
      show() {
        win.classList.remove("hidden", "collapsed");
      },
    };
  }

  class PangLiveExtension {
    getInfo() {
      return {
        id: "panglive",
        name: "PangLive",
        color1: "#222222",
        color2: "#111111",
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

  const ui = createUI();
  Scratch.extensions.register(new PangLiveExtension());

  setTimeout(() => ui.show(), 1500);
  installHooks();
  log("PangLive loaded unsandboxed");
})(Scratch);
