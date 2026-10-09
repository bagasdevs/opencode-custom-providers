import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: postinstall.js is intentionally dependency-free plain JS with no types.
import { OPT_OUT_ENV, placeBundles, resolvePluginDir } from "../scripts/postinstall.js";

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
  it("copies both bundles into a temp OPENCODE_CONFIG_DIR", () => {
    const root = mkdtempSync(join(tmpdir(), "autoplace-"));
    const bundlesDir = join(root, "bundles");
    mkdirSync(bundlesDir, { recursive: true });
    writeFileSync(join(bundlesDir, "opencode-custom-providers.server.js"), "server");
    writeFileSync(join(bundlesDir, "opencode-custom-providers.tui.js"), "tui");
    const prev = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = join(root, "cfg");
    try {
      const pluginsDir = resolvePluginDir(process.env, root);
      const installed = placeBundles(pluginsDir, bundlesDir);
      expect(installed).toHaveLength(2);
      for (const p of installed) expect(existsSync(p)).toBe(true);
      expect(readFileSync(join(pluginsDir, "opencode-custom-providers.server.js"), "utf8")).toBe("server");
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_CONFIG_DIR;
      else process.env.OPENCODE_CONFIG_DIR = prev;
    }
  });

  it("never throws when the bundles dir is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "autoplace-"));
    const pluginsDir = join(root, "cfg", "plugins");
    expect(() => placeBundles(pluginsDir, join(root, "no-bundles"))).not.toThrow();
    expect(existsSync(pluginsDir)).toBe(false);
  });
});
