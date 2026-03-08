# agent-router

Local OpenAPI router for `codex`, `claude`, and `gemini` CLIs via ACP.

## What you get

- One local HTTP endpoint for 3 CLI backends
- OpenAI-compatible APIs: `/v1/models`, `/v1/chat/completions`, `/v1/responses`
- Streaming output (tokens + reasoning where supported)
- Sticky/session pooling support for long conversations
- OpenCode plugin integration (`CliACP`)

## Requirements

- Node.js 20+
- Installed CLIs in `PATH`:
  - `codex-acp`
  - `claude-code-acp`
  - `gemini`

Optional (if CLIs are not installed yet):

```powershell
npm i -g @zed-industries/codex-acp
npm i -g @zed-industries/claude-code-acp
npm i -g @google/gemini-cli
```

## Quick start (router)

```powershell
cd H:\GIT\!Libs\agent-router
npm install
npm start
```

Router starts at:
- `http://127.0.0.1:8787`

## Basic API call

```powershell
$body = @{
  provider = "cliacp"
  model = "gpt-5.3-codex"
  message = "Respond with exactly OK"
} | ConvertTo-Json

irm -Method Post `
  -Uri "http://127.0.0.1:8787/v1/agents/chat" `
  -ContentType "application/json" `
  -Body $body
```

## Auth behavior

- If no API key is provided, router uses native CLI auth sessions.
- API key can be passed via:
  1. `CLI_ACP_API_KEY`
  2. request body `apiKey`
  3. header `X-API-Key` (or `Authorization: Bearer ...`)

## Upstream API URL behavior

Defaults:
- Codex/Claude: `https://co.yes.vg`
- Gemini: `https://co.yes.vg/gemini`

Global env overrides:
- `CLI_ACP_BASE_URL`
- `CLI_ACP_GEMINI_BASE_URL`

Per-request overrides:
- `baseUrl` (Codex/Claude)
- `geminiBaseUrl` (Gemini)

## Session modes

With pool enabled (`ACP_POOL_ENABLED=1`, default):
- `sessionMode: "stateless"`: reuse worker, new ACP session per request
- `sessionMode: "sticky"`: reuse ACP session across requests via `routerSessionId`
- `releaseSession: true`: closes sticky session after response

Useful endpoints:
- `GET /health`
- `GET /v1/runtime`
- `GET /v1/providers`
- `GET /openapi.json`

## OpenCode plugin (CliACP)

Plugin docs are in:
- `opencode/README.md`

Build plugin bundle:

```powershell
npm run build:opencode-plugin
```

Install plugin:

```powershell
npm run dev:opencode-plugin:install
```

After install in OpenCode:
1. Run `opencode auth login`
2. Choose provider `CliACP`
3. Choose one method:
   - `Codex CLI`
   - `Claude CLI`
   - `Gemini CLI`

Each method stores key separately for that CLI.

## Build standalone `.exe` (Bun)

```powershell
npm run build:router:exe
```

Output:
- `dist/router/agent-router.exe`
