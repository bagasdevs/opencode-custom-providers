// Zero-dependency postinstall: copies prebuilt bundles into the opencode plugins dir.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const OPT_OUT_ENV = "OPENCODE_NO_AUTOPLACE";

const BUNDLE_FILES = [
  "opencode-custom-providers.server.js",
  "opencode-custom-providers.tui.js",
];

export function resolvePluginDir(env, home) {
  const configDir = env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode");
  return join(configDir, "plugins");
}

export function placeBundles(pluginsDir, bundlesDir) {
  if (!existsSync(bundlesDir)) {
    console.warn(`[opencode-custom-providers] bundles dir missing, skipping: ${bundlesDir}`);
    return [];
  }
  mkdirSync(pluginsDir, { recursive: true });
  const installed = [];
  for (const file of BUNDLE_FILES) {
    const src = join(bundlesDir, file);
    if (!existsSync(src)) {
      console.warn(`[opencode-custom-providers] bundle missing, skipping: ${src}`);
      continue;
    }
    const dest = join(pluginsDir, file);
    copyFileSync(src, dest);
    console.log(`[opencode-custom-providers] installed ${dest}`);
    installed.push(dest);
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
