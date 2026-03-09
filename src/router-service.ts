import path from "node:path";
import {
  AcpProcess,
  type AcpMcpServer,
  type AcpNameValue
} from "./acp-process.js";
import {
  APP_CONFIG,
  buildProviderRuntime,
  resolveProviderRuntimePlan
} from "./config.js";
import { AcpWorkerPool } from "./acp-worker-pool.js";

const VALID_PROVIDERS = new Set(["cliacp", "codex", "claude", "gemini"]);
const VALID_PERMISSION_MODES = new Set(["allow", "reject"]);
const VALID_SESSION_MODES = new Set(["stateless", "sticky"]);
const VALID_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);
const VALID_REASONING_SUMMARIES = new Set([
  "auto",
  "concise",
  "detailed",
  "none"
]);

const WORKER_POOL = APP_CONFIG.acpPoolEnabled
  ? new AcpWorkerPool({
      maxSize: APP_CONFIG.acpPoolMaxSize,
      minSize: APP_CONFIG.acpPoolMinSize,
      idleTtlMs: APP_CONFIG.acpPoolIdleTtlMs,
      stickyTtlMs: APP_CONFIG.acpPoolStickyTtlMs,
      acquireTimeoutMs: APP_CONFIG.acpPoolAcquireTimeoutMs,
      maxQueue: APP_CONFIG.acpPoolMaxQueue,
      maxRequestsPerWorker: APP_CONFIG.acpPoolMaxRequestsPerWorker,
      reaperIntervalMs: APP_CONFIG.acpPoolReaperIntervalMs
    })
  : null;

let poolClosePromise: Promise<void> | null = null;

async function closeWorkerPool(): Promise<void> {
  if (!WORKER_POOL) {
    return;
  }
  if (!poolClosePromise) {
    poolClosePromise = WORKER_POOL.close();
  }
  await poolClosePromise;
}

const closePoolOnSignal = () => {
  void closeWorkerPool();
};

if (WORKER_POOL) {
  process.once("SIGINT", closePoolOnSignal);
  process.once("SIGTERM", closePoolOnSignal);
  process.once("exit", closePoolOnSignal);
}

function resolveCliAcpProvider(model: string | undefined) {
  const id = String(model || "").toLowerCase();
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

function normalizeProvider(value: unknown): "cliacp" | "codex" | "claude" | "gemini" {
  const provider = String(value || "").trim().toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(
      `Unsupported provider "${value}". Use: cliacp | codex | claude | gemini.`
    );
  }
  return provider as "cliacp" | "codex" | "claude" | "gemini";
}

function normalizeMessage(value: unknown): string | any[] {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (Array.isArray(value) && value.length > 0) {
    return value;
  }

  throw new Error("message is required and must be a non-empty string or ACP content array.");
}

function normalizeCwd(value: unknown): string {
  if (!value) {
    return APP_CONFIG.defaultCwd;
  }
  return path.resolve(String(value));
}

function normalizePermissionMode(value: unknown): "allow" | "reject" {
  const mode = String(value || "allow").toLowerCase();
  if (!VALID_PERMISSION_MODES.has(mode)) {
    throw new Error('permissionMode must be "allow" or "reject".');
  }
  return mode as "allow" | "reject";
}

function normalizeModel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const model = String(value).trim();
  if (!model) {
    return undefined;
  }
  if (model.length > 200) {
    throw new Error("model must be shorter than 200 characters.");
  }
  return model;
}

function normalizeBaseUrl(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const url = String(value).trim();
  if (!url) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${fieldName} must be a valid absolute URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http or https protocol.`);
  }
  return url;
}

function normalizeTimeout(value: unknown): number {
  if (value === undefined || value === null) {
    return APP_CONFIG.requestTimeoutMs;
  }
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("timeoutMs must be between 1 and 3600000.");
  }
  return timeoutMs;
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const effort = String(value).trim().toLowerCase();
  if (!effort) {
    return undefined;
  }
  if (!VALID_REASONING_EFFORTS.has(effort)) {
    throw new Error(
      `Unsupported reasoningEffort "${value}". Use: ${[...VALID_REASONING_EFFORTS].join(" | ")}.`
    );
  }
  return effort;
}

function normalizeReasoningSummary(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const summary = String(value).trim().toLowerCase();
  if (!summary) {
    return undefined;
  }
  if (!VALID_REASONING_SUMMARIES.has(summary)) {
    throw new Error(
      `Unsupported reasoningSummary "${value}". Use: ${[...VALID_REASONING_SUMMARIES].join(" | ")}.`
    );
  }
  return summary;
}

function normalizeSessionMode(value: unknown, hasSessionId: boolean): "stateless" | "sticky" {
  const defaultMode = hasSessionId ? "sticky" : APP_CONFIG.acpSessionMode;
  const mode = String(value || defaultMode || "stateless")
    .trim()
    .toLowerCase();
  if (!VALID_SESSION_MODES.has(mode)) {
    throw new Error('sessionMode must be "stateless" or "sticky".');
  }
  return mode as "stateless" | "sticky";
}

function normalizeRouterSessionId(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const sessionId = String(value).trim();
  if (!sessionId) {
    return "";
  }
  if (sessionId.length > 200) {
    throw new Error("routerSessionId must be shorter than 200 characters.");
  }
  return sessionId;
}

function normalizeBoolean(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const text = String(value).trim().toLowerCase();
  if (!text) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(text)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string.`);
    }
    result.push(item.trim());
  }
  return result;
}

function normalizeNameValuePairs(value: unknown, fieldName: string): AcpNameValue[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of {name,value} objects.`);
  }

  const result: AcpNameValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${fieldName}[${index}] must be an object.`);
    }
    const name = String((entry as Record<string, unknown>).name || "").trim();
    const rawValue = (entry as Record<string, unknown>).value;
    if (!name) {
      throw new Error(`${fieldName}[${index}].name is required.`);
    }
    if (rawValue === undefined || rawValue === null) {
      throw new Error(`${fieldName}[${index}].value is required.`);
    }
    result.push({
      name,
      value: String(rawValue)
    });
  }
  return result;
}

function normalizeMcpServers(value: unknown): AcpMcpServer[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("mcpServers must be an array.");
  }

  const result: AcpMcpServer[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`mcpServers[${index}] must be an object.`);
    }
    const raw = entry as Record<string, unknown>;
    const name = String(raw.name || "").trim();
    if (!name) {
      throw new Error(`mcpServers[${index}].name is required.`);
    }

    if (Object.prototype.hasOwnProperty.call(raw, "type")) {
      const inputType = String(raw.type || "").trim().toLowerCase();
      const type = inputType === "remote" ? "http" : inputType;
      const url = String(raw.url || "").trim();
      if (!type) {
        throw new Error(`mcpServers[${index}].type is required for remote MCP server.`);
      }
      if (!url) {
        throw new Error(`mcpServers[${index}].url is required for remote MCP server.`);
      }
      const headers = normalizeNameValuePairs(
        raw.headers,
        `mcpServers[${index}].headers`
      );
      const remote: AcpMcpServer = {
        name,
        type,
        url,
        headers
      }
      result.push(remote);
      continue;
    }

    const command = String(raw.command || "").trim();
    if (!command) {
      throw new Error(`mcpServers[${index}].command is required for local MCP server.`);
    }
    const args = normalizeStringArray(raw.args, `mcpServers[${index}].args`);
    const env = normalizeNameValuePairs(raw.env, `mcpServers[${index}].env`);
    const local: AcpMcpServer = {
      name,
      command,
      args,
      env
    }
    result.push(local);
  }

  return result;
}

function normalizeRequest({
  provider: rawProvider,
  message: rawMessage,
  model: rawModel,
  cwd: rawCwd,
  timeoutMs: rawTimeoutMs,
  permissionMode: rawPermissionMode,
  reasoningEffort: rawReasoningEffort,
  reasoningSummary: rawReasoningSummary,
  sessionMode: rawSessionMode,
  routerSessionId: rawRouterSessionId,
  releaseSession: rawReleaseSession,
  baseUrl: rawBaseUrl,
  geminiBaseUrl: rawGeminiBaseUrl,
  mcpServers: rawMcpServers
}: any) {
  const provider = normalizeProvider(rawProvider);
  const message = normalizeMessage(rawMessage);
  const model = normalizeModel(rawModel);
  const effectiveProvider =
    provider === "cliacp" ? resolveCliAcpProvider(model) : provider;
  const cwd = normalizeCwd(rawCwd);
  const timeoutMs = normalizeTimeout(rawTimeoutMs);
  const permissionMode = normalizePermissionMode(rawPermissionMode);
  const reasoningEffort = normalizeReasoningEffort(rawReasoningEffort);
  const reasoningSummary = normalizeReasoningSummary(rawReasoningSummary);
  const baseUrl = normalizeBaseUrl(rawBaseUrl, "baseUrl");
  const geminiBaseUrl = normalizeBaseUrl(rawGeminiBaseUrl, "geminiBaseUrl");
  const routerSessionId = normalizeRouterSessionId(rawRouterSessionId);
  const sessionMode = normalizeSessionMode(rawSessionMode, Boolean(routerSessionId));
  const mcpServers = normalizeMcpServers(rawMcpServers);
  if (routerSessionId && sessionMode !== "sticky") {
    throw new Error("routerSessionId can be used only with sessionMode=sticky.");
  }
  const releaseSession = normalizeBoolean(rawReleaseSession);

  return {
    provider: effectiveProvider,
    requestedProvider: provider,
    model,
    reasoningEffort,
    reasoningSummary,
    baseUrl,
    geminiBaseUrl,
    message,
    cwd,
    timeoutMs,
    permissionMode,
    mcpServers,
    sessionMode,
    routerSessionId,
    releaseSession
  };
}

function withAbort(promise: Promise<any>, signal?: AbortSignal): Promise<any> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(new Error("Request aborted by client."));
  }
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Request aborted by client.")),
        { once: true }
      );
    })
  ]);
}

function asErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return fallback;
}

function bindRunnerEvents(runner: any, onEvent?: ((event: any) => void) | null) {
  runner.resetCapturedOutput();
  runner.setUpdateHandler((update) => {
    onEvent?.({ type: "update", update });
    const sessionUpdate = String(update?.sessionUpdate || "").toLowerCase();
    const contentType = String(update?.content?.type || "").toLowerCase();

    const isThinkingChunk =
      contentType === "text" &&
      (sessionUpdate === "agent_thought_chunk" ||
        sessionUpdate === "agent_reasoning_chunk" ||
        sessionUpdate.includes("thought") ||
        sessionUpdate.includes("reasoning"));

    if (isThinkingChunk) {
      onEvent?.({
        type: "reasoning_token",
        text: update.content.text || ""
      });
      return;
    }

    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text"
    ) {
      onEvent?.({
        type: "token",
        text: update.content.text || ""
      });
    }
  });
}

async function executePromptOnRunner({
  runner,
  provider,
  init,
  message,
  cwd,
  timeoutMs,
  permissionMode,
  mcpServers,
  existingSessionId,
  onEvent,
  signal
}: any) {
  const startedAt = Date.now();
  let initInfo = init || null;

  runner.setPermissionMode(permissionMode);
  bindRunnerEvents(runner, onEvent);

  let abortError = null;
  const handleAbort = () => {
    abortError = new Error("Request aborted by client.");
  };
  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    if (!initInfo) {
      onEvent?.({ type: "status", stage: "starting" });
      await withAbort(runner.start(), signal);
      onEvent?.({ type: "status", stage: "initializing" });
      initInfo = await withAbort(runner.initialize(), signal);
    }

    onEvent?.({
      type: "initialized",
      protocolVersion: initInfo.protocolVersion,
      agentInfo: initInfo.agentInfo || null
    });

    let sessionId = existingSessionId;
    if (!sessionId) {
      onEvent?.({ type: "status", stage: "creating_session" });
      const session = await withAbort(
        runner.newSession(cwd, mcpServers || []),
        signal
      );
      sessionId = session.sessionId;
      onEvent?.({ type: "session", sessionId, reused: false });
    } else {
      onEvent?.({ type: "session", sessionId, reused: true });
    }

    onEvent?.({ type: "status", stage: "prompting" });
    if (provider === "gemini") {
      // Gemini ACP can still flush turn-bound updates right around prompt boundaries.
      // Waiting for short quiescence reduces malformed tool-call terminations on follow-up turns.
      await withAbort(
        runner.waitForSessionQuiescence({
          quietMs: 300,
          maxWaitMs: 2000
        }),
        signal
      );
    }
    const promptResult = await withAbort(
      runner.prompt(message, timeoutMs, sessionId),
      signal
    );
    if (provider === "gemini") {
      // Ensure the stream is fully settled before the next turn starts on sticky sessions.
      await withAbort(
        runner.waitForSessionQuiescence({
          quietMs: 300,
          maxWaitMs: 2000
        }),
        signal
      );
    }

    const elapsedMs = Date.now() - startedAt;
    const outputText = runner.textOutput.trim();
    onEvent?.({
      type: "completed",
      stopReason: promptResult.stopReason || "unknown",
      elapsedMs
    });

    return {
      sessionId,
      protocolVersion: initInfo.protocolVersion,
      stopReason: promptResult.stopReason || "unknown",
      outputText,
      elapsedMs,
      updates: runner.updates,
      stderr: runner.stderr
    };
  } catch (err) {
    if (abortError) {
      throw abortError;
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    runner.setUpdateHandler(null);
  }
}

async function runEphemeral({
  provider,
  requestedProvider,
  model,
  message,
  cwd,
  timeoutMs,
  permissionMode,
  mcpServers,
  includeEvents,
  apiKey,
  reasoningEffort,
  reasoningSummary,
  baseUrl,
  geminiBaseUrl,
  onEvent,
  signal
}: any) {
  const runtimeConfig = buildProviderRuntime(provider, apiKey, model, {
    reasoningEffort,
    reasoningSummary,
    baseUrl,
    geminiBaseUrl
  });
  const runner = new AcpProcess({
    ...runtimeConfig,
    cwd,
    permissionMode,
    onUpdate: null
  });

  let execution;
  try {
    execution = await executePromptOnRunner({
      runner,
      provider,
      init: null,
      message,
      cwd,
      timeoutMs,
      permissionMode,
      mcpServers,
      existingSessionId: "",
      onEvent,
      signal
    });
  } finally {
    await runner.close();
    if (typeof runtimeConfig.cleanup === "function") {
      try {
        runtimeConfig.cleanup();
      } catch {
        // Ignore cleanup failures.
      }
    }
  }

  return {
    provider: requestedProvider || provider,
    routedProvider: provider,
    model: runtimeConfig.model || model || null,
    sessionId: execution.sessionId,
    protocolVersion: execution.protocolVersion,
    stopReason: execution.stopReason,
    outputText: execution.outputText,
    elapsedMs: execution.elapsedMs,
    updates: includeEvents ? execution.updates : undefined,
    stderr:
      APP_CONFIG.includeStderrInResponse && execution.stderr
        ? execution.stderr.trim()
        : undefined,
    pooled: false
  };
}

async function runPooled({
  provider,
  requestedProvider,
  model,
  message,
  cwd,
  timeoutMs,
  permissionMode,
  mcpServers,
  includeEvents,
  apiKey,
  reasoningEffort,
  reasoningSummary,
  baseUrl,
  geminiBaseUrl,
  onEvent,
  signal,
  sessionMode,
  routerSessionId,
  releaseSession
}: any) {
  if (!WORKER_POOL) {
    throw new Error("ACP worker pool is disabled.");
  }

  const plan = resolveProviderRuntimePlan(provider, apiKey, model, {
    reasoningEffort,
    reasoningSummary,
    baseUrl,
    geminiBaseUrl
  });

  let stickySession = null;
  if (routerSessionId) {
    stickySession = WORKER_POOL.getStickySession(routerSessionId);
    if (!stickySession) {
      throw new Error(`routerSessionId is not active: ${routerSessionId}`);
    }
    if (stickySession.runtimeKey !== plan.runtimeKey) {
      throw new Error(
        `routerSessionId ${routerSessionId} belongs to a different provider/model.`
      );
    }
  }

  if (sessionMode !== "stateless" && sessionMode !== "sticky") {
    throw new Error('sessionMode must be "stateless" or "sticky".');
  }

  if (releaseSession && sessionMode !== "sticky") {
    throw new Error("releaseSession can be used only with sessionMode=sticky.");
  }

  const acquire = await WORKER_POOL.acquire({
    runtimeKey: plan.runtimeKey,
    createRuntime: plan.createRuntime,
    preferredWorkerId: stickySession?.workerId || "",
    signal,
    waitTimeoutMs: Math.min(timeoutMs, APP_CONFIG.acpPoolAcquireTimeoutMs)
  });

  const worker = acquire.worker;
  onEvent?.({
    type: "pool",
    stage: "acquired",
    workerId: worker.id,
    queuedMs: acquire.queuedMs,
    createdWorker: acquire.createdWorker,
    sticky: sessionMode === "sticky"
  });

  let shouldDestroyWorker = false;
  let execution = null;
  let resolvedStickySession = stickySession;

  const handleAbort = () => {
    shouldDestroyWorker = true;
  };
  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    execution = await executePromptOnRunner({
      runner: worker.runner,
      provider,
      init: worker.init,
      message,
      cwd,
      timeoutMs,
      permissionMode,
      mcpServers,
      existingSessionId: resolvedStickySession?.acpSessionId || "",
      onEvent,
      signal
    });

    if (sessionMode === "sticky") {
      if (!resolvedStickySession) {
        resolvedStickySession = WORKER_POOL.createStickySession({
          runtimeKey: plan.runtimeKey,
          workerId: worker.id,
          acpSessionId: execution.sessionId
        });
      } else {
        resolvedStickySession = WORKER_POOL.updateStickySession(
          resolvedStickySession.routerSessionId,
          { acpSessionId: execution.sessionId }
        );
      }

      if (releaseSession && resolvedStickySession) {
        WORKER_POOL.deleteStickySession(resolvedStickySession.routerSessionId);
      }
    } else if (routerSessionId) {
      WORKER_POOL.deleteStickySession(routerSessionId);
    }
  } catch (err) {
    shouldDestroyWorker = true;
    throw err;
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    await WORKER_POOL.release(worker, {
      destroy: shouldDestroyWorker
    });
  }

  return {
    provider: requestedProvider || provider,
    routedProvider: provider,
    model: plan.model || model || null,
    sessionId: execution.sessionId,
    routerSessionId:
      sessionMode === "sticky" && !releaseSession
        ? resolvedStickySession?.routerSessionId || ""
        : undefined,
    protocolVersion: execution.protocolVersion,
    stopReason: execution.stopReason,
    outputText: execution.outputText,
    elapsedMs: execution.elapsedMs,
    updates: includeEvents ? execution.updates : undefined,
    stderr:
      APP_CONFIG.includeStderrInResponse && execution.stderr
        ? execution.stderr.trim()
        : undefined,
    pooled: true,
    workerId: worker.id,
    queuedMs: acquire.queuedMs,
    createdWorker: acquire.createdWorker
  };
}

async function runInternal({
  provider,
  requestedProvider,
  model,
  message,
  cwd,
  timeoutMs,
  permissionMode,
  mcpServers,
  includeEvents,
  apiKey,
  reasoningEffort,
  reasoningSummary,
  baseUrl,
  geminiBaseUrl,
  onEvent,
  signal,
  sessionMode,
  routerSessionId,
  releaseSession
}: any) {
  if (!APP_CONFIG.acpPoolEnabled) {
    if (sessionMode === "sticky") {
      throw new Error("Sticky sessions require ACP_POOL_ENABLED=1.");
    }
    return runEphemeral({
      provider,
      requestedProvider,
      model,
      message,
      cwd,
      timeoutMs,
      permissionMode,
      mcpServers,
      includeEvents,
      apiKey,
      reasoningEffort,
      reasoningSummary,
      baseUrl,
      geminiBaseUrl,
      onEvent,
      signal
    });
  }

  try {
    return await runPooled({
      provider,
      requestedProvider,
      model,
      message,
      cwd,
      timeoutMs,
      permissionMode,
      mcpServers,
      includeEvents,
      apiKey,
      reasoningEffort,
      reasoningSummary,
      baseUrl,
      geminiBaseUrl,
      onEvent,
      signal,
      sessionMode,
      routerSessionId,
      releaseSession
    });
  } catch (err) {
    throw new Error(asErrorMessage(err, "Failed to run ACP prompt."));
  }
}

export async function runProviderPrompt({
  includeEvents = false,
  apiKey,
  ...raw
}: any) {
  const normalized = normalizeRequest(raw);
  return runInternal({
    ...normalized,
    includeEvents,
    apiKey
  });
}

export async function runProviderPromptStream({
  includeEvents = true,
  apiKey,
  signal,
  onEvent,
  ...raw
}: any) {
  const normalized = normalizeRequest(raw);
  return runInternal({
    ...normalized,
    includeEvents,
    apiKey,
    signal,
    onEvent
  });
}

export function listProviders() {
  return ["cliacp", "codex", "claude", "gemini"];
}

export function getRouterRuntimeStats() {
  return {
    pool: WORKER_POOL
      ? WORKER_POOL.getStats()
      : {
          enabled: false
        }
  };
}

export async function shutdownRouterRuntime(): Promise<void> {
  if (!WORKER_POOL) {
    return;
  }
  process.removeListener("SIGINT", closePoolOnSignal);
  process.removeListener("SIGTERM", closePoolOnSignal);
  process.removeListener("exit", closePoolOnSignal);
  await closeWorkerPool();
}
