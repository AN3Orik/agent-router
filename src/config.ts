import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

const DEFAULT_COYES_BASE_URL = "https://co.yes.vg";
const DEFAULT_COYES_GEMINI_BASE_URL = "https://co.yes.vg/gemini";

export const APP_CONFIG = {
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 8787),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 180000),
  defaultCwd: path.resolve(process.env.DEFAULT_CWD || process.cwd()),
  includeStderrInResponse: (process.env.INCLUDE_STDERR_IN_RESPONSE || "0") === "1",
  coYesBaseUrl: process.env.COYES_BASE_URL || DEFAULT_COYES_BASE_URL,
  coYesGeminiBaseUrl:
    process.env.COYES_GEMINI_BASE_URL || DEFAULT_COYES_GEMINI_BASE_URL,
  acpPoolEnabled: (process.env.ACP_POOL_ENABLED || "1") !== "0",
  acpPoolMaxSize: Number(process.env.ACP_POOL_MAX_SIZE || 2),
  acpPoolMinSize: Number(process.env.ACP_POOL_MIN_SIZE || 0),
  acpPoolIdleTtlMs: Number(process.env.ACP_POOL_IDLE_TTL_MS || 300000),
  acpPoolStickyTtlMs: Number(process.env.ACP_POOL_STICKY_TTL_MS || 1800000),
  acpPoolAcquireTimeoutMs: Number(process.env.ACP_POOL_ACQUIRE_TIMEOUT_MS || 30000),
  acpPoolMaxQueue: Number(process.env.ACP_POOL_MAX_QUEUE || 256),
  acpPoolMaxRequestsPerWorker: Number(
    process.env.ACP_POOL_MAX_REQUESTS_PER_WORKER || 200
  ),
  acpPoolReaperIntervalMs: Number(process.env.ACP_POOL_REAPER_INTERVAL_MS || 10000),
  acpSessionMode: (process.env.ACP_SESSION_MODE || "stateless").toLowerCase()
};

const DEFAULT_MODELS = {
  codex: process.env.CODEX_MODEL || "gpt-5.3-codex",
  claude: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  gemini: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview"
};

type ProviderId = "codex" | "claude" | "gemini";

type RuntimeOptions = {
  reasoningEffort?: string;
};

export type ProviderRuntime = {
  model: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cleanup?: () => void;
};

export type ProviderRuntimePlan = {
  provider: ProviderId;
  model: string;
  reasoningEffort?: string;
  runtimeKey: string;
  createRuntime: () => ProviderRuntime;
};

function firstExistingFile(candidates: string[]): string {
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) {
      continue;
    }
    if (!path.isAbsolute(value)) {
      continue;
    }
    try {
      if (fs.existsSync(value) && fs.statSync(value).isFile()) {
        return value;
      }
    } catch {
      // Ignore lookup failures and continue.
    }
  }
  return "";
}

function uniqueNonEmpty(items: Array<string | undefined | null>): string[] {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function resolveWindowsCliCommand({
  baseNames,
  envOverrides = []
}: {
  baseNames: string[];
  envOverrides?: string[];
}): string {
  const preferred = uniqueNonEmpty([
    ...envOverrides.map((name) => process.env[name]),
    ...baseNames
  ]);

  const direct = firstExistingFile(preferred);
  if (direct) {
    return direct;
  }

  const nvmSymlink = String(process.env.NVM_SYMLINK || "").trim();
  const nvmHome = String(process.env.NVM_HOME || "").trim();
  const processDir = path.dirname(process.execPath || "");
  const nodeDirs = uniqueNonEmpty([
    nvmSymlink,
    nvmHome ? path.join(nvmHome, "nodejs") : "",
    processDir,
    "C:\\nvm4w\\nodejs",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : "",
    process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "nodejs")
      : ""
  ]);

  const filenames = uniqueNonEmpty(
    preferred.flatMap((name) => {
      const base = path.basename(name);
      const withCmd = base.toLowerCase().endsWith(".cmd") ? base : `${base}.cmd`;
      return [base, withCmd];
    })
  );

  const joinedCandidates = [];
  for (const dir of nodeDirs) {
    for (const filename of filenames) {
      joinedCandidates.push(path.join(dir, filename));
    }
  }

  const resolved = firstExistingFile(joinedCandidates);
  if (resolved) {
    return resolved;
  }

  // Last resort: rely on PATH lookup from the parent process.
  return preferred[0] || "";
}

function normalizeModelForProvider(provider: ProviderId, model: string): string {
  const raw = String(model || "").trim();
  if (!raw) {
    return raw;
  }

  if (provider !== "gemini") {
    return raw;
  }

  let next = raw;
  const lowerRaw = next.toLowerCase();
  if (lowerRaw.startsWith("google/")) {
    next = next.slice("google/".length);
  }

  const lower = next.toLowerCase();
  if (lower.startsWith("models/")) {
    next = next.slice("models/".length);
  }

  const geminiIndex = next.toLowerCase().indexOf("gemini-");
  if (geminiIndex > 0) {
    next = next.slice(geminiIndex);
  }

  return next.trim();
}

function toTomlStringLiteral(value: string): string {
  return JSON.stringify(String(value));
}

function normalizeReasoningEffort(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const effort = value.trim().toLowerCase();
  return effort;
}

function resolveGeminiThinkingConfig({
  model,
  reasoningEffort
}: {
  model: string;
  reasoningEffort?: string;
}) {
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (!effort) {
    return null;
  }

  const modelId = String(model || "").toLowerCase();
  if (!modelId.startsWith("gemini-")) {
    throw new Error(`Gemini reasoning is supported only for Gemini models. Got: ${model}`);
  }

  let thinkingConfig = null;

  if (modelId.includes("gemini-2.5")) {
    if (effort === "high") {
      thinkingConfig = { thinkingBudget: 16000 };
    } else if (effort === "max") {
      thinkingConfig = { thinkingBudget: 24576 };
    } else {
      throw new Error(
        `Unsupported reasoningEffort "${effort}" for ${model}. Use: high | max.`
      );
    }
  } else if (modelId.includes("gemini-3.1")) {
    const isProFamily = modelId.includes("pro");
    if (
      (isProFamily && (effort === "low" || effort === "high")) ||
      (!isProFamily && (effort === "low" || effort === "medium" || effort === "high"))
    ) {
      thinkingConfig = { thinkingLevel: effort.toUpperCase() };
    } else {
      const allowed = isProFamily ? "low | high" : "low | medium | high";
      throw new Error(
        `Unsupported reasoningEffort "${effort}" for ${model}. Use: ${allowed}.`
      );
    }
  } else if (modelId.includes("gemini-3")) {
    if (effort === "low" || effort === "high") {
      thinkingConfig = { thinkingLevel: effort.toUpperCase() };
    } else {
      throw new Error(
        `Unsupported reasoningEffort "${effort}" for ${model}. Use: low | high.`
      );
    }
  } else {
    throw new Error(`No Gemini reasoning profile is defined for model: ${model}`);
  }

  return thinkingConfig;
}

function writeGeminiCliSettings({
  model,
  reasoningEffort
}: {
  model: string;
  reasoningEffort?: string;
}) {
  const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-gemini-"));
  const geminiDir = path.join(geminiHome, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });

  const effort = normalizeReasoningEffort(reasoningEffort);
  const thinkingConfig = effort
    ? resolveGeminiThinkingConfig({
      model,
      reasoningEffort: effort
    })
    : null;

  const settingsPath = path.join(geminiDir, "settings.json");
  const settings = {
    security: {
      auth: {
        selectedType: "gemini-api-key"
      }
    },
    general: {
      previewFeatures: true
    },
    ...(thinkingConfig
      ? {
        modelConfigs: {
          customOverrides: [
            {
              match: { model },
              modelConfig: {
                generateContentConfig: {
                  thinkingConfig
                }
              }
            }
          ]
        }
      }
      : {})
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  return {
    geminiCliHome: geminiHome,
    cleanup: () => {
      try {
        fs.rmSync(geminiHome, { recursive: true, force: true });
      } catch {
        // Ignore best-effort cleanup failures.
      }
    }
  };
}

function normalizeApiKey(apiKey: string): string {
  if (!apiKey) {
    throw new Error(
      "API key is required. Set COYES_API_KEY or pass apiKey in request body/header."
    );
  }
  return String(apiKey);
}

export function getDefaultModel(provider) {
  return DEFAULT_MODELS[provider];
}

function normalizeCodexReasoningEffort(reasoningEffort: string): string {
  if (
    typeof reasoningEffort !== "string" ||
    !reasoningEffort.trim()
  ) {
    return "";
  }
  return reasoningEffort.trim().toLowerCase();
}

function validateReasoningEffort(
  provider: ProviderId,
  selectedModel: string,
  reasoningEffort?: string
): string {
  const normalized = normalizeReasoningEffort(reasoningEffort);
  if (!normalized) {
    return "";
  }

  if (provider === "claude") {
    if (!["low", "medium", "high", "max"].includes(normalized)) {
      throw new Error(
        `Unsupported reasoningEffort "${normalized}" for Claude. Use: low | medium | high | max.`
      );
    }
    return normalized;
  }

  if (provider === "gemini") {
    resolveGeminiThinkingConfig({
      model: selectedModel,
      reasoningEffort: normalized
    });
    return normalized;
  }

  if (provider === "codex") {
    return normalizeCodexReasoningEffort(normalized);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

export function resolveProviderRuntimePlan(
  provider: ProviderId,
  apiKey: string,
  model: string,
  options: RuntimeOptions = {}
): ProviderRuntimePlan {
  const normalizedApiKey = normalizeApiKey(apiKey);
  const selectedModel = normalizeModelForProvider(
    provider,
    model || DEFAULT_MODELS[provider]
  );
  if (!selectedModel) {
    throw new Error(`No default model is configured for provider: ${provider}`);
  }
  const reasoningEffort = validateReasoningEffort(
    provider,
    selectedModel,
    options.reasoningEffort
  );
  const keySeed = [
    provider,
    selectedModel,
    reasoningEffort || "-",
    crypto
      .createHash("sha256")
      .update(normalizedApiKey)
      .digest("hex")
      .slice(0, 16)
  ].join("|");

  return {
    provider,
    model: selectedModel,
    reasoningEffort: reasoningEffort || undefined,
    runtimeKey: keySeed,
    createRuntime: () =>
      buildProviderRuntime(provider, normalizedApiKey, selectedModel, {
        reasoningEffort
      })
  };
}

export function buildProviderRuntime(
  provider: ProviderId,
  apiKey: string,
  model: string,
  options: RuntimeOptions = {}
): ProviderRuntime {
  normalizeApiKey(apiKey);
  const selectedModel = normalizeModelForProvider(
    provider,
    model || DEFAULT_MODELS[provider]
  );
  if (!selectedModel) {
    throw new Error(`No default model is configured for provider: ${provider}`);
  }

  if (provider === "claude") {
    const reasoningEffort = validateReasoningEffort(
      provider,
      selectedModel,
      options.reasoningEffort
    );
    const command =
      process.platform === "win32"
        ? resolveWindowsCliCommand({
          baseNames: ["claude-code-acp.cmd", "claude-code-acp"],
          envOverrides: ["YESCODE_CLAUDE_ACP_PATH", "CLAUDE_CODE_ACP_PATH"]
        })
        : "claude-code-acp";
    const args = selectedModel ? ["--model", selectedModel] : [];
    if (reasoningEffort) {
      args.push("--effort", reasoningEffort);
    }

    return {
      model: selectedModel,
      command,
      args,
      env: {
        ANTHROPIC_BASE_URL: APP_CONFIG.coYesBaseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_USER_AGENT: "agent-router/0.1.0 (yescode-router)"
      }
    };
  }

  if (provider === "codex") {
    const reasoningEffort = validateReasoningEffort(
      provider,
      selectedModel,
      options.reasoningEffort
    );
    const command =
      process.platform === "win32"
        ? resolveWindowsCliCommand({
          baseNames: ["codex-acp.cmd", "codex-acp"],
          envOverrides: ["YESCODE_CODEX_ACP_PATH", "CODEX_ACP_PATH"]
        })
        : "codex-acp";
    const args = [
      "-c",
      'model_provider="apirouter"',
      "-c",
      `model=${toTomlStringLiteral(selectedModel)}`,
      "-c",
      'model_providers.apirouter.name="apirouter"',
      "-c",
      `model_providers.apirouter.base_url="${APP_CONFIG.coYesBaseUrl}/v1"`,
      "-c",
      'model_providers.apirouter.wire_api="responses"',
      "-c",
      "model_providers.apirouter.requires_openai_auth=true",
      "-c",
      'model_providers.apirouter.env_key="APIROUTER_API_KEY"'
    ];
    if (reasoningEffort) {
      args.push("-c", `model_reasoning_effort=${toTomlStringLiteral(reasoningEffort)}`);
    }

    return {
      model: selectedModel,
      command,
      args,
      env: {
        OPENAI_API_KEY: apiKey,
        APIROUTER_API_KEY: apiKey,
        HTTP_USER_AGENT: "agent-router/0.1.0 yescode-router"
      }
    };
  }

  if (provider === "gemini") {
    const reasoningEffort = validateReasoningEffort(
      provider,
      selectedModel,
      options.reasoningEffort
    );
    const command =
      process.platform === "win32"
        ? resolveWindowsCliCommand({
          baseNames: ["gemini.cmd", "gemini"],
          envOverrides: ["YESCODE_GEMINI_CLI_PATH", "GEMINI_CLI_PATH"]
        })
        : "gemini";
    const geminiSetup = writeGeminiCliSettings({
      model: selectedModel,
      reasoningEffort
    });

    return {
      model: selectedModel,
      command,
      args: ["--experimental-acp", "--model", selectedModel],
      env: {
        GOOGLE_GEMINI_BASE_URL: APP_CONFIG.coYesGeminiBaseUrl,
        GEMINI_API_KEY: apiKey,
        GOOGLE_API_KEY: apiKey,
        GEMINI_MODEL: selectedModel,
        GEMINI_DEFAULT_AUTH_TYPE: "gemini-api-key",
        GEMINI_CLI_HOME: geminiSetup.geminiCliHome,
        HTTP_USER_AGENT: "agent-router/0.1.0 yescode-router"
      },
      cleanup: geminiSetup.cleanup
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

export function resolveApiKey(inputApiKey?: string, headerApiKey?: string): string {
  return inputApiKey || headerApiKey || process.env.COYES_API_KEY || "";
}
