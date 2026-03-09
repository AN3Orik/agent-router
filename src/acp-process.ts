import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const JSONRPC = "2.0";
const DIAG_MAX_RECENT_UPDATES = 24;
const DIAG_MAX_NONJSON_LINES = 12;
const DIAG_MAX_TEXT_TAIL = 400;
const DIAG_MAX_STDERR_TAIL = 800;
const DIAG_MAX_LINE_TAIL = 260;

type PermissionMode = "allow" | "reject";

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: JsonRpcError;
};

type SessionUpdate = {
  sessionUpdate?: string;
  content?: {
    type?: string;
    text?: string;
  };
  [key: string]: unknown;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
  method: string;
};

type RpcMessage = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: JsonRpcError;
};

type TerminalState = {
  child: ReturnType<typeof spawn>;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  done: boolean;
  outputByteLimit: number;
  donePromise: Promise<void>;
  doneResolve: () => void;
};

type TerminalCreateParams = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Array<{ name?: string; value?: string }>;
  outputByteLimit?: number;
};

export type AcpNameValue = {
  name: string;
  value: string;
};

export type AcpMcpLocalServer = {
  name: string;
  command: string;
  args?: string[];
  env?: AcpNameValue[];
};

export type AcpMcpRemoteServer = {
  name: string;
  type: string;
  url: string;
  headers?: AcpNameValue[];
};

export type AcpMcpServer = AcpMcpLocalServer | AcpMcpRemoteServer;

type AcpProcessOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  sessionMeta?: Record<string, unknown>;
  permissionMode?: PermissionMode;
  onUpdate?: ((update: SessionUpdate) => void) | null;
};

function makeError(code: number, message: string, data?: unknown): JsonRpcError {
  return {
    code,
    message,
    ...(data === undefined ? {} : { data })
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAcpCwd(value: string): string {
  const resolved = path.resolve(value);
  if (process.platform !== "win32") {
    return resolved;
  }
  // Prefer forward slashes for tool-call JSON arguments to avoid backslash escaping issues.
  return resolved.replace(/\\/g, "/");
}

class TerminalRegistry {
  private terminals = new Map<string, TerminalState>();

  create(params: TerminalCreateParams): { terminalId: string } {
    const terminalId = crypto.randomUUID();
    const outputByteLimit =
      typeof params.outputByteLimit === "number" && params.outputByteLimit > 0
        ? params.outputByteLimit
        : 1_000_000;

    const env: Record<string, string | undefined> = { ...process.env };
    for (const pair of params.env || []) {
      if (pair && typeof pair.name === "string") {
        env[pair.name] = String(pair.value ?? "");
      }
    }

    const child = spawn(params.command, params.args || [], {
      cwd: params.cwd || process.cwd(),
      env: env as NodeJS.ProcessEnv,
      shell: process.platform === "win32",
      windowsHide: true
    });

    let doneResolve: () => void = () => undefined;
    const state: TerminalState = {
      child,
      output: "",
      truncated: false,
      exitCode: null,
      signal: null,
      done: false,
      outputByteLimit,
      donePromise: new Promise<void>((resolve) => {
        doneResolve = resolve;
      }),
      doneResolve
    };

    const appendOutput = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      state.output += text;
      const bytes = Buffer.byteLength(state.output, "utf8");
      if (bytes > state.outputByteLimit) {
        state.truncated = true;
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

  private get(terminalId: string): TerminalState | undefined {
    return this.terminals.get(terminalId);
  }

  output(terminalId: string): {
    output: string;
    truncated: boolean;
    exitStatus: { exitCode: number | null; signal: NodeJS.Signals | null } | null;
  } {
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

  async waitForExit(terminalId: string): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }> {
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

  kill(terminalId: string): Record<string, never> {
    const state = this.get(terminalId);
    if (!state) {
      throw new Error(`Unknown terminalId: ${terminalId}`);
    }
    if (!state.done) {
      state.child.kill();
    }
    return {};
  }

  release(terminalId: string): Record<string, never> {
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

  releaseAll(): void {
    for (const terminalId of this.terminals.keys()) {
      this.release(terminalId);
    }
  }
}

export class AcpProcess {
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private readonly cwd: string;
  private readonly sessionMeta: Record<string, unknown> | null;
  private permissionMode: PermissionMode;
  private onUpdate: ((update: SessionUpdate) => void) | null;

  private child: ReturnType<typeof spawn> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private nextId = 1;
  private sessionId: string | null = null;
  private lastSessionUpdateAt = 0;
  private readonly recentSessionUpdates: SessionUpdate[] = [];
  private readonly recentNonJsonStdout: string[] = [];
  public stderr = "";
  private closed = false;
  private readonly terminalRegistry = new TerminalRegistry();

  public updates: SessionUpdate[] = [];
  public textOutput = "";

  constructor({
    command,
    args,
    env,
    cwd,
    sessionMeta,
    permissionMode = "allow",
    onUpdate = null
  }: AcpProcessOptions) {
    this.command = command;
    this.args = args || [];
    this.env = env || {};
    this.cwd = cwd || process.cwd();
    this.sessionMeta = sessionMeta && typeof sessionMeta === "object" ? sessionMeta : null;
    this.permissionMode = permissionMode;
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : null;
  }

  setUpdateHandler(onUpdate: ((update: SessionUpdate) => void) | null): void {
    this.onUpdate = typeof onUpdate === "function" ? onUpdate : null;
  }

  setPermissionMode(permissionMode: string): void {
    this.permissionMode = permissionMode === "reject" ? "reject" : "allow";
  }

  resetCapturedOutput(): void {
    this.updates = [];
    this.textOutput = "";
    this.recentSessionUpdates.length = 0;
    this.recentNonJsonStdout.length = 0;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const spawnSpec = this.buildSpawnSpec(this.command, this.args);
    const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };
    const commandBase = path.basename(this.command || "").toLowerCase();
    const isCodexAcpCommand =
      commandBase === "codex-acp" ||
      commandBase === "codex-acp.cmd" ||
      commandBase === "codex-acp.exe";
    if (isCodexAcpCommand) {
      delete inheritedEnv.CODEX_THREAD_ID;
      delete inheritedEnv.CODEX_HOME;
      delete inheritedEnv.CODEX_PROFILE;
      delete inheritedEnv.CODEX_CONFIG;
      delete inheritedEnv.CODEX_MANAGED_BY_NPM;
    }

    this.child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.cwd,
      env: { ...inheritedEnv, ...this.env },
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

  private buildSpawnSpec(command: string, args: string[]): { command: string; args: string[] } {
    if (process.platform !== "win32") {
      return { command, args };
    }

    const quote = (value: unknown): string => {
      const str = String(value ?? "");
      if (str.length === 0) {
        return "\"\"";
      }
      if (!/[ \t"&|<>^]/.test(str)) {
        return str;
      }
      return `"${str.replace(/"/g, "\\\"")}"`;
    };

    const commandLine = [command, ...(args || [])].map(quote).join(" ");
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", commandLine]
    };
  }

  async close(): Promise<void> {
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

  private rejectAllPending(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  async initialize(): Promise<any> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "agent-router",
        version: "0.1.0"
      },
      clientCapabilities: {}
    });
  }

  async newSession(cwd?: string, mcpServers: AcpMcpServer[] = []): Promise<any> {
    const payload: Record<string, unknown> = {
      cwd: normalizeAcpCwd(cwd || this.cwd),
      mcpServers: Array.isArray(mcpServers) ? mcpServers : []
    };
    if (this.sessionMeta) {
      payload._meta = this.sessionMeta;
    }
    const session = await this.request("session/new", payload);
    this.sessionId = String(session.sessionId || "");
    return session;
  }

  async prompt(
    prompt: string | Array<Record<string, unknown>>,
    timeoutMs: number,
    sessionId: string | null = this.sessionId
  ): Promise<any> {
    if (!sessionId) {
      throw new Error("sessionId is missing. Call newSession() first.");
    }

    let promptBlocks: Array<Record<string, unknown>> | null = null;
    if (typeof prompt === "string" && prompt.trim()) {
      promptBlocks = [{ type: "text", text: prompt }];
    } else if (Array.isArray(prompt) && prompt.length > 0) {
      promptBlocks = prompt;
    } else {
      throw new Error("prompt must be a non-empty string or ACP content array.");
    }

    return this.request(
      "session/prompt",
      {
        sessionId,
        prompt: promptBlocks
      },
      timeoutMs
    );
  }

  async waitForSessionQuiescence({
    quietMs = 0,
    maxWaitMs = 0
  }: {
    quietMs?: number;
    maxWaitMs?: number;
  }): Promise<void> {
    const requiredQuietMs = Math.max(0, Number(quietMs || 0));
    if (requiredQuietMs <= 0) {
      return;
    }

    const maxWait = Math.max(requiredQuietMs, Number(maxWaitMs || 0));
    const deadline = Date.now() + maxWait;
    for (;;) {
      const idleForMs = Date.now() - this.lastSessionUpdateAt;
      if (idleForMs >= requiredQuietMs) {
        return;
      }
      if (Date.now() >= deadline) {
        return;
      }
      await sleep(Math.min(50, requiredQuietMs));
    }
  }

  request(method: string, params: any, timeoutMs = 180000): Promise<any> {
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
      this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private respond(id: number, result: unknown): void {
    if (!this.child || this.closed) {
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: JSONRPC, id, result: result || {} })}\n`
    );
  }

  private respondError(id: number, error: JsonRpcError): void {
    if (!this.child || this.closed) {
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: JSONRPC, id, error })}\n`
    );
  }

  private handleStdoutChunk(chunk: string): void {
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

  private handleStdoutLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.stderr += `\n[stdout-nonjson] ${line}`;
      this.rememberNonJsonStdout(line);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      if (
        Object.prototype.hasOwnProperty.call(message, "result") ||
        Object.prototype.hasOwnProperty.call(message, "error")
      ) {
        this.handleResponse(message as JsonRpcResponse);
        return;
      }
      if (typeof message.method === "string") {
        void this.handleAgentRequest(message as Required<Pick<RpcMessage, "id" | "method">> & RpcMessage);
        return;
      }
    }

    if (typeof message.method === "string" && !message.id) {
      this.handleAgentNotification(message);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);

    if (message.error) {
      const base = `ACP error (${pending.method}): ${JSON.stringify(message.error)}`;
      if (pending.method === "session/prompt") {
        const diagnostics = this.buildPromptErrorDiagnostics(message.error);
        pending.reject(
          new Error(diagnostics ? `${base} | diagnostics: ${diagnostics}` : base)
        );
        return;
      }
      pending.reject(new Error(base));
      return;
    }
    pending.resolve(message.result);
  }

  private handleAgentNotification(message: RpcMessage): void {
    if (message.method !== "session/update") {
      return;
    }
    const update = message.params?.update as SessionUpdate | undefined;
    if (!update || typeof update !== "object") {
      return;
    }
    this.rememberSessionUpdate(update);
    this.lastSessionUpdateAt = Date.now();
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

  private async handleAgentRequest(message: {
    id: number;
    method: string;
    params?: any;
  }): Promise<void> {
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
      const messageText = err instanceof Error ? err.message : String(err);
      this.respondError(id, makeError(-32603, messageText));
    }
  }

  private handlePermission(params: any): { outcome: { outcome: string; optionId?: string } } {
    const options = params?.options || [];
    if (!Array.isArray(options) || options.length === 0) {
      return { outcome: { outcome: "cancelled" } };
    }

    if (this.permissionMode === "reject") {
      const rejectOption =
        options.find((option: any) => option.kind === "reject_once") ||
        options.find((option: any) => option.kind === "reject_always");
      if (!rejectOption) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: { outcome: "selected", optionId: rejectOption.optionId }
      };
    }

    const allowOption =
      options.find((option: any) => option.kind === "allow_once") ||
      options.find((option: any) => option.kind === "allow_always");
    if (!allowOption) {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: { outcome: "selected", optionId: allowOption.optionId }
    };
  }

  private resolveFilePath(filePath: unknown): string {
    if (!filePath || typeof filePath !== "string") {
      throw new Error("Invalid path");
    }
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(this.cwd, filePath);
  }

  private async handleReadFile(params: any): Promise<{ content: string }> {
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

  private async handleWriteFile(params: any): Promise<Record<string, never>> {
    const fullPath = this.resolveFilePath(params?.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, String(params?.content ?? ""), "utf8");
    return {};
  }

  private rememberSessionUpdate(update: SessionUpdate): void {
    this.recentSessionUpdates.push(update);
    if (this.recentSessionUpdates.length > DIAG_MAX_RECENT_UPDATES) {
      this.recentSessionUpdates.splice(
        0,
        this.recentSessionUpdates.length - DIAG_MAX_RECENT_UPDATES
      );
    }
  }

  private rememberNonJsonStdout(line: string): void {
    const compact = String(line || "").replace(/\s+/g, " ").trim();
    if (!compact) {
      return;
    }
    this.recentNonJsonStdout.push(
      compact.slice(0, DIAG_MAX_LINE_TAIL)
    );
    if (this.recentNonJsonStdout.length > DIAG_MAX_NONJSON_LINES) {
      this.recentNonJsonStdout.splice(
        0,
        this.recentNonJsonStdout.length - DIAG_MAX_NONJSON_LINES
      );
    }
  }

  private buildPromptErrorDiagnostics(error: JsonRpcError): string {
    const parts: string[] = [];
    const details = (() => {
      if (!error || typeof error !== "object") {
        return "";
      }
      const data = (error as Record<string, unknown>).data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return "";
      }
      const detail = (data as Record<string, unknown>).details;
      if (typeof detail === "string" && detail.trim()) {
        return detail.trim();
      }
      const message = (data as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
      return "";
    })();
    if (details) {
      parts.push(`error_details=${JSON.stringify(details)}`);
    }

    if (this.recentSessionUpdates.length > 0) {
      parts.push(`updates_count=${this.recentSessionUpdates.length}`);
      const recentKinds = this.recentSessionUpdates
        .slice(-8)
        .map((update) => String(update?.sessionUpdate || "unknown"));
      parts.push(`recent_updates=${JSON.stringify(recentKinds)}`);

      const lastUpdate = this.recentSessionUpdates[this.recentSessionUpdates.length - 1];
      const lastUpdateKind = String(lastUpdate?.sessionUpdate || "unknown");
      const lastStatus = String((lastUpdate as any)?.status || "").trim().toLowerCase();
      const lastToolCallId = String((lastUpdate as any)?.toolCallId || "").trim();
      const lastToolName = String((lastUpdate as any)?.toolName || "").trim();
      parts.push(
        `last_update=${JSON.stringify({
          kind: lastUpdateKind,
          ...(lastStatus ? { status: lastStatus } : {}),
          ...(lastToolCallId ? { toolCallId: lastToolCallId } : {}),
          ...(lastToolName ? { toolName: lastToolName } : {})
        })}`
      );
      const lastChunkText =
        typeof (lastUpdate as any)?.content?.text === "string"
          ? String((lastUpdate as any).content.text).replace(/\s+/g, " ").trim()
          : "";
      if (lastChunkText) {
        parts.push(`last_chunk_text_tail=${JSON.stringify(lastChunkText.slice(-220))}`);
      }

      const lastToolUpdate = [...this.recentSessionUpdates]
        .reverse()
        .find(
          (update) =>
            String(update?.sessionUpdate || "").toLowerCase() === "tool_call" ||
            String(update?.sessionUpdate || "").toLowerCase() === "tool_call_update"
        ) as Record<string, unknown> | undefined;
      if (lastToolUpdate) {
        const rawInput =
          lastToolUpdate.rawInput &&
          typeof lastToolUpdate.rawInput === "object" &&
          !Array.isArray(lastToolUpdate.rawInput)
            ? (lastToolUpdate.rawInput as Record<string, unknown>)
            : {};
        parts.push(
          `last_tool_update=${JSON.stringify({
            kind: String(lastToolUpdate.sessionUpdate || ""),
            toolCallId: String(lastToolUpdate.toolCallId || ""),
            status: String(lastToolUpdate.status || ""),
            title: String(lastToolUpdate.title || ""),
            rawInputKeys: Object.keys(rawInput).slice(0, 16)
          })}`
        );
      }
    }

    const textTail = this.textOutput.slice(-DIAG_MAX_TEXT_TAIL).replace(/\s+/g, " ").trim();
    if (textTail) {
      parts.push(`text_tail=${JSON.stringify(textTail)}`);
    }

    const stderrTail = this.stderr.slice(-DIAG_MAX_STDERR_TAIL).replace(/\s+/g, " ").trim();
    if (stderrTail) {
      parts.push(`stderr_tail=${JSON.stringify(stderrTail)}`);
    }

    if (this.recentNonJsonStdout.length > 0) {
      parts.push(`stdout_nonjson_tail=${JSON.stringify(this.recentNonJsonStdout.slice(-5))}`);
    }

    return parts.join("; ");
  }
}
