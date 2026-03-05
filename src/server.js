import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { APP_CONFIG, resolveApiKey } from "./config.js";
import {
  listProviders,
  runProviderPrompt,
  runProviderPromptStream
} from "./router-service.js";

const OPENAPI_PATH = path.resolve(process.cwd(), "openapi.json");

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

    if (method === "POST" && url.pathname === "/v1/agents/chat") {
      const body = await readJsonBody(req);
      const apiKey = resolveApiKey(body.apiKey, extractHeaderApiKey(req));
      const result = await runProviderPrompt({
        ...body,
        apiKey
      });
      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && url.pathname === "/v1/agents/chat/stream") {
      const body = await readJsonBody(req);
      const apiKey = resolveApiKey(body.apiKey, extractHeaderApiKey(req));
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
