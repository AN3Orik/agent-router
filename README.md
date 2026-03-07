# agent-router

Local OpenAPI server that wraps `codex`, `claude`, and `gemini` CLIs via ACP and exposes one unified HTTP endpoint.

## What it does

- Starts the selected CLI in ACP mode (`codex-acp`, `claude-code-acp`, `gemini --experimental-acp`)
- Connects as ACP client (`initialize` -> `session/new` -> `session/prompt`)
- Streams agent text chunks (`token` / OpenAI-compatible deltas)
- Returns a single JSON response via OpenAPI endpoint
- Preconfigured for `co.yes.vg` URLs
- Exposes OpenAI-compatible endpoints for agent frameworks (`/v1/chat/completions`, `/v1/responses`, `/v1/models`)
- Supports `reasoningEffort` passthrough for Codex/Claude/Gemini
- Does not bridge ACP tool-call events into OpenAI output; responses contain model-generated content only

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
npm install
$env:COYES_API_KEY="YOUR_CO_YES_KEY"
npm start
```

Server starts on `http://127.0.0.1:8787`.

## Build standalone router `.exe` (Bun)

```powershell
cd H:\GIT\!Libs\agent-router
npm install
npm run build:router:exe
```

Output:

- `dist/router/agent-router.exe` (OpenAPI spec is embedded)

Run executable:

```powershell
$env:COYES_API_KEY="YOUR_CO_YES_KEY"
dist\router\agent-router.exe
```

## API

- OpenAPI spec: `GET /openapi.json`
- Health: `GET /health`
- Runtime stats: `GET /v1/runtime`
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
  "sessionMode": "sticky",
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

## Persistent pool sessions

`ACP_POOL_ENABLED=1` (default) keeps a pool of live CLI ACP workers and reuses
them between requests.

- `sessionMode: "stateless"` (default): worker is reused, but ACP conversation
  session is recreated every request.
- `sessionMode: "sticky"`: router reuses the same ACP conversation session and
  returns `routerSessionId`; pass it back on next requests to continue context.
- `releaseSession: true` closes a sticky session after the response.
- OpenCode integration is automatic: plugin sets `setCacheKey=true`, OpenCode
  sends `promptCacheKey`, router auto-bridges it to sticky ACP `routerSessionId`.

Pool env vars:

- `ACP_POOL_MAX_SIZE` (default `2`)
- `ACP_POOL_MIN_SIZE` (default `0`)
- `ACP_POOL_IDLE_TTL_MS` (default `300000`)
- `ACP_POOL_STICKY_TTL_MS` (default `1800000`)
- `ACP_POOL_ACQUIRE_TIMEOUT_MS` (default `30000`)
- `ACP_POOL_MAX_QUEUE` (default `256`)
- `ACP_POOL_MAX_REQUESTS_PER_WORKER` (default `200`)
- `ACP_SESSION_MODE` (`stateless` or `sticky`, default `stateless`)
- `OPENAI_AUTO_SESSION_BRIDGE` (default `1`)
- `OPENAI_SESSION_BRIDGE_TTL_MS` (default `1800000`)

`GET /v1/models` now resolves a dynamic catalog from `co.yes.vg`:

- Source endpoint: `https://co.yes.vg/api/v1/public/models`

So `yescode` can expose all available model ids from all 3 sets.

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

- `opencode/co-yes-auth/index.ts`
- `opencode/README.md`

Build embedded router bundle for the plugin:

```powershell
npm install
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
The plugin also forwards the active OpenCode worktree as request `cwd`, so Codex/Claude/Gemini run in the project directory (not plugin directory).
