import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const SOURCE_PLUGIN_DIR = path.resolve(ROOT, "opencode", "co-yes-auth");
const DIST_PLUGIN_DIR = path.resolve(ROOT, "dist", "opencode", "co-yes-auth");
const ROUTER_DIR = path.resolve(DIST_PLUGIN_DIR, "router");
const ROUTER_SRC_DIR = path.resolve(ROUTER_DIR, "src");

async function copyRouter() {
  await fs.mkdir(ROUTER_SRC_DIR, { recursive: true });

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

  const pluginFiles = [
    "index.mjs",
    "package.json",
    "install.ps1",
    "uninstall.ps1"
  ];

  for (const file of pluginFiles) {
    await fs.copyFile(
      path.resolve(SOURCE_PLUGIN_DIR, file),
      path.resolve(DIST_PLUGIN_DIR, file)
    );
  }

  const srcFiles = [
    "acp-process.js",
    "config.js",
    "router-service.js",
    "model-catalog.js",
    "server.js"
  ];

  for (const file of srcFiles) {
    const from = path.resolve(ROOT, "src", file);
    const to = path.resolve(ROUTER_SRC_DIR, file);
    await fs.copyFile(from, to);
  }

  await fs.copyFile(
    path.resolve(ROOT, "openapi.json"),
    path.resolve(ROUTER_DIR, "openapi.json")
  );
}

await copyRouter();
console.log("Built OpenCode yescode plugin:", DIST_PLUGIN_DIR);
