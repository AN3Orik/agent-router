import { spawn } from "node:child_process";
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
const ROUTER_STATE_KEY = "__cli_acp_router_state__";
const PROVIDER_ID = "cliacp";
const NATIVE_AUTH_SENTINEL = "__CLI_ACP_NATIVE_AUTH__";
const CODEX_AUTH_PROVIDER_ID = "cliacp-codex";
const CLAUDE_AUTH_PROVIDER_ID = "cliacp-claude";
const GEMINI_AUTH_PROVIDER_ID = "cliacp-gemini";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

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

function buildRouterEnv({ pluginWorkdir, apiKey, options }) {
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

  return env;
}

async function ensureRouterRunning({ baseUrl, apiKey, routerEntry, extraEnv }) {
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
    return startedBaseUrl;
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

async function fetchRouterModelIds(baseURL): Promise<string[]> {
  const response = await fetch(`${trimRightSlash(baseURL)}/models`);
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
  if (!init || typeof init !== "object" || typeof init.body !== "string") {
    return null;
  }
  const raw = init.body.trim();
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

function resolveAuthPath() {
  const fromEnv = trimOptional(process.env.OPENCODE_AUTH_PATH);
  if (fromEnv) {
    return fromEnv;
  }
  const dataDir = trimOptional(process.env.OPENCODE_DATA_DIR);
  if (dataDir) {
    return path.join(dataDir, "auth.json");
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
  let configuredMcpServers = [];

  return {
    config: async (config) => {
      const currentConfig = ensureObject(config);
      const providerMap = ensureObject(currentConfig.provider);
      const existingProvider = ensureObject(providerMap[PROVIDER_ID]);
      const existingOptions = ensureObject(existingProvider.options);
      const apiKey = trimOptional(process.env.CLI_ACP_API_KEY);
      const routerEnv = buildRouterEnv({
        pluginWorkdir,
        apiKey,
        options: existingOptions
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
      const modelIds = await fetchRouterModelIds(catalogBaseURL);

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
          options
        });

        if (autoStartRouter && isLocalBaseUrl(baseURL)) {
          baseURL = await ensureRouterRunning({
            baseUrl: baseURL,
            apiKey: globalApiKey,
            routerEntry,
            extraEnv: routerEnv
          });
        }

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
            if (autoStartRouter && isLocalBaseUrl(baseURL)) {
              baseURL = await ensureRouterRunning({
                baseUrl: baseURL,
                apiKey: globalApiKey,
                routerEntry,
                extraEnv: routerEnv
              });
            }
            let patchedInit = init || {};
            let requestApiKey = globalApiKey;
            const url = getRequestUrl(input);
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
              const body = parseJsonBody(patchedInit);
              if (body) {
                const patched = patchRequestBodyForCliAcp({
                  body,
                  options,
                  authKeys,
                  mcpServers: configuredMcpServers
                });
                if (patched) {
                  requestApiKey = patched.apiKey || requestApiKey;
                  patchedInit = {
                    ...patchedInit,
                    body: JSON.stringify(patched.body)
                  };
                }
              }
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
            return upstreamFetch(input, {
              ...patchedInit,
              headers: requestHeaders
            });
          }
        };
      }
    }
  };
}

export default CliAcpAuthPlugin;
