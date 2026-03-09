import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AcpProcess } from "./acp-process.js";
import { APP_CONFIG, buildProviderRuntime } from "./config.js";

const CACHE_TTL_MS = Number(process.env.MODEL_CATALOG_CACHE_MS || 60000);
const MODEL_CATALOG_RETRY_COUNT = Number(process.env.MODEL_CATALOG_RETRY_COUNT || 3);
const MODEL_CATALOG_RETRY_DELAY_MS = Number(process.env.MODEL_CATALOG_RETRY_DELAY_MS || 250);

type CatalogModel = {
  id: string;
  provider: "codex" | "claude" | "gemini";
  family: string;
  source: string;
};

let cache: {
  key: string;
  expiresAt: number;
  models: CatalogModel[];
  byId: Map<string, CatalogModel>;
} = {
  key: "",
  expiresAt: 0,
  models: [],
  byId: new Map()
};

function asErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error || "unknown error");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = MODEL_CATALOG_RETRY_COUNT
): Promise<T> {
  const maxAttempts = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }
      const delay = MODEL_CATALOG_RETRY_DELAY_MS * attempt;
      await sleep(delay);
    }
  }
  throw new Error(
    `Failed to load ${label} models after ${maxAttempts} attempt(s): ${asErrorMessage(lastError)}`
  );
}

function inferProviderFromModel(modelId: string): "codex" | "claude" | "gemini" {
  const id = String(modelId || "").toLowerCase();
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

function resolveCatalogApiKey(
  provider: "codex" | "claude" | "gemini",
  requestApiKey?: string
): string {
  const direct = String(requestApiKey || "").trim();
  if (direct) {
    return direct;
  }

  const envSpecific = String(
    process.env[`CLI_ACP_${provider.toUpperCase()}_API_KEY`] || ""
  ).trim();
  if (envSpecific) {
    return envSpecific;
  }

  return String(process.env.CLI_ACP_API_KEY || "").trim();
}

function toCatalogRecord(
  id: string,
  provider: CatalogModel["provider"],
  family: string,
  source: string
): CatalogModel {
  return {
    id,
    provider,
    family,
    source
  };
}

function resolveCommandPath(candidates: string[]): string {
  const resolver = process.platform === "win32" ? "where" : "which";
  for (const candidate of candidates) {
    const name = String(candidate || "").trim();
    if (!name) {
      continue;
    }
    const result = spawnSync(resolver, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result.status === 0) {
      const lines = String(result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines[0]) {
        return lines[0];
      }
      return name;
    }
  }
  return "";
}

function normalizeClaudeModelId(rawId: string, name: string, description: string): string {
  const trimmed = String(rawId || "").trim();
  if (!trimmed) {
    return "";
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("claude-")) {
    return lower;
  }

  const context = `${name} ${description}`.toLowerCase();
  const familyMatch = context.match(/\b(sonnet|opus|haiku)\b/);
  const versionMatch = context.match(/\b(\d+(?:\.\d+)?)\b/);
  if (familyMatch && versionMatch) {
    const family = familyMatch[1];
    const version = versionMatch[1].replace(/\./g, "-");
    return `claude-${family}-${version}`;
  }

  return lower.replace(/\[[^\]]+\]/g, "");
}

function normalizeModelIdForProvider(
  provider: "codex" | "claude" | "gemini",
  rawId: string,
  name: string,
  description: string
): string {
  const id = String(rawId || "").trim();
  if (!id) {
    return "";
  }
  if (provider === "codex") {
    return id.split("/")[0].trim().toLowerCase();
  }
  if (provider === "claude") {
    return normalizeClaudeModelId(id, name, description);
  }
  return id.toLowerCase();
}

async function collectAcpModels(
  provider: "codex" | "claude",
  apiKey?: string
): Promise<CatalogModel[]> {
  const runtime = buildProviderRuntime(provider, apiKey || undefined, "", {});
  const runner = new AcpProcess({
    command: runtime.command,
    args: runtime.args,
    env: runtime.env,
    cwd: APP_CONFIG.defaultCwd,
    sessionMeta: runtime.sessionMeta || null
  });

  try {
    await runner.start();
    await runner.initialize();
    const session = await runner.newSession(APP_CONFIG.defaultCwd);
    const available = Array.isArray(session?.models?.availableModels)
      ? session.models.availableModels
      : [];
    if (available.length === 0) {
      throw new Error(`${provider} CLI returned empty models list.`);
    }

    const map = new Map<string, CatalogModel>();
    for (const item of available) {
      const rawId = String(item?.modelId || item?.id || "").trim();
      const name = String(item?.name || "").trim();
      const description = String(item?.description || "").trim();
      const normalizedId = normalizeModelIdForProvider(
        provider,
        rawId,
        name,
        description
      );
      if (!normalizedId) {
        continue;
      }
      if (!map.has(normalizedId)) {
        map.set(
          normalizedId,
          toCatalogRecord(normalizedId, provider, provider, `acp:${provider}`)
        );
      }
    }

    if (map.size === 0) {
      throw new Error(`${provider} CLI models could not be normalized.`);
    }

    return [...map.values()];
  } finally {
    try {
      await runner.close();
    } catch {
      // Ignore close errors on catalog sync.
    }
    if (runtime.cleanup) {
      try {
        runtime.cleanup();
      } catch {
        // Ignore cleanup errors on catalog sync.
      }
    }
  }
}

async function resolveGeminiModelsConfigPath(): Promise<string> {
  const require = createRequire(import.meta.url);
  const candidates: string[] = [];

  const pushCandidate = (value: string): void => {
    const next = String(value || "").trim();
    if (!next || candidates.includes(next)) {
      return;
    }
    candidates.push(next);
  };

  for (const request of [
    "@google/gemini-cli-core/dist/src/config/models.js",
    "@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/config/models.js"
  ]) {
    try {
      pushCandidate(require.resolve(request));
    } catch {
      // Ignore unresolved module candidates.
    }
  }

  const geminiCommand = resolveCommandPath(["gemini", "gemini.cmd"]);
  if (geminiCommand) {
    const commandDir = path.dirname(geminiCommand);
    pushCandidate(
      path.join(
        commandDir,
        "node_modules",
        "@google",
        "gemini-cli",
        "node_modules",
        "@google",
        "gemini-cli-core",
        "dist",
        "src",
        "config",
        "models.js"
      )
    );
    pushCandidate(
      path.join(
        commandDir,
        "node_modules",
        "@google",
        "gemini-cli-core",
        "dist",
        "src",
        "config",
        "models.js"
      )
    );
  }

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Ignore inaccessible paths and continue.
    }
  }

  throw new Error(
    "Cannot locate Gemini CLI model config file (gemini-cli-core/dist/src/config/models.js)."
  );
}

async function collectGeminiModelsFromCli(): Promise<CatalogModel[]> {
  const configPath = await resolveGeminiModelsConfigPath();
  const mod = await import(pathToFileURL(configPath).href);
  const setLike = mod?.VALID_GEMINI_MODELS;
  if (!setLike || typeof setLike[Symbol.iterator] !== "function") {
    throw new Error("Gemini CLI did not expose VALID_GEMINI_MODELS.");
  }

  const map = new Map<string, CatalogModel>();
  for (const item of setLike as Iterable<unknown>) {
    const id = String(item || "").trim().toLowerCase();
    if (!id.startsWith("gemini-")) {
      continue;
    }
    if (id.includes("embedding")) {
      continue;
    }
    if (!map.has(id)) {
      map.set(id, toCatalogRecord(id, "gemini", "gemini", "cli:gemini"));
    }
  }

  if (map.size === 0) {
    throw new Error("Gemini CLI model set is empty.");
  }
  return [...map.values()];
}

async function fetchCliModels(apiKey?: string): Promise<CatalogModel[]> {
  const codexApiKey = resolveCatalogApiKey("codex", apiKey);
  const claudeApiKey = resolveCatalogApiKey("claude", apiKey);
  const results = await Promise.allSettled([
    withRetries("codex CLI", () => collectAcpModels("codex", codexApiKey)),
    withRetries("claude CLI", () => collectAcpModels("claude", claudeApiKey)),
    withRetries("gemini CLI", () => collectGeminiModelsFromCli())
  ]);

  const collected: CatalogModel[] = [];
  const errors: string[] = [];
  const labels = ["codex CLI", "claude CLI", "gemini CLI"] as const;

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const label = labels[index] || `provider #${index + 1}`;
    if (result.status === "fulfilled") {
      collected.push(...result.value);
      continue;
    }
    errors.push(`${label}: ${asErrorMessage(result.reason)}`);
  }

  if (errors.length > 0) {
    process.stderr.write(
      `[model-catalog] partial provider failures: ${errors.join(" | ")}\n`
    );
  }

  if (collected.length === 0) {
    const detail = errors.length > 0 ? ` Errors: ${errors.join(" | ")}` : "";
    throw new Error(`All CLI model catalogs are empty.${detail}`);
  }
  return collected;
}

function dedupeModels(models: CatalogModel[]): Map<string, CatalogModel> {
  const byId = new Map<string, CatalogModel>();
  for (const model of models) {
    if (!model?.id) {
      continue;
    }
    if (!byId.has(model.id)) {
      byId.set(model.id, model);
    }
  }
  return byId;
}

export async function getModelCatalog(apiKey?: string, forceRefresh = false): Promise<{
  models: CatalogModel[];
  byId: Map<string, CatalogModel>;
}> {
  const normalizedApiKey = String(apiKey || "").trim();
  const now = Date.now();
  if (
    !forceRefresh &&
    cache.key === normalizedApiKey &&
    cache.models.length > 0 &&
    cache.expiresAt > now
  ) {
    return {
      models: cache.models,
      byId: cache.byId
    };
  }

  const collected = await fetchCliModels(normalizedApiKey).catch((error) => {
    throw new Error(`Failed to load model catalog from CLI backends: ${asErrorMessage(error)}`);
  });

  const models = [...dedupeModels(collected).values()].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const byId = dedupeModels(models);
  cache = {
    key: normalizedApiKey,
    expiresAt: now + CACHE_TTL_MS,
    models,
    byId
  };

  return {
    models,
    byId
  };
}

export async function resolveProviderAndModel({
  provider,
  model,
  apiKey
}: {
  provider?: string;
  model?: string;
  apiKey?: string;
}): Promise<{ provider: "cliacp" | "codex" | "claude" | "gemini"; model?: string }> {
  const providerRaw = String(provider || "").trim().toLowerCase();
  const requestedModel = String(model || "").trim();
  if (providerRaw && providerRaw !== "cliacp") {
    return {
      provider: providerRaw as "codex" | "claude" | "gemini",
      model: requestedModel || undefined
    };
  }

  if (!requestedModel) {
    return {
      provider: "codex",
      model: undefined
    };
  }

  const { byId } = await getModelCatalog(apiKey);
  const exact = byId.get(requestedModel);
  if (exact) {
    return {
      provider: exact.provider,
      model: exact.id
    };
  }

  const lower = requestedModel.toLowerCase();
  for (const [id, entry] of byId.entries()) {
    if (id.toLowerCase() === lower) {
      return {
        provider: entry.provider,
        model: entry.id
      };
    }
  }

  throw new Error(`Unknown model "${requestedModel}" for CliACP catalog.`);
}
