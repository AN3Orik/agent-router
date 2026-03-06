# OpenCode integration (yescode)

## Build

```powershell
cd H:\GIT\!Libs\agent-router
npm run build:opencode-plugin
```

Build output: `dist/opencode/co-yes-auth/`.

## Install (one click)

```powershell
dist\opencode\co-yes-auth\install.ps1
```

What installer does automatically:
- copies plugin bundle to `%USERPROFILE%\.config\opencode\plugins\co-yes-auth`
- registers plugin by absolute `file:///.../yescode.mjs` entry in `opencode.jsonc/opencode.json`
- adds `provider.yescode` (OpenAI-compatible -> `http://127.0.0.1:8787/v1`)
- checks `auth.json` for existing `yescode` key; if key is missing, runs `opencode auth login --provider yescode`
- pulls live models from `https://co.yes.vg/api/v1/public/models`
- enriches each model from `https://models.dev/api.json` when exact match exists
- writes full `provider.yescode.models` metadata (`family`, `limit`, `modalities`, `reasoning`, `tool_call`, `cost`, etc.)
- writes `variants` per model only for supported reasoning modes (no synthetic fallback)

### Reasoning variants written at install time

- OpenAI models:
  - GPT reasoning models: `none|minimal|low|medium|high|xhigh` (depends on exact model/release)
  - Codex models: `low|medium|high` (+ `xhigh` for newer codex variants where applicable)
- Anthropic models:
  - Standard reasoning models: `high|max`
  - Claude 4.6 family: `low|medium|high|max`
- Gemini models:
  - `gemini-2.5-*`: `high|max`
  - `gemini-3-*`: `low|high`
  - `gemini-3.1-*`: `low|medium|high`

## Uninstall

```powershell
dist\opencode\co-yes-auth\uninstall.ps1
```

It removes plugin files and cleans `provider.yescode` + plugin registration from OpenCode config.
