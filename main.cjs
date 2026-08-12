"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// electron/main.ts
var import_electron = require("electron");
var import_node_fs2 = require("node:fs");
var import_promises7 = require("node:fs/promises");
var import_node_path9 = require("node:path");

// electron/agent-env.ts
var import_node_path = require("node:path");
function buildAgentEnv(sessionId, agentId, role, sessionDir) {
  const box = (0, import_node_path.join)(sessionDir, "agents", agentId);
  return {
    FRAKTOLE_SESSION_ID: sessionId,
    FRAKTOLE_SESSION_DIR: sessionDir,
    FRAKTOLE_AGENT_ID: agentId,
    FRAKTOLE_ROLE: role,
    FRAKTOLE_INBOX: (0, import_node_path.join)(box, "inbox"),
    FRAKTOLE_OUTBOX: (0, import_node_path.join)(box, "outbox")
  };
}

// electron/mailbox.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path2 = require("node:path");
var ORCHESTRATOR_ID = "orchestrator";
var seq = 0;
function messageId() {
  seq += 1;
  return `m-${Date.now()}-${seq}`;
}
function routeMessage(msg, srcRole) {
  if (!msg || typeof msg !== "object") return "malformed";
  if (typeof msg.from !== "string" || typeof msg.to !== "string") return "malformed";
  if (typeof msg.body !== "string" || typeof msg.at !== "number") return "malformed";
  if (msg.kind !== "task" && msg.kind !== "result" && msg.kind !== "note") return "malformed";
  if (srcRole === "agent" && msg.to !== ORCHESTRATOR_ID) return "forbidden";
  if (msg.to === msg.from) return "forbidden";
  return "ok";
}
function echoText(from, to, kind, body) {
  return `\r
\x1B[36m[fraktole]\x1B[0m ${from} \x1B[2m\u2192\x1B[0m ${to} \x1B[2m(${kind})\x1B[0m: ${body}\r
`;
}
function log(opts, line) {
  (opts.logger ?? console.log)(line);
}
var MailboxRouter = class {
  constructor(opts) {
    this.opts = opts;
  }
  watcher = null;
  scanTimer = null;
  scanPending = false;
  start(sessionId) {
    this.stop();
    const agentsDir = (0, import_node_path2.join)(this.opts.root, sessionId, "agents");
    try {
      this.watcher = (0, import_node_fs.watch)(agentsDir, { recursive: true }, () => this.scheduleScan());
    } catch (err) {
      log(this.opts, `mailbox watcher unavailable (${String(err)}); relying on the scan`);
    }
    this.scanTimer = setInterval(() => this.scanOutboxes(), 2e3);
    this.scanTimer.unref();
    this.scheduleScan();
  }
  stop() {
    this.watcher?.close();
    this.watcher = null;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }
  scheduleScan() {
    if (this.scanPending) return;
    this.scanPending = true;
    setTimeout(() => {
      this.scanPending = false;
      void this.scanOutboxes();
    }, 150);
  }
  /** Reads every outbox and ingests new message files. */
  async scanOutboxes() {
    const session = this.opts.currentSession();
    if (!session) return;
    const agentsDir = (0, import_node_path2.join)(this.opts.root, session.id, "agents");
    let agents;
    try {
      agents = (await (0, import_promises.readdir)(agentsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    for (const agentId of agents) {
      const outbox = (0, import_node_path2.join)(agentsDir, agentId, "outbox");
      let files;
      try {
        files = await (0, import_promises.readdir)(outbox);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/^m-\d+-\d+\.json$/.test(file)) continue;
        await this.ingestOutboxFile((0, import_node_path2.join)(outbox, file), agentId);
      }
    }
  }
  /** Reads one outbox file, delivers it, then consumes it. */
  async ingestOutboxFile(file, sourceAgentId) {
    const session = this.opts.currentSession();
    if (!session) return;
    let raw;
    try {
      raw = await (0, import_promises.readFile)(file, "utf8");
    } catch {
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log(this.opts, `mailbox: dropping malformed ${file}`);
      await (0, import_promises.unlink)(file).catch(() => void 0);
      return;
    }
    const verdict = routeMessage(msg, sourceAgentId === ORCHESTRATOR_ID ? "judge" : "agent");
    if (verdict !== "ok") {
      log(this.opts, `mailbox: ${file} rejected (${verdict})`);
      await (0, import_promises.unlink)(file).catch(() => void 0);
      return;
    }
    msg.from = sourceAgentId;
    await this.deliver(msg, sourceAgentId);
    await (0, import_promises.unlink)(file).catch(() => void 0);
  }
  /** Validates + writes a message produced inside Fraktole (the composer). */
  async sendFromOrchestrator(msg) {
    const session = this.opts.currentSession();
    if (!session) return false;
    if (routeMessage(msg, "judge") !== "ok") return false;
    if (!session.tiles.some((t) => t.agentId === msg.to)) return false;
    await this.deliver(msg, ORCHESTRATOR_ID);
    return true;
  }
  /** Routes a message to the target's inbox, appends the canonical log and
   *  echoes it into the target's terminal. Idempotent by message id. */
  async deliver(msg, sourceAgentId) {
    const session = this.opts.currentSession();
    if (!session) return;
    if (await this.alreadyLogged(session.id, msg.id)) return;
    if (sourceAgentId !== ORCHESTRATOR_ID) msg.from = sourceAgentId;
    if (msg.from === ORCHESTRATOR_ID && msg.at === 0) msg.at = Date.now();
    const agentsDir = (0, import_node_path2.join)(this.opts.root, session.id, "agents");
    const targetDir = (0, import_node_path2.join)(agentsDir, msg.to);
    await (0, import_promises.mkdir)((0, import_node_path2.join)(targetDir, "inbox"), { recursive: true });
    await this.appendLog(session.id, msg);
    await (0, import_promises.writeFile)((0, import_node_path2.join)(targetDir, "inbox", `${msg.id}.json`), JSON.stringify(msg, null, 2), "utf8");
    const tileId = this.opts.tileOfAgent(msg.to);
    if (tileId) this.opts.write(tileId, echoText(msg.from, msg.to, msg.kind, msg.body));
    this.opts.emit(msg);
  }
  async alreadyLogged(sessionId, id) {
    try {
      const raw = await (0, import_promises.readFile)(this.logFile(sessionId), "utf8");
      return raw.includes(id);
    } catch {
      return false;
    }
  }
  logFile(sessionId) {
    return (0, import_node_path2.join)(this.opts.root, sessionId, "messages.jsonl");
  }
  /** Append-only log with tmp+rename so a crash never truncates history. */
  async appendLog(sessionId, msg) {
    const file = this.logFile(sessionId);
    let raw = "";
    try {
      raw = await (0, import_promises.readFile)(file, "utf8");
    } catch {
    }
    const next = raw.length === 0 ? raw : raw.endsWith("\n") ? raw : `${raw}
`;
    const tmp = `${file}.tmp`;
    await (0, import_promises.writeFile)(tmp, `${next}${JSON.stringify(msg)}
`, "utf8");
    await (0, import_promises.rename)(tmp, file);
  }
  async listMessages(sessionId) {
    try {
      const raw = await (0, import_promises.readFile)(this.logFile(sessionId), "utf8");
      const messages = [];
      for (const line of raw.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
        }
      }
      return messages.sort((a, b) => b.at - a.at);
    } catch {
      return [];
    }
  }
};

// electron/pty-host.ts
var pty = __toESM(require("node-pty"), 1);

// src/shared/ipc.ts
var IPC = {
  ptySpawn: "pty:spawn",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyKill: "pty:kill",
  ptyData: "pty:data",
  tileExit: "tile:exit",
  appInfo: "app:info",
  projectsList: "projects:list",
  projectsAdd: "projects:add",
  projectsRemove: "projects:remove",
  pickFolder: "dialog:pick-folder",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  menuNewTile: "menu:new-tile",
  menuTheme: "menu:theme",
  sessionsList: "sessions:list",
  sessionNew: "session:new",
  sessionSaveAs: "session:save-as",
  sessionSave: "session:save",
  sessionOpen: "session:open",
  sessionDelete: "session:delete",
  sessionStop: "session:stop",
  sessionStart: "session:start",
  projectOpen: "project:open",
  fsListDir: "fs:list-dir",
  fsReadFile: "fs:read-file",
  fsWriteFile: "fs:write-file",
  fsStat: "fs:stat",
  messageSend: "message:send",
  messageList: "message:list",
  messageEvent: "message:event",
  snapshotCreate: "snapshot:create",
  snapshotGet: "snapshot:get",
  scrollbackGet: "scrollback:get",
  reviewerEnsure: "reviewer:ensure",
  reviewerPrompt: "reviewer:prompt",
  reviewerStop: "reviewer:stop",
  reviewerRestart: "reviewer:restart",
  reviewerTranscript: "reviewer:transcript",
  reviewerStatus: "reviewer:status",
  reviewerStream: "reviewer:stream",
  reviewerToolCall: "reviewer:tool-call",
  reviewerMessage: "reviewer:message",
  menuSession: "menu:session"
};

// electron/pty-host.ts
var PtyHost = class {
  constructor(opts) {
    this.opts = opts;
  }
  sessions = /* @__PURE__ */ new Map();
  spawn(tileId, opts) {
    const shell = process.env.SHELL ?? "/bin/bash";
    const term = pty.spawn(opts.command ?? shell, opts.args ?? [], {
      name: "xterm-256color",
      cols: Math.max(opts.cols, 2),
      rows: Math.max(opts.rows, 2),
      cwd: opts.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        PWD: opts.cwd,
        ...opts.envExt
      }
    });
    term.onData((data) => this.opts.send(IPC.ptyData, tileId, data));
    term.onExit(({ exitCode }) => {
      const payload = { code: exitCode };
      this.opts.send(IPC.tileExit, tileId, payload);
      this.sessions.delete(tileId);
    });
    this.sessions.set(tileId, { pty: term, cwd: opts.cwd });
    return { pid: term.pid, cwd: opts.cwd };
  }
  write(tileId, data) {
    this.sessions.get(tileId)?.pty.write(data);
  }
  cwdOf(tileId) {
    return this.sessions.get(tileId)?.cwd ?? null;
  }
  resize(tileId, cols, rows) {
    this.sessions.get(tileId)?.pty.resize(Math.max(cols, 2), Math.max(rows, 2));
  }
  kill(tileId) {
    const session = this.sessions.get(tileId);
    if (!session) return;
    const { pty: term } = session;
    try {
      process.kill(-term.pid, "SIGTERM");
    } catch {
      term.kill("SIGTERM");
    }
    const escalation = setTimeout(() => {
      if (this.sessions.has(tileId)) {
        try {
          process.kill(-term.pid, "SIGKILL");
        } catch {
          term.kill("SIGKILL");
        }
      }
    }, 2e3);
    escalation.unref();
  }
  killAll() {
    for (const tileId of [...this.sessions.keys()]) this.kill(tileId);
  }
};

// electron/projects.ts
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var import_promises2 = require("node:fs/promises");
var import_node_path3 = require("node:path");
var execFileP = (0, import_node_util.promisify)(import_node_child_process.execFile);
var ProjectsStore = class {
  constructor(file) {
    this.file = file;
  }
  async list() {
    try {
      const raw = await (0, import_promises2.readFile)(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.projects)) return [];
      return [...parsed.projects].sort((a, b) => b.lastUsed - a.lastUsed);
    } catch {
      return [];
    }
  }
  async add(path) {
    const abs = (0, import_node_path3.resolve)(path);
    const root = await this.gitTopLevel(abs).catch(() => abs);
    const all = await this.list();
    const existing = all.find((p) => p.path === root);
    const project = existing ? { ...existing, lastUsed: Date.now() } : { path: root, name: (0, import_node_path3.basename)(root), lastUsed: Date.now() };
    const next = existing ? all.map((p) => p.path === root ? project : p) : [...all, project];
    await this.persist(next);
    return project;
  }
  /** Binds a project to its session (1:1). */
  async bindSession(path, sessionId) {
    const root = await this.gitTopLevel(path).catch(() => (0, import_node_path3.resolve)(path));
    const all = await this.list();
    const existing = all.find((p) => p.path === root);
    if (!existing) return null;
    const bound = { ...existing, sessionId };
    await this.persist(all.map((p) => p.path === root ? bound : p));
    return bound;
  }
  async remove(path) {
    const root = await this.gitTopLevel(path).catch(() => (0, import_node_path3.resolve)(path));
    const all = await this.list();
    const next = all.filter((p) => p.path !== root);
    if (next.length === all.length) return false;
    await this.persist(next);
    return true;
  }
  async persist(projects) {
    await (0, import_promises2.mkdir)((0, import_node_path3.dirname)(this.file), { recursive: true });
    const sorted = [...projects].sort((a, b) => b.lastUsed - a.lastUsed);
    const tmp = `${this.file}.tmp`;
    await (0, import_promises2.writeFile)(tmp, JSON.stringify({ projects: sorted }, null, 2), "utf8");
    await (0, import_promises2.rename)(tmp, this.file);
  }
  async gitTopLevel(path) {
    const { stdout } = await execFileP("git", ["rev-parse", "--show-toplevel"], { cwd: path });
    const top = stdout.trim();
    return top.length > 0 ? top : (0, import_node_path3.resolve)(path);
  }
};

// electron/reviewer.ts
var import_promises4 = require("node:fs/promises");
var import_node_path5 = require("node:path");

// electron/reviewer-tools.ts
var import_node_child_process2 = require("node:child_process");
var import_promises3 = require("node:fs/promises");
var import_node_path4 = require("node:path");
var TOOL_RESULT_CAP = 2e4;
function capResult(text) {
  if (text.length <= TOOL_RESULT_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_CAP)}
\u2026[truncated]`;
}
var TOOLS = [
  {
    name: "list_tiles",
    description: "List every agent tile in this session: agent id, tile id, working dir, recorded line count.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx) {
      const rows = Array.from(ctx.recorder.list().entries()).map(([tileId, summary]) => {
        const agentId = ctx.agentOfTile(tileId) ?? tileId;
        return { tileId, agentId, cwd: ctx.cwdOfAgent(agentId), lines: summary.lines };
      });
      if (rows.length === 0) return "no tiles recorded yet";
      return JSON.stringify(rows, null, 2);
    }
  },
  {
    name: "read_tile",
    description: "Read the live recording of an agent tile: the last `tail` lines, or lines matching `grep`. Use a small tail (5-40) unless you need more; full history lives in read_scrollback.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "agent id (from list_tiles)" },
        tileId: { type: "string" },
        tail: { type: "number", description: "last N lines to return (default 40)" },
        grep: { type: "string", description: "return only lines matching this regex" }
      }
    },
    async run(args, ctx) {
      const tileId = resolveTile(args, ctx);
      if (!tileId) return "error: unknown tile \u2014 call list_tiles first";
      if (typeof args.grep === "string" && args.grep.length > 0) {
        let re;
        try {
          re = new RegExp(args.grep);
        } catch (err) {
          return `error: bad grep regex: ${String(err)}`;
        }
        return capResult(ctx.recorder.search(tileId, re).join("\n") || "(no matches)");
      }
      const n = clampInt(args.tail, 40, 1, 500);
      return capResult(ctx.recorder.tail(tileId, n).join("\n") || "(empty)");
    }
  },
  {
    name: "read_scrollback",
    description: "Read the persisted scrollback of an agent (full history captured at save time). Returns up to 1000 lines.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        tail: { type: "number", description: "last N lines (default 200, max 1000)" }
      }
    },
    async run(args, ctx) {
      const agentId = typeof args.agentId === "string" ? args.agentId : "";
      if (!agentId) return "error: agentId required";
      let raw;
      try {
        raw = await (0, import_promises3.readFile)((0, import_node_path4.join)(ctx.sessionDir, "scrollback", `${agentId}.json`), "utf8");
      } catch {
        return "error: no scrollback for this agent yet";
      }
      let lines;
      try {
        lines = JSON.parse(raw).lines ?? [];
      } catch {
        return "error: corrupt scrollback file";
      }
      const n = clampInt(args.tail, 200, 1, 1e3);
      return capResult(lines.slice(-n).join("\n") || "(empty)");
    }
  },
  {
    name: "send_message",
    description: "Send a task or note to an agent. Tasks get results back through the mailboxes; notes are informational.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "agent id (from list_tiles)" },
        kind: { type: "string", enum: ["task", "note"] },
        body: { type: "string" }
      },
      required: ["to", "kind", "body"]
    },
    async run(args, ctx) {
      const to = typeof args.to === "string" ? args.to : "";
      const kind = args.kind === "task" ? "task" : args.kind === "note" ? "note" : null;
      const body = typeof args.body === "string" ? args.body : "";
      if (!to || !kind) return "error: to, kind (task|note) and body are required";
      const ok = await ctx.router.sendFromOrchestrator({
        id: messageId(),
        from: ORCHESTRATOR_ID,
        to,
        kind,
        body,
        at: Date.now()
      });
      return ok ? `sent ${kind} to ${to}` : `error: cannot reach ${to} (unknown agent?)`;
    }
  },
  {
    name: "run_bash",
    description: "Run a shell command in the session project (or an agent's working dir). Output is capped at 64 KiB.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "working directory (defaults to the project root)" }
      },
      required: ["command"]
    },
    async run(args, ctx) {
      const command = typeof args.command === "string" ? args.command : "";
      if (!command) return "error: command required";
      const cwd = typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : ctx.cwd;
      return runShell(command, cwd);
    }
  },
  {
    name: "read_file",
    description: "Read a file from the project (or an absolute path). Cap: 4 MiB.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    },
    async run(args, ctx) {
      const path = typeof args.path === "string" ? args.path : "";
      if (!path) return "error: path required";
      const abs = path.startsWith("/") ? path : (0, import_node_path4.join)(ctx.cwd, path);
      try {
        const content = await (0, import_promises3.readFile)(abs, "utf8");
        if (content.length > 4 * 1024 * 1024) return "error: file larger than 4 MiB";
        return content;
      } catch (err) {
        return `error: ${err.message}`;
      }
    }
  }
];
var ReviewerTools = class {
  tools = new Map(TOOLS.map((t) => [t.name, t]));
  definitions() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
  }
  async run(name, args, ctx) {
    const tool = this.tools.get(name);
    if (!tool) return `error: unknown tool ${name}`;
    try {
      return await tool.run(args, ctx);
    } catch (err) {
      return `error: ${err.message}`;
    }
  }
};
function resolveTile(args, ctx) {
  if (typeof args.tileId === "string" && args.tileId.length > 0) return args.tileId;
  if (typeof args.agentId === "string" && args.agentId.length > 0) return ctx.tileOfAgent(args.agentId);
  return null;
}
function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(min, Math.min(max, n));
}
function runShell(command, cwd) {
  return new Promise((resolve2) => {
    const child = (0, import_node_child_process2.execFile)(
      "/bin/bash",
      ["-lc", command],
      { cwd, timeout: 3e4, maxBuffer: 64 * 1024 + 4096, env: { ...process.env, PWD: cwd } },
      (err, stdout, stderr) => {
        const out = `${stdout}
${stderr}`.trim();
        if (err) {
          const killed = err.killed === true;
          const kind = killed ? "timed out after 30s" : err.message;
          resolve2(out.length > 0 ? `error: ${kind}
${out}` : `error: ${kind}`);
          return;
        }
        resolve2(out.length > 0 ? out : "(no output)");
      }
    );
    void child;
  });
}

// electron/reviewer/providers/anthropic.ts
var DEFAULT_BASE = "https://api.anthropic.com";
var ANTHROPIC_VERSION = "2023-06-01";
function toMessages(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const out = [];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push({ role: "user", content: [{ type: "text", text: m.content }] });
        break;
      case "assistant": {
        const content = [];
        if (m.content.length > 0) content.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
        }
        out.push({ role: "assistant", content });
        break;
      }
      case "tool":
        out.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]
        });
        break;
    }
  }
  return { system, messages: out };
}
var AnthropicProvider = class {
  name = "anthropic";
  async complete(opts) {
    const { system, messages } = toMessages(opts.messages);
    const url = joinBase(opts.baseUrl || DEFAULT_BASE, "/v1/messages");
    const res = await fetch(url, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 4096,
        system: system.length > 0 ? system : void 0,
        messages,
        tools: opts.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema
        })),
        stream: true
      })
    });
    if (!res.ok || !res.body) {
      throw new Error(`anthropic API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    let text = "";
    const calls = /* @__PURE__ */ new Map();
    let openBlock = null;
    for await (const payload of ssePayloads(res.body)) {
      const ev = payload;
      switch (ev.type) {
        case "content_block_start":
          if (ev.content_block?.type === "tool_use") {
            openBlock = {
              call: { id: ev.content_block.id ?? "", name: ev.content_block.name ?? "", args: {} },
              raw: ""
            };
            calls.set(openBlock.call.id, openBlock.call);
          }
          break;
        case "content_block_delta":
          if (ev.delta?.type === "text_delta" && ev.delta.text) {
            text += ev.delta.text;
            opts.onDelta(ev.delta.text);
          } else if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json && openBlock) {
            openBlock.raw += ev.delta.partial_json;
          }
          break;
        case "content_block_stop": {
          if (openBlock) {
            openBlock.call.args = parseArgs(openBlock.raw);
            openBlock = null;
          }
          break;
        }
      }
    }
    return { text, toolCalls: [...calls.values()] };
  }
};
function parseArgs(raw) {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

// electron/reviewer/providers/ollama.ts
var DEFAULT_BASE2 = "http://localhost:11434";
function toMessages2(messages) {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          tool_calls: m.toolCalls?.map((c) => ({
            function: { name: c.name, arguments: JSON.stringify(c.args) }
          }))
        };
      case "tool":
        return { role: "tool", content: m.content };
    }
  });
}
function toTools(tools) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }));
}
var OllamaProvider = class {
  name = "ollama";
  async complete(opts) {
    const url = joinBase(opts.baseUrl || DEFAULT_BASE2, "/api/chat");
    const res = await fetch(url, {
      method: "POST",
      signal: opts.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        messages: toMessages2(opts.messages),
        tools: toTools(opts.tools)
      })
    });
    if (!res.ok || !res.body) {
      throw new Error(`ollama API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    let text = "";
    const toolCalls = [];
    for await (const payload of ndjsonPayloads(res.body)) {
      const msg = payload.message;
      if (!msg) continue;
      if (typeof msg.content === "string" && msg.content.length > 0) {
        text += msg.content;
        opts.onDelta(msg.content);
      }
      for (const tc of msg.tool_calls ?? []) {
        const name = tc.function?.name;
        if (!name) continue;
        toolCalls.push({
          id: `tc-${name}-${toolCalls.length}`,
          name,
          args: parseArgs2(tc.function?.arguments ?? "")
        });
      }
    }
    return { text, toolCalls };
  }
};
function parseArgs2(raw) {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

// electron/reviewer/providers/openai.ts
var DEFAULT_BASE3 = "https://api.openai.com/v1";
function toMessages3(messages) {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return {
          role: "assistant",
          content: m.content,
          tool_calls: m.toolCalls?.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) }
          }))
        };
      case "tool":
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
  });
}
function toTools2(tools) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }));
}
var OpenAIProvider = class {
  name = "openai";
  async complete(opts) {
    const url = joinBase(opts.baseUrl || DEFAULT_BASE3, "/chat/completions");
    const res = await fetch(url, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`
      },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        max_tokens: 4096,
        messages: toMessages3(opts.messages),
        tools: toTools2(opts.tools)
      })
    });
    if (!res.ok || !res.body) {
      throw new Error(`openai API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    let text = "";
    const calls = /* @__PURE__ */ new Map();
    const ensure = (i) => {
      const cur = calls.get(i) ?? { id: "", name: "", args: "" };
      calls.set(i, cur);
      return cur;
    };
    for await (const payload of ssePayloads(res.body)) {
      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        opts.onDelta(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const raw = tc;
        const cur = ensure(raw.index ?? 0);
        if (raw.id) cur.id = raw.id;
        if (raw.function?.name) cur.name = raw.function.name;
        if (raw.function?.arguments) cur.args += raw.function.arguments;
      }
    }
    const toolCalls = [...calls.values()].filter((c) => c.name.length > 0).map((c) => ({ id: c.id || `tc-${c.name}`, name: c.name, args: parseArgs3(c.args) }));
    return { text, toolCalls };
  }
};
function parseArgs3(raw) {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

// electron/reviewer/providers.ts
function createProvider(name) {
  switch (name) {
    case "openai":
      return new OpenAIProvider();
    case "anthropic":
      return new AnthropicProvider();
    case "ollama":
      return new OllamaProvider();
    default:
      throw new Error(`unknown reviewer provider: ${name}`);
  }
}
function joinBase(baseUrl, path) {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
async function* readBytes(body) {
  const reader = body.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
async function* ssePayloads(body) {
  let buf = "";
  for await (const chunk of readBytes(body)) {
    buf += new TextDecoder().decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      if (data.length === 0) continue;
      yield JSON.parse(data);
    }
  }
}
async function* ndjsonPayloads(body) {
  let buf = "";
  for await (const chunk of readBytes(body)) {
    buf += new TextDecoder().decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      yield JSON.parse(line);
    }
  }
}

// electron/reviewer.ts
var MAX_TOOL_ITERATIONS = 25;
var COMPACT_THRESHOLD = 6e4;
var TOOL_RESULT_CHARS = 2e4;
function buildSystemPrompt(sessionId, cwd) {
  return [
    `You are the Fraktole reviewer orchestrator for session ${sessionId}.`,
    `You observe agents through tools (list_tiles, read_tile, read_scrollback), delegate work via`,
    `send_message (kind task|note), and may run_bash/read_file in the project (cwd: ${cwd}).`,
    `Start each engagement by calling list_tiles so you know what is running.`,
    "Read the TAIL of a tile before judging it; use read_scrollback for full history.",
    "Do not send messages to an agent unless the task warrants it.",
    "End each engagement with a concise verdict: what each agent did, and what you recommend."
  ].join("\n");
}
var ReviewerHost = class {
  constructor(opts) {
    this.opts = opts;
    this.provider = (opts.createProvider ?? createProvider)("anthropic");
    this.tools = opts.tools ?? new ReviewerTools();
    this.conversationFile = opts.conversationFile ?? (0, import_node_path5.join)(opts.sessionDir, "reviewer", "conversation.jsonl");
  }
  status = "offline";
  messages = [];
  queue = [];
  running = false;
  aborter = null;
  provider;
  tools;
  conversationFile;
  get conversation() {
    return this.messages.map(toEntry);
  }
  /** Loads the conversation and marks the harness ready. False when the
   *  provider config is unusable (missing API key). */
  async start() {
    const cfg = await this.opts.getConfig();
    const key = await this.apiKeyFor(cfg);
    if (key === null) {
      this.setStatus("unconfigured", "missing API key \u2014 configure the reviewer provider first");
      return false;
    }
    this.provider = (this.opts.createProvider ?? createProvider)(cfg.provider);
    await this.load();
    if (this.messages.length === 0) {
      this.messages.push({ role: "system", content: buildSystemPrompt(this.opts.sessionId, this.opts.cwd) });
    }
    this.setStatus("running");
    this.drainQueue();
    return true;
  }
  /** Aborts the current run and forgets the conversation. */
  async restart() {
    this.cancel();
    this.messages = [];
    this.queue = [];
    await this.truncateConversation();
    return this.start();
  }
  /** Explicit off switch (session stopped). */
  stop() {
    this.cancel();
    this.queue = [];
    this.setStatus("stopped");
  }
  /** Idle shutdown: aborts the run, keeps the conversation for later. */
  idleOut() {
    this.cancel();
    this.setStatus("idle");
  }
  /** Queues a user prompt (from the Reviewer tab). */
  async prompt(text) {
    if (this.status !== "running") return;
    this.queue.push({ role: "user", content: text });
    this.drainQueue();
  }
  /** Queues an agent result message as a turn. */
  onAgentMessage(msg) {
    if (this.status !== "running") return;
    this.queue.push({
      role: "user",
      content: `[${msg.from} \u2192 ${msg.to} (${msg.kind})]: ${msg.body}`
    });
    this.drainQueue();
  }
  /** Aborts the in-flight provider call; queued turns are dropped. */
  cancel() {
    this.aborter?.abort();
    this.aborter = null;
  }
  async apiKeyFor(cfg) {
    if (cfg.provider === "ollama") return "ollama";
    const envName = cfg.apiKeyEnv ?? (cfg.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
    const key = process.env[envName];
    if (!key) return null;
    return key;
  }
  setStatus(status, error) {
    this.status = status;
    this.opts.emit.status(status, error);
  }
  drainQueue() {
    void this.run();
  }
  async run() {
    if (this.running || this.status !== "running") return;
    this.running = true;
    const aborter = new AbortController();
    this.aborter = aborter;
    const cfg = await this.opts.getConfig();
    const apiKey = await this.apiKeyFor(cfg) ?? "";
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift();
        this.messages.push(turn);
        await this.persist();
        this.opts.emit.message(toEntry(turn));
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
          const res = await this.provider.complete({
            model: cfg.model,
            apiKey,
            baseUrl: cfg.baseUrl ?? "",
            messages: this.messages,
            tools: this.tools.definitions(),
            signal: aborter.signal,
            onDelta: (delta) => this.opts.emit.stream(delta)
          });
          this.messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
          await this.persist();
          const entry = toEntry(this.messages[this.messages.length - 1]);
          this.opts.emit.message(entry);
          if (res.toolCalls.length === 0) break;
          let failed = false;
          for (const call of res.toolCalls) {
            const started = Date.now();
            this.opts.emit.toolCall({ name: call.name, args: call.args, state: "start" });
            const result = await this.tools.run(call.name, call.args, this.opts.toolContext);
            const durationMs = Date.now() - started;
            if (result.startsWith("error:")) {
              failed = true;
              this.opts.emit.toolCall({ name: call.name, args: call.args, state: "error", error: result, durationMs });
            } else {
              this.opts.emit.toolCall({
                name: call.name,
                args: call.args,
                state: "done",
                result: result.slice(0, 2e3),
                durationMs
              });
            }
            const capped = result.length > TOOL_RESULT_CHARS ? `${result.slice(0, TOOL_RESULT_CHARS)}
\u2026[truncated]` : result;
            this.messages.push({ role: "tool", content: capped, toolCallId: call.id });
            this.opts.emit.message(toEntry(this.messages[this.messages.length - 1]));
          }
          await this.persist();
          if (failed) break;
        }
        this.compactIfNeeded();
      }
    } catch (err) {
      if (!aborter.signal.aborted) {
        this.setStatus("error", err.message);
      }
    } finally {
      this.running = false;
      this.aborter = null;
    }
  }
  /** Drops old tool rows when the conversation outgrows the budget. */
  compactIfNeeded() {
    let total = 0;
    for (const m of this.messages) total += m.content.length;
    if (total <= COMPACT_THRESHOLD) return;
    let dropped = 0;
    while (this.messages.length > 4 && total > COMPACT_THRESHOLD) {
      const victim = this.messages[1];
      total -= victim.content.length;
      this.messages.splice(1, 1);
      dropped += 1;
    }
    if (dropped > 0) {
      const note = { role: "system", content: `[context compacted: ${dropped} old exchanges dropped]` };
      this.messages.splice(1, 0, note);
      this.opts.emit.message(toEntry(note));
    }
  }
  async load() {
    let raw;
    try {
      raw = await (0, import_promises4.readFile)(this.conversationFile, "utf8");
    } catch {
      return;
    }
    const loaded = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        loaded.push(JSON.parse(line));
      } catch {
      }
    }
    this.messages = loaded;
  }
  async persist() {
    const last = this.messages[this.messages.length - 1];
    if (!last) return;
    try {
      await (0, import_promises4.mkdir)((0, import_node_path5.dirname)(this.conversationFile), { recursive: true });
      await (0, import_promises4.appendFile)(this.conversationFile, `${JSON.stringify(last)}
`, "utf8");
    } catch (err) {
      this.opts.logger?.(`reviewer: persist failed (${err.message})`);
    }
  }
  async truncateConversation() {
    try {
      await (0, import_promises4.mkdir)((0, import_node_path5.dirname)(this.conversationFile), { recursive: true });
      const fs = await import("node:fs/promises");
      await fs.truncate(this.conversationFile);
    } catch {
    }
  }
};
function toEntry(msg) {
  return {
    role: msg.role,
    content: msg.content,
    toolCalls: msg.toolCalls,
    toolCallId: msg.toolCallId,
    at: Date.now()
  };
}

// electron/session-runtime.ts
var import_node_path6 = require("node:path");
var DEFAULT_IDLE_TIMEOUT_MS = 10 * 6e4;
var SessionRuntime = class {
  constructor(opts) {
    this.opts = opts;
    this.sessionRef = opts.session;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }
  state = "running";
  agentToTile = /* @__PURE__ */ new Map();
  lastActiveAt = Date.now();
  sessionRef;
  idleTimer = null;
  idleTimeoutMs;
  get id() {
    return this.sessionRef.id;
  }
  get session() {
    return this.sessionRef;
  }
  get host() {
    return this.opts.host;
  }
  get reviewer() {
    return this.opts.reviewer;
  }
  get router() {
    return this.opts.router;
  }
  /** Keep the runtime's view of the session file in sync after saves. */
  updateSession(session) {
    this.sessionRef = session;
  }
  sessionDir() {
    return (0, import_node_path6.join)(this.opts.sessionRoot, this.sessionRef.id);
  }
  /** Called when this session becomes the active one. */
  activate() {
    this.lastActiveAt = Date.now();
    this.clearIdleTimer();
    if (this.state === "stopped") this.state = "running";
  }
  /** Called when another session becomes active. */
  deactivate() {
    this.lastActiveAt = Date.now();
    this.startIdleTimer();
  }
  /** The reviewer starts only when its tab is actually visited. Revives a
   *  stopped session first. */
  ensureReviewer() {
    if (this.state === "stopped") this.start();
    if (this.opts.reviewer.status === "running") {
      return Promise.resolve(true);
    }
    return this.opts.reviewer.start(this.sessionRef.id, this.sessionDir(), this.opts.judgeCwd());
  }
  /** Explicit off switch: kills every PTY and the reviewer. */
  stop() {
    this.clearIdleTimer();
    this.opts.host.killAll();
    this.opts.reviewer.stop();
    this.opts.router.stop();
    this.state = "stopped";
  }
  /** Revives a stopped session; the renderer re-spawns the tiles and the
   *  reviewer comes back on the next reviewer visit. */
  start() {
    if (this.state !== "stopped") return;
    this.state = "running";
    this.opts.router.start(this.sessionRef.id);
  }
  /** Full teardown (session deleted). */
  teardown() {
    this.clearIdleTimer();
    this.opts.host.killAll();
    this.opts.reviewer.stop();
    this.opts.router.stop();
    this.state = "stopped";
  }
  killAll() {
    this.opts.host.killAll();
  }
  startIdleTimer() {
    if (this.idleTimer !== null || this.state === "stopped") return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.state !== "stopped") {
        this.opts.reviewer.idleOut();
        this.state = "idle";
        this.opts.logger?.(`session ${this.id}: reviewer idle-shutdown`);
      }
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }
  clearIdleTimer() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
};
var SessionRegistry = class {
  constructor(opts) {
    this.opts = opts;
  }
  runtimes = /* @__PURE__ */ new Map();
  activeId = null;
  get active() {
    return this.activeId;
  }
  get(id) {
    return this.runtimes.get(id) ?? null;
  }
  all() {
    return [...this.runtimes.values()];
  }
  /** Activates a session, creating its runtime on first visit. */
  open(id, session) {
    if (this.activeId !== null && this.activeId !== id) {
      this.runtimes.get(this.activeId)?.deactivate();
    }
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = this.opts.makeRuntime(session);
      this.runtimes.set(id, rt);
    }
    rt.updateSession(session);
    rt.activate();
    this.activeId = id;
    return rt;
  }
  stop(id) {
    this.runtimes.get(id)?.stop();
  }
  start(id) {
    this.runtimes.get(id)?.start();
  }
  /** Deletes the runtime (and kills everything in it). */
  teardown(id) {
    this.runtimes.get(id)?.teardown();
    this.runtimes.delete(id);
    if (this.activeId === id) this.activeId = null;
  }
  /** App quit: everything dies. */
  killAll() {
    for (const rt of this.runtimes.values()) rt.killAll();
  }
};

// electron/sessions.ts
var import_promises5 = require("node:fs/promises");
var import_node_path7 = require("node:path");
var SessionStore = class {
  constructor(root) {
    this.root = root;
  }
  dir(id) {
    return (0, import_node_path7.join)(this.root, id);
  }
  indexFile() {
    return (0, import_node_path7.join)(this.root, "index.json");
  }
  sessionFile(id) {
    return (0, import_node_path7.join)(this.dir(id), "session.json");
  }
  async readIndex() {
    try {
      const raw = await (0, import_promises5.readFile)(this.indexFile(), "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.sessions)) return [];
      return parsed.sessions;
    } catch {
      return [];
    }
  }
  async writeIndex(entries) {
    await this.persist(this.indexFile(), { sessions: entries });
  }
  async persist(file, data) {
    await (0, import_promises5.mkdir)((0, import_node_path7.dirname)(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await (0, import_promises5.writeFile)(tmp, JSON.stringify(data, null, 2), "utf8");
    await (0, import_promises5.rename)(tmp, file);
  }
  async list() {
    const entries = await this.readIndex();
    const summaries = [];
    for (const entry of entries) {
      try {
        const session = await this.load(entry.id);
        summaries.push({
          id: entry.id,
          name: entry.name,
          updatedAt: entry.updatedAt,
          agentCount: session.tiles.length,
          projectPath: session.projectPath
        });
      } catch {
      }
    }
    return summaries;
  }
  async newSession(name) {
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const session = {
      version: 1,
      id,
      name: name.trim() || `Session ${(/* @__PURE__ */ new Date()).toLocaleDateString()}`,
      createdAt: now,
      updatedAt: now,
      nextAgentSeq: 1,
      judge: null,
      tree: null,
      tiles: []
    };
    await (0, import_promises5.mkdir)(this.dir(id), { recursive: true });
    await this.ensureSessionDirs(id);
    await this.persist(this.sessionFile(id), session);
    await this.touchIndex(id, session.name, now);
    return { session, agents: [], state: "running" };
  }
  async rename(id, name) {
    const session = await this.load(id);
    session.name = name.trim() || session.name;
    session.updatedAt = Date.now();
    await this.persist(this.sessionFile(id), session);
    await this.touchIndex(id, session.name, session.updatedAt);
    return session;
  }
  async load(id) {
    const raw = await (0, import_promises5.readFile)(this.sessionFile(id), "utf8");
    const session = JSON.parse(raw);
    if (session.version !== 1 || typeof session.id !== "string") {
      throw new Error(`unsupported session format in ${id}`);
    }
    return session;
  }
  /** Persists the session model (arrangement, zoom/focus, agent list). */
  async save(session) {
    session.updatedAt = Date.now();
    await this.ensureSessionDirs(session.id);
    await this.persist(this.sessionFile(session.id), session);
    await this.touchIndex(session.id, session.name, session.updatedAt);
  }
  async delete(id) {
    await (0, import_promises5.rm)(this.dir(id), { recursive: true, force: true });
    const entries = await this.readIndex();
    await this.writeIndex(entries.filter((e) => e.id !== id));
  }
  /** Monotonic agent ids per session; never reused across save/load cycles. */
  allocateAgentId(session) {
    const id = `agent-${session.nextAgentSeq}`;
    session.nextAgentSeq += 1;
    return id;
  }
  async ensureSessionDirs(id) {
    const dir = this.dir(id);
    await (0, import_promises5.mkdir)((0, import_node_path7.join)(dir, "agents"), { recursive: true });
    await (0, import_promises5.mkdir)((0, import_node_path7.join)(dir, "snapshots"), { recursive: true });
    await (0, import_promises5.mkdir)((0, import_node_path7.join)(dir, "scrollback"), { recursive: true });
  }
  async ensureAgentMailbox(id, agentId) {
    await (0, import_promises5.mkdir)((0, import_node_path7.join)(this.dir(id), "agents", agentId, "inbox"), { recursive: true });
    await (0, import_promises5.mkdir)((0, import_node_path7.join)(this.dir(id), "agents", agentId, "outbox"), { recursive: true });
  }
  /** Known agent ids in this session (from disk, so it also sees boxes left
   *  behind by exited agents). */
  async listAgentIds(id) {
    const dir = (0, import_node_path7.join)(this.dir(id), "agents");
    try {
      const entries = await (0, import_promises5.readdir)(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }
  async touchIndex(id, name, updatedAt) {
    const entries = await this.readIndex();
    const rest = entries.filter((e) => e.id !== id);
    await this.writeIndex([{ id, name, updatedAt }, ...rest]);
  }
};

// electron/settings.ts
var import_promises6 = require("node:fs/promises");
var import_node_path8 = require("node:path");
var DEFAULT_REVIEWER = {
  provider: "anthropic",
  model: "claude-sonnet-4-5"
};
var SettingsStore = class {
  constructor(file) {
    this.file = file;
  }
  async get() {
    try {
      const raw = await (0, import_promises6.readFile)(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return {
        theme: typeof parsed.theme === "string" ? parsed.theme : "midnight",
        reviewer: {
          provider: parsed.reviewer?.provider === "openai" || parsed.reviewer?.provider === "anthropic" || parsed.reviewer?.provider === "ollama" ? parsed.reviewer.provider : DEFAULT_REVIEWER.provider,
          model: typeof parsed.reviewer?.model === "string" ? parsed.reviewer.model : DEFAULT_REVIEWER.model,
          apiKeyEnv: typeof parsed.reviewer?.apiKeyEnv === "string" ? parsed.reviewer.apiKeyEnv : void 0,
          baseUrl: typeof parsed.reviewer?.baseUrl === "string" ? parsed.reviewer.baseUrl : void 0
        }
      };
    } catch {
      return {
        theme: "midnight",
        reviewer: { provider: DEFAULT_REVIEWER.provider, model: DEFAULT_REVIEWER.model }
      };
    }
  }
  async set(patch) {
    const current = await this.get();
    const next = { ...current, ...patch, reviewer: { ...current.reviewer, ...patch.reviewer } };
    await (0, import_promises6.mkdir)((0, import_node_path8.dirname)(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await (0, import_promises6.writeFile)(tmp, JSON.stringify(next, null, 2), "utf8");
    await (0, import_promises6.rename)(tmp, this.file);
    return next;
  }
};

// electron/tile-recorder.ts
var CSI_RE = /\x1b\[[0-9;?]*[- /]*[@-~]/g;
var OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function stripAnsi(text) {
  return text.replace(OSC_RE, "").replace(CSI_RE, "");
}
var TileRecorder = class {
  maxLines;
  maxLineLen;
  buffers = /* @__PURE__ */ new Map();
  partial = /* @__PURE__ */ new Map();
  lastAt = /* @__PURE__ */ new Map();
  constructor(opts = {}) {
    this.maxLines = opts.maxLines ?? 2e3;
    this.maxLineLen = opts.maxLineLen ?? 4096;
  }
  /** Feeds one ptyData chunk into the tile's recording. */
  record(tileId, chunk) {
    const clean = stripAnsi(chunk).replace(/\r/g, "");
    if (clean.length === 0) return;
    let buf = this.partial.get(tileId);
    if (buf === void 0) {
      buf = "";
      this.partial.set(tileId, buf);
    }
    const parts = clean.split("\n");
    buf += parts.shift() ?? "";
    for (const p of parts) {
      this.append(tileId, buf);
      buf = p;
    }
    if (buf.length > this.maxLineLen) {
      buf = `${buf.slice(0, this.maxLineLen)}\u2026[truncated]`;
    }
    this.partial.set(tileId, buf);
    this.lastAt.set(tileId, Date.now());
  }
  has(tileId) {
    return (this.buffers.get(tileId)?.length ?? 0) > 0 || (this.partial.get(tileId)?.length ?? 0) > 0;
  }
  /** The last `n` lines of the tile, including the in-flight (newline-less)
   *  line — the live prompt is real content the reviewer must see. */
  tail(tileId, n) {
    const lines = this.buffers.get(tileId) ?? [];
    const live = this.partial.get(tileId);
    const withLive = live && live.length > 0 ? [...lines, live] : lines;
    return withLive.slice(Math.max(0, withLive.length - n));
  }
  /** Lines matching `re` (reset between tests so /g flags are safe). */
  search(tileId, re, limit = 50) {
    const lines = [...this.buffers.get(tileId) ?? []];
    const live = this.partial.get(tileId);
    if (live && live.length > 0) lines.push(live);
    const out = [];
    for (const line of lines) {
      re.lastIndex = 0;
      if (re.test(line)) {
        out.push(line);
        if (out.length >= limit) break;
      }
    }
    re.lastIndex = 0;
    return out;
  }
  summary(tileId) {
    return {
      lines: this.buffers.get(tileId)?.length ?? 0,
      lastAt: this.lastAt.get(tileId) ?? 0
    };
  }
  /** Every tile with recorded content, keyed by tileId. */
  list() {
    const out = /* @__PURE__ */ new Map();
    for (const [tileId] of this.buffers) {
      const live = this.partial.get(tileId);
      const lines = this.buffers.get(tileId)?.length ?? 0;
      if (lines > 0 || live && live.length > 0) out.set(tileId, this.summary(tileId));
    }
    return out;
  }
  append(tileId, line) {
    let buf = this.buffers.get(tileId);
    if (!buf) {
      buf = [];
      this.buffers.set(tileId, buf);
    }
    if (line.length > this.maxLineLen) {
      line = `${line.slice(0, this.maxLineLen)}\u2026[truncated]`;
    }
    buf.push(line);
    if (buf.length > this.maxLines) {
      buf.splice(0, buf.length - this.maxLines);
    }
  }
};

// src/themes.ts
var THEME_IDS = ["midnight", "gold", "amber", "forest", "neon", "paper"];

// electron/main.ts
import_electron.app.setName("Fraktole");
var DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
async function waitForDevServer(url, timeoutMs = 15e3) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
    }
    if (Date.now() > deadline) throw new Error(`dev server unreachable at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
var mainWindow = null;
var currentTheme = "midnight";
var registry = null;
function buildMenu(currentTheme2, sessions) {
  const sessionMenu = [
    { label: "New Session\u2026", click: () => mainWindow?.webContents.send(IPC.menuSession, { action: "new" }) },
    { label: "Save As\u2026", click: () => mainWindow?.webContents.send(IPC.menuSession, { action: "save-as" }) }
  ];
  if (sessions.length > 0) {
    sessionMenu.push({ type: "separator" });
    for (const s of sessions) {
      sessionMenu.push({
        label: s.name,
        submenu: [
          { label: "Open", click: () => mainWindow?.webContents.send(IPC.menuSession, { action: "open", id: s.id }) },
          { label: "Stop", click: () => mainWindow?.webContents.send(IPC.menuSession, { action: "stop", id: s.id }) },
          { label: "Start", click: () => mainWindow?.webContents.send(IPC.menuSession, { action: "start", id: s.id }) },
          { type: "separator" },
          { label: "Delete\u2026", click: () => mainWindow?.webContents.send(IPC.menuSession, { action: "delete", id: s.id }) }
        ]
      });
    }
  }
  return import_electron.Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        {
          label: "New Tile",
          accelerator: "Ctrl+Shift+T",
          click: () => mainWindow?.webContents.send(IPC.menuNewTile)
        },
        { type: "separator" },
        { label: "Sessions", submenu: sessionMenu },
        { type: "separator" },
        { role: "quit", label: "Quit" }
      ]
    },
    {
      label: "View",
      submenu: [
        {
          label: "Theme",
          submenu: THEME_IDS.map((id) => ({
            label: id.charAt(0).toUpperCase() + id.slice(1),
            type: "checkbox",
            checked: id === currentTheme2,
            click: () => mainWindow?.webContents.send(IPC.menuTheme, id)
          }))
        }
      ]
    }
  ]);
}
function migrateUserData() {
  const current = import_electron.app.getPath("userData");
  const legacy = (0, import_node_path9.join)(import_electron.app.getPath("appData"), "@fraktole", "desktop");
  if (legacy === current) return;
  if ((0, import_node_fs2.existsSync)((0, import_node_path9.join)(current, "projects.json"))) return;
  const legacyProjects = (0, import_node_path9.join)(legacy, "projects.json");
  if ((0, import_node_fs2.existsSync)(legacyProjects)) {
    try {
      (0, import_node_fs2.copyFile)(legacyProjects, (0, import_node_path9.join)(current, "projects.json"), (err) => {
        if (err) console.error("migrate projects.json failed:", err);
      });
    } catch {
    }
  }
}
function createWindow() {
  const win = new import_electron.BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#171a20",
    show: false,
    title: "Fraktole",
    webPreferences: {
      preload: (0, import_node_path9.join)(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.on("render-process-gone", () => {
    registry?.killAll();
    import_electron.app.quit();
  });
  void (async () => {
    if (!import_electron.app.isPackaged) {
      await waitForDevServer(DEV_SERVER_URL);
      await win.loadURL(DEV_SERVER_URL);
    } else {
      await win.loadFile((0, import_node_path9.join)(__dirname, "..", "dist-renderer", "index.html"));
    }
  })();
}
if (!import_electron.app.requestSingleInstanceLock()) {
  import_electron.app.quit();
} else {
  const focusApp = () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  import_electron.app.on("second-instance", focusApp);
  process.on("SIGUSR2", focusApp);
  import_electron.app.whenReady().then(async () => {
    migrateUserData();
    const projects = new ProjectsStore((0, import_node_path9.join)(import_electron.app.getPath("userData"), "projects.json"));
    const settings = new SettingsStore((0, import_node_path9.join)(import_electron.app.getPath("userData"), "settings.json"));
    const sessions = new SessionStore((0, import_node_path9.join)(import_electron.app.getPath("userData"), "sessions"));
    const sessionsRoot = (0, import_node_path9.join)(import_electron.app.getPath("userData"), "sessions");
    const home = import_electron.app.getPath("home");
    const judgeCwdFor = (session) => session.projectPath ?? session.judge?.cwd ?? home;
    registry = new SessionRegistry({
      sessionRoot: sessionsRoot,
      logger: (line) => console.log(line),
      makeRuntime: (session) => {
        let rt = null;
        const recorder = new TileRecorder();
        const host = new PtyHost({
          send: (channel, tileId, payload) => {
            if (channel === IPC.ptyData) recorder.record(tileId, payload);
            mainWindow?.webContents.send(channel, session.id, tileId, payload);
          }
        });
        const tileOfAgent = (agentId) => agentId === ORCHESTRATOR_ID ? null : rt?.agentToTile.get(agentId) ?? null;
        const agentOfTile = (tileId) => {
          for (const [agentId, tid] of rt?.agentToTile ?? []) {
            if (tid === tileId) return agentId;
          }
          return null;
        };
        const cwdOfAgent = (agentId) => rt?.session.tiles.find((t) => t.agentId === agentId)?.cwd ?? null;
        const router = new MailboxRouter({
          root: sessionsRoot,
          currentSession: () => rt?.session ?? session,
          tileOfAgent,
          write: (tileId, text) => host.write(tileId, text),
          emit: (msg) => {
            mainWindow?.webContents.send(IPC.messageEvent, session.id, msg);
            if (msg.to === ORCHESTRATOR_ID && msg.from !== ORCHESTRATOR_ID) {
              void rt?.reviewer.onAgentMessage(msg);
            }
          }
        });
        const tools = new ReviewerTools();
        const reviewer = new ReviewerHost({
          getConfig: () => settings.get().then((s) => s.reviewer),
          sessionId: session.id,
          sessionDir: (0, import_node_path9.join)(sessionsRoot, session.id),
          cwd: judgeCwdFor(session),
          recorder,
          toolContext: {
            sessionId: session.id,
            sessionDir: (0, import_node_path9.join)(sessionsRoot, session.id),
            cwd: judgeCwdFor(session),
            recorder,
            router: {
              sendFromOrchestrator: (msg) => router.sendFromOrchestrator(msg)
            },
            tileOfAgent,
            agentOfTile,
            cwdOfAgent
          },
          tools,
          emit: {
            status: (status, error) => mainWindow?.webContents.send(IPC.reviewerStatus, session.id, { status, error }),
            stream: (delta) => mainWindow?.webContents.send(IPC.reviewerStream, session.id, delta),
            toolCall: (ev) => mainWindow?.webContents.send(IPC.reviewerToolCall, session.id, ev),
            message: (entry) => mainWindow?.webContents.send(IPC.reviewerMessage, session.id, entry)
          },
          logger: (line) => console.log(line)
        });
        const runtime = new SessionRuntime({
          session,
          sessionRoot: sessionsRoot,
          host,
          reviewer,
          router,
          judgeCwd: () => judgeCwdFor(session)
        });
        rt = runtime;
        return runtime;
      }
    });
    const openSession = async (id) => {
      const session = await sessions.load(id);
      const rt = registry.open(id, session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    };
    const pendingProjectOpens = /* @__PURE__ */ new Map();
    const openProjectSession = async (projectPath) => {
      let project = (await projects.list()).find((p) => p.path === projectPath) ?? await projects.add(projectPath);
      if (project.sessionId) {
        try {
          return await openSession(project.sessionId);
        } catch {
        }
      }
      const opened = await sessions.newSession(project.name);
      project = await projects.bindSession(projectPath, opened.session.id) ?? project;
      opened.session.projectPath = projectPath;
      opened.session.name = project.name;
      opened.session.judge = { command: "", cwd: projectPath };
      await sessions.save(opened.session);
      const rt = registry.open(opened.session.id, opened.session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    };
    import_electron.ipcMain.handle(IPC.appInfo, () => ({
      version: import_electron.app.getVersion(),
      shell: process.env.SHELL ?? "/bin/bash",
      userData: import_electron.app.getPath("userData"),
      home
    }));
    import_electron.ipcMain.handle(IPC.ptySpawn, async (_e, args) => {
      const rt = registry?.get(args.sessionId) ?? null;
      const session = rt?.session ?? null;
      if (!rt || !session) throw new Error(`no runtime for session ${args.sessionId}`);
      let agentId = args.agentId ?? null;
      if (agentId === null || !session.tiles.some((t) => t.agentId === agentId)) {
        agentId = sessions.allocateAgentId(session);
        session.tiles.push({ agentId, cwd: args.cwd });
        await sessions.save(session);
        rt.updateSession(session);
      }
      await sessions.ensureAgentMailbox(session.id, agentId);
      rt.agentToTile.set(agentId, args.tileId);
      const env = buildAgentEnv(session.id, agentId, "agent", rt.sessionDir());
      try {
        rt.host.spawn(args.tileId, { cwd: args.cwd, cols: args.cols, rows: args.rows, envExt: env });
      } catch (err) {
        console.error(`pty spawn failed for ${args.tileId}:`, err);
        mainWindow?.webContents.send(IPC.tileExit, session.id, args.tileId, { code: -1 });
      }
      return { agentId };
    });
    import_electron.ipcMain.on(IPC.ptyWrite, (_e, sessionId, tileId, data) => {
      registry?.get(sessionId)?.host.write(tileId, data);
    });
    import_electron.ipcMain.on(IPC.ptyResize, (_e, sessionId, tileId, cols, rows) => {
      registry?.get(sessionId)?.host.resize(tileId, cols, rows);
    });
    import_electron.ipcMain.on(IPC.ptyKill, (_e, sessionId, tileId) => {
      registry?.get(sessionId)?.host.kill(tileId);
    });
    currentTheme = (await settings.get()).theme ?? "midnight";
    if (!THEME_IDS.includes(currentTheme)) currentTheme = "midnight";
    const refreshMenu = () => {
      void sessions.list().then((list) => {
        import_electron.Menu.setApplicationMenu(buildMenu(currentTheme, list));
      });
    };
    refreshMenu();
    import_electron.ipcMain.handle(IPC.projectsList, () => projects.list());
    import_electron.ipcMain.handle(IPC.projectsAdd, (_e, path) => projects.add(path));
    import_electron.ipcMain.handle(IPC.projectsRemove, (_e, path) => projects.remove(path));
    import_electron.ipcMain.handle(IPC.settingsGet, () => settings.get());
    import_electron.ipcMain.handle(IPC.settingsSet, async (_e, patch) => {
      const next = await settings.set(patch);
      if (THEME_IDS.includes(next.theme)) {
        currentTheme = next.theme;
        refreshMenu();
      }
      return next;
    });
    import_electron.ipcMain.handle(IPC.sessionsList, async () => {
      const list = await sessions.list();
      return list.map((s) => ({ ...s, state: registry?.get(s.id)?.state ?? "stopped" }));
    });
    import_electron.ipcMain.handle(IPC.sessionNew, async (_e, name) => {
      const opened = await sessions.newSession(name);
      const rt = registry.open(opened.session.id, opened.session);
      refreshMenu();
      return { session: rt.session, agents: rt.session.tiles, state: rt.state };
    });
    import_electron.ipcMain.handle(IPC.sessionSaveAs, async (_e, id, name) => {
      const session = await sessions.rename(id, name);
      registry?.get(id)?.updateSession(session);
      refreshMenu();
      return session;
    });
    import_electron.ipcMain.handle(IPC.sessionOpen, (_e, id) => openSession(id));
    import_electron.ipcMain.handle(IPC.sessionDelete, async (_e, id) => {
      registry?.teardown(id);
      await sessions.delete(id);
      refreshMenu();
    });
    import_electron.ipcMain.handle(IPC.sessionStop, (_e, id) => registry?.stop(id));
    import_electron.ipcMain.handle(IPC.sessionStart, (_e, id) => registry?.start(id));
    import_electron.ipcMain.handle(IPC.projectOpen, async (_e, path) => {
      const pending = pendingProjectOpens.get(path);
      if (pending) return pending;
      const p = (async () => {
        const project = await projects.add(path);
        return openProjectSession(project.path);
      })();
      pendingProjectOpens.set(path, p);
      try {
        return await p;
      } finally {
        pendingProjectOpens.delete(path);
      }
    });
    import_electron.ipcMain.handle(IPC.sessionSave, async (_e, sessionId, payload) => {
      const rt = registry?.get(sessionId) ?? null;
      const session = rt?.session ?? null;
      if (!session) return null;
      if (rt?.state === "stopped") return session;
      session.tree = payload.tree;
      if (payload.zoomedAgentId !== void 0) session.zoomedAgentId = payload.zoomedAgentId ?? void 0;
      if (payload.focusedAgentId !== void 0) session.focusedAgentId = payload.focusedAgentId ?? void 0;
      if (payload.judgeCwd) session.judge = { command: "", cwd: payload.judgeCwd };
      session.tiles = session.tiles.filter((t) => payload.agents.includes(t.agentId));
      await sessions.save(session);
      rt?.updateSession(session);
      if (payload.scrollback) {
        const sessionDir = rt?.sessionDir() ?? (0, import_node_path9.join)(sessionsRoot, session.id);
        await (0, import_promises7.mkdir)((0, import_node_path9.join)(sessionDir, "scrollback"), { recursive: true });
        for (const [agentId, lines] of Object.entries(payload.scrollback)) {
          await (0, import_promises7.writeFile)(
            (0, import_node_path9.join)(sessionDir, "scrollback", `${agentId}.json`),
            JSON.stringify({ lines }, null, 2),
            "utf8"
          );
        }
      }
      return session;
    });
    import_electron.ipcMain.handle(IPC.messageSend, async (_e, sessionId, args) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.router.sendFromOrchestrator({
        id: messageId(),
        from: ORCHESTRATOR_ID,
        to: args.to,
        kind: args.kind,
        body: args.body,
        ref: args.ref,
        at: Date.now()
      });
    });
    import_electron.ipcMain.handle(IPC.messageList, async (_e, sessionId) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return [];
      return rt.router.listMessages(rt.session.id);
    });
    import_electron.ipcMain.handle(IPC.snapshotCreate, async (_e, sessionId, args) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) throw new Error("no session runtime");
      const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const snapshot = {
        id,
        agentId: args.agentId,
        at: Date.now(),
        lineCount: args.text.length > 0 ? args.text.split("\n").length : 0,
        text: args.text
      };
      await (0, import_promises7.mkdir)((0, import_node_path9.join)(rt.sessionDir(), "snapshots"), { recursive: true });
      await (0, import_promises7.writeFile)(
        (0, import_node_path9.join)(rt.sessionDir(), "snapshots", `${id}.json`),
        JSON.stringify(snapshot, null, 2),
        "utf8"
      );
      return snapshot;
    });
    import_electron.ipcMain.handle(IPC.snapshotGet, async (_e, sessionId, id) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return null;
      try {
        const raw = await (0, import_promises7.readFile)((0, import_node_path9.join)(rt.sessionDir(), "snapshots", `${id}.json`), "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    });
    import_electron.ipcMain.handle(IPC.reviewerEnsure, async (_e, sessionId) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.ensureReviewer();
    });
    import_electron.ipcMain.handle(IPC.reviewerPrompt, async (_e, sessionId, text) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt || text.trim().length === 0) return;
      await rt.reviewer.prompt(text);
    });
    import_electron.ipcMain.handle(IPC.reviewerStop, async (_e, sessionId) => {
      const rt = registry?.get(sessionId) ?? null;
      rt?.reviewer.cancel();
    });
    import_electron.ipcMain.handle(IPC.reviewerRestart, async (_e, sessionId) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return false;
      return rt.reviewer.restart();
    });
    import_electron.ipcMain.handle(IPC.reviewerTranscript, async (_e, sessionId) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return [];
      return rt.reviewer.conversation;
    });
    import_electron.ipcMain.handle(IPC.scrollbackGet, async (_e, sessionId, agentId) => {
      const rt = registry?.get(sessionId) ?? null;
      if (!rt) return null;
      try {
        const raw = await (0, import_promises7.readFile)((0, import_node_path9.join)(rt.sessionDir(), "scrollback", `${agentId}.json`), "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed.lines) ? parsed.lines : null;
      } catch {
        return null;
      }
    });
    import_electron.ipcMain.handle(IPC.fsListDir, async (_e, path) => {
      const entries = await (0, import_promises7.readdir)(path, { withFileTypes: true });
      const out = [];
      for (const e of entries) {
        const full = (0, import_node_path9.join)(path, e.name);
        let isDir = e.isDirectory();
        let size = 0;
        try {
          if (e.isSymbolicLink()) {
            const st = await (0, import_promises7.stat)(full);
            isDir = st.isDirectory();
            size = st.size;
          } else if (!isDir) {
            size = (await (0, import_promises7.stat)(full)).size;
          }
        } catch {
          continue;
        }
        out.push({ name: e.name, path: full, isDir, size });
      }
      out.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
      return out;
    });
    import_electron.ipcMain.handle(IPC.fsReadFile, async (_e, path) => {
      const st = await (0, import_promises7.stat)(path);
      if (st.size > 4 * 1024 * 1024) throw new Error("file too large");
      return { content: await (0, import_promises7.readFile)(path, "utf8"), size: st.size };
    });
    import_electron.ipcMain.handle(IPC.fsWriteFile, async (_e, path, content) => {
      await (0, import_promises7.writeFile)(path, content, "utf8");
    });
    import_electron.ipcMain.handle(IPC.fsStat, async (_e, path) => {
      const st = await (0, import_promises7.stat)(path);
      return { path, isDir: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs };
    });
    import_electron.ipcMain.handle(IPC.pickFolder, async () => {
      if (!mainWindow) return null;
      const result = await import_electron.dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
        title: "Add a project folder"
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    import_electron.app.on("will-quit", () => registry?.killAll());
    createWindow();
    import_electron.app.on("activate", () => {
      if (import_electron.BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  import_electron.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") import_electron.app.quit();
  });
}
