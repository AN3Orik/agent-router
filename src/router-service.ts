import path from "node:path";
import { AcpProcess } from "./acp-process.js";
import {
  APP_CONFIG,
  buildProviderRuntime,
  resolveProviderRuntimePlan
} from "./config.js";
import { AcpWorkerPool } from "./acp-worker-pool.js";

const VALID_PROVIDERS = new Set(["yescode", "codex", "claude", "gemini"]);
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

if (WORKER_POOL) {
  const closePool = () => {
    void WORKER_POOL.close();
  };
  process.once("SIGINT", closePool);
  process.once("SIGTERM", closePool);
  process.once("exit", closePool);
}

function resolveYescodeProvider(model: string | undefined) {
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

function normalizeProvider(value: unknown): "yescode" | "codex" | "claude" | "gemini" {
  const provider = String(value || "").trim().toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(
      `Unsupported provider "${value}". Use: yescode | codex | claude | gemini.`
    );
  }
  return provider as "yescode" | "codex" | "claude" | "gemini";
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

function normalizeRequest({
  provider: rawProvider,
  message: rawMessage,
  model: rawModel,
  cwd: rawCwd,
  timeoutMs: rawTimeoutMs,
  permissionMode: rawPermissionMode,
  reasoningEffort: rawReasoningEffort,
  sessionMode: rawSessionMode,
  routerSessionId: rawRouterSessionId,
  stickySessionId: rawStickySessionId,
  releaseSession: rawReleaseSession
}: any) {
  const provider = normalizeProvider(rawProvider);
  const message = normalizeMessage(rawMessage);
  const model = normalizeModel(rawModel);
  const effectiveProvider =
    provider === "yescode" ? resolveYescodeProvider(model) : provider;
  const cwd = normalizeCwd(rawCwd);
  const timeoutMs = normalizeTimeout(rawTimeoutMs);
  const permissionMode = normalizePermissionMode(rawPermissionMode);
  const reasoningEffort = normalizeReasoningEffort(rawReasoningEffort);
  const routerSessionId =
    normalizeRouterSessionId(rawRouterSessionId) ||
    normalizeRouterSessionId(rawStickySessionId);
  const sessionMode = normalizeSessionMode(rawSessionMode, Boolean(routerSessionId));
  if (routerSessionId && sessionMode !== "sticky") {
    throw new Error("routerSessionId can be used only with sessionMode=sticky.");
  }
  const releaseSession = normalizeBoolean(rawReleaseSession);

  return {
    provider: effectiveProvider,
    requestedProvider: provider,
    model,
    reasoningEffort,
    message,
    cwd,
    timeoutMs,
    permissionMode,
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
  init,
  message,
  cwd,
  timeoutMs,
  permissionMode,
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
      const session = await withAbort(runner.newSession(cwd), signal);
      sessionId = session.sessionId;
      onEvent?.({ type: "session", sessionId, reused: false });
    } else {
      onEvent?.({ type: "session", sessionId, reused: true });
    }

    onEvent?.({ type: "status", stage: "prompting" });
    const promptResult = await withAbort(
      runner.prompt(message, timeoutMs, sessionId),
      signal
    );

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
  includeEvents,
  apiKey,
  reasoningEffort,
  onEvent,
  signal
}: any) {
  const runtimeConfig = buildProviderRuntime(provider, apiKey, model, {
    reasoningEffort
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
      init: null,
      message,
      cwd,
      timeoutMs,
      permissionMode,
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
  includeEvents,
  apiKey,
  reasoningEffort,
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
    reasoningEffort
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
      init: worker.init,
      message,
      cwd,
      timeoutMs,
      permissionMode,
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
  includeEvents,
  apiKey,
  reasoningEffort,
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
      includeEvents,
      apiKey,
      reasoningEffort,
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
      includeEvents,
      apiKey,
      reasoningEffort,
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
  return ["yescode", "codex", "claude", "gemini"];
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
