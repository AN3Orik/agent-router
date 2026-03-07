import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const BUILD_ROOT = path.resolve(ROOT, ".build");
const SOURCE_PLUGIN_DIR = path.resolve(ROOT, "opencode", "opencode-yescode-auth");
const SOURCE_PLUGIN_BUILD_DIR = path.resolve(BUILD_ROOT, "opencode", "opencode-yescode-auth");
const DIST_PLUGIN_DIR = path.resolve(ROOT, "dist", "opencode", "opencode-yescode-auth");
const ROUTER_DIR = path.resolve(DIST_PLUGIN_DIR, "router");
const ROUTER_SRC_DIR = path.resolve(ROUTER_DIR, "src");
const SOURCE_ROUTER_BUILD_DIR = path.resolve(BUILD_ROOT, "src");

async function copyFile(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function buildPluginBundle() {
  try {
    await fs.rm(DIST_PLUGIN_DIR, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code || "";
    if (code !== "EBUSY" && code !== "EPERM") {
      throw error;
    }
    // When OpenCode/router process keeps files locked, continue with in-place overwrite.
  }
  await fs.mkdir(ROUTER_SRC_DIR, { recursive: true });

  const staleRouterItems = [
    path.resolve(ROUTER_DIR, "_tmp_event_probe.txt"),
    path.resolve(ROUTER_DIR, "parse_json.py"),
    path.resolve(ROUTER_DIR, "dist")
  ];
  for (const item of staleRouterItems) {
    try {
      await fs.rm(item, { recursive: true, force: true });
    } catch {
      // Ignore stale cleanup failures under active file locks.
    }
  }

  const staleFiles = [
    "configure-opencode.ps1",
    "remove-opencode-provider.ps1",
    "install-plugin.bat",
    "uninstall-plugin.bat"
  ];
  for (const name of staleFiles) {
    try {
      await fs.rm(path.resolve(DIST_PLUGIN_DIR, name), { force: true });
    } catch {
      // Ignore stale file cleanup errors; copy step still refreshes active files.
    }
  }

  await copyFile(
    path.resolve(SOURCE_PLUGIN_BUILD_DIR, "index.js"),
    path.resolve(DIST_PLUGIN_DIR, "index.mjs")
  );
  await copyFile(
    path.resolve(SOURCE_PLUGIN_BUILD_DIR, "yescode.js"),
    path.resolve(DIST_PLUGIN_DIR, "yescode.mjs")
  );
  const yescodeEntryPath = path.resolve(DIST_PLUGIN_DIR, "yescode.mjs");
  const yescodeEntryRaw = await fs.readFile(yescodeEntryPath, "utf8");
  const yescodeEntryFixed = yescodeEntryRaw.replace("./index.js", "./index.mjs");
  if (yescodeEntryFixed !== yescodeEntryRaw) {
    await fs.writeFile(yescodeEntryPath, yescodeEntryFixed, "utf8");
  }
  await copyFile(
    path.resolve(SOURCE_PLUGIN_DIR, "package.json"),
    path.resolve(DIST_PLUGIN_DIR, "package.json")
  );
  await copyFile(
    path.resolve(SOURCE_PLUGIN_DIR, "install.ps1"),
    path.resolve(DIST_PLUGIN_DIR, "install.ps1")
  );
  await copyFile(
    path.resolve(SOURCE_PLUGIN_DIR, "uninstall.ps1"),
    path.resolve(DIST_PLUGIN_DIR, "uninstall.ps1")
  );

  const srcFiles = [
    "acp-process.js",
    "acp-worker-pool.js",
    "config.js",
    "router-service.js",
    "model-catalog.js",
    "server.js"
  ];

  for (const file of srcFiles) {
    const from = path.resolve(SOURCE_ROUTER_BUILD_DIR, file);
    const to = path.resolve(ROUTER_SRC_DIR, file);
    await copyFile(from, to);
  }

  await copyFile(
    path.resolve(ROOT, "openapi.json"),
    path.resolve(ROUTER_DIR, "openapi.json")
  );
}

await buildPluginBundle();
console.log("Built OpenCode yescode plugin:", DIST_PLUGIN_DIR);
