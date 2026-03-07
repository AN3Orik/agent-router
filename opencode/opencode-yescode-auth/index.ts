import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROUTER_BOOT_TIMEOUT_MS = 20_000;
const ROUTER_HEALTH_RETRY_MS = 500;
const ROUTER_STDERR_TAIL_MAX = 4000;
const ROUTER_STATE_KEY = "__yescode_router_state__";
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
      bootPromise: null
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
    const payload = (await res.json()) as any;
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
  if (process.env.YESCODE_ROUTER_RUNTIME) {
    commands.push(normalizeRuntime(process.env.YESCODE_ROUTER_RUNTIME));
  }
  // Windows: force Node first because ACP child-process spawning is most reliable under Node.
  commands.push(process.platform === "win32" ? "node.exe" : "node");
  // Reuse current runtime only when it is Node.
  if (process.execPath && isNodeRuntime(process.execPath)) {
    commands.push(normalizeRuntime(process.execPath));
  }
  // Keep Bun as last fallback.
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

async function ensureRouterRunning({
  baseUrl,
  apiKey,
  routerEntry,
  extraEnv
}) {
  const routerRoot = resolveRouterRoot(baseUrl);
  if (await checkHealth(routerRoot)) {
    return;
  }

  const entry = resolveRouterEntry(routerEntry);
  if (!entry) {
    throw new Error("Cannot find embedded router entry point for yescode plugin.");
  }

  const state = getRouterState();
  if (state.bootPromise) {
    await state.bootPromise;
    return;
  }

  state.bootPromise = (async () => {
    const { host, port } = parseHostPort(routerRoot);
    const runtimes = resolveRuntimeCommands();
    let lastError = null;

    for (const runtime of runtimes) {
      let stderrTail = "";
      let exitStatus = "";
      let spawnError = null;

      const child = spawn(runtime, [entry], {
        cwd: path.dirname(path.dirname(entry)),
        env: {
          ...process.env,
          ...extraEnv,
          HOST: process.env.HOST || host,
          PORT: process.env.PORT || String(port),
          COYES_API_KEY: process.env.COYES_API_KEY || apiKey
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
            `yescode router failed to spawn using "${runtime}": ${spawnError.message}`
          );
          break;
        }
        if (exitStatus) {
          const hint = stderrTail.trim()
            ? ` Stderr: ${stderrTail.trim()}`
            : "";
          lastError = new Error(
            `yescode router process exited before health check using "${runtime}" (${exitStatus}).${hint}`
          );
          break;
        }
        if (await checkHealth(routerRoot)) {
          return;
        }
        await sleep(ROUTER_HEALTH_RETRY_MS);
      }

      if (!exitStatus && !spawnError) {
        const hint = stderrTail.trim() ? ` Last stderr: ${stderrTail.trim()}` : "";
        lastError = new Error(
          `yescode router did not start within ${ROUTER_BOOT_TIMEOUT_MS}ms (${routerRoot}) using "${runtime}".${hint}`
        );
      }

      try {
        child.kill();
      } catch {
        // Ignore cleanup errors.
      }
    }

    throw (
      lastError ||
      new Error(`yescode router failed to start on ${routerRoot}.`)
    );
  })();

  try {
    await state.bootPromise;
  } finally {
    state.bootPromise = null;
  }
}

function readApiKey(auth) {
  if (!auth) {
    return "";
  }
  if (typeof auth === "string") {
    return auth.trim();
  }
  if (typeof auth === "object") {
    if (typeof auth.key === "string") {
      return auth.key.trim();
    }
    if (typeof auth.apiKey === "string") {
      return auth.apiKey.trim();
    }
    if (typeof auth.access === "string") {
      return auth.access.trim();
    }
  }
  return "";
}

export async function YescodeAuthPlugin() {
  const pluginInput =
    arguments.length > 0 && arguments[0] && typeof arguments[0] === "object"
      ? arguments[0]
      : {};
  const providerId = "yescode";
  const routerBaseUrl = process.env.YESCODE_ROUTER_BASE_URL || "http://127.0.0.1:8787/v1";
  const autoStartRouter = process.env.YESCODE_AUTOSTART_ROUTER !== "0";
  const routerEntry = process.env.YESCODE_ROUTER_ENTRY || "";
  const pluginWorkdir =
    (typeof pluginInput.worktree === "string" && pluginInput.worktree.trim()) ||
    (typeof pluginInput.directory === "string" && pluginInput.directory.trim()) ||
    "";
  const routerEnv = pluginWorkdir
    ? {
        DEFAULT_CWD: pluginWorkdir
      }
    : {};

  return {
    auth: {
      provider: providerId,
      methods: [
        {
          provider: providerId,
          label: "API Key",
          type: "api"
        }
      ],
      async loader(getAuth, provider) {
        const auth = await getAuth();
        const apiKey = readApiKey(auth);
        if (!apiKey) {
          throw new Error(`Missing API key for "${providerId}". Run: opencode auth login`);
        }

        const options = provider?.options || {};
        const headers = options.headers || {};
        const baseURL = options.baseURL || routerBaseUrl;
        const upstreamFetch = options.fetch || fetch;

        if (autoStartRouter && isLocalBaseUrl(baseURL)) {
          await ensureRouterRunning({
            baseUrl: baseURL,
            apiKey,
            routerEntry,
            extraEnv: routerEnv
          });
        }

        return {
          ...options,
          // Ask OpenCode to send stable promptCacheKey/session key per chat.
          setCacheKey: true,
          baseURL,
          headers: {
            ...headers,
            "x-api-key": apiKey,
            ...(pluginWorkdir ? { "x-yescode-cwd": pluginWorkdir } : {})
          },
          apiKey,
          fetch: async (input, init) => {
            if (autoStartRouter && isLocalBaseUrl(baseURL)) {
              await ensureRouterRunning({
                baseUrl: baseURL,
                apiKey,
                routerEntry,
                extraEnv: routerEnv
              });
            }
            const requestHeaders = new Headers(init?.headers || {});
            if (!requestHeaders.has("x-api-key")) {
              requestHeaders.set("x-api-key", apiKey);
            }
            if (pluginWorkdir && !requestHeaders.has("x-yescode-cwd")) {
              requestHeaders.set("x-yescode-cwd", pluginWorkdir);
            }
            return upstreamFetch(input, {
              ...init,
              headers: requestHeaders
            });
          }
        };
      }
    }
  };
}

export default YescodeAuthPlugin;
