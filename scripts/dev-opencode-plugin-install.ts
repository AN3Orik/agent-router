import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const PLUGIN_NAME = "opencode-cli-acp";
const NATIVE_AUTH_SENTINEL = "__CLI_ACP_NATIVE_AUTH__";
const DIST_PLUGIN_DIR = path.resolve(ROOT, "dist", "opencode", PLUGIN_NAME);
const PLUGIN_ENTRY = path.resolve(DIST_PLUGIN_DIR, "cli-acp.mjs");
const ROUTER_ENTRY = path.resolve(DIST_PLUGIN_DIR, "router", "src", "server.js");
const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");
const AUTH_FILE_PATH =
  trim(process.env.OPENCODE_AUTH_PATH) ||
  path.join(os.homedir(), ".local", "share", "opencode", "auth.json");

function trim(value: unknown): string {
  return String(value ?? "").trim();
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function getConfigPath(dir: string): string {
  const explicit = trim(process.env.OPENCODE_CONFIG_PATH);
  if (explicit) {
    return path.resolve(explicit);
  }
  const jsonc = path.join(dir, "opencode.jsonc");
  const json = path.join(dir, "opencode.json");
  if (fsSync.existsSync(jsonc)) {
    return jsonc;
  }
  if (fsSync.existsSync(json)) {
    return json;
  }
  return jsonc;
}

function parseLooseObject(raw: string): any {
  const source = trim(raw);
  if (!source) {
    return {};
  }

  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Fall through to JS-eval parser for JSONC/trailing commas.
  }

  // Local-dev helper: accept JSONC/trailing commas by evaluating object literal.
  const parsed = Function(`"use strict"; return (${source});`)();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config root must be an object.");
  }
  return parsed;
}

async function readLooseObject(filePath: string): Promise<any> {
  if (!(await fileExists(filePath))) {
    return {};
  }
  const raw = await fs.readFile(filePath, "utf8");
  return parseLooseObject(raw);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveCommandPath(candidates: string[]): string {
  const resolver = process.platform === "win32" ? "where" : "which";
  for (const candidate of candidates) {
    const name = trim(candidate);
    if (!name) {
      continue;
    }
    const result = spawnSync(resolver, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result.status === 0) {
      const output = trim(result.stdout.split(/\r?\n/)[0]);
      return output || name;
    }
  }
  return "";
}

function assertRequiredCliTools(): void {
  const requirements = [
    {
      label: "Codex ACP",
      candidates: ["codex-acp", "codex-acp.cmd"],
      help: "npm i -g @zed-industries/codex-acp"
    },
    {
      label: "Claude ACP",
      candidates: ["claude-code-acp", "claude-code-acp.cmd"],
      help: "npm i -g @zed-industries/claude-code-acp"
    },
    {
      label: "Gemini CLI",
      candidates: ["gemini", "gemini.cmd"],
      help: "npm i -g @google/gemini-cli"
    }
  ];

  const missing: string[] = [];
  for (const item of requirements) {
    const resolved = resolveCommandPath(item.candidates);
    if (!resolved) {
      missing.push(`${item.label}: ${item.help}`);
      continue;
    }
    // eslint-disable-next-line no-console
    console.log(`[OK] Found ${item.label}: ${resolved}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `Required CLI tools are missing:\n- ${missing.join("\n- ")}`
    );
  }
}

async function ensureCliAcpAuthEntry(): Promise<void> {
  const authObject: any = await readLooseObject(AUTH_FILE_PATH).catch(() => ({}));
  if (!authObject.cliacp) {
    authObject.cliacp = {
      type: "api",
      key: NATIVE_AUTH_SENTINEL
    };
    await writeJson(AUTH_FILE_PATH, authObject);
  }
}

async function main() {
  if (!(await fileExists(PLUGIN_ENTRY)) || !(await fileExists(ROUTER_ENTRY))) {
    throw new Error(
      "Plugin bundle is missing. Run: npm run build:opencode-plugin"
    );
  }

  assertRequiredCliTools();

  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const configPath = getConfigPath(CONFIG_DIR);
  const config: any = await readLooseObject(configPath).catch(() => ({}));
  if (!config.$schema) {
    config.$schema = "https://opencode.ai/config.json";
  }

  const pluginSpecifier = pathToFileURL(PLUGIN_ENTRY).href;
  const pluginList = Array.isArray(config.plugin) ? config.plugin : [];
  const filtered = pluginList.filter(
    (entry: unknown) =>
      typeof entry === "string" && !entry.includes(PLUGIN_NAME)
  );
  config.plugin = [...filtered, pluginSpecifier];

  const provider =
    config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)
      ? config.provider
      : {};
  const cliacp =
    provider.cliacp && typeof provider.cliacp === "object" && !Array.isArray(provider.cliacp)
      ? provider.cliacp
      : {};
  cliacp.name = "CliACP";
  provider.cliacp = cliacp;
  config.provider = provider;

  await writeJson(configPath, config);
  await ensureCliAcpAuthEntry();

  // eslint-disable-next-line no-console
  console.log(`[OK] Registered plugin entry: ${pluginSpecifier}`);
  // eslint-disable-next-line no-console
  console.log(`[OK] Updated ${configPath}`);
  // eslint-disable-next-line no-console
  console.log("[OK] Dev plugin installation completed.");
}

await main();
