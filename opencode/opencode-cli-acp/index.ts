import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliAcpProviderConfig } from "./provider-config.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_BOOT_TIMEOUT_MS = 20_000;
const ROUTER_HEALTH_RETRY_MS = 500;
const ROUTER_STDERR_TAIL_MAX = 4000;
const ROUTER_STARTUP_TOAST_DELAY_MS = 600;
const ROUTER_STARTUP_TOAST_DURATION_MS = 2500;
const ROUTER_STARTUP_ERROR_TOAST_DURATION_MS = 7000;
const ROUTER_STATE_KEY = "__cli_acp_router_state__";
const PROVIDER_ID = "cliacp";
const NATIVE_AUTH_SENTINEL = "__CLI_ACP_NATIVE_AUTH__";
const CODEX_AUTH_PROVIDER_ID = "cliacp-codex";
const CLAUDE_AUTH_PROVIDER_ID = "cliacp-claude";
const GEMINI_AUTH_PROVIDER_ID = "cliacp-gemini";
const CLIACP_ACP_SSE_COMMENT_PREFIX = "cliacp_acp_update";
const CLIACP_BRIDGE_STATE_KEY = "__cliacp_tool_bridge_state__";
const CLIACP_BRIDGE_META_SOURCE = "cliacp-acp-bridge";
const CLIACP_GENERIC_TOOL_NAME = "acp_tool";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

type RouterStartupObserver = {
  onStart?: (context: { baseUrl: string }) => void | Promise<void>;
  onReady?: (context: { baseUrl: string }) => void | Promise<void>;
  onError?: (context: { baseUrl: string; error: unknown }) => void | Promise<void>;
};

function fireAndForget(task) {
  if (typeof task !== "function") {
    return;
  }
  Promise.resolve()
    .then(task)
    .catch(() => {
      // Ignore secondary UI-notification errors.
    });
}

function providerLabel(provider) {
  const normalized = trimOptional(provider).toLowerCase();
  if (normalized === "claude") {
    return "Claude CLI";
  }
  if (normalized === "gemini") {
    return "Gemini CLI";
  }
  return "Codex CLI";
}

function describeError(error) {
  if (error && typeof error === "object" && "message" in error) {
    return trimOptional((error as { message?: string }).message) || "Unknown error";
  }
  return trimOptional(String(error || "")) || "Unknown error";
}

/**
 * Uses the native OpenCode toast route to surface CLI startup state in TUI/WebUI.
 */
async function showCliAcpToast({
  client,
  directory,
  title,
  message,
  variant = "info",
  duration
}: {
  client: any;
  directory?: string;
  title?: string;
  message: string;
  variant?: "info" | "success" | "warning" | "error" | string;
  duration?: number;
}) {
  const normalizedMessage = trimOptional(message);
  if (!normalizedMessage) {
    return;
  }

  const payload: any = {
    message: normalizedMessage,
    variant
  };
  const query = directory ? { directory } : undefined;
  const normalizedTitle = trimOptional(title);
  if (normalizedTitle) {
    payload.title = normalizedTitle;
  }
  if (Number.isFinite(duration) && duration > 0) {
    payload.duration = duration;
  }

  try {
    if (client?.tui?.showToast) {
      // SDK v2 shape.
      const directResult = await client.tui.showToast({
        ...(query || {}),
        ...payload
      });
      if (!directResult?.error) {
        return;
      }

      // Legacy plugin-client shape.
      const legacyResult = await client.tui.showToast({
        ...(query ? { query } : {}),
        body: payload
      });
      if (!legacyResult?.error) {
        return;
      }
    }
  } catch {
    // Fall through to raw route client.
  }

  try {
    if (client?._client?.post) {
      await client._client.post({
        url: "/tui/show-toast",
        ...(query ? { query } : {}),
        body: payload,
        headers: {
          "content-type": "application/json"
        }
      });
    }
  } catch {
    // Toasts are best-effort; do not fail request flow.
  }
}

/**
 * Creates a cold-start observer that only displays delayed startup toast once per boot.
 */
function createRouterStartupToastObserver({ client, provider, delayMs, directory }) {
  const launchLabel = providerLabel(provider);
  const effectiveDelay =
    Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : ROUTER_STARTUP_TOAST_DELAY_MS;
  let timer = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    onStart: () => {
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        void showCliAcpToast({
          client,
          directory,
          message: `Starting ${launchLabel}...`,
          variant: "info",
          duration: ROUTER_STARTUP_TOAST_DURATION_MS
        });
      }, effectiveDelay);
    },
    onReady: () => {
      clearTimer();
    },
    onError: ({ error }) => {
      clearTimer();
      const reason = describeError(error);
      void showCliAcpToast({
        client,
        directory,
        message: `Failed to start ${launchLabel}: ${reason}`,
        variant: "error",
        duration: ROUTER_STARTUP_ERROR_TOAST_DURATION_MS
      });
    }
  } as RouterStartupObserver;
}

function trimRightSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveRouterRoot(baseUrl) {
  const clean = trimRightSlash(baseUrl);
  if (clean.endsWith("/v1")) {
    return clean.slice(0, -3);
  }
  return clean;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRouterState() {
  if (!globalThis[ROUTER_STATE_KEY]) {
    globalThis[ROUTER_STATE_KEY] = {
      bootPromise: null,
      activeBaseUrl: ""
    };
  }
  return globalThis[ROUTER_STATE_KEY];
}

/**
 * Returns per-process bridge state used to map ACP tool events to OpenCode parts.
 */
function getBridgeState() {
  if (!globalThis[CLIACP_BRIDGE_STATE_KEY]) {
    globalThis[CLIACP_BRIDGE_STATE_KEY] = {
      assistantBySession: new Map(),
      toolPartByCall: new Map(),
      pendingBySession: new Map(),
      queueBySession: new Map(),
      startupToastByRequest: new Map(),
      partOrderByMessage: new Map()
    };
  }
  return globalThis[CLIACP_BRIDGE_STATE_KEY];
}

/**
 * Builds a stable composite key for a tool call within a specific session.
 */
function bridgeCallKey(sessionID, callId) {
  return `${sessionID}::${callId}`;
}

function bridgeStartupRequestKey(sessionID, requestId) {
  return `${sessionID}::${requestId}`;
}

function bridgeMessageKey(sessionID, messageID) {
  return `${sessionID}::${messageID}`;
}

/**
 * Allocates a message-local monotonic order index for bridge tool parts.
 * OpenCode renders parts in id order, so stable ordering must be encoded into part ids.
 */
function allocateBridgePartOrder(state, sessionID, messageID) {
  const key = bridgeMessageKey(sessionID, messageID);
  const next = Number(state.partOrderByMessage.get(key) || 0) + 1;
  state.partOrderByMessage.set(key, next);
  return next;
}

/**
 * Builds a bridge part id sortable by actual tool-call arrival order within a message.
 */
function buildOrderedBridgePartId(sessionID, messageID, callId, order) {
  const digest = crypto
    .createHash("sha1")
    .update(`${sessionID}::${messageID}::${callId}`)
    .digest("hex")
    .slice(0, 12);
  const ordinal = String(Math.max(1, Number(order) || 1)).padStart(8, "0");
  return `part_br_${ordinal}_${digest}`;
}

/**
 * Parses bridge input summary into an object accepted by ToolPart.state.input.
 */
function parseBridgeToolInput(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Preserve raw text if summary is not JSON.
  }
  return {
    raw: value
  };
}

/**
 * Whether a terminal tool status should be rendered as an error tool part.
 */
function isBridgeResultStatusError(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return new Set([
    "failed",
    "error",
    "cancelled",
    "canceled",
    "rejected",
    "aborted",
    "timeout"
  ]).has(normalized);
}

/**
 * Whether a tool status indicates completion and allows finalizing the tool part.
 */
function isTerminalBridgeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return new Set([
    "completed",
    "failed",
    "error",
    "cancelled",
    "canceled",
    "rejected",
    "aborted",
    "timeout"
  ]).has(normalized);
}

/**
 * Extracts prompt cache key / session id from request body metadata.
 */
function extractPromptCacheKey(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const metadata =
    payload.metadata && typeof payload.metadata === "object"
      ? payload.metadata
      : {};
  const candidates = [
    payload.promptCacheKey,
    payload.prompt_cache_key,
    metadata.promptCacheKey,
    metadata.prompt_cache_key
  ];
  for (const candidate of candidates) {
    const value = trimOptional(candidate);
    if (value) {
      return value;
    }
  }
  return "";
}

/**
 * Decodes bridge payload from an SSE comment line emitted by the router.
 */
function decodeBridgeCommentLine(line) {
  if (typeof line !== "string" || !line.startsWith(":")) {
    return null;
  }
  const content = line.slice(1).trim();
  const prefix = `${CLIACP_ACP_SSE_COMMENT_PREFIX} `;
  if (!content.startsWith(prefix)) {
    return null;
  }
  const encoded = content.slice(prefix.length).trim();
  if (!encoded) {
    return null;
  }
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const payload = JSON.parse(decoded);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const payloadType = trimOptional(payload.type);
    if (!payloadType) {
      return null;
    }
    if (
      (payloadType === "tool_call" || payloadType === "tool_result") &&
      !trimOptional(payload.callId)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Serializes bridge updates per session to avoid out-of-order part transitions.
 */
function enqueueBridgeSessionJob(sessionID, task) {
  const state = getBridgeState();
  const previous = state.queueBySession.get(sessionID) || Promise.resolve();
  const next = previous
    .then(task)
    .catch(() => {
      // Avoid breaking the queue chain.
    })
    .finally(() => {
      if (state.queueBySession.get(sessionID) === next) {
        state.queueBySession.delete(sessionID);
      }
    });
  state.queueBySession.set(sessionID, next);
  return next;
}

async function checkHealth(routerRoot) {
  try {
    const res = await fetch(`${routerRoot}/health`);
    if (!res.ok) {
      return false;
    }
    const payload: any = await res.json();
    return payload?.ok === true;
  } catch {
    return false;
  }
}

function isLocalBaseUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return LOCAL_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function resolveRouterEntry(customEntry) {
  if (customEntry) {
    return path.isAbsolute(customEntry)
      ? customEntry
      : path.resolve(process.cwd(), customEntry);
  }

  return firstExistingPath([
    path.resolve(MODULE_DIR, "router", "src", "server.js"),
    path.resolve(MODULE_DIR, "..", "..", "src", "server.js")
  ]);
}

function resolveRuntimeCommands() {
  const normalizeRuntime = (runtime) => {
    if (!runtime) {
      return "";
    }
    return String(runtime).trim();
  };
  const isNodeRuntime = (runtime) => {
    const value = normalizeRuntime(runtime);
    if (!value) {
      return false;
    }
    const name = path.basename(value).toLowerCase();
    return name === "node" || name === "node.exe";
  };

  const commands = [];
  if (process.env.CLI_ACP_ROUTER_RUNTIME) {
    commands.push(normalizeRuntime(process.env.CLI_ACP_ROUTER_RUNTIME));
  }
  commands.push(process.platform === "win32" ? "node.exe" : "node");
  if (process.execPath && isNodeRuntime(process.execPath)) {
    commands.push(normalizeRuntime(process.execPath));
  }
  commands.push(process.platform === "win32" ? "bun.exe" : "bun");
  return [...new Set(commands.filter(Boolean))];
}

function parseHostPort(baseUrl) {
  const parsed = new URL(baseUrl);
  return {
    host: parsed.hostname,
    port: parsed.port || (parsed.protocol === "https:" ? "443" : "80")
  };
}

function withPort(baseUrl, port) {
  const parsed = new URL(baseUrl);
  parsed.port = String(port);
  return trimRightSlash(parsed.toString());
}

function isPortInUseError(err) {
  const message =
    err instanceof Error ? err.message : String(err || "");
  return /EADDRINUSE/i.test(message);
}

async function canListenOnPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const cleanup = (result) => {
      try {
        server.close();
      } catch {
        // Ignore cleanup errors.
      }
      resolve(result);
    };
    server.once("error", () => cleanup(false));
    server.once("listening", () => cleanup(true));
    server.listen(port, host);
  });
}

async function reserveEphemeralPort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : 0;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!port) {
          reject(new Error("Failed to reserve ephemeral router port."));
          return;
        }
        resolve(port);
      });
    });
    server.listen(0, host);
  });
}

async function pickLaunchBaseUrl(baseUrl, forceEphemeral = false) {
  if (!isLocalBaseUrl(baseUrl)) {
    return baseUrl;
  }
  const parsed = new URL(baseUrl);
  const host = parsed.hostname;
  const preferredPort = Number(
    parsed.port || (parsed.protocol === "https:" ? "443" : "80")
  );

  if (!forceEphemeral) {
    const free = await canListenOnPort(host, preferredPort);
    if (free) {
      return withPort(baseUrl, preferredPort);
    }
  }

  const fallbackPort = await reserveEphemeralPort(host);
  return withPort(baseUrl, fallbackPort);
}

function trimOptional(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function resolveCatalogApiKey(globalApiKey, authKeys) {
  const direct = trimOptional(globalApiKey);
  if (direct) {
    return direct;
  }
  for (const key of [authKeys?.codex, authKeys?.claude, authKeys?.gemini]) {
    const value = trimOptional(key);
    if (value) {
      return value;
    }
  }
  return "";
}

function buildRouterEnv({ pluginWorkdir, apiKey, options, authKeys = null }) {
  const env: Record<string, string> = {};

  if (pluginWorkdir) {
    env.DEFAULT_CWD = pluginWorkdir;
  }

  const codexBaseUrl =
    trimOptional(options?.cliAcpCodexBaseURL) ||
    trimOptional(process.env.CLI_ACP_CODEX_BASE_URL);
  if (codexBaseUrl) {
    env.CLI_ACP_CODEX_BASE_URL = codexBaseUrl;
  }

  const claudeBaseUrl =
    trimOptional(options?.cliAcpClaudeBaseURL) ||
    trimOptional(process.env.CLI_ACP_CLAUDE_BASE_URL);
  if (claudeBaseUrl) {
    env.CLI_ACP_CLAUDE_BASE_URL = claudeBaseUrl;
  }

  const geminiBaseUrl =
    trimOptional(options?.cliAcpGeminiBaseURL) ||
    trimOptional(process.env.CLI_ACP_GEMINI_BASE_URL);
  if (geminiBaseUrl) {
    env.CLI_ACP_GEMINI_BASE_URL = geminiBaseUrl;
  }

  const resolvedApiKey = trimOptional(process.env.CLI_ACP_API_KEY) || apiKey;
  if (resolvedApiKey) {
    env.CLI_ACP_API_KEY = resolvedApiKey;
  }
  const codexApiKey = trimOptional(authKeys?.codex || process.env.CLI_ACP_CODEX_API_KEY);
  if (codexApiKey) {
    env.CLI_ACP_CODEX_API_KEY = codexApiKey;
  }
  const claudeApiKey = trimOptional(authKeys?.claude || process.env.CLI_ACP_CLAUDE_API_KEY);
  if (claudeApiKey) {
    env.CLI_ACP_CLAUDE_API_KEY = claudeApiKey;
  }
  const geminiApiKey = trimOptional(authKeys?.gemini || process.env.CLI_ACP_GEMINI_API_KEY);
  if (geminiApiKey) {
    env.CLI_ACP_GEMINI_API_KEY = geminiApiKey;
  }

  return env;
}

async function ensureRouterRunning({
  baseUrl,
  apiKey,
  routerEntry,
  extraEnv,
  startupObserver = null
}) {
  const requestedBaseUrl = trimOptional(baseUrl) || "http://127.0.0.1:8787/v1";
  const state = getRouterState();

  if (state.activeBaseUrl) {
    const activeRoot = resolveRouterRoot(state.activeBaseUrl);
    if (await checkHealth(activeRoot)) {
      return state.activeBaseUrl;
    }
    state.activeBaseUrl = "";
  }

  const requestedRoot = resolveRouterRoot(requestedBaseUrl);
  if (await checkHealth(requestedRoot)) {
    state.activeBaseUrl = requestedBaseUrl;
    return requestedBaseUrl;
  }

  const entry = resolveRouterEntry(routerEntry);
  if (!entry) {
    throw new Error("Cannot find embedded router entry point for CLI ACP plugin.");
  }

  if (state.bootPromise) {
    return state.bootPromise;
  }
  fireAndForget(() => startupObserver?.onStart?.({ baseUrl: requestedBaseUrl }));

  state.bootPromise = (async (): Promise<string> => {
    const runtimes = resolveRuntimeCommands();
    let launchBaseUrl = requestedBaseUrl;
    let forceEphemeral = false;
    let lastError = null;

    for (let launchAttempt = 0; launchAttempt < 3; launchAttempt += 1) {
      launchBaseUrl = await pickLaunchBaseUrl(requestedBaseUrl, forceEphemeral);
      const launchRoot = resolveRouterRoot(launchBaseUrl);

      if (await checkHealth(launchRoot)) {
        state.activeBaseUrl = launchBaseUrl;
        return launchBaseUrl;
      }

      const { host, port } = parseHostPort(launchRoot);
      let shouldRetryPort = false;

      for (const runtime of runtimes) {
        let stderrTail = "";
        let exitStatus = "";
        let spawnError = null;

        const child = spawn(runtime, [entry], {
          cwd: path.dirname(path.dirname(entry)),
          env: {
            ...process.env,
            ...extraEnv,
            HOST: host,
            PORT: String(port)
          },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true
        });

        child.on("error", (err) => {
          spawnError = err;
        });
        child.on("exit", (code, signal) => {
          exitStatus = `code=${code ?? "null"} signal=${signal ?? "null"}`;
        });
        child.stderr?.on("data", (chunk) => {
          stderrTail += chunk.toString();
          if (stderrTail.length > ROUTER_STDERR_TAIL_MAX) {
            stderrTail = stderrTail.slice(-ROUTER_STDERR_TAIL_MAX);
          }
        });

        const deadline = Date.now() + ROUTER_BOOT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (spawnError) {
            lastError = new Error(
              `CLI ACP router failed to spawn using "${runtime}": ${spawnError.message}`
            );
            shouldRetryPort =
              isLocalBaseUrl(launchBaseUrl) && isPortInUseError(spawnError);
            break;
          }
          if (exitStatus) {
            const hint = stderrTail.trim() ? ` Stderr: ${stderrTail.trim()}` : "";
            const combinedMessage = `${exitStatus} ${stderrTail}`;
            lastError = new Error(
              `CLI ACP router process exited before health check using "${runtime}" (${exitStatus}).${hint}`
            );
            shouldRetryPort =
              isLocalBaseUrl(launchBaseUrl) &&
              /EADDRINUSE/i.test(combinedMessage);
            break;
          }
          if (await checkHealth(launchRoot)) {
            state.activeBaseUrl = launchBaseUrl;
            return launchBaseUrl;
          }
          await sleep(ROUTER_HEALTH_RETRY_MS);
        }

        if (!exitStatus && !spawnError) {
          const hint = stderrTail.trim() ? ` Last stderr: ${stderrTail.trim()}` : "";
          lastError = new Error(
            `CLI ACP router did not start within ${ROUTER_BOOT_TIMEOUT_MS}ms (${launchRoot}) using "${runtime}".${hint}`
          );
          shouldRetryPort =
            isLocalBaseUrl(launchBaseUrl) && /EADDRINUSE/i.test(stderrTail);
        }

        try {
          child.kill();
        } catch {
          // Ignore cleanup errors.
        }
      }

      if (!shouldRetryPort || !isLocalBaseUrl(launchBaseUrl)) {
        break;
      }
      forceEphemeral = true;
    }

    throw lastError || new Error(`CLI ACP router failed to start on ${requestedRoot}.`);
  })();

  try {
    const startedBaseUrl = await state.bootPromise;
    state.activeBaseUrl = startedBaseUrl;
    fireAndForget(() => startupObserver?.onReady?.({ baseUrl: startedBaseUrl }));
    return startedBaseUrl;
  } catch (error) {
    fireAndForget(() => startupObserver?.onError?.({ baseUrl: requestedBaseUrl, error }));
    throw error;
  } finally {
    state.bootPromise = null;
  }
}

function ensureObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function normalizeProviderForModel(modelId) {
  const id = String(modelId || "").trim().toLowerCase();
  if (!id) {
    return "codex";
  }
  if (id.includes("gemini")) {
    return "gemini";
  }
  if (
    id.includes("claude") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku")
  ) {
    return "claude";
  }
  return "codex";
}

function getRequestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input && typeof input === "object" && typeof input.url === "string") {
    return input.url;
  }
  return "";
}

async function fetchRouterModelIds(baseURL, apiKey = ""): Promise<string[]> {
  const headers = new Headers();
  const key = trimOptional(apiKey);
  if (key) {
    headers.set("x-api-key", key);
  }
  const response = await fetch(`${trimRightSlash(baseURL)}/models`, {
    headers
  });
  if (!response.ok) {
    throw new Error(`Router /v1/models returned HTTP ${response.status}.`);
  }
  const payload: any = await response.json();
  const records = Array.isArray(payload && payload.data) ? payload.data : [];
  const ids: string[] = records
    .map((item: any) => trimOptional(item?.id))
    .filter((item: string): item is string => Boolean(item));
  if (ids.length === 0) {
    throw new Error("Router /v1/models returned empty model list.");
  }
  return [...new Set<string>(ids)];
}

function parseJsonBody(init) {
  if (!init || typeof init !== "object") {
    return null;
  }
  const rawBody = init.body;
  if (rawBody === undefined || rawBody === null) {
    return null;
  }
  let raw = "";
  if (typeof rawBody === "string") {
    raw = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    raw = Buffer.from(rawBody).toString("utf8");
  } else if (rawBody instanceof ArrayBuffer) {
    raw = Buffer.from(rawBody).toString("utf8");
  } else {
    return null;
  }
  raw = raw.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore malformed payloads.
  }
  return null;
}

/**
 * True when the request is OpenAI Responses streaming call that can carry bridge comments.
 */
function isResponsesStreamRequest(requestUrl, body) {
  if (!requestUrl) {
    return false;
  }
  try {
    const parsed = new URL(requestUrl);
    if (!parsed.pathname.endsWith("/v1/responses")) {
      return false;
    }
  } catch {
    return false;
  }
  return body?.stream === true;
}

/**
 * Persists tool part changes into OpenCode using whichever client surface is available.
 */
async function updateBridgeToolPart({
  client,
  serverUrl,
  directory,
  sessionID,
  messageID,
  part
}) {
  if (client?.part?.update) {
    const result = await client.part.update({
      sessionID,
      messageID,
      partID: part.id,
      directory,
      part
    });
    if (result?.error) {
      const message =
        result.error && typeof result.error === "object" && "message" in result.error
          ? String(result.error.message || "Failed to update bridge tool part.")
          : "Failed to update bridge tool part.";
      throw new Error(message);
    }
    return;
  }

  if (client?._client?.patch) {
    const result = await client._client.patch({
      url: "/session/{sessionID}/message/{messageID}/part/{partID}",
      path: {
        sessionID,
        messageID,
        partID: part.id
      },
      query: directory ? { directory } : undefined,
      body: part,
      headers: {
        "content-type": "application/json"
      }
    });
    if (result?.error) {
      const message =
        result.error && typeof result.error === "object" && "message" in result.error
          ? String(result.error.message || "Failed to update bridge tool part.")
          : "Failed to update bridge tool part.";
      throw new Error(message);
    }
    return;
  }

  const base = trimOptional(serverUrl);
  throw new Error(
    base
      ? `Cannot update bridge tool part: unsupported client shape for server ${base}.`
      : "Cannot update bridge tool part: unsupported client shape."
  );
}

/**
 * Applies decoded bridge payload to message tool parts for a specific session.
 */
async function applyBridgePayloadForSession({
  client,
  serverUrl,
  directory,
  sessionID,
  payload
}) {
  const state = getBridgeState();
  const message = state.assistantBySession.get(sessionID);
  const activeMessageID = trimOptional(message?.messageID);

  const callId = trimOptional(payload.callId);
  if (!callId) {
    return;
  }
  const key = bridgeCallKey(sessionID, callId);
  const now = Date.now();
  const stored = state.toolPartByCall.get(key);
  const messageID = trimOptional(stored?.messageID) || activeMessageID;
  if (!messageID) {
    const queue = state.pendingBySession.get(sessionID) || [];
    queue.push(payload);
    state.pendingBySession.set(sessionID, queue);
    return;
  }
  const input = stored?.input || parseBridgeToolInput(payload.inputSummary);
  const payloadToolName = trimOptional(payload.toolName);
  const toolName =
    payloadToolName && payloadToolName !== CLIACP_GENERIC_TOOL_NAME
      ? payloadToolName
      : stored?.toolName || CLIACP_GENERIC_TOOL_NAME;
  const title = trimOptional(payload.title) || stored?.title || toolName;
  const startTime =
    typeof stored?.startTime === "number" && stored.startTime > 0
      ? stored.startTime
      : now;
  const partID =
    stored?.partID ||
    buildOrderedBridgePartId(
      sessionID,
      messageID,
      callId,
      allocateBridgePartOrder(state, sessionID, messageID)
    );
  const metadata = {
    source: CLIACP_BRIDGE_META_SOURCE,
    cliacpBridge: true,
    callId
  };

  if (payload.type === "tool_call") {
    const part = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      callID: callId,
      tool: toolName,
      state: {
        status: "running",
        input,
        title,
        metadata: {
          ...metadata,
          status: trimOptional(payload.status) || "running"
        },
        time: {
          start: startTime
        }
      },
      metadata
    };
    await updateBridgeToolPart({
      client,
      serverUrl,
      directory,
      sessionID,
      messageID,
      part
    });
    state.toolPartByCall.set(key, {
      partID,
      sessionID,
      messageID,
      toolName,
      title,
      input,
      startTime
    });
    return;
  }

  if (payload.type !== "tool_result" || !isTerminalBridgeStatus(payload.status)) {
    return;
  }

  const resultStatus = trimOptional(payload.status).toLowerCase() || "completed";
  const outputText = String(payload.outputText || "");
  if (isBridgeResultStatusError(resultStatus)) {
    const part = {
      id: partID,
      sessionID,
      messageID,
      type: "tool",
      callID: callId,
      tool: toolName,
      state: {
        status: "error",
        input,
        error: outputText || `Tool finished with status "${resultStatus}".`,
        metadata: {
          ...metadata,
          status: resultStatus
        },
        time: {
          start: startTime,
          end: now
        }
      },
      metadata
    };
    await updateBridgeToolPart({
      client,
      serverUrl,
      directory,
      sessionID,
      messageID,
      part
    });
    state.toolPartByCall.delete(key);
    return;
  }

  const part = {
    id: partID,
    sessionID,
    messageID,
    type: "tool",
    callID: callId,
    tool: toolName,
    state: {
      status: "completed",
      input,
      output: outputText,
      title,
      metadata: {
        ...metadata,
        status: resultStatus
      },
      time: {
        start: startTime,
        end: now
      }
    },
    metadata
  };
  await updateBridgeToolPart({
    client,
    serverUrl,
    directory,
    sessionID,
    messageID,
    part
  });
  state.toolPartByCall.delete(key);
}

function clearBridgeStartupToastTimer(state, requestKey) {
  const current = state.startupToastByRequest.get(requestKey);
  if (current?.timer) {
    clearTimeout(current.timer);
  }
  state.startupToastByRequest.delete(requestKey);
}

/**
 * Handles non-tool bridge lifecycle payloads used for delayed cold-start startup toasts.
 */
function handleBridgeCliStatusPayload({ client, directory, sessionID, payload }) {
  const stage = trimOptional(payload?.stage).toLowerCase();
  const requestId =
    trimOptional(payload?.requestId) || trimOptional(payload?.responseId);
  if (!stage || !requestId) {
    return;
  }

  const state = getBridgeState();
  const requestKey = bridgeStartupRequestKey(sessionID, requestId);

  if (stage === "starting" || stage === "initializing") {
    if (state.startupToastByRequest.has(requestKey)) {
      return;
    }
    const provider =
      trimOptional(payload?.provider) || normalizeProviderForModel(payload?.model);
    const launchLabel = providerLabel(provider);
    const timer = setTimeout(() => {
      clearBridgeStartupToastTimer(state, requestKey);
      void showCliAcpToast({
        client,
        directory,
        message: `Starting ${launchLabel}...`,
        variant: "info",
        duration: ROUTER_STARTUP_TOAST_DURATION_MS
      });
    }, ROUTER_STARTUP_TOAST_DELAY_MS);
    state.startupToastByRequest.set(requestKey, {
      timer,
      createdAt: Date.now()
    });
    return;
  }

  if (stage === "ready" || stage === "completed") {
    clearBridgeStartupToastTimer(state, requestKey);
    return;
  }

  if (stage === "failed" || stage === "error") {
    clearBridgeStartupToastTimer(state, requestKey);
    const provider =
      trimOptional(payload?.provider) || normalizeProviderForModel(payload?.model);
    const reason = describeError(payload?.reason);
    void showCliAcpToast({
      client,
      directory,
      message: `Failed to start ${providerLabel(provider)}: ${reason}`,
      variant: "error",
      duration: ROUTER_STARTUP_ERROR_TOAST_DURATION_MS
    });
  }
}

/**
 * Observes cloned Responses stream and dispatches bridge comment payloads to the queue.
 */
function observeBridgeStream({
  response,
  sessionID,
  client,
  serverUrl,
  directory
}) {
  if (!response?.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const processLine = (line) => {
    const payload = decodeBridgeCommentLine(line);
    if (!payload) {
      return;
    }
    if (payload.type === "cli_status") {
      handleBridgeCliStatusPayload({
        client,
        directory,
        sessionID,
        payload
      });
      return;
    }
    enqueueBridgeSessionJob(sessionID, async () => {
      await applyBridgePayloadForSession({
        client,
        serverUrl,
        directory,
        sessionID,
        payload
      });
    });
  };

  const pump = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        processLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail) {
      processLine(tail.replace(/\r$/, ""));
    }
  };

  void pump().catch(() => {
    // Ignore observer failures; they must not break model responses.
  });
}

function resolveAuthPath() {
  const fromEnv = trimOptional(process.env.OPENCODE_AUTH_PATH);
  if (fromEnv) {
    return fromEnv;
  }
  const dataDir = trimOptional(process.env.OPENCODE_DATA_DIR);
  if (dataDir) {
    return path.join(dataDir, "auth.json");
  }
  const xdgDataHome = trimOptional(process.env.XDG_DATA_HOME);
  if (xdgDataHome) {
    return path.join(xdgDataHome, "opencode", "auth.json");
  }
  const testHome = trimOptional(process.env.OPENCODE_TEST_HOME);
  if (testHome) {
    return path.join(testHome, ".local", "share", "opencode", "auth.json");
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

function readApiKeyFromAuthEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "";
  }
  if (typeof entry.key === "string") {
    const key = entry.key.trim();
    return key === NATIVE_AUTH_SENTINEL ? "" : key;
  }
  if (typeof entry.apiKey === "string") {
    const key = entry.apiKey.trim();
    return key === NATIVE_AUTH_SENTINEL ? "" : key;
  }
  if (typeof entry.access === "string") {
    const key = entry.access.trim();
    return key === NATIVE_AUTH_SENTINEL ? "" : key;
  }
  return "";
}

function readCliAcpAuthKeys() {
  const keys = {
    codex: "",
    claude: "",
    gemini: ""
  };

  const authPath = resolveAuthPath();
  if (!authPath || !fs.existsSync(authPath)) {
    return keys;
  }

  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return keys;
    }

    keys.codex = readApiKeyFromAuthEntry(parsed[CODEX_AUTH_PROVIDER_ID]);
    keys.claude = readApiKeyFromAuthEntry(parsed[CLAUDE_AUTH_PROVIDER_ID]);
    keys.gemini = readApiKeyFromAuthEntry(parsed[GEMINI_AUTH_PROVIDER_ID]);
  } catch {
    // Ignore malformed auth file and use defaults.
  }

  return keys;
}

function getProviderBaseUrls(options) {
  return {
    codex:
      trimOptional(options?.cliAcpCodexBaseURL) ||
      trimOptional(process.env.CLI_ACP_CODEX_BASE_URL),
    claude:
      trimOptional(options?.cliAcpClaudeBaseURL) ||
      trimOptional(process.env.CLI_ACP_CLAUDE_BASE_URL),
    gemini:
      trimOptional(options?.cliAcpGeminiBaseURL) ||
      trimOptional(process.env.CLI_ACP_GEMINI_BASE_URL)
  };
}

function normalizeNameValueEntries(record) {
  const source = ensureObject(record);
  const entries = [];
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = trimOptional(rawName);
    if (!name) {
      continue;
    }
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    entries.push({
      name,
      value: String(rawValue)
    });
  }
  return entries;
}

function cloneAcpMcpServers(servers) {
  if (!Array.isArray(servers)) {
    return [];
  }
  return servers.map((server) => {
    const copy = { ...server };
    if (Array.isArray(server?.args)) {
      copy.args = [...server.args];
    }
    if (Array.isArray(server?.headers)) {
      copy.headers = server.headers.map((entry) => ({ ...entry }));
    }
    if (Array.isArray(server?.env)) {
      copy.env = server.env.map((entry) => ({ ...entry }));
    }
    return copy;
  });
}

function buildAcpMcpServersFromConfig(configMcp) {
  const map = ensureObject(configMcp);
  const servers = [];

  for (const [rawName, rawServer] of Object.entries(map)) {
    const name = trimOptional(rawName);
    if (!name) {
      continue;
    }

    const server = ensureObject(rawServer);
    if (server.enabled === false) {
      continue;
    }

    const type = trimOptional(server.type).toLowerCase();
    if (type === "local") {
      const commandParts = Array.isArray(server.command)
        ? server.command.map((part) => trimOptional(part)).filter(Boolean)
        : [];
      if (commandParts.length === 0) {
        continue;
      }

      const local: any = {
        name,
        command: commandParts[0],
        args: commandParts.slice(1),
        env: normalizeNameValueEntries(server.environment)
      };
      servers.push(local);
      continue;
    }

    if (type === "remote") {
      const url = trimOptional(server.url);
      if (!url) {
        continue;
      }
      const remote: any = {
        name,
        type: "http",
        url,
        headers: normalizeNameValueEntries(server.headers)
      };
      servers.push(remote);
    }
  }

  return servers;
}

function selectProviderApiKey(provider, keys) {
  if (provider === "codex") {
    return keys.codex || "";
  }
  if (provider === "claude") {
    return keys.claude || "";
  }
  if (provider === "gemini") {
    return keys.gemini || "";
  }
  return "";
}

function patchRequestBodyForCliAcp({ body, options, authKeys, mcpServers }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const next = { ...body };

  const explicitProvider = trimOptional(next.provider).toLowerCase();
  const provider =
    explicitProvider === "codex" || explicitProvider === "claude" || explicitProvider === "gemini"
      ? explicitProvider
      : normalizeProviderForModel(next.model);
  const providerBaseUrls = getProviderBaseUrls(options);
  const providerApiKey = selectProviderApiKey(provider, authKeys);

  if (!trimOptional(next.apiKey) && providerApiKey) {
    next.apiKey = providerApiKey;
  }

  if (
    (provider === "codex" || provider === "claude") &&
    !trimOptional(next.baseUrl)
  ) {
    const baseUrl = provider === "codex" ? providerBaseUrls.codex : providerBaseUrls.claude;
    if (baseUrl) {
      next.baseUrl = baseUrl;
    }
  }

  if (provider === "gemini" && !trimOptional(next.geminiBaseUrl) && providerBaseUrls.gemini) {
    next.geminiBaseUrl = providerBaseUrls.gemini;
  }

  if (
    !Object.prototype.hasOwnProperty.call(next, "mcpServers") &&
    Array.isArray(mcpServers) &&
    mcpServers.length > 0
  ) {
    next.mcpServers = cloneAcpMcpServers(mcpServers);
  }

  return {
    body: next,
    provider,
    apiKey: providerApiKey
  };
}

export async function CliAcpAuthPlugin() {
  const pluginInput =
    arguments.length > 0 && arguments[0] && typeof arguments[0] === "object"
      ? arguments[0]
      : {};

  const routerBaseUrl =
    process.env.CLI_ACP_ROUTER_BASE_URL || "http://127.0.0.1:8787/v1";
  const autoStartRouter = process.env.CLI_ACP_AUTOSTART_ROUTER !== "0";
  const routerEntry = process.env.CLI_ACP_ROUTER_ENTRY || "";
  const pluginWorkdir =
    (typeof pluginInput.worktree === "string" && pluginInput.worktree.trim()) ||
    (typeof pluginInput.directory === "string" && pluginInput.directory.trim()) ||
    "";
  const bridgeClient = pluginInput.client;
  const bridgeServerUrl =
    pluginInput.serverUrl && typeof pluginInput.serverUrl.toString === "function"
      ? pluginInput.serverUrl.toString()
      : "";
  const bridgeDirectory =
    (typeof pluginInput.directory === "string" && pluginInput.directory.trim()) ||
    pluginWorkdir;
  let configuredMcpServers = [];
  const flushPendingBridgePayloads = (sessionID) =>
    enqueueBridgeSessionJob(sessionID, async () => {
      const state = getBridgeState();
      const pending = state.pendingBySession.get(sessionID) || [];
      if (pending.length === 0) {
        return;
      }
      state.pendingBySession.delete(sessionID);
      for (const payload of pending) {
        await applyBridgePayloadForSession({
          client: bridgeClient,
          serverUrl: bridgeServerUrl,
          directory: bridgeDirectory,
          sessionID,
          payload
        });
      }
    });

  const rememberAssistantMessage = (sessionID, messageID) => {
    if (!sessionID || !messageID) {
      return;
    }
    const state = getBridgeState();
    state.assistantBySession.set(sessionID, {
      sessionID,
      messageID,
      updatedAt: Date.now()
    });
    void flushPendingBridgePayloads(sessionID);
  };

  return {
    event: async ({ event }) => {
      const evt = event && typeof event === "object" ? event : null;
      if (!evt) {
        return;
      }

      if (evt.type === "message.updated") {
        const info = evt.properties?.info;
        if (info?.role === "assistant") {
          const sessionID = trimOptional(info.sessionID);
          const messageID = trimOptional(info.id);
          if (sessionID && messageID) {
            rememberAssistantMessage(sessionID, messageID);
          }
        }
        return;
      }

      if (evt.type === "message.removed") {
        const sessionID = trimOptional(evt.properties?.sessionID);
        const messageID = trimOptional(evt.properties?.messageID);
        if (!sessionID || !messageID) {
          return;
        }
        const state = getBridgeState();
        const current = state.assistantBySession.get(sessionID);
        if (current?.messageID === messageID) {
          state.assistantBySession.delete(sessionID);
        }
        state.partOrderByMessage.delete(bridgeMessageKey(sessionID, messageID));
        for (const [key, record] of state.toolPartByCall.entries()) {
          if (record?.sessionID === sessionID && record?.messageID === messageID) {
            state.toolPartByCall.delete(key);
          }
        }
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!output || !Array.isArray(output.messages)) {
        return;
      }
      for (const message of output.messages) {
        if (!message || !Array.isArray(message.parts)) {
          continue;
        }
        message.parts = message.parts.filter((part) => {
          if (!part || part.type !== "tool") {
            return true;
          }
          const partMeta =
            part.metadata && typeof part.metadata === "object"
              ? part.metadata
              : {};
          const stateMeta =
            part.state &&
            part.state.metadata &&
            typeof part.state.metadata === "object"
              ? part.state.metadata
              : {};
          const source = trimOptional(partMeta.source || stateMeta.source);
          const bridgeFlag =
            partMeta.cliacpBridge === true || stateMeta.cliacpBridge === true;
          if (bridgeFlag) {
            return false;
          }
          return source !== CLIACP_BRIDGE_META_SOURCE;
        });
      }
    },
    config: async (config) => {
      const currentConfig = ensureObject(config);
      const providerMap = ensureObject(currentConfig.provider);
      const existingProvider = ensureObject(providerMap[PROVIDER_ID]);
      const existingOptions = ensureObject(existingProvider.options);
      const apiKey = trimOptional(process.env.CLI_ACP_API_KEY);
      const authKeys = readCliAcpAuthKeys();
      const routerEnv = buildRouterEnv({
        pluginWorkdir,
        apiKey,
        options: existingOptions,
        authKeys
      });
      configuredMcpServers = buildAcpMcpServersFromConfig(currentConfig.mcp);

      let catalogBaseURL = trimOptional(process.env.CLI_ACP_ROUTER_BASE_URL) || routerBaseUrl;
      if (autoStartRouter && isLocalBaseUrl(catalogBaseURL)) {
        catalogBaseURL = await ensureRouterRunning({
          baseUrl: catalogBaseURL,
          apiKey,
          routerEntry,
          extraEnv: routerEnv
        });
      }
      const catalogApiKey = resolveCatalogApiKey(apiKey, authKeys);
      const modelIds = await fetchRouterModelIds(catalogBaseURL, catalogApiKey);

      const providerPayload = await buildCliAcpProviderConfig({
        existingProvider,
        modelIds,
        cliAcpCodexBaseURL:
          trimOptional(existingOptions.cliAcpCodexBaseURL) ||
          trimOptional(process.env.CLI_ACP_CODEX_BASE_URL),
        cliAcpClaudeBaseURL:
          trimOptional(existingOptions.cliAcpClaudeBaseURL) ||
          trimOptional(process.env.CLI_ACP_CLAUDE_BASE_URL),
        cliAcpGeminiBaseURL:
          trimOptional(existingOptions.cliAcpGeminiBaseURL) ||
          trimOptional(process.env.CLI_ACP_GEMINI_BASE_URL),
        apiKey
      });
      providerMap[PROVIDER_ID] = providerPayload.provider;

      currentConfig.provider = providerMap;
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          provider: PROVIDER_ID,
          label: "Codex CLI",
          type: "api",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "Enter API key for Codex CLI",
              validate: (value) =>
                value && value.trim().length > 0 ? undefined : "Required"
            }
          ],
          async authorize(inputs) {
            const key = trimOptional(inputs?.apiKey);
            if (!key) {
              return { type: "failed" };
            }
            return {
              type: "success",
              provider: CODEX_AUTH_PROVIDER_ID,
              key
            };
          }
        },
        {
          provider: PROVIDER_ID,
          label: "Claude CLI",
          type: "api",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "Enter API key for Claude CLI",
              validate: (value) =>
                value && value.trim().length > 0 ? undefined : "Required"
            }
          ],
          async authorize(inputs) {
            const key = trimOptional(inputs?.apiKey);
            if (!key) {
              return { type: "failed" };
            }
            return {
              type: "success",
              provider: CLAUDE_AUTH_PROVIDER_ID,
              key
            };
          }
        },
        {
          provider: PROVIDER_ID,
          label: "Gemini CLI",
          type: "api",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "Enter API key for Gemini CLI",
              validate: (value) =>
                value && value.trim().length > 0 ? undefined : "Required"
            }
          ],
          async authorize(inputs) {
            const key = trimOptional(inputs?.apiKey);
            if (!key) {
              return { type: "failed" };
            }
            return {
              type: "success",
              provider: GEMINI_AUTH_PROVIDER_ID,
              key
            };
          }
        }
      ],
      async loader(getAuth, provider) {
        void getAuth;

        const options = provider?.options || {};
        const headers = options.headers || {};
        let baseURL = trimOptional(process.env.CLI_ACP_ROUTER_BASE_URL) || routerBaseUrl;
        const upstreamFetch = options.fetch || fetch;
        const authKeys = readCliAcpAuthKeys();
        const globalApiKey = trimOptional(process.env.CLI_ACP_API_KEY);
        const sdkApiKey = globalApiKey || NATIVE_AUTH_SENTINEL;
        const routerEnv = buildRouterEnv({
          pluginWorkdir,
          apiKey: globalApiKey,
          options,
          authKeys
        });

        return {
          ...options,
          setCacheKey: true,
          baseURL,
          headers: {
            ...headers,
            ...(pluginWorkdir ? { "x-cliacp-cwd": pluginWorkdir } : {})
          },
          apiKey: sdkApiKey,
          fetch: async (input, init) => {
            let patchedInit = init || {};
            let requestApiKey = globalApiKey;
            const url = getRequestUrl(input);
            let requestBody = parseJsonBody(patchedInit);
            let requestProvider = normalizeProviderForModel(requestBody?.model);
            const isWriteRequest = (() => {
              if (!url) {
                return false;
              }
              try {
                const parsed = new URL(url);
                return parsed.pathname.startsWith("/v1/") && parsed.pathname !== "/v1/models";
              } catch {
                return false;
              }
            })();
            if (isWriteRequest) {
              if (requestBody) {
                const patched = patchRequestBodyForCliAcp({
                  body: requestBody,
                  options,
                  authKeys,
                  mcpServers: configuredMcpServers
                });
                if (patched) {
                  requestProvider = patched.provider || requestProvider;
                  requestApiKey = patched.apiKey || requestApiKey;
                  requestBody = patched.body;
                  patchedInit = {
                    ...patchedInit,
                    body: JSON.stringify(patched.body)
                  };
                }
              }
            }
            if (autoStartRouter && isLocalBaseUrl(baseURL)) {
              const startupObserver = isWriteRequest
                ? createRouterStartupToastObserver({
                    client: bridgeClient,
                    provider: requestProvider,
                    delayMs: ROUTER_STARTUP_TOAST_DELAY_MS,
                    directory: bridgeDirectory
                  })
                : null;
              baseURL = await ensureRouterRunning({
                baseUrl: baseURL,
                apiKey: globalApiKey,
                routerEntry,
                extraEnv: routerEnv,
                startupObserver
              });
            }
            const requestHeaders = new Headers(patchedInit?.headers || {});
            if (sdkApiKey === NATIVE_AUTH_SENTINEL) {
              requestHeaders.delete("authorization");
              requestHeaders.delete("Authorization");
            }
            if (requestApiKey && !requestHeaders.has("x-api-key")) {
              requestHeaders.set("x-api-key", requestApiKey);
            }
            if (pluginWorkdir && !requestHeaders.has("x-cliacp-cwd")) {
              requestHeaders.set("x-cliacp-cwd", pluginWorkdir);
            }
            const response = await upstreamFetch(input, {
              ...patchedInit,
              headers: requestHeaders
            });
            if (isWriteRequest && isResponsesStreamRequest(url, requestBody)) {
              const sessionID = extractPromptCacheKey(requestBody);
              if (sessionID && response?.body) {
                observeBridgeStream({
                  response: response.clone(),
                  sessionID,
                  client: bridgeClient,
                  serverUrl: bridgeServerUrl,
                  directory: bridgeDirectory
                });
              }
            }
            return response;
          }
        };
      }
    }
  };
}

export default CliAcpAuthPlugin;
