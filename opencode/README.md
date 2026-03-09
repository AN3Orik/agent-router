# CliACP Plugin for OpenCode

[![npm version](https://img.shields.io/npm/v/opencode-cli-acp)](https://www.npmjs.com/package/opencode-cli-acp)
[![npm downloads](https://img.shields.io/npm/dm/opencode-cli-acp)](https://www.npmjs.com/package/opencode-cli-acp)
[![license](https://img.shields.io/npm/l/opencode-cli-acp)](https://www.npmjs.com/package/opencode-cli-acp)

`opencode-cli-acp` adds one OpenCode provider (`CliACP`) that routes requests to Codex ACP, Claude ACP, and Gemini CLI through a local ACP router.

## What You Get

- One provider in OpenCode for 3 CLI backends
- Streaming responses (including reasoning chunks when backend supports it)
- Separate login methods for each backend (`Codex CLI`, `Claude CLI`, `Gemini CLI`)
- Automatic local router startup and automatic local port selection
- Dynamic model catalog from local CLI backends, enriched by `models.dev`
- Optional per-CLI upstream URL overrides

## Requirements

- Node.js 20+
- OpenCode installed
- CLI tools available in `PATH`:
  - `codex-acp`
  - `claude-code-acp`
  - `gemini`

## Installation

### Option A: Install from npm (recommended)

Add plugin to OpenCode config (`~/.config/opencode/opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cli-acp@latest"]
}
```

Restart OpenCode.

### Option B: Local development install (from this repository)

```powershell
cd H:\GIT\!Libs\agent-router
npm install
npm run build:opencode-plugin
npm run dev:opencode-plugin:install
```

This installs plugin entry from local build: `dist/opencode/opencode-cli-acp/`.

## Authentication

Run:

```powershell
opencode auth login
```

Then select:

1. Provider: `CliACP`
2. Method:
   - `Codex CLI`
   - `Claude CLI`
   - `Gemini CLI`

Each method stores its key separately.  
If a key is missing for some backend, native CLI auth for that backend is used.

## Usage

```powershell
opencode run --model cliacp/gpt-5.3-codex "Respond with exactly OK"
opencode run --model cliacp/claude-sonnet-4-6 "Respond with exactly OK"
opencode run --model cliacp/gemini-3.1-pro-preview "Respond with exactly OK"
```

## Configuration

Optional per-CLI upstream API URLs can be set in `~/.config/opencode/opencode.jsonc`:

```json
{
  "provider": {
    "cliacp": {
      "options": {
        "cliAcpCodexBaseURL": "https://your-codex-endpoint",
        "cliAcpClaudeBaseURL": "https://your-claude-endpoint",
        "cliAcpGeminiBaseURL": "https://your-gemini-endpoint"
      }
    }
  }
}
```

Model list source:
- `codex-acp` and `claude-code-acp` via ACP `session/new`
- `gemini` via installed `gemini-cli-core` model config

## Oh My OpenCode compatibility

If you use `oh-my-opencode` (`https://github.com/code-yeongyu/oh-my-openagent/`), below is a reference config that maps recommended OmO agents/categories to `CliACP` models.

<details>
<summary>Show example OmO configuration (JSON)</summary>

```json
{
  "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-opencode/master/assets/oh-my-opencode.schema.json",
  "agents": {
    "sisyphus": {
      "model": "cliacp/claude-opus-4-6",
      "variant": "max"
    },
    "librarian": {
      "model": "cliacp/claude-sonnet-4-5"
    },
    "explore": {
      "model": "cliacp/gpt-5.1-codex-mini"
    },
    "oracle": {
      "model": "cliacp/gpt-5.4",
      "variant": "high"
    },
    "frontend-ui-ux-engineer": {
      "model": "cliacp/antigravity-gemini-3.1-pro"
    },
    "multimodal-looker": {
      "model": "cliacp/gemini-3-flash-preview"
    },
    "prometheus": {
      "model": "cliacp/claude-opus-4-6",
      "variant": "max"
    },
    "metis": {
      "model": "cliacp/claude-opus-4-6",
      "variant": "max"
    },
    "momus": {
      "model": "cliacp/gpt-5.4",
      "variant": "medium"
    },
    "atlas": {
      "model": "cliacp/claude-sonnet-4-5"
    },
    "sisyphus-junior": {
      "model": "cliacp/gpt-5.3-codex",
      "variant": "high"
    },
    "hephaestus": {
      "model": "cliacp/gpt-5.3-codex",
      "variant": "medium"
    }
  },
  "categories": {
    "visual-engineering": {
      "model": "cliacp/gemini-3.1-pro-preview"
    },
    "ultrabrain": {
      "model": "cliacp/gpt-5.3-codex",
      "variant": "xhigh"
    },
    "artistry": {
      "model": "cliacp/gemini-3.1-pro-preview",
      "variant": "high"
    },
    "quick": {
      "model": "cliacp/claude-haiku-4-5"
    },
    "unspecified-low": {
      "model": "cliacp/claude-sonnet-4-5"
    },
    "unspecified-high": {
      "model": "cliacp/claude-sonnet-4-5"
    },
    "deep": {
      "model": "cliacp/gpt-5.3-codex",
      "variant": "medium"
    },
    "writing": {
      "model": "cliacp/gemini-3-flash-preview"
    }
  }
}
```

</details>

## Troubleshooting

- If `CliACP` does not appear in provider list, restart OpenCode after plugin install.
- If requests fail with connection errors, verify required CLIs are installed and in `PATH`.
- If provider auth is missing, run `opencode auth login` and add credentials for the required backend.
- For local dev reinstall:

```powershell
npm run dev:opencode-plugin:install
```

## Uninstall (local dev install)

```powershell
npm run dev:opencode-plugin:unintstall
```
