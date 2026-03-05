import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const JSONRPC = "2.0";

function makeError(code, message, data) {
  return {
    code,
    message,
    ...(data === undefined ? {} : { data })
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TerminalRegistry {
  constructor() {
    this.terminals = new Map();
  }

  create(params) {
    const terminalId = crypto.randomUUID();
    const outputByteLimit =
      typeof params.outputByteLimit === "number" && params.outputByteLimit > 0
        ? params.outputByteLimit
        : 1_000_000;

    const env = { ...process.env };
    for (const pair of params.env || []) {
      if (pair && typeof pair.name === "string") {
        env[pair.name] = String(pair.value ?? "");
      }
    }

    const child = spawn(params.command, params.args || [], {
      cwd: params.cwd || process.cwd(),
      env,
      shell: process.platform === "win32",
      windowsHide: true
    });

    const state = {
      child,
      output: "",
      truncated: false,
      exitCode: null,
      signal: null,
      done: false,
      outputByteLimit,
      donePromise: null,
      doneResolve: null
    };

    state.donePromise = new Promise((resolve) => {
      state.doneResolve = resolve;
    });

    const appendOutput = (chunk) => {
      const text = chunk.toString();
      state.output += text;
      const bytes = Buffer.byteLength(state.output, "utf8");
      if (bytes > state.outputByteLimit) {
        state.truncated = true;
        // Trim from the beginning while preserving valid UTF-8 boundaries.
        let slice = state.output;
        while (Buffer.byteLength(slice, "utf8") > state.outputByteLimit) {
          slice = slice.slice(Math.max(1, Math.floor(slice.length * 0.1)));
        }
        state.output = slice;
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("exit", (exitCode, signal) => {
      state.exitCode = exitCode;
      state.signal = signal;
      state.done = true;
      state.doneResolve();
    });
    child.on("error", (err) => {
      appendOutput(Buffer.from(`\n[terminal error] ${err.message}\n`, "utf8"));
      state.done = true;
      state.doneResolve();
    });

    this.terminals.set(terminalId, state);
    return { terminalId };
  }

  get(terminalId) {
    return this.terminals.get(terminalId);
  }

  output(terminalId) {
    const state = this.get(terminalId);
    if (!state) {
      throw new Error(`Unknown terminalId: ${terminalId}`);
    }
    return {
      output: state.output,
      truncated: state.truncated,
      exitStatus: state.done
        ? {
            exitCode: state.exitCode,
            signal: state.signal
          }
        : null
    };
  }

  async waitForExit(terminalId) {
    const state = this.get(terminalId);
    if (!state) {
      throw new Error(`Unknown terminalId: ${terminalId}`);
    }
    await state.donePromise;
    return {
      exitCode: state.exitCode,
      signal: state.signal
    };
  }

  kill(terminalId) {
    const state = this.get(terminalId);
    if (!state) {
      throw new Error(`Unknown terminalId: ${terminalId}`);
    }
    if (!state.done) {
      state.child.kill();
    }
    return {};
  }

  release(terminalId) {
    const state = this.get(terminalId);
    if (!state) {
      return {};
    }
    if (!state.done) {
      state.child.kill();
    }
    this.terminals.delete(terminalId);
    return {};
  }

  releaseAll() {
    for (const terminalId of this.terminals.keys()) {
      this.release(terminalId);
    }
  }
}

export class AcpProcess {
  constructor({
    command,
    args,
    env,
    cwd,
    permissionMode = "allow",
    onUpdate = null
  }) {
    this.command = command;
    this.args = args || [];
    this.env = env || {};
    this.cwd = cwd || process.cwd();
    this.permissionMode = permissionMode;
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : null;

    this.child = null;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.nextId = 1;
    this.sessionId = null;
    this.stderr = "";
    this.closed = false;
    this.terminalRegistry = new TerminalRegistry();

    this.updates = [];
    this.textOutput = "";
  }

  async start() {
    if (this.child) {
      return;
    }

    const spawnSpec = this.buildSpawnSpec(this.command, this.args);

    this.child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.on("data", (chunk) => {
      this.handleStdoutChunk(chunk.toString());
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
      if (this.stderr.length > 200_000) {
        this.stderr = this.stderr.slice(-200_000);
      }
    });

    this.child.on("error", (err) => {
      this.rejectAllPending(new Error(`Failed to start ACP process: ${err.message}`));
    });

    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.rejectAllPending(
        new Error(`ACP process exited (code=${code}, signal=${signal || "none"})`)
      );
      this.terminalRegistry.releaseAll();
    });

    await sleep(30);
  }

  buildSpawnSpec(command, args) {
    if (process.platform !== "win32") {
      return { command, args };
    }

    const quote = (value) => {
      const str = String(value ?? "");
      if (str.length === 0) {
        return '""';
      }
      if (!/[ \t"&|<>^]/.test(str)) {
        return str;
      }
      return `"${str.replace(/"/g, '\\"')}"`;
    };

    const commandLine = [command, ...(args || [])].map(quote).join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", commandLine]
    };
  }

  async close() {
    if (!this.child) {
      return;
    }
    this.terminalRegistry.releaseAll();
    if (!this.closed) {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
      } else {
        this.child.kill("SIGTERM");
      }
    }
    this.closed = true;
  }

  rejectAllPending(err) {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "agent-router",
        version: "0.1.0"
      },
      clientCapabilities: {}
    });
  }

  async newSession(cwd) {
    const session = await this.request("session/new", {
      cwd: path.resolve(cwd || this.cwd),
      mcpServers: []
    });
    this.sessionId = session.sessionId;
    return session;
  }

  async prompt(prompt, timeoutMs) {
    if (!this.sessionId) {
      throw new Error("sessionId is missing. Call newSession() first.");
    }

    return this.request(
      "session/prompt",
      {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: prompt }]
      },
      timeoutMs
    );
  }

  request(method, params, timeoutMs = 180000) {
    if (!this.child || this.closed) {
      return Promise.reject(new Error("ACP process is not running."));
    }

    const id = this.nextId++;
    const payload = {
      jsonrpc: JSONRPC,
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout, method });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  respond(id, result) {
    if (!this.child || this.closed) {
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: JSONRPC, id, result: result || {} })}\n`
    );
  }

  respondError(id, error) {
    if (!this.child || this.closed) {
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: JSONRPC, id, error })}\n`
    );
  }

  handleStdoutChunk(chunk) {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      this.handleStdoutLine(line);
    }
  }

  handleStdoutLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Some CLIs may leak human logs to stdout; keep going.
      this.stderr += `\n[stdout-nonjson] ${line}`;
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      if (
        Object.prototype.hasOwnProperty.call(message, "result") ||
        Object.prototype.hasOwnProperty.call(message, "error")
      ) {
        this.handleResponse(message);
        return;
      }
      if (typeof message.method === "string") {
        void this.handleAgentRequest(message);
        return;
      }
    }

    if (typeof message.method === "string" && !message.id) {
      this.handleAgentNotification(message);
    }
  }

  handleResponse(message) {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(`ACP error (${pending.method}): ${JSON.stringify(message.error)}`));
      return;
    }
    pending.resolve(message.result);
  }

  handleAgentNotification(message) {
    if (message.method !== "session/update") {
      return;
    }
    const update = message.params?.update;
    if (!update || typeof update !== "object") {
      return;
    }
    this.updates.push(update);
    if (this.onUpdate) {
      try {
        this.onUpdate(update);
      } catch {
        // Ignore callback errors so ACP flow can continue.
      }
    }

    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text"
    ) {
      this.textOutput += update.content.text || "";
    }
  }

  async handleAgentRequest(message) {
    const { id, method, params } = message;
    try {
      if (method === "session/request_permission") {
        this.respond(id, this.handlePermission(params));
        return;
      }

      if (method === "fs/read_text_file") {
        this.respond(id, await this.handleReadFile(params));
        return;
      }

      if (method === "fs/write_text_file") {
        this.respond(id, await this.handleWriteFile(params));
        return;
      }

      if (method === "terminal/create") {
        this.respond(id, this.terminalRegistry.create(params || {}));
        return;
      }

      if (method === "terminal/output") {
        this.respond(id, this.terminalRegistry.output(params?.terminalId));
        return;
      }

      if (method === "terminal/wait_for_exit") {
        this.respond(
          id,
          await this.terminalRegistry.waitForExit(params?.terminalId)
        );
        return;
      }

      if (method === "terminal/kill") {
        this.respond(id, this.terminalRegistry.kill(params?.terminalId));
        return;
      }

      if (method === "terminal/release") {
        this.respond(id, this.terminalRegistry.release(params?.terminalId));
        return;
      }

      this.respondError(id, makeError(-32601, `Method not found: ${method}`));
    } catch (err) {
      this.respondError(id, makeError(-32603, err.message));
    }
  }

  handlePermission(params) {
    const options = params?.options || [];
    if (!Array.isArray(options) || options.length === 0) {
      return { outcome: { outcome: "cancelled" } };
    }

    if (this.permissionMode === "reject") {
      const rejectOption =
        options.find((option) => option.kind === "reject_once") ||
        options.find((option) => option.kind === "reject_always");
      if (!rejectOption) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: { outcome: "selected", optionId: rejectOption.optionId }
      };
    }

    const allowOption =
      options.find((option) => option.kind === "allow_once") ||
      options.find((option) => option.kind === "allow_always");
    if (!allowOption) {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: { outcome: "selected", optionId: allowOption.optionId }
    };
  }

  resolveFilePath(filePath) {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("Invalid path");
    }
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(this.cwd, filePath);
  }

  async handleReadFile(params) {
    const fullPath = this.resolveFilePath(params?.path);
    const raw = await fs.readFile(fullPath, "utf8");

    const line = Number.isInteger(params?.line) ? Math.max(params.line, 1) : 1;
    const limit = Number.isInteger(params?.limit) ? Math.max(params.limit, 1) : null;
    if (line === 1 && !limit) {
      return { content: raw };
    }

    const lines = raw.split(/\r?\n/);
    const startIndex = line - 1;
    const slice = lines.slice(startIndex, limit ? startIndex + limit : undefined);
    return { content: slice.join(os.EOL) };
  }

  async handleWriteFile(params) {
    const fullPath = this.resolveFilePath(params?.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, String(params?.content ?? ""), "utf8");
    return {};
  }
}
