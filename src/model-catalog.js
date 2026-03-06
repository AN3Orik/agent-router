import { APP_CONFIG } from "./config.js";

const CACHE_TTL_MS = Number(process.env.MODEL_CATALOG_CACHE_MS || 60000);

let cache = {
  key: "",
  expiresAt: 0,
  models: [],
  byId: new Map()
};

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function inferProviderFromModel(modelId) {
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

function toCatalogRecord(id, provider, family, source) {
  return {
    id,
    provider,
    family,
    source
  };
}

async function fetchJson(url, headers) {
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

async function fetchPublicModels(apiKey) {
  const payload = await fetchJson(
    `${trimSlash(APP_CONFIG.coYesBaseUrl)}/api/v1/public/models`,
    {
      Authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey
    }
  );

  const data = Array.isArray(payload?.models) ? payload.models : [];
  return data
    .map((item) => String(item?.model_name || "").trim())
    .filter(Boolean)
    .map((id) =>
      toCatalogRecord(id, inferProviderFromModel(id), inferProviderFromModel(id), "public")
    );
}

function dedupeModels(models) {
  const byId = new Map();
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

export async function getModelCatalog(apiKey, forceRefresh = false) {
  if (!apiKey) {
    throw new Error("API key is required to list models.");
  }

  const now = Date.now();
  if (
    !forceRefresh &&
    cache.key === apiKey &&
    cache.models.length > 0 &&
    cache.expiresAt > now
  ) {
    return {
      models: cache.models,
      byId: cache.byId
    };
  }

  const publicRes = await fetchPublicModels(apiKey);

  const collected = Array.isArray(publicRes) ? publicRes : [];

  if (collected.length === 0) {
    throw new Error("Failed to load model catalog from co.yes.vg.");
  }

  const models = [...dedupeModels(collected).values()].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const byId = dedupeModels(models);
  cache = {
    key: apiKey,
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
}) {
  const providerRaw = String(provider || "").trim().toLowerCase();
  const requestedModel = String(model || "").trim();
  if (providerRaw && providerRaw !== "yescode") {
    return {
      provider: providerRaw,
      model: requestedModel || undefined
    };
  }

  if (!requestedModel) {
    return {
      provider: "codex",
      model: undefined
    };
  }

  if (!apiKey) {
    return {
      provider: inferProviderFromModel(requestedModel),
      model: requestedModel
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

  return {
    provider: inferProviderFromModel(requestedModel),
    model: requestedModel
  };
}
