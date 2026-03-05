import path from "node:path";

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

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export function buildProviderRuntime(provider, apiKey) {
  if (!apiKey) {
    throw new Error(
      "API key is required. Set COYES_API_KEY or pass apiKey in request body/header."
    );
  }

  if (provider === "claude") {
    return {
      command: process.platform === "win32" ? "claude-code-acp.cmd" : "claude-code-acp",
      args: [],
      env: {
        ANTHROPIC_BASE_URL: APP_CONFIG.coYesBaseUrl,
        ANTHROPIC_AUTH_TOKEN: apiKey
      }
    };
  }

  if (provider === "codex") {
    return {
      command: process.platform === "win32" ? "codex-acp.cmd" : "codex-acp",
      args: [
        "-c",
        'model_provider="apirouter"',
        "-c",
        'model="gpt-5-codex"',
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
      ],
      env: {
        OPENAI_API_KEY: apiKey,
        APIROUTER_API_KEY: apiKey
      }
    };
  }

  if (provider === "gemini") {
    return {
      command: process.platform === "win32" ? "gemini.cmd" : "gemini",
      args: ["--experimental-acp"],
      env: {
        GOOGLE_GEMINI_BASE_URL: APP_CONFIG.coYesGeminiBaseUrl,
        GEMINI_API_KEY: apiKey,
        GOOGLE_API_KEY: apiKey,
        GEMINI_MODEL,
        GEMINI_DEFAULT_AUTH_TYPE: "gemini-api-key"
      }
    };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

export function resolveApiKey(inputApiKey, headerApiKey) {
  return inputApiKey || headerApiKey || process.env.COYES_API_KEY || "";
}
