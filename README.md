# agent-router

Local OpenAPI server that wraps `codex`, `claude`, and `gemini` CLIs via ACP and exposes one unified HTTP endpoint.

## What it does

- Starts the selected CLI in ACP mode (`codex-acp`, `claude-code-acp`, `gemini --experimental-acp`)
- Connects as ACP client (`initialize` -> `session/new` -> `session/prompt`)
- Streams and aggregates agent message chunks into one `outputText`
- Returns a single JSON response via OpenAPI endpoint
- Preconfigured for `co.yes.vg` URLs
- Exposes OpenAI-compatible endpoints for agent frameworks (`/v1/chat/completions`, `/v1/responses`, `/v1/models`)
- Supports reasoning effort passthrough to wrapped CLIs:
  - Codex: `model_reasoning_effort`
  - Claude: `--effort`
  - Gemini: per-request `thinkingConfig` via temporary Gemini settings

## Requirements

- Node.js 20+
- Installed CLIs in `PATH`:
  - `codex-acp`
  - `claude-code-acp`
  - `gemini`
- Valid `co.yes.vg` API key

## Quick start

```powershell
cd H:\GIT\!Libs\agent-router
$env:COYES_API_KEY="YOUR_CO_YES_KEY"
npm start
```

Server starts on `http://127.0.0.1:8787`.

## API

- OpenAPI spec: `GET /openapi.json`
- Health: `GET /health`
- Providers: `GET /v1/providers`
- OpenAI models: `GET /v1/models`
- OpenAI chat completions: `POST /v1/chat/completions`
- OpenAI responses API: `POST /v1/responses`
- Unified prompt: `POST /v1/agents/chat`
- Unified prompt stream (SSE): `POST /v1/agents/chat/stream`

Request example:

```json
{
  "provider": "yescode",
  "model": "claude-sonnet-4-5",
  "reasoningEffort": "high",
  "message": "Respond with exactly OK",
  "permissionMode": "allow",
  "timeoutMs": 180000
}
```

PowerShell example:

```powershell
$body = @{
  provider = "claude"
  message = "Respond with exactly OK"
} | ConvertTo-Json

irm -Method Post `
  -Uri "http://127.0.0.1:8787/v1/agents/chat" `
  -ContentType "application/json" `
  -Body $body
```

SSE example (`curl`):

```powershell
curl.exe -N -X POST "http://127.0.0.1:8787/v1/agents/chat/stream" `
  -H "Content-Type: application/json" `
  -d "{\"provider\":\"codex\",\"message\":\"Explain in 1 sentence\"}"
```

SSE events:

- `ready` - stream initialized
- `event` - ACP lifecycle/update payloads
- `token` - real-time text chunks
- `done` - final result object
- `error` - runtime failure

OpenAI-compatible streaming (`stream: true`) returns `data: ...` SSE chunks
and closes with `data: [DONE]`.

`GET /v1/models` now resolves a dynamic catalog from `co.yes.vg`:

- Source endpoint: `https://co.yes.vg/api/v1/public/models`

So `yescode` can expose all available model ids from all 3 sets.

## Reasoning effort input

You can pass reasoning effort in requests as:

- `reasoningEffort`
- `reasoning_effort`
- `reasoning.effort` (OpenAI-style object)

Allowed values at router level:

- `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`

Actual allowed values depend on provider/model. Unsupported combinations fail with validation/runtime error (no silent fallback).

## Key handling

API key can be provided in any of these ways:

1. `COYES_API_KEY` env var (recommended for local app)
2. `apiKey` field in request body
3. `X-API-Key` header (or `Authorization: Bearer ...`)

## co.yes.vg defaults

- Codex/Claude base URL: `https://co.yes.vg`
- Gemini base URL: `https://co.yes.vg/gemini`

Override with env vars:

- `COYES_BASE_URL`
- `COYES_GEMINI_BASE_URL`
- `HOST`
- `PORT`
- `REQUEST_TIMEOUT_MS`
- `DEFAULT_CWD`

## OpenCode plugin/auth provider

Full OpenCode plugin integration (auth provider + config example) is in:

- `opencode/co-yes-auth/index.mjs`
- `opencode/README.md`

Build embedded router bundle for the plugin:

```powershell
npm run build:opencode-plugin
```

Build output:

- `dist/opencode/co-yes-auth/`
- `dist/opencode/co-yes-auth/install.ps1`
- `dist/opencode/co-yes-auth/uninstall.ps1`

Installer script also auto-adds `provider.yescode` into OpenCode config
(`%USERPROFILE%\.config\opencode\opencode.json` or `.jsonc`), adds local plugin
entry, synchronizes model metadata + variants from `co.yes.vg` + `models.dev`,
and runs `opencode auth login --provider yescode` only when `yescode` key is not already present in auth storage.
