# OpenCode plugin: CliACP

Use Codex/Claude/Gemini CLIs in OpenCode through one provider: `CliACP`.

## 1) Build plugin

```powershell
cd H:\GIT\!Libs\agent-router
npm install
npm run build:opencode-plugin
```

Build output:
- `dist/opencode/opencode-cli-acp/`

## 2) Install plugin

```powershell
npm run dev:opencode-plugin:install
```

This is a local-dev installer. It updates OpenCode config and registers
plugin entry from current local build.

## 3) Add credentials in OpenCode

Run:

```powershell
opencode auth login
```

Then choose provider `CliACP`, and pick one of:
- `Codex CLI`
- `Claude CLI`
- `Gemini CLI`

Each option saves its own key separately.

If a key for some CLI is not set, that CLI can still use its native login session.

## 4) Run

Examples:

```powershell
opencode run --model cliacp/gpt-5.3-codex "Respond with exactly OK"
opencode run --model cliacp/claude-sonnet-4-6 "Respond with exactly OK"
opencode run --model cliacp/gemini-3.1-pro-preview "Respond with exactly OK"
```

## Optional: API URL configuration

You can set upstream URLs in `C:\Users\<YOU>\.config\opencode\opencode.jsonc`:

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

Compatibility options (shared):
- `cliAcpBaseURL` (shared for Codex + Claude)
- `cliAcpGeminiBaseURL` (Gemini)

## Notes

- Provider name in UI: `CliACP`.
- Plugin starts local router automatically.
- Local router port is selected automatically if default port is busy.
- `baseURL` for provider is managed by plugin runtime; manual fixed local port config is not required.

## Uninstall

```powershell
npm run dev:opencode-plugin:unintstall
```
