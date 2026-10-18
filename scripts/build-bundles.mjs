// Dev-only bundler: emits self-contained ESM plugin files into bundles/.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "bundles");
mkdirSync(outdir, { recursive: true });

// V1 packages stay external: the host provides them. @opencode/plugin is rewritten to a stub
// because bundles land in a directory with no node_modules, and a V1 host cannot resolve it.
const v2Stub = join(root, "scripts", "v2-plugin-stub.mjs");

/** @type {import("esbuild").Plugin} */
const v2StubPlugin = {
  name: "v2-plugin-stub",
  setup(build) {
    build.onResolve({ filter: /^@opencode\/plugin(\/.*)?$/ }, () => ({ path: v2Stub }));
  },
};

const targets = [
  {
    entry: join(root, "src", "server.ts"),
    outfile: join(outdir, "opencode-custom-providers.server.js"),
    external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
  },
  {
    entry: join(root, "src", "tui.ts"),
    outfile: join(outdir, "opencode-custom-providers.tui.js"),
    external: ["@opencode-ai/plugin", "@opencode-ai/sdk", "@opencode-ai/sdk/v2"],
  },
];

for (const t of targets) {
  await build({
    bundle: true,
    platform: "node",
    format: "esm",
    entryPoints: [t.entry],
    outfile: t.outfile,
    external: t.external,
    plugins: [v2StubPlugin],
  });
  console.log(`bundled ${t.outfile}`);
}
