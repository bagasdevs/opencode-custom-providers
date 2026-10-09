# opencode-custom-providers

Manage custom LLM providers in OpenCode through a wizard instead of raw JSON:
add, edit, re-probe, and delete providers from the TUI or via agent tools.

## Features

- **Wizard** — TUI slash commands and agent tools over one shared layer
- **Catalog add** — take a models.dev site's URL and model list, no probing
- **5 flavors** — OpenAI Chat/Responses, Anthropic, Gemini, Ollama
- **Tiered metadata** — gateway > models.dev > local rules > fallback; cost is never guessed
- **Tri-state reconcile** — apply / keep / remove per model; stored fields survive
- **Full edit** — rename, endpoint, flavor, key, display style, per-model fields, bulk delete
- **Honest security** — auth-store keys, fail loudly, rotation purges inline copies

## Install

```bash
bun add github:bagasdevs/opencode-custom-providers && bun pm trust opencode-custom-providers
```

One paste: installs the package, approves its setup script, and places both
plugin files automatically. Verify with `opencode plugin list`, then restart
opencode.

## Usage

| TUI | Agent tools |
|---|---|
| `/add-provider` | `add-provider`, `add-from-catalog`, `list-catalog-sites` |
| `/reprobe-models` | `reprobe-models`, `apply-reconcile` |
| `/edit-provider` | `edit-provider` |
| `/delete-provider` | `delete-provider`, `delete-models` |
| `/reload-models` | `refresh-models` |

```json
{ "provider": { "my-proxy": {
  "flavor": "openai-chat", "dynamic": true,
  "options": { "baseURL": "https://api.proxy.com/v1" } } } }
```

Keys: auth store · `OPENCODE_LOCAL_<ID>_API_KEY` · legacy inline `apiKey`
(migrates on next edit, never written). Rules: `~/.opencode-custom-providers-rules.json`.

## Development

```bash
npm install && npm run build   # tsc
npm test                       # build + node tests
npm run test:src               # vitest (104 tests)
npm run typecheck:tests        # typecheck src + tests
npm run lint                   # eslint
```

Standalone bundles for manual install (no registry needed):

```bash
esbuild src/server.ts --bundle --platform=node --format=esm \
  --external:@opencode-ai/plugin --external:@opencode-ai/sdk \
  --outfile=~/.config/opencode/plugins/opencode-custom-providers.server.js
esbuild src/tui.ts --bundle --platform=node --format=esm \
  --external:@opencode-ai/plugin --external:@opencode-ai/sdk \
  --external:@opencode-ai/sdk/v2 \
  --outfile=~/.config/opencode/plugins/opencode-custom-providers.tui.js
```

## Limits

- Bounded network per dynamic provider at startup (15s timeouts; failures never block)
- `reasoningLevels` / `supportsDeveloperRole` are recorded but inert (no such opencode fields)
- TUI dialogs are single-select, so review is sequential
