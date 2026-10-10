import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: postinstall.js is intentionally dependency-free plain JS with no types.
import { OPT_OUT_ENV, PLUGIN_DIR_NAME, placeBundles, resolvePluginDir } from "../scripts/postinstall.js";

describe("resolvePluginDir", () => {
  it("honors OPENCODE_CONFIG_DIR", () => {
    expect(resolvePluginDir({ OPENCODE_CONFIG_DIR: "/tmp/custom" }, "/home/user")).toBe(
      join("/tmp/custom", "plugins"),
    );
  });

  it("falls back to ~/.config/opencode", () => {
    expect(resolvePluginDir({}, "/home/user")).toBe(
      join("/home/user", ".config", "opencode", "plugins"),
    );
  });

  it("opts out via OPENCODE_NO_AUTOPLACE", () => {
    expect(OPT_OUT_ENV).toBe("OPENCODE_NO_AUTOPLACE");
  });
});

describe("placeBundles", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "autoplace-"));
    const bundlesDir = join(root, "bundles");
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(join(bundlesDir, "opencode-custom-providers.server.js"), "server");
    writeFileSync(join(bundlesDir, "opencode-custom-providers.tui.js"), "tui");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    return { root, bundlesDir, pluginsDir: join(root, "cfg", "plugins") };
  };

  it("installs both bundles into a single named plugin directory", () => {
    const { root, bundlesDir, pluginsDir } = setup();
    const installed = placeBundles(pluginsDir, bundlesDir);
    expect(installed).toHaveLength(2);
    for (const p of installed) expect(existsSync(p)).toBe(true);
    expect(readFileSync(join(pluginsDir, PLUGIN_DIR_NAME, "server.js"), "utf8")).toBe("server");
    expect(readFileSync(join(pluginsDir, PLUGIN_DIR_NAME, "tui.js"), "utf8")).toBe("tui");
    expect(join(root, "unused")).toBeTruthy();
  });

  it("writes a manifest carrying the package version", () => {
    const { bundlesDir, pluginsDir } = setup();
    placeBundles(pluginsDir, bundlesDir);
    const manifest = JSON.parse(readFileSync(join(pluginsDir, PLUGIN_DIR_NAME, "package.json"), "utf8"));
    expect(manifest.name).toBe(PLUGIN_DIR_NAME);
    expect(manifest.version).toBe("9.9.9");
    expect(manifest.exports).toEqual({ "./server": "./server.js", "./tui": "./tui.js" });
  });

  it("never leaves loose bundle files that would load the plugin twice", () => {
    const { bundlesDir, pluginsDir } = setup();
    // Simulate the layout an older release produced.
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, "opencode-custom-providers.server.js"), "old");
    placeBundles(pluginsDir, bundlesDir);
    expect(existsSync(join(pluginsDir, "opencode-custom-providers.server.js"))).toBe(false);
    expect(existsSync(join(pluginsDir, PLUGIN_DIR_NAME, "server.js"))).toBe(true);
  });

  it("never throws when the bundles dir is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "autoplace-"));
    const pluginsDir = join(root, "cfg", "plugins");
    expect(() => placeBundles(pluginsDir, join(root, "no-bundles"))).not.toThrow();
    expect(existsSync(pluginsDir)).toBe(false);
  });
});
