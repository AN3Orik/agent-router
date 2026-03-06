import path from "node:path";
import { AcpProcess } from "./acp-process.js";
import { APP_CONFIG, buildProviderRuntime } from "./config.js";

const VALID_PROVIDERS = new Set(["yescode", "codex", "claude", "gemini"]);
const VALID_PERMISSION_MODES = new Set(["allow", "reject"]);
const VALID_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

function resolveYescodeProvider(model) {
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

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(
      `Unsupported provider "${value}". Use: yescode | codex | claude | gemini.`
    );
  }
  return provider;
}

function normalizeMessage(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("message is required and must be a non-empty string.");
  }
  return value;
}

function normalizeCwd(value) {
  if (!value) {
    return APP_CONFIG.defaultCwd;
  }
  return path.resolve(String(value));
}

function normalizePermissionMode(value) {
  const mode = String(value || "allow").toLowerCase();
  if (!VALID_PERMISSION_MODES.has(mode)) {
    throw new Error('permissionMode must be "allow" or "reject".');
  }
  return mode;
}

function normalizeModel(value) {
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

function normalizeTimeout(value) {
  if (value === undefined || value === null) {
    return APP_CONFIG.requestTimeoutMs;
  }
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("timeoutMs must be between 1 and 3600000.");
  }
  return timeoutMs;
}

function normalizeReasoningEffort(value) {
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

function normalizeRequest({
  provider: rawProvider,
  message: rawMessage,
  model: rawModel,
  cwd: rawCwd,
  timeoutMs: rawTimeoutMs,
  permissionMode: rawPermissionMode,
  reasoningEffort: rawReasoningEffort
}) {
  const provider = normalizeProvider(rawProvider);
  const message = normalizeMessage(rawMessage);
  const model = normalizeModel(rawModel);
  const effectiveProvider =
    provider === "yescode" ? resolveYescodeProvider(model) : provider;
  const cwd = normalizeCwd(rawCwd);
  const timeoutMs = normalizeTimeout(rawTimeoutMs);
  const permissionMode = normalizePermissionMode(rawPermissionMode);
  const reasoningEffort = normalizeReasoningEffort(rawReasoningEffort);
  return {
    provider: effectiveProvider,
    requestedProvider: provider,
    model,
    reasoningEffort,
    message,
    cwd,
    timeoutMs,
    permissionMode
  };
}

function withAbort(promise, signal) {
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
  signal
}) {
  const runtimeConfig = buildProviderRuntime(provider, apiKey, model, {
    reasoningEffort
  });
  const runner = new AcpProcess({
    ...runtimeConfig,
    cwd,
    permissionMode,
    onUpdate: (update) => {
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
    }
  });

  const startedAt = Date.now();
  const handleAbort = () => {
    void runner.close();
  };
  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    onEvent?.({ type: "status", stage: "starting" });
    await withAbort(runner.start(), signal);
    onEvent?.({ type: "status", stage: "initializing" });
    const init = await withAbort(runner.initialize(), signal);
    onEvent?.({
      type: "initialized",
      protocolVersion: init.protocolVersion,
      agentInfo: init.agentInfo || null
    });
    onEvent?.({ type: "status", stage: "creating_session" });
    const session = await withAbort(runner.newSession(cwd), signal);
    onEvent?.({ type: "session", sessionId: session.sessionId });
    onEvent?.({ type: "status", stage: "prompting" });
    const promptResult = await withAbort(runner.prompt(message, timeoutMs), signal);
    const elapsedMs = Date.now() - startedAt;
    const result = {
      provider: requestedProvider || provider,
      routedProvider: provider,
      model: runtimeConfig.model || model || null,
      sessionId: session.sessionId,
      protocolVersion: init.protocolVersion,
      stopReason: promptResult.stopReason || "unknown",
      outputText: runner.textOutput.trim(),
      elapsedMs,
      updates: includeEvents ? runner.updates : undefined,
      stderr:
        APP_CONFIG.includeStderrInResponse && runner.stderr
          ? runner.stderr.trim()
          : undefined
    };

    onEvent?.({
      type: "completed",
      stopReason: result.stopReason,
      elapsedMs: result.elapsedMs
    });
    return result;
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    await runner.close();
    if (typeof runtimeConfig.cleanup === "function") {
      try {
        runtimeConfig.cleanup();
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}

export async function runProviderPrompt({
  includeEvents = false,
  apiKey,
  ...raw
}) {
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
}) {
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
