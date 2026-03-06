import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_CONFIG, resolveApiKey } from "./config.js";
import { getModelCatalog, resolveProviderAndModel } from "./model-catalog.js";
import {
  listProviders,
  runProviderPrompt,
  runProviderPromptStream
} from "./router-service.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OPENAPI_PATH = path.resolve(MODULE_DIR, "..", "openapi.json");

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key,authorization"
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

async function getOpenApi() {
  const content = await fs.readFile(OPENAPI_PATH, "utf8");
  return JSON.parse(content);
}

function beginSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-api-key,authorization"
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

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (!part || typeof part !== "object") {
        return "";
      }
      if (typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.input_text === "string") {
        return part.input_text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildPromptFromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("messages must be a non-empty array.");
  }
  return messages
    .map((item) => {
      const role = typeof item?.role === "string" ? item.role : "user";
      const content = textFromContent(item?.content);
      return `[${role}] ${content}`.trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

function buildPromptFromInput(input) {
  if (typeof input === "string" && input.trim()) {
    return input;
  }
  if (Array.isArray(input) && input.length > 0) {
    if (typeof input[0] === "string") {
      return input.filter(Boolean).join("\n\n");
    }
    const hasMessages = input.some(
      (entry) => entry && typeof entry === "object" && "role" in entry
    );
    if (hasMessages) {
      return buildPromptFromMessages(input);
    }
    return input
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        if (typeof entry.text === "string") {
          return entry.text;
        }
        if (typeof entry.input_text === "string") {
          return entry.input_text;
        }
        return textFromContent(entry.content);
      })
      .filter(Boolean)
      .join("\n\n");
  }
  throw new Error("input must be a non-empty string or array.");
}

function mapFinishReason(stopReason) {
  const reason = String(stopReason || "").toLowerCase();
  if (reason.includes("max")) {
    return "length";
  }
  if (reason.includes("tool")) {
    return "tool_calls";
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
  stopReason
}) {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model,
    output: [
      {
        id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
            annotations: []
          }
        ]
      }
    ],
    output_text: text,
    stop_reason: stopReason
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
      sendJson(res, 200, { ok: true, service: "agent-router" });
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
      const result = await runProviderPrompt({
        ...body,
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
      const reasoningEffort = getReasoningEffortFromBody(body);
      const resolved = await resolveProviderAndModel({
        provider: body.provider,
        model: body.model,
        apiKey
      });
      const provider = resolved.provider;
      const model = resolved.model || body.model || "auto";
      const prompt = buildPromptFromMessages(body.messages);

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
          const result = await runProviderPromptStream({
            provider,
            model,
            message: prompt,
            cwd: body.cwd,
            timeoutMs: body.timeoutMs,
            permissionMode: body.permissionMode,
            reasoningEffort,
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
                error: {
                  message: err instanceof Error ? err.message : "stream_failed",
                  type: "invalid_request_error"
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

      const result = await runProviderPrompt({
        provider,
        model,
        message: prompt,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        permissionMode: body.permissionMode,
        reasoningEffort,
        apiKey
      });

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
      const reasoningEffort = getReasoningEffortFromBody(body);
      const resolved = await resolveProviderAndModel({
        provider: body.provider,
        model: body.model,
        apiKey
      });
      const provider = resolved.provider;
      const model = resolved.model || body.model || "auto";
      const prompt = buildPromptFromInput(body.input ?? body.message ?? body.prompt);

      if (body.stream === true) {
        const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
        const createdAt = nowUnix();
        const abortController = new AbortController();
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

        const heartbeat = setInterval(() => {
          if (!res.writableEnded) {
            res.write(": ping\n\n");
          }
        }, 15000);

        try {
          const result = await runProviderPromptStream({
            provider,
            model,
            message: prompt,
            cwd: body.cwd,
            timeoutMs: body.timeoutMs,
            permissionMode: body.permissionMode,
            reasoningEffort,
            apiKey,
            signal: abortController.signal,
            onEvent: (evt) => {
              if (evt?.type !== "token" || !evt.text) {
                return;
              }
              writeSseData(
                res,
                JSON.stringify({
                  type: "response.output_text.delta",
                  response_id: responseId,
                  delta: evt.text
                })
              );
            }
          });

          writeSseData(
            res,
            JSON.stringify({
              type: "response.completed",
              response: makeResponsesApiResult({
                id: responseId,
                createdAt,
                model,
                text: result.outputText,
                stopReason: result.stopReason
              })
            })
          );
          writeSseData(res, "[DONE]");
        } catch (err) {
          if (!res.writableEnded) {
            writeSseData(
              res,
              JSON.stringify({
                error: {
                  message: err instanceof Error ? err.message : "stream_failed",
                  type: "invalid_request_error"
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

      const result = await runProviderPrompt({
        provider,
        model,
        message: prompt,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        permissionMode: body.permissionMode,
        reasoningEffort,
        apiKey
      });

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
