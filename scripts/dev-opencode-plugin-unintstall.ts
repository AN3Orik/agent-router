import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PLUGIN_NAME = "opencode-cli-acp";
const CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");

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
  const jsonc = path.join(dir, "opencode.jsonc");
  const json = path.join(dir, "opencode.json");
  const explicit = trim(process.env.OPENCODE_CONFIG_PATH);
  if (explicit) {
    return path.resolve(explicit);
  }
  return fsSync.existsSync(jsonc) ? jsonc : json;
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

  const parsed = Function(`"use strict"; return (${source});`)();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config root must be an object.");
  }
  return parsed;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const configPath = getConfigPath(CONFIG_DIR);
  if (!(await fileExists(configPath))) {
    // eslint-disable-next-line no-console
    console.log("[OK] OpenCode config file not found. Nothing to uninstall.");
    return;
  }

  const raw = await fs.readFile(configPath, "utf8");
  const config: any = parseLooseObject(raw);

  if (config.provider && typeof config.provider === "object" && !Array.isArray(config.provider)) {
    delete config.provider.cliacp;
  }

  if (Array.isArray(config.plugin)) {
    config.plugin = config.plugin.filter(
      (entry: unknown) =>
        typeof entry === "string" && !entry.includes(PLUGIN_NAME)
    );
  }

  await writeJson(configPath, config);
  // eslint-disable-next-line no-console
  console.log(`[OK] Removed plugin entry and provider.cliacp from ${configPath}`);
}

await main();
