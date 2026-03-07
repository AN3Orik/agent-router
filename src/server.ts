import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_CONFIG, resolveApiKey } from "./config.js";
import { getModelCatalog, resolveProviderAndModel } from "./model-catalog.js";
import {
  getRouterRuntimeStats,
  listProviders,
  runProviderPrompt,
  runProviderPromptStream
} from "./router-service.js";
import OPENAPI_EMBEDDED from "../openapi.json" with { type: "json" };

const OPENAI_AUTO_SESSION_BRIDGE =
  (process.env.OPENAI_AUTO_SESSION_BRIDGE || "1") !== "0";
const OPENAI_SESSION_BRIDGE_TTL_MS = Number(
  process.env.OPENAI_SESSION_BRIDGE_TTL_MS || 1_800_000
);
const OPENAI_SESSION_BRIDGE_MAX = Number(
  process.env.OPENAI_SESSION_BRIDGE_MAX || 10_000
);
const OPENAI_SESSION_BRIDGE = new Map();

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key,authorization,x-yescode-cwd"
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 5_000_000) {
      throw new Error("Request body is too large.");
    }
  }
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function extractHeaderApiKey(req) {
  const fromHeader = req.headers["x-api-key"];
  if (typeof fromHeader === "string" && fromHeader.trim()) {
    return fromHeader.trim();
  }

  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function extractHeaderCwd(req) {
  const value = req.headers["x-yescode-cwd"];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) {
        return item.trim();
      }
    }
  }
  return "";
}

async function getOpenApi() {
  return OPENAPI_EMBEDDED;
}

function beginSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key,authorization,x-yescode-cwd"
  });
}

function writeSseEvent(res, event, data) {
  if (res.writableEnded) {
    return;
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseData(res, data) {
  if (!res.writableEnded) {
    res.write(`data: ${data}\n\n`);
  }
}

function textBlock(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return null;
  }
  return { type: "text", text: normalized };
}

function parseDataUrl(value) {
  const raw = String(value || "");
  const match = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(raw);
  if (!match) {
    return null;
  }
  const mimeType = (match[1] || "image/png").trim().toLowerCase();
  const data = String(match[2] || "").trim();
  if (!data) {
    return null;
  }
  return { mimeType, data };
}

function guessMimeType(uri, fallback = "") {
  const normalized = String(uri || "").toLowerCase();
  const match = /\.([a-z0-9]+)(?:[?#].*)?$/.exec(normalized);
  const ext = match?.[1] || "";
  const map = {
    pdf: "application/pdf",
    txt: "text/plain",
    json: "application/json",
    csv: "text/csv",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    heic: "image/heic",
    heif: "image/heif",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    m4v: "video/x-m4v",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    flac: "audio/flac"
  };
  return map[ext] || fallback || "application/octet-stream";
}

function isImageMimeType(mimeType) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  return normalized.startsWith("image/");
}

function normalizeUri(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^(https?|file):\/\//i.test(raw)) {
    return raw;
  }
  if (/^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\\\")) {
    try {
      return pathToFileURL(raw).href;
    } catch {
      return raw;
    }
  }
  return raw;
}

function resolveLocalImagePath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (/^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\\\")) {
    return raw;
  }

  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return "";
    }
  }

  return "";
}

function blockFromImageLike(value, mimeTypeHint = "", name = "image") {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const hintedMimeType = String(mimeTypeHint || "").trim().toLowerCase();

  const dataUrl = parseDataUrl(raw);
  if (dataUrl) {
    if (!isImageMimeType(dataUrl.mimeType)) {
      return {
        type: "resource_link",
        name,
        uri: raw,
        mimeType: hintedMimeType || dataUrl.mimeType
      };
    }
    return {
      type: "image",
      mimeType: hintedMimeType || dataUrl.mimeType,
      data: dataUrl.data,
      uri: raw
    };
  }

  const localPath = resolveLocalImagePath(raw);
  if (localPath && fs.existsSync(localPath)) {
    const localMimeType = hintedMimeType || guessMimeType(localPath);
    if (!isImageMimeType(localMimeType)) {
      return {
        type: "resource_link",
        name,
        uri: pathToFileURL(localPath).href,
        mimeType: localMimeType
      };
    }

    try {
      const data = fs.readFileSync(localPath).toString("base64");
      if (data) {
        return {
          type: "image",
          mimeType: localMimeType,
          data,
          uri: normalizeUri(raw)
        };
      }
    } catch {
      // Fall through to resource_link for unreadable files.
    }
  }

  const uri = normalizeUri(raw);
  if (!uri) {
    return null;
  }
  return {
    type: "resource_link",
    name,
    uri,
    mimeType: hintedMimeType || guessMimeType(uri)
  };
}

function extractImageLikeValue(part) {
  if (!part || typeof part !== "object") {
    return "";
  }

  const candidates = [
    part.url,
    part.uri,
    part.path,
    part.file,
    part.filePath,
    part.image,
    part.image_url,
    part.imageUrl,
    part.input_image,
    part.source,
    part.video,
    part.pdf
  ];

  const directBase64 = part.data || part.base64 || part.bytes;
  if (typeof directBase64 === "string" && directBase64.trim()) {
    const mimeType = String(
      part.mimeType || part.media_type || part.mediaType || part.contentType || "application/octet-stream"
    ).trim();
    return `data:${mimeType};base64,${directBase64.trim()}`;
  }

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (value && typeof value === "object") {
      if (typeof value.url === "string" && value.url.trim()) {
        return value.url.trim();
      }
      if (typeof value.uri === "string" && value.uri.trim()) {
        return value.uri.trim();
      }
    }
  }

  return "";
}

function contentBlocksFromParts(parts, role = "user") {
  const blocks = [];
  const roleText = textBlock(`[${role}]`);
  if (roleText) {
    blocks.push(roleText);
  }

  for (const part of parts) {
    if (typeof part === "string") {
      const block = textBlock(part);
      if (block) {
        blocks.push(block);
      }
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }

    const text = part.text ?? part.input_text ?? "";
    if (typeof text === "string" && text.trim()) {
      const block = textBlock(text);
      if (block) {
        blocks.push(block);
      }
      continue;
    }

    const imageLike = extractImageLikeValue(part);
    if (imageLike) {
      const mimeType = String(
        part.mimeType || part.media_type || part.mediaType || part.contentType || ""
      ).trim();
      const block = blockFromImageLike(imageLike, mimeType || "image/png", "image");
      if (block) {
        blocks.push(block);
      }
    }
  }

  return blocks;
}

function blocksFromAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const blocks = [];
  attachments.forEach((attachment, index) => {
    if (!attachment) {
      return;
    }
    if (typeof attachment === "string") {
      const block = blockFromImageLike(attachment, "", `attachment_${index + 1}`);
      if (block) {
        blocks.push(block);
      }
      return;
    }
    if (typeof attachment !== "object") {
      return;
    }

    const imageLike = extractImageLikeValue(attachment);
    if (!imageLike) {
      return;
    }
    const mimeType = String(
      attachment.mimeType ||
      attachment.mediaType ||
      attachment.contentType ||
      attachment.type ||
      ""
    ).trim();
    const name = String(
      attachment.name || attachment.fileName || attachment.filename || `attachment_${index + 1}`
    ).trim();
    const block = blockFromImageLike(imageLike, mimeType, name || `attachment_${index + 1}`);
    if (block) {
      blocks.push(block);
    }
  });

  return blocks;
}

function buildPromptBlocksFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array.");
  }

  const blocks = [];
  for (const message of messages) {
    const role = typeof message?.role === "string" ? message.role : "user";
    const content = message?.content;

    if (typeof content === "string") {
      const block = textBlock(`[${role}] ${content}`);
      if (block) {
        blocks.push(block);
      }
    } else if (Array.isArray(content)) {
      blocks.push(...contentBlocksFromParts(content, role));
    } else {
      const block = textBlock(`[${role}]`);
      if (block) {
        blocks.push(block);
      }
    }

    blocks.push(...blocksFromAttachments(message?.attachments));
  }

  if (blocks.length === 0) {
    throw new Error("messages must include text or supported attachments.");
  }
  return blocks;
}

function buildPromptBlocksFromInput(input) {
  if (typeof input === "string" && input.trim()) {
    return [textBlock(input)].filter(Boolean);
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("input must be a non-empty string or array.");
  }

  const hasMessages = input.some(
    (entry) => entry && typeof entry === "object" && "role" in entry
  );
  if (hasMessages) {
    return buildPromptBlocksFromMessages(input);
  }

  const blocks = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      const block = textBlock(entry);
      if (block) {
        blocks.push(block);
      }
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (typeof entry.text === "string" && entry.text.trim()) {
      blocks.push({ type: "text", text: entry.text.trim() });
      continue;
    }
    if (typeof entry.input_text === "string" && entry.input_text.trim()) {
      blocks.push({ type: "text", text: entry.input_text.trim() });
      continue;
    }

    if (Array.isArray(entry.content)) {
      blocks.push(...contentBlocksFromParts(entry.content, "user"));
      continue;
    }

    const imageLike = extractImageLikeValue(entry);
    if (imageLike) {
      const block = blockFromImageLike(imageLike, "", "input_image");
      if (block) {
        blocks.push(block);
      }
    }
  }

  if (blocks.length === 0) {
    throw new Error("input must include text or supported attachments.");
  }
  return blocks;
}

function mapFinishReason(stopReason) {
  const reason = String(stopReason || "").toLowerCase();
  if (reason.includes("max")) {
    return "length";
  }
  return "stop";
}

function getReasoningEffortFromBody(body) {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const direct = body.reasoningEffort ?? body.reasoning_effort;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim().toLowerCase();
  }

  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object") {
    const effort = reasoning.effort ?? reasoning.reasoning_effort;
    if (typeof effort === "string" && effort.trim()) {
      return effort.trim().toLowerCase();
    }
  }

  return undefined;
}

function getBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const text = String(value).trim().toLowerCase();
  if (!text) {
    return defaultValue;
  }
  if (["1", "true", "yes", "on"].includes(text)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(text)) {
    return false;
  }
  return defaultValue;
}

function readSessionMode(body) {
  const mode = body?.sessionMode ?? body?.session_mode;
  if (typeof mode !== "string") {
    return "";
  }
  const normalized = mode.trim().toLowerCase();
  if (normalized === "stateless" || normalized === "sticky") {
    return normalized;
  }
  return "";
}

function readRouterSessionId(body) {
  const candidates = [
    body?.routerSessionId,
    body?.router_session_id,
    body?.stickySessionId,
    body?.sticky_session_id
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readExternalSessionKey(body) {
  if (!body || typeof body !== "object") {
    return "";
  }

  const metadata =
    body.metadata && typeof body.metadata === "object" ? body.metadata : {};
  const candidates = [
    body.promptCacheKey,
    body.prompt_cache_key,
    body.sessionKey,
    body.session_key,
    body.sessionID,
    body.sessionId,
    body.conversationId,
    body.conversation_id,
    body.threadId,
    body.thread_id,
    metadata.promptCacheKey,
    metadata.prompt_cache_key,
    metadata.sessionKey,
    metadata.session_key,
    metadata.sessionID,
    metadata.sessionId,
    metadata.conversationId,
    metadata.conversation_id,
    metadata.threadId,
    metadata.thread_id
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      const key = value.trim();
      return key.length <= 500 ? key : key.slice(0, 500);
    }
  }
  return "";
}

function buildSessionBridgeKey({ provider, model, apiKey, externalSessionKey }) {
  const hash = crypto
    .createHash("sha256")
    .update(String(apiKey || ""))
    .digest("hex")
    .slice(0, 16);
  return `${provider}|${model || ""}|${hash}|${externalSessionKey}`;
}

function reapSessionBridge(now = Date.now()) {
  for (const [key, entry] of OPENAI_SESSION_BRIDGE.entries()) {
    if (!entry || entry.expiresAt <= now) {
      OPENAI_SESSION_BRIDGE.delete(key);
    }
  }
  if (OPENAI_SESSION_BRIDGE.size <= OPENAI_SESSION_BRIDGE_MAX) {
    return;
  }
  const ordered = [...OPENAI_SESSION_BRIDGE.entries()].sort(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  const toDrop = OPENAI_SESSION_BRIDGE.size - OPENAI_SESSION_BRIDGE_MAX;
  for (let i = 0; i < toDrop; i += 1) {
    OPENAI_SESSION_BRIDGE.delete(ordered[i][0]);
  }
}

function readBridgedRouterSessionId(bridgeKey) {
  if (!bridgeKey) {
    return "";
  }
  const entry = OPENAI_SESSION_BRIDGE.get(bridgeKey);
  if (!entry) {
    return "";
  }
  const now = Date.now();
  if (entry.expiresAt <= now) {
    OPENAI_SESSION_BRIDGE.delete(bridgeKey);
    return "";
  }
  entry.updatedAt = now;
  entry.expiresAt = now + OPENAI_SESSION_BRIDGE_TTL_MS;
  return entry.routerSessionId;
}

function setBridgedRouterSessionId(bridgeKey, routerSessionId) {
  if (!bridgeKey || !routerSessionId) {
    return;
  }
  const now = Date.now();
  OPENAI_SESSION_BRIDGE.set(bridgeKey, {
    routerSessionId,
    updatedAt: now,
    expiresAt: now + OPENAI_SESSION_BRIDGE_TTL_MS
  });
  reapSessionBridge(now);
}

function deleteBridgedRouterSessionId(bridgeKey) {
  if (bridgeKey) {
    OPENAI_SESSION_BRIDGE.delete(bridgeKey);
  }
}

function shouldRetryWithoutRouterSession(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("routerSessionId is not active") ||
    message.includes("belongs to a different provider/model") ||
    message.includes("Sticky worker")
  );
}

function resolveSessionRouting({ body, provider, model, apiKey }) {
  const sessionMode = readSessionMode(body);
  const explicitRouterSessionId = readRouterSessionId(body);
  const releaseSession = getBoolean(
    body?.releaseSession ?? body?.release_session,
    false
  );

  const externalSessionKey = readExternalSessionKey(body);
  const bridgeKey =
    OPENAI_AUTO_SESSION_BRIDGE && externalSessionKey
      ? buildSessionBridgeKey({
        provider,
        model,
        apiKey,
        externalSessionKey
      })
      : "";

  let resolvedMode = sessionMode;
  if (!resolvedMode && (explicitRouterSessionId || bridgeKey)) {
    resolvedMode = "sticky";
  }

  let routerSessionId = explicitRouterSessionId;
  if (!routerSessionId && resolvedMode === "sticky") {
    routerSessionId = readBridgedRouterSessionId(bridgeKey);
  }

  return {
    sessionMode: resolvedMode || undefined,
    routerSessionId: routerSessionId || undefined,
    releaseSession,
    bridgeKey
  };
}

function finalizeSessionRouting(routing, result) {
  if (!routing?.bridgeKey) {
    return;
  }
  if (routing.releaseSession) {
    deleteBridgedRouterSessionId(routing.bridgeKey);
    return;
  }
  if (routing.sessionMode !== "sticky") {
    deleteBridgedRouterSessionId(routing.bridgeKey);
    return;
  }
  if (result?.routerSessionId) {
    setBridgedRouterSessionId(routing.bridgeKey, result.routerSessionId);
  }
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function makeChatCompletion({
  id,
  created,
  model,
  text,
  finishReason
}) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text
        },
        finish_reason: finishReason
      }
    ]
  };
}

function makeResponsesApiResult({
  id,
  createdAt,
  model,
  text,
  stopReason,
  outputItems = []
}) {
  const normalizedText = String(text || "").trim();
  const hasOutputItems = Array.isArray(outputItems) && outputItems.length > 0;
  const output = hasOutputItems ? [...outputItems] : [];

  if (!hasOutputItems) {
    output.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: normalizedText,
          annotations: []
        }
      ]
    });
  }

  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model,
    output,
    output_text: normalizedText,
    stop_reason: stopReason,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: {
        cached_tokens: null
      },
      output_tokens_details: {
        reasoning_tokens: null
      }
    },
    incomplete_details: null,
    service_tier: null
  };
}

function toOpenAiModelsResponse(models) {
  return {
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 1735689600,
      owned_by: "yescode",
      metadata: {
        provider: model.provider,
        family: model.family,
        source: model.source
      }
    }))
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const method = req.method || "GET";

    if (method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "agent-router",
        runtime: getRouterRuntimeStats()
      });
      return;
    }

    if (method === "GET" && url.pathname === "/v1/runtime") {
      sendJson(res, 200, getRouterRuntimeStats());
      return;
    }

    if (method === "GET" && url.pathname === "/v1/providers") {
      sendJson(res, 200, { providers: listProviders() });
      return;
    }

    if (method === "GET" && url.pathname === "/openapi.json") {
      const openapi = await getOpenApi();
      sendJson(res, 200, openapi);
      return;
    }

    if (method === "GET" && url.pathname === "/v1/models") {
      const apiKey = resolveApiKey("", extractHeaderApiKey(req));
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const catalog = await getModelCatalog(apiKey, forceRefresh);
      sendJson(res, 200, toOpenAiModelsResponse(catalog.models));
      return;
    }

    if (method === "POST" && url.pathname === "/v1/agents/chat") {
      const body = await readJsonBody(req);
      const apiKey = resolveApiKey(body.apiKey, extractHeaderApiKey(req));
      const reasoningEffort = getReasoningEffortFromBody(body);
      const fallbackCwd = extractHeaderCwd(req);
      const result = await runProviderPrompt({
        ...body,
        cwd: body.cwd || fallbackCwd,
        reasoningEffort,
        apiKey
      });
      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/agents/chat/stream") {
      const body = await readJsonBody(req);
      const apiKey = resolveApiKey(body.apiKey, extractHeaderApiKey(req));
      const reasoningEffort = getReasoningEffortFromBody(body);
      const fallbackCwd = extractHeaderCwd(req);
      const abortController = new AbortController();
      let clientDisconnected = false;

      req.on("close", () => {
        clientDisconnected = true;
        abortController.abort();
      });

      beginSse(res);
      writeSseEvent(res, "ready", {
        ok: true,
        ts: Date.now()
      });

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(": ping\n\n");
        }
      }, 15000);

      try {
        const result = await runProviderPromptStream({
          ...body,
          cwd: body.cwd || fallbackCwd,
          reasoningEffort,
          apiKey,
          signal: abortController.signal,
          onEvent: (evt) => {
            if (evt?.type === "token") {
              writeSseEvent(res, "token", evt);
              return;
            }
            writeSseEvent(res, "event", evt);
          }
        });

        writeSseEvent(res, "done", result);
      } catch (err) {
        if (!clientDisconnected) {
          const details = err instanceof Error ? err.message : "Internal error";
          writeSseEvent(res, "error", {
            error: "stream_failed",
            details
          });
        }
      } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    if (method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readJsonBody(req);
      const apiKey = resolveApiKey(body.apiKey, extractHeaderApiKey(req));
      const fallbackCwd = extractHeaderCwd(req);
      const reasoningEffort = getReasoningEffortFromBody(body);
      const resolved = await resolveProviderAndModel({
        provider: body.provider,
        model: body.model,
        apiKey
      });
      const provider = resolved.provider;
      const model = resolved.model || body.model || "auto";
      const prompt = buildPromptBlocksFromMessages(body.messages);
      const sessionRouting = resolveSessionRouting({
        body,
        provider,
        model,
        apiKey
      });

      if (body.stream === true) {
        const completionId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
        const created = nowUnix();
        const abortController = new AbortController();
        req.on("close", () => abortController.abort());

        beginSse(res);
        writeSseData(
          res,
          JSON.stringify({
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null
              }
            ]
          })
        );

        const heartbeat = setInterval(() => {
          if (!res.writableEnded) {
            res.write(": ping\n\n");
          }
        }, 15000);

        try {
          const runStream = (routing) =>
            runProviderPromptStream({
              provider,
              model,
              message: prompt,
              cwd: body.cwd || fallbackCwd,
              timeoutMs: body.timeoutMs,
              permissionMode: body.permissionMode,
              reasoningEffort,
              sessionMode: routing.sessionMode,
              routerSessionId: routing.routerSessionId,
              releaseSession: routing.releaseSession,
              apiKey,
              signal: abortController.signal,
              onEvent: (evt) => {
                if (evt?.type !== "token" || !evt.text) {
                  return;
                }
                writeSseData(
                  res,
                  JSON.stringify({
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: evt.text },
                        finish_reason: null
                      }
                    ]
                  })
                );
              }
            });

          let result;
          try {
            result = await runStream(sessionRouting);
          } catch (err) {
            if (
              sessionRouting.routerSessionId &&
              sessionRouting.bridgeKey &&
              shouldRetryWithoutRouterSession(err)
            ) {
              deleteBridgedRouterSessionId(sessionRouting.bridgeKey);
              result = await runStream({
                ...sessionRouting,
                routerSessionId: undefined
              });
            } else {
              throw err;
            }
          }
          finalizeSessionRouting(sessionRouting, result);

          writeSseData(
            res,
            JSON.stringify({
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: mapFinishReason(result.stopReason)
                }
              ]
            })
          );
          writeSseData(res, "[DONE]");
        } catch (err) {
          if (!res.writableEnded) {
            writeSseData(
              res,
              JSON.stringify({
                type: "error",
                sequence_number: 0,
                error: {
                  code: "stream_failed",
                  message: err instanceof Error ? err.message : "stream_failed",
                  type: "invalid_request_error",
                  param: null
                }
              })
            );
          }
        } finally {
          clearInterval(heartbeat);
          if (!res.writableEnded) {
            res.end();
          }
        }
        return;
      }

      const runOnce = (routing) =>
        runProviderPrompt({
          provider,
          model,
          message: prompt,
          cwd: body.cwd || fallbackCwd,
          timeoutMs: body.timeoutMs,
          permissionMode: body.permissionMode,
          reasoningEffort,
          sessionMode: routing.sessionMode,
          routerSessionId: routing.routerSessionId,
          releaseSession: routing.releaseSession,
          apiKey
        });

      let result;
      try {
        result = await runOnce(sessionRouting);
      } catch (err) {
        if (
          sessionRouting.routerSessionId &&
          sessionRouting.bridgeKey &&
          shouldRetryWithoutRouterSession(err)
        ) {
          deleteBridgedRouterSessionId(sessionRouting.bridgeKey);
          result = await runOnce({
            ...sessionRouting,
            routerSessionId: undefined
          });
        } else {
          throw err;
        }
      }
      finalizeSessionRouting(sessionRouting, result);

      sendJson(
        res,
        200,
        makeChatCompletion({
          id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
          created: nowUnix(),
          model: result.model || model || "auto",
          text: result.outputText,
          finishReason: mapFinishReason(result.stopReason)
        })
      );
      return;
    }

    if (method === "POST" && url.pathname === "/v1/responses") {
      const body = await readJsonBody(req);
      const apiKey = resolveApiKey(body.apiKey, extractHeaderApiKey(req));
      const fallbackCwd = extractHeaderCwd(req);
      const reasoningEffort = getReasoningEffortFromBody(body);
      const resolved = await resolveProviderAndModel({
        provider: body.provider,
        model: body.model,
        apiKey
      });
      const provider = resolved.provider;
      const model = resolved.model || body.model || "auto";
      const prompt = buildPromptBlocksFromInput(body.input ?? body.message ?? body.prompt);
      const sessionRouting = resolveSessionRouting({
        body,
        provider,
        model,
        apiKey
      });

      if (body.stream === true) {
        const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
        const createdAt = nowUnix();
        const abortController = new AbortController();
        const streamedOutputItems = [];
        let nextOutputIndex = 0;
        let currentAssistantMessage = null;
        req.on("close", () => abortController.abort());

        beginSse(res);
        writeSseData(
          res,
          JSON.stringify({
            type: "response.created",
            response: {
              id: responseId,
              object: "response",
              created_at: createdAt,
              status: "in_progress",
              model
            }
          })
        );

        const openAssistantMessage = () => {
          if (currentAssistantMessage) {
            return currentAssistantMessage;
          }
          const message = {
            id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
            outputIndex: nextOutputIndex++,
            text: ""
          };
          currentAssistantMessage = message;
          writeSseData(
            res,
            JSON.stringify({
              type: "response.output_item.added",
              output_index: message.outputIndex,
              item: {
                type: "message",
                id: message.id
              }
            })
          );
          return message;
        };

        const closeAssistantMessage = () => {
          if (!currentAssistantMessage) {
            return;
          }
          const message = currentAssistantMessage;
          currentAssistantMessage = null;
          writeSseData(
            res,
            JSON.stringify({
              type: "response.output_item.done",
              output_index: message.outputIndex,
              item: {
                type: "message",
                id: message.id
              }
            })
          );
          streamedOutputItems.push({
            id: message.id,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: message.text,
                annotations: []
              }
            ]
          });
        };

        const heartbeat = setInterval(() => {
          if (!res.writableEnded) {
            res.write(": ping\n\n");
          }
        }, 15000);

        try {
          const runStream = (routing) =>
            runProviderPromptStream({
              provider,
              model,
              message: prompt,
              cwd: body.cwd || fallbackCwd,
              timeoutMs: body.timeoutMs,
              permissionMode: body.permissionMode,
              reasoningEffort,
              sessionMode: routing.sessionMode,
              routerSessionId: routing.routerSessionId,
              releaseSession: routing.releaseSession,
              apiKey,
              signal: abortController.signal,
              onEvent: (evt) => {
                if (evt?.type !== "token" || !evt.text) {
                  return;
                }
                const message = openAssistantMessage();
                message.text += evt.text;
                writeSseData(
                  res,
                  JSON.stringify({
                    type: "response.output_text.delta",
                    item_id: message.id,
                    delta: evt.text
                  })
                );
              }
            });

          let result;
          try {
            result = await runStream(sessionRouting);
          } catch (err) {
            if (
              sessionRouting.routerSessionId &&
              sessionRouting.bridgeKey &&
              shouldRetryWithoutRouterSession(err)
            ) {
              deleteBridgedRouterSessionId(sessionRouting.bridgeKey);
              result = await runStream({
                ...sessionRouting,
                routerSessionId: undefined
              });
            } else {
              throw err;
            }
          }
          finalizeSessionRouting(sessionRouting, result);

          closeAssistantMessage();
          if (
            streamedOutputItems.findIndex((item) => item?.type === "message") === -1
          ) {
            streamedOutputItems.push({
              id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: String(result.outputText || ""),
                  annotations: []
                }
              ]
            });
          }

          writeSseData(
            res,
            JSON.stringify({
              type: "response.completed",
              response: makeResponsesApiResult({
                id: responseId,
                createdAt,
                model,
                text: result.outputText,
                stopReason: result.stopReason,
                outputItems: streamedOutputItems
              })
            })
          );
          writeSseData(res, "[DONE]");
        } catch (err) {
          if (!res.writableEnded) {
            writeSseData(
              res,
              JSON.stringify({
                type: "error",
                sequence_number: 0,
                error: {
                  code: "stream_failed",
                  message: err instanceof Error ? err.message : "stream_failed",
                  type: "invalid_request_error",
                  param: null
                }
              })
            );
          }
        } finally {
          clearInterval(heartbeat);
          if (!res.writableEnded) {
            res.end();
          }
        }
        return;
      }

      const runOnce = (routing) =>
        runProviderPrompt({
          provider,
          model,
          message: prompt,
          cwd: body.cwd || fallbackCwd,
          timeoutMs: body.timeoutMs,
          permissionMode: body.permissionMode,
          reasoningEffort,
          sessionMode: routing.sessionMode,
          routerSessionId: routing.routerSessionId,
          releaseSession: routing.releaseSession,
          apiKey
        });

      let result;
      try {
        result = await runOnce(sessionRouting);
      } catch (err) {
        if (
          sessionRouting.routerSessionId &&
          sessionRouting.bridgeKey &&
          shouldRetryWithoutRouterSession(err)
        ) {
          deleteBridgedRouterSessionId(sessionRouting.bridgeKey);
          result = await runOnce({
            ...sessionRouting,
            routerSessionId: undefined
          });
        } else {
          throw err;
        }
      }
      finalizeSessionRouting(sessionRouting, result);

      sendJson(
        res,
        200,
        makeResponsesApiResult({
          id: `resp_${crypto.randomUUID().replace(/-/g, "")}`,
          createdAt: nowUnix(),
          model: result.model || model || "auto",
          text: result.outputText,
          stopReason: result.stopReason
        })
      );
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status = /required|must be|unsupported|invalid|too large|json/i.test(message)
      ? 400
      : 500;
    sendJson(res, status, {
      error: status === 400 ? "Bad request" : "Internal error",
      details: message
    });
  }
});

server.listen(APP_CONFIG.port, APP_CONFIG.host, () => {
  // eslint-disable-next-line no-console
  console.log(
    `agent-router listening on http://${APP_CONFIG.host}:${APP_CONFIG.port}`
  );
});
