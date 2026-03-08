type ModelsDevIndexEntry = {
  provider: "openai" | "anthropic" | "google";
  meta: Record<string, any>;
};

type ModelsDevIndex = {
  provider: Record<string, Record<string, Record<string, any>>>;
  qualified: Record<string, ModelsDevIndexEntry>;
  byId: Record<string, ModelsDevIndexEntry[]>;
};

function trimOptional(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function asBoolOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function fetchJsonWithTimeout(
  url: string,
  {
    headers = {},
    timeoutMs = 20000
  }: { headers?: Record<string, string>; timeoutMs?: number } = {}
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    method: "GET",
    headers,
    signal: controller.signal
  })
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res.json();
    })
    .finally(() => clearTimeout(timer));
}

function inferOfficialProviderFromModelId(modelId: string): "" | "openai" | "anthropic" | "google" {
  const id = asString(modelId).toLowerCase();
  if (!id) {
    return "";
  }

  if (/^(openai|anthropic|google)\//.test(id)) {
    const provider = id.split("/")[0];
    if (provider === "openai" || provider === "anthropic" || provider === "google") {
      return provider;
    }
  }
  if (id.startsWith("claude")) {
    return "anthropic";
  }
  if (id.startsWith("gemini")) {
    return "google";
  }
  if (id.startsWith("gpt") || id.startsWith("o") || id.includes("codex")) {
    return "openai";
  }
  return "";
}

function parseModelRef(modelId: string): { raw: string; base: string; provider: string } {
  const raw = asString(modelId);
  if (!raw) {
    return { raw: "", base: "", provider: "" };
  }

  let base = raw;
  let provider = "";
  const slash = raw.indexOf("/");
  if (slash > 0 && slash < raw.length - 1) {
    const maybeProvider = raw.slice(0, slash).trim().toLowerCase();
    const maybeBase = raw.slice(slash + 1).trim();
    if (maybeBase) {
      base = maybeBase;
    }
    if (maybeProvider === "openai" || maybeProvider === "anthropic" || maybeProvider === "google") {
      provider = maybeProvider;
    }
  }

  return { raw, base, provider };
}

async function getModelsDevIndex(): Promise<ModelsDevIndex> {
  const payload = await fetchJsonWithTimeout("https://models.dev/api.json", {
    timeoutMs: 20000
  });
  if (!payload || typeof payload !== "object") {
    throw new Error("models.dev returned empty payload.");
  }

  const providerIndex: Record<string, Record<string, Record<string, any>>> = {};
  const qualified: Record<string, ModelsDevIndexEntry> = {};
  const byId: Record<string, ModelsDevIndexEntry[]> = {};
  const officialProviders = ["openai", "anthropic", "google"] as const;

  for (const providerId of officialProviders) {
    const providerNode = payload[providerId];
    const modelsNode = providerNode?.models;
    if (!modelsNode || typeof modelsNode !== "object") {
      continue;
    }

    const map: Record<string, Record<string, any>> = {};
    for (const [modelId, meta] of Object.entries(modelsNode)) {
      const key = asString(modelId).toLowerCase();
      if (!key || !meta || typeof meta !== "object") {
        continue;
      }

      map[key] = meta as Record<string, any>;
      qualified[`${providerId}/${key}`] = {
        provider: providerId,
        meta: meta as Record<string, any>
      };

      if (!byId[key]) {
        byId[key] = [];
      }
      byId[key].push({
        provider: providerId,
        meta: meta as Record<string, any>
      });
    }

    providerIndex[providerId] = map;
  }

  if (Object.keys(providerIndex).length === 0) {
    throw new Error("models.dev does not expose official providers (openai/anthropic/google).");
  }

  return {
    provider: providerIndex,
    qualified,
    byId
  };
}

function resolveModelsDevMeta(
  index: ModelsDevIndex,
  modelId: string,
  providerHint: string
): ModelsDevIndexEntry | null {
  const parts = parseModelRef(modelId);
  if (!parts.raw) {
    return null;
  }

  const rawKey = parts.raw.toLowerCase();
  if (index.qualified[rawKey]) {
    return index.qualified[rawKey];
  }

  const baseKey = parts.base.toLowerCase();
  const candidates = [
    parts.provider,
    providerHint,
    inferOfficialProviderFromModelId(parts.base),
    inferOfficialProviderFromModelId(parts.raw),
    "openai",
    "anthropic",
    "google"
  ];
  const unique = [...new Set(candidates.map((item) => asString(item).toLowerCase()).filter(Boolean))];

  for (const providerId of unique) {
    const providerMap = index.provider[providerId];
    if (providerMap && providerMap[baseKey]) {
      return {
        provider: providerId as "openai" | "anthropic" | "google",
        meta: providerMap[baseKey]
      };
    }
  }

  const matches = index.byId[baseKey];
  if (matches && matches.length === 1) {
    return matches[0];
  }

  return null;
}

function addReasoningEffortVariants(efforts: string[]): Record<string, Record<string, any>> {
  const variants: Record<string, Record<string, any>> = {};
  for (const effort of efforts) {
    const normalized = asString(effort).toLowerCase();
    if (!normalized || variants[normalized]) {
      continue;
    }
    variants[normalized] = { reasoningEffort: normalized };
  }
  return variants;
}

function getOpenAiVariants(modelId: string, releaseDate: string): Record<string, Record<string, any>> {
  const id = asString(modelId).toLowerCase();
  if (!id || id === "gpt-5-pro") {
    return {};
  }

  if (id.includes("codex")) {
    const efforts = ["low", "medium", "high"];
    if (id.includes("5.2") || id.includes("5.3")) {
      efforts.push("xhigh");
    }
    return addReasoningEffortVariants(efforts);
  }

  let efforts = ["low", "medium", "high"];
  if (id.startsWith("gpt-5-") || id === "gpt-5") {
    efforts = ["minimal", ...efforts];
  }
  if (releaseDate && releaseDate >= "2025-11-13") {
    efforts = ["none", ...efforts];
  }
  if (releaseDate && releaseDate >= "2025-12-04") {
    efforts.push("xhigh");
  }
  return addReasoningEffortVariants(efforts);
}

function getAnthropicVariants(modelId: string): Record<string, Record<string, any>> {
  const id = asString(modelId).toLowerCase();
  if (!id) {
    return {};
  }
  if (
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("sonnet-4-6") ||
    id.includes("sonnet-4.6")
  ) {
    return addReasoningEffortVariants(["low", "medium", "high", "max"]);
  }
  return addReasoningEffortVariants(["high", "max"]);
}

function getGoogleVariants(modelId: string): Record<string, Record<string, any>> {
  const id = asString(modelId).toLowerCase();
  if (!id) {
    return {};
  }

  if (id.includes("gemini-2.5")) {
    return addReasoningEffortVariants(["high", "max"]);
  }
  if (id.includes("gemini-3.1")) {
    if (id.includes("pro")) {
      return addReasoningEffortVariants(["low", "high"]);
    }
    return addReasoningEffortVariants(["low", "medium", "high"]);
  }
  if (id.includes("gemini-3")) {
    return addReasoningEffortVariants(["low", "high"]);
  }
  return {};
}

function getVariantsForModel(
  providerId: string,
  modelId: string,
  releaseDate: string,
  reasoningSupported: boolean
): Record<string, Record<string, any>> {
  if (!reasoningSupported) {
    return {};
  }
  const provider = asString(providerId).toLowerCase();
  if (provider === "openai") {
    return getOpenAiVariants(modelId, releaseDate);
  }
  if (provider === "anthropic") {
    return getAnthropicVariants(modelId);
  }
  if (provider === "google") {
    return getGoogleVariants(modelId);
  }
  return {};
}

function applyOpenCodeDefaultVariantDisables(
  variants: Record<string, Record<string, any>>,
  reasoningSupported: boolean
): Record<string, Record<string, any>> {
  if (!reasoningSupported) {
    return variants;
  }
  const next = { ...(variants || {}) };
  for (const effort of ["low", "medium", "high"]) {
    if (!next[effort]) {
      next[effort] = { disabled: true };
    }
  }
  return next;
}

function normalizeModalities(value: unknown): string[] {
  const allowed = new Set(["text", "audio", "image", "video", "pdf"]);
  const list = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (const item of list) {
    const key = asString(item).toLowerCase();
    if (!key || !allowed.has(key) || result.includes(key)) {
      continue;
    }
    result.push(key);
  }
  return result;
}

type CatalogProviderHint = "" | "openai" | "anthropic" | "google";

type CatalogModelItem = {
  id: string;
  name: string;
  providerHint: CatalogProviderHint;
  description: string;
};

function toProviderHint(value: unknown): CatalogProviderHint {
  const normalized = asString(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "openai" || normalized === "codex") {
    return "openai";
  }
  if (normalized === "anthropic" || normalized === "claude") {
    return "anthropic";
  }
  if (normalized === "google" || normalized === "gemini") {
    return "google";
  }
  return "";
}

function toDisplayName(modelId: string): string {
  const source = asString(modelId);
  if (!source) {
    return "";
  }
  return source
    .replace(/[._/]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toCatalogModelItemFromId(modelId: string): CatalogModelItem | null {
  const id = asString(modelId).toLowerCase();
  if (!id) {
    return null;
  }
  const providerHint = toProviderHint(inferOfficialProviderFromModelId(id));
  return {
    id,
    name: toDisplayName(id) || id,
    providerHint,
    description: ""
  };
}

function buildEnrichedModelEntry(
  item: CatalogModelItem,
  modelsDevIndex: ModelsDevIndex
): Record<string, any> | null {
  const id = asString(item.id);
  if (!id) {
    return null;
  }
  const displayName = asString(item.name) || id;
  const providerHint = item.providerHint || inferOfficialProviderFromModelId(id);
  const resolved = resolveModelsDevMeta(modelsDevIndex, id, providerHint);
  if (!resolved) {
    return null;
  }

  const providerId = resolved.provider;
  const meta = resolved.meta;
  const entry: Record<string, any> = {
    id,
    name: displayName,
    options: {}
  };

  for (const field of ["family", "release_date"]) {
    const value = asString(meta[field]);
    if (value) {
      entry[field] = value;
    }
  }

  for (const field of ["attachment", "reasoning", "temperature", "tool_call", "experimental"]) {
    const value = asBoolOrNull(meta[field]);
    if (value !== null) {
      entry[field] = value;
    }
  }

  const status = asString(meta.status).toLowerCase();
  if (status === "alpha" || status === "beta" || status === "deprecated") {
    entry.status = status;
  }

  const interleaved = meta.interleaved;
  if (typeof interleaved === "boolean") {
    if (interleaved) {
      entry.interleaved = true;
    }
  } else if (interleaved && typeof interleaved === "object") {
    const field = asString((interleaved as Record<string, any>).field);
    if (field === "reasoning_content" || field === "reasoning_details") {
      entry.interleaved = { field };
    }
  }

  const cost = meta.cost;
  if (cost && typeof cost === "object") {
    const input = asNumberOrNull((cost as Record<string, any>).input);
    const output = asNumberOrNull((cost as Record<string, any>).output);
    if (input !== null && output !== null) {
      const costBlock: Record<string, any> = {
        input,
        output
      };
      for (const optionalField of ["cache_read", "cache_write"]) {
        const optionalValue = asNumberOrNull((cost as Record<string, any>)[optionalField]);
        if (optionalValue !== null) {
          costBlock[optionalField] = optionalValue;
        }
      }
      const contextOver200k = (cost as Record<string, any>).context_over_200k;
      if (contextOver200k && typeof contextOver200k === "object") {
        const ctxInput = asNumberOrNull((contextOver200k as Record<string, any>).input);
        const ctxOutput = asNumberOrNull((contextOver200k as Record<string, any>).output);
        if (ctxInput !== null && ctxOutput !== null) {
          const ctxBlock: Record<string, any> = {
            input: ctxInput,
            output: ctxOutput
          };
          for (const optionalField of ["cache_read", "cache_write"]) {
            const optionalValue = asNumberOrNull((contextOver200k as Record<string, any>)[optionalField]);
            if (optionalValue !== null) {
              ctxBlock[optionalField] = optionalValue;
            }
          }
          costBlock.context_over_200k = ctxBlock;
        }
      }
      entry.cost = costBlock;
    }
  }

  const limit = meta.limit;
  if (limit && typeof limit === "object") {
    const context = asNumberOrNull((limit as Record<string, any>).context);
    const output = asNumberOrNull((limit as Record<string, any>).output);
    if (context !== null && output !== null) {
      const limitBlock: Record<string, any> = {
        context: Math.floor(context)
      };
      const input = asNumberOrNull((limit as Record<string, any>).input);
      if (input !== null) {
        limitBlock.input = Math.floor(input);
      }
      limitBlock.output = Math.floor(output);
      entry.limit = limitBlock;
    }
  }

  const modalities = meta.modalities;
  if (modalities && typeof modalities === "object") {
    const input = normalizeModalities((modalities as Record<string, any>).input);
    const output = normalizeModalities((modalities as Record<string, any>).output);
    if (input.length > 0 && output.length > 0) {
      entry.modalities = { input, output };
    }
  }

  const reasoningSupported = entry.reasoning === true;
  const releaseDate = asString(entry.release_date);
  const variants = applyOpenCodeDefaultVariantDisables(
    getVariantsForModel(providerId, id, releaseDate, reasoningSupported),
    reasoningSupported
  );
  if (Object.keys(variants).length > 0) {
    entry.variants = variants;
  }

  return entry;
}

async function buildCliAcpModelsMap(input: {
  modelIds: string[];
}): Promise<{
  models: Record<string, Record<string, any>>;
  total: number;
  enriched: number;
  skipped: number;
}> {
  const modelIds = Array.isArray(input.modelIds) ? input.modelIds : [];
  const list = modelIds
    .map((id) => toCatalogModelItemFromId(id))
    .filter((item): item is CatalogModelItem => Boolean(item));
  if (list.length === 0) {
    throw new Error("CliACP model list is empty.");
  }
  const modelsDevIndex = await getModelsDevIndex();

  const excluded = new Set(["gemini-3.1-flash-image"]);
  const map: Record<string, Record<string, any>> = {};
  const unresolved: string[] = [];
  let skipped = 0;

  for (const item of list) {
    const rawId = asString(item?.id);
    if (!rawId || excluded.has(rawId)) {
      continue;
    }
    const entry = buildEnrichedModelEntry(item as CatalogModelItem, modelsDevIndex);
    if (!entry) {
      unresolved.push(rawId);
      skipped += 1;
      continue;
    }
    if (!map[entry.id]) {
      map[entry.id] = entry;
    }
  }

  if (unresolved.length > 0) {
    throw new Error(
      `models.dev does not contain metadata for: ${unresolved.sort((a, b) => a.localeCompare(b)).join(", ")}`
    );
  }

  const orderedIds = Object.keys(map).sort((a, b) => a.localeCompare(b));
  const orderedMap: Record<string, Record<string, any>> = {};
  for (const id of orderedIds) {
    orderedMap[id] = map[id];
  }

  if (orderedIds.length === 0) {
    throw new Error("Resolved zero models for CliACP provider.");
  }

  return {
    models: orderedMap,
    total: orderedIds.length,
    enriched: orderedIds.length,
    skipped
  };
}

export async function buildCliAcpProviderConfig(input: {
  existingProvider?: Record<string, any>;
  modelIds?: string[];
  cliAcpCodexBaseURL?: string;
  cliAcpClaudeBaseURL?: string;
  cliAcpGeminiBaseURL?: string;
  apiKey?: string;
}): Promise<{
  provider: Record<string, any>;
  stats: { total: number; enriched: number; skipped: number };
}> {
  const existingProvider =
    input.existingProvider && typeof input.existingProvider === "object"
      ? input.existingProvider
      : {};
  const existingOptions =
    existingProvider.options && typeof existingProvider.options === "object"
      ? existingProvider.options
      : {};
  const options: Record<string, any> = {
    ...existingOptions
  };
  delete options.baseURL;
  delete options.cliAcpBaseURL;

  const cliAcpCodexBaseURL = trimOptional(input.cliAcpCodexBaseURL);
  if (cliAcpCodexBaseURL) {
    options.cliAcpCodexBaseURL = cliAcpCodexBaseURL;
  }

  const cliAcpClaudeBaseURL = trimOptional(input.cliAcpClaudeBaseURL);
  if (cliAcpClaudeBaseURL) {
    options.cliAcpClaudeBaseURL = cliAcpClaudeBaseURL;
  }

  const cliAcpGeminiBaseURL = trimOptional(input.cliAcpGeminiBaseURL);
  if (cliAcpGeminiBaseURL) {
    options.cliAcpGeminiBaseURL = cliAcpGeminiBaseURL;
  }

  const models = await buildCliAcpModelsMap({
    modelIds: Array.isArray(input.modelIds) ? input.modelIds : []
  });

  return {
    provider: {
      ...existingProvider,
      name: "CliACP",
      npm: "@ai-sdk/openai",
      options,
      models: models.models
    },
    stats: {
      total: models.total,
      enriched: models.enriched,
      skipped: models.skipped
    }
  };
}
