# OpenCode integration (yescode)

## Build

```powershell
cd H:\GIT\!Libs\agent-router
npm install
npm run build:opencode-plugin
```

Build output: `dist/opencode/opencode-yescode-auth/`.

Note: this build is for the OpenCode plugin bundle (embedded router).  
If you need a standalone router executable, use root script:

```powershell
npm run build:router:exe
```

Standalone output is a single file: `dist/router/agent-router.exe`.

## Install (one click)

```powershell
dist\opencode\opencode-yescode-auth\install.ps1
```

What installer does automatically:
- copies plugin bundle to `%USERPROFILE%\.config\opencode\plugins\opencode-yescode-auth`
- registers plugin by absolute `file:///.../yescode.mjs` entry in `opencode.jsonc/opencode.json`
- adds `provider.yescode` (OpenAI-compatible -> `http://127.0.0.1:8787/v1`)
- forwards current OpenCode worktree as request `cwd` (so CLI runs in project folder)
- checks `auth.json` for existing `yescode` key; if key is missing, runs `opencode auth login --provider yescode`
- pulls live models from `https://co.yes.vg/api/v1/public/models`
- enriches each model from `https://models.dev/api.json` when exact match exists
- writes `provider.yescode.models` metadata and valid reasoning variants per model

Note: ACP tool-call bridge events are disabled in router output; OpenCode receives model-generated content only.

## Uninstall

```powershell
dist\opencode\opencode-yescode-auth\uninstall.ps1
```

It removes plugin files and cleans `provider.yescode` + plugin registration from OpenCode config.
