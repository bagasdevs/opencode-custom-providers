// Zero-dependency postinstall: copies prebuilt bundles into the opencode plugins dir.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const OPT_OUT_ENV = "OPENCODE_NO_AUTOPLACE";

// One directory, mirroring the layout the README documents. The loader scans every entry in
// plugins/, so shipping loose files with other names would register the plugin twice.
export const PLUGIN_DIR_NAME = "opencode-custom-providers";

const BUNDLE_FILES = [
  ["opencode-custom-providers.server.js", "server.js"],
  ["opencode-custom-providers.tui.js", "tui.js"],
];

// Names an earlier release dropped straight into plugins/. Left behind, they load the plugin
// a second time under a different id.
const LEGACY_FILES = [
  "opencode-custom-providers.server.js",
  "opencode-custom-providers.tui.js",
];

export function resolvePluginDir(env, home) {
  const configDir = env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode");
  return join(configDir, "plugins");
}

function readVersion(bundlesDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(bundlesDir, "..", "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function placeBundles(pluginsDir, bundlesDir) {
  if (!existsSync(bundlesDir)) {
    console.warn(`[opencode-custom-providers] bundles dir missing, skipping: ${bundlesDir}`);
    return [];
  }
  const targetDir = join(pluginsDir, PLUGIN_DIR_NAME);
  mkdirSync(targetDir, { recursive: true });
  const installed = [];
  for (const [srcName, destName] of BUNDLE_FILES) {
    const src = join(bundlesDir, srcName);
    if (!existsSync(src)) {
      console.warn(`[opencode-custom-providers] bundle missing, skipping: ${src}`);
      continue;
    }
    const dest = join(targetDir, destName);
    copyFileSync(src, dest);
    console.log(`[opencode-custom-providers] installed ${dest}`);
    installed.push(dest);
  }
  if (installed.length === 0) return installed;
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify(
      {
        name: PLUGIN_DIR_NAME,
        version: readVersion(bundlesDir),
        type: "module",
        exports: { "./server": "./server.js", "./tui": "./tui.js" },
      },
      null,
      2,
    ) + "\n",
  );
  for (const legacy of LEGACY_FILES) {
    const stale = join(pluginsDir, legacy);
    if (existsSync(stale)) {
      rmSync(stale, { force: true });
      console.log(`[opencode-custom-providers] removed stale ${stale}`);
    }
  }
  return installed;
}

function main() {
  try {
    if (process.env[OPT_OUT_ENV]) {
      console.log(`[opencode-custom-providers] ${OPT_OUT_ENV} set, skipping plugin placement.`);
      return;
    }
    const bundlesDir = fileURLToPath(new URL("../bundles", import.meta.url));
    const pluginsDir = resolvePluginDir(process.env, homedir());
    placeBundles(pluginsDir, bundlesDir);
    console.log("[opencode-custom-providers] bun users: run `bun pm trust` once for this package; npm v12 users: allow install scripts for it.");
  } catch (err) {
    console.warn(`[opencode-custom-providers] auto-place failed, continuing install: ${err instanceof Error ? err.message : err}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
