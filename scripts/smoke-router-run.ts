import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProviderPrompt, shutdownRouterRuntime } from "../src/router-service.js";

type CliArgs = {
  provider: string;
  model: string;
  message: string;
  cwd: string;
  timeoutMs: number;
  reasoningEffort?: string;
  reasoningSummary?: string;
  includeEvents: boolean;
};

const NATIVE_AUTH_SENTINEL = "__CLI_ACP_NATIVE_AUTH__";

function readFlag(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    return "";
  }
  return String(args[index + 1] || "").trim();
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseArgs(argv: string[]): CliArgs {
  const provider = readFlag(argv, "--provider") || "cliacp";
  const model = readFlag(argv, "--model");
  const message = readFlag(argv, "--message") || "Respond with exactly OK";
  const cwd = readFlag(argv, "--cwd") || process.cwd();
  const timeoutMsRaw = readFlag(argv, "--timeout-ms");
  const timeoutMs = Number(timeoutMsRaw || 180000);
  if (!model) {
    throw new Error("Missing --model");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("Invalid --timeout-ms");
  }

  return {
    provider,
    model,
    message,
    cwd,
    timeoutMs,
    reasoningEffort: readFlag(argv, "--reasoning-effort") || undefined,
    reasoningSummary: readFlag(argv, "--reasoning-summary") || undefined,
    includeEvents: hasFlag(argv, "--include-events")
  };
}

function summarizeUpdates(updates: any[] | undefined): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const update of updates || []) {
    const name = String(update?.sessionUpdate || update?.type || "unknown");
    summary[name] = (summary[name] || 0) + 1;
  }
  return summary;
}

function readApiKeyFromAuthEntry(entry: unknown): string {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "";
  }
  const record = entry as Record<string, unknown>;
  for (const keyName of ["key", "apiKey", "access"]) {
    const value = record[keyName];
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || normalized === NATIVE_AUTH_SENTINEL) {
      continue;
    }
    return normalized;
  }
  return "";
}

function readCliAcpAuthKeysFromAuthFile() {
  const empty = {
    cliacp: "",
    codex: "",
    claude: "",
    gemini: ""
  };
  const candidates = [
    path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
    process.env.XDG_DATA_HOME
      ? path.join(process.env.XDG_DATA_HOME, "opencode", "auth.json")
      : ""
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, any>;
      return {
        cliacp: readApiKeyFromAuthEntry(parsed?.cliacp),
        codex: readApiKeyFromAuthEntry(parsed?.["cliacp-codex"]),
        claude: readApiKeyFromAuthEntry(parsed?.["cliacp-claude"]),
        gemini: readApiKeyFromAuthEntry(parsed?.["cliacp-gemini"])
      };
    } catch {
      // Try next location.
    }
  }
  return empty;
}

function normalizeProviderForModel(model: string): "codex" | "claude" | "gemini" {
  const id = String(model || "").trim().toLowerCase();
  if (!id) {
    return "codex";
  }
  if (id.includes("gemini")) {
    return "gemini";
  }
  if (
    id.includes("claude") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku")
  ) {
    return "claude";
  }
  return "codex";
}

function resolveApiKey(args: CliArgs): string | undefined {
  const envKey = String(process.env.CLI_ACP_API_KEY || "").trim();
  if (envKey) {
    return envKey;
  }
  const authKeys = readCliAcpAuthKeysFromAuthFile();
  const provider = normalizeProviderForModel(args.model);
  const providerKey = authKeys[provider];
  if (providerKey) {
    return providerKey;
  }
  return authKeys.cliacp || undefined;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = resolveApiKey(args);
  const result = await runProviderPrompt({
    provider: args.provider,
    model: args.model,
    message: args.message,
    cwd: args.cwd,
    timeoutMs: args.timeoutMs,
    permissionMode: "allow",
    reasoningEffort: args.reasoningEffort,
    reasoningSummary: args.reasoningSummary,
    includeEvents: args.includeEvents,
    apiKey
  });

  const updates = Array.isArray(result?.updates) ? result.updates : [];
  const payload = {
    provider: result?.provider,
    routedProvider: result?.routedProvider,
    model: result?.model,
    stopReason: result?.stopReason,
    output: String(result?.outputText || ""),
    updatesCount: updates.length,
    updatesMap: summarizeUpdates(updates)
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main()
  .catch((err) => {
    const message =
      err instanceof Error && err.message ? err.message : String(err || "Unknown error");
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownRouterRuntime();
  });
