// Dev-only bundler: emits self-contained ESM plugin files into bundles/.
import { buildSync } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "bundles");
mkdirSync(outdir, { recursive: true });

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
  buildSync({
    bundle: true,
    platform: "node",
    format: "esm",
    entryPoints: [t.entry],
    outfile: t.outfile,
    external: t.external,
  });
  console.log(`bundled ${t.outfile}`);
}
