import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const PLUGIN_PACKAGE_PATH = path.resolve(
  ROOT,
  "opencode",
  "opencode-cli-acp",
  "package.json"
);

function resolveVersionFromTag(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("Tag is required (argv[2] or GITHUB_REF_NAME).");
  }

  const ref = raw.replace(/^refs\/tags\//, "");
  const semverMatch = ref.match(
    /(?:^|\/)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
  );
  if (!semverMatch) {
    throw new Error(
      `Tag "${raw}" must end with semver, e.g. v1.2.3 or 1.2.3.`
    );
  }

  return semverMatch[1];
}

async function main() {
  const tagInput =
    process.argv[2] || process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || "";
  const version = resolveVersionFromTag(tagInput);

  const raw = await fs.readFile(PLUGIN_PACKAGE_PATH, "utf8");
  const pkg = JSON.parse(raw);
  pkg.version = version;
  await fs.writeFile(PLUGIN_PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(`Set plugin version to ${version} from tag "${tagInput}"`);
}

await main();
