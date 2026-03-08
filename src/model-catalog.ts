import { APP_CONFIG } from "./config.js";

const CACHE_TTL_MS = Number(process.env.MODEL_CATALOG_CACHE_MS || 60000);

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

function trimSlash(value: string): string {
  return String(value || "").replace(/\/+$/, "");
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

function toCatalogRecord(id: string, provider: CatalogModel["provider"], family: string, source: string): CatalogModel {
  return {
    id,
    provider,
    family,
    source
  };
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPublicModels(apiKey?: string): Promise<CatalogModel[]> {
  const headers: Record<string, string> = {};
  const normalizedApiKey = String(apiKey || "").trim();
  if (normalizedApiKey) {
    headers.Authorization = `Bearer ${normalizedApiKey}`;
    headers["x-api-key"] = normalizedApiKey;
  }

  const payload = await fetchJson(
    `${trimSlash(APP_CONFIG.baseUrl)}/api/v1/public/models`,
    headers
  );

  const data = Array.isArray(payload?.models) ? payload.models : [];
  return data
    .map((item) => String(item?.model_name || "").trim())
    .filter(Boolean)
    .map((id) =>
      toCatalogRecord(id, inferProviderFromModel(id), inferProviderFromModel(id), "public")
    );
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

  const publicRes = await fetchPublicModels(normalizedApiKey);
  const collected = Array.isArray(publicRes) ? publicRes : [];

  if (collected.length === 0) {
    throw new Error("Failed to load model catalog from configured BASE_URL.");
  }

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

  try {
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
  } catch {
    // Fall back to provider inference when catalog lookup is unavailable.
  }

  return {
    provider: inferProviderFromModel(requestedModel),
    model: requestedModel
  };
}
