import path from "node:path";
import os from "node:os";
import fs from "node:fs";

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
    process.env.COYES_GEMINI_BASE_URL || DEFAULT_COYES_GEMINI_BASE_URL
};

const DEFAULT_MODELS = {
  codex: process.env.CODEX_MODEL || "gpt-5-codex",
  claude: process.env.CLAUDE_MODEL || "sonnet",
  gemini: process.env.GEMINI_MODEL || "gemini-2.5-flash"
};

function toTomlStringLiteral(value) {
  return JSON.stringify(String(value));
}

function normalizeReasoningEffort(value) {
  if (typeof value !== "string") {
    return "";
  }
  const effort = value.trim().toLowerCase();
  return effort;
}

function writeGeminiSettingsForThinking({ model, reasoningEffort }) {
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (!effort) {
    return {
      geminiCliHome: "",
      cleanup: null
    };
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
    if (effort === "low" || effort === "medium" || effort === "high") {
      thinkingConfig = { thinkingLevel: effort.toUpperCase() };
    } else {
      throw new Error(
        `Unsupported reasoningEffort "${effort}" for ${model}. Use: low | medium | high.`
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

  const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-gemini-"));
  const geminiDir = path.join(geminiHome, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });

  const settingsPath = path.join(geminiDir, "settings.json");
  const settings = {
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

export function buildProviderRuntime(provider, apiKey, model, options = {}) {
  if (!apiKey) {
    throw new Error(
      "API key is required. Set COYES_API_KEY or pass apiKey in request body/header."
    );
  }

  const selectedModel = model || DEFAULT_MODELS[provider];

  if (provider === "claude") {
    const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
    const args = selectedModel ? ["--model", selectedModel] : [];
    if (reasoningEffort) {
      if (!["low", "medium", "high", "max"].includes(reasoningEffort)) {
        throw new Error(
          `Unsupported reasoningEffort "${reasoningEffort}" for Claude. Use: low | medium | high | max.`
        );
      }
      args.push("--effort", reasoningEffort);
    }

    return {
      model: selectedModel,
      command: process.platform === "win32" ? "claude-code-acp.cmd" : "claude-code-acp",
      args,
      env: {
        ANTHROPIC_BASE_URL: APP_CONFIG.coYesBaseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey
      }
    };
  }

  if (provider === "codex") {
    const reasoningEffort =
      typeof options.reasoningEffort === "string" && options.reasoningEffort.trim()
        ? options.reasoningEffort.trim().toLowerCase()
        : "";
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
      command: process.platform === "win32" ? "codex-acp.cmd" : "codex-acp",
      args,
      env: {
        OPENAI_API_KEY: apiKey,
        APIROUTER_API_KEY: apiKey
      }
    };
  }

  if (provider === "gemini") {
    const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
    const thinkingSetup = writeGeminiSettingsForThinking({
      model: selectedModel,
      reasoningEffort
    });

    return {
      model: selectedModel,
      command: process.platform === "win32" ? "gemini.cmd" : "gemini",
      args: ["--experimental-acp", "--model", selectedModel],
      env: {
        GOOGLE_GEMINI_BASE_URL: APP_CONFIG.coYesGeminiBaseUrl,
        GEMINI_API_KEY: apiKey,
        GOOGLE_API_KEY: apiKey,
        GEMINI_MODEL: selectedModel,
        GEMINI_DEFAULT_AUTH_TYPE: "gemini-api-key",
        ...(thinkingSetup.geminiCliHome
          ? { GEMINI_CLI_HOME: thinkingSetup.geminiCliHome }
          : {})
      },
      cleanup: thinkingSetup.cleanup
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

export function resolveApiKey(inputApiKey, headerApiKey) {
  return inputApiKey || headerApiKey || process.env.COYES_API_KEY || "";
}
