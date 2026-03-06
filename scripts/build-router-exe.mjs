import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DIST_DIR = path.resolve(ROOT, "dist", "router");
const EXE_NAME = process.platform === "win32" ? "agent-router.exe" : "agent-router";
const EXE_PATH = path.resolve(DIST_DIR, EXE_NAME);
const bunBin = process.env.BUN_BIN || "bun";

async function buildRouterExe() {
  await fs.mkdir(DIST_DIR, { recursive: true });

  const result = spawnSync(
    bunBin,
    ["build", "src/server.js", "--compile", "--outfile", EXE_PATH],
    {
      cwd: ROOT,
      stdio: "inherit"
    }
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  // eslint-disable-next-line no-console
  console.log(`Built router executable: ${EXE_PATH}`);
}

await buildRouterExe();
