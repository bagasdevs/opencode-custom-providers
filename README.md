# opencode-custom-providers

[![npm version](https://img.shields.io/npm/v/opencode-custom-providers)](https://www.npmjs.com/package/opencode-custom-providers)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/bagasdevs/opencode-custom-providers/actions/workflows/ci.yml/badge.svg)](https://github.com/bagasdevs/opencode-custom-providers/actions)

Interactive wizard for managing custom LLM providers in OpenCode: add providers,
re-probe their models, and edit everything afterwards from the TUI or via agent tools.

## Quick Start

**1. Install the plugin**

```bash
opencode plugin add opencode-custom-providers
```

**Or:**

```bash
bun add github:bagasdevs/opencode-custom-providers && bun pm trust opencode-custom-providers
```

**2. Confirm it loaded**

```bash
opencode plugin list
```

**3. Restart opencode, open the TUI, run `/add-provider`, and follow the prompts:**
pick a flavor (e.g. OpenAI Chat), enter the base URL and API key, done.
Models are discovered and enriched automatically.

## Features

- **Wizard** - TUI slash commands and agent tools over one shared layer
- **Catalog add** - take a models.dev site's URL and model list, no probing
- **5 flavors** - OpenAI Chat/Responses, Anthropic, Gemini, Ollama
- **Tiered metadata** - gateway > models.dev > local rules > fallback; cost is never guessed
- **Tri-state reconcile** - apply / keep / remove per model; stored fields survive
- **Full edit** - rename, endpoint, flavor, key, display style, per-model fields, bulk delete
- **Honest security** - auth-store keys, fail loudly, rotation purges inline copies

## Commands

| TUI | Agent tools |
| --- | --- |
| `/add-provider` | `add-provider`, `add-from-catalog`, `list-catalog-sites` |
| `/reprobe-models` | `reprobe-models`, `apply-reconcile` |
| `/edit-provider` | `edit-provider` |
| `/delete-provider` | `delete-provider`, `delete-models` |
| `/reload-models` | `refresh-models` |

## Configuration

```json
{
  "provider": {
    "my-proxy": {
      "flavor": "openai-chat",
      "dynamic": true,
      "options": { "baseURL": "https://api.proxy.com/v1" }
    }
  }
}
```

Discovery runs for providers with `options.baseURL` plus `dynamic: true` or no stored models.

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

## Limits

- Bounded network per dynamic provider at startup (15s timeouts; failures never block)
- `reasoningLevels` / `supportsDeveloperRole` are recorded but inert (no such opencode fields)
- TUI dialogs are single-select, so review is sequential

## License

MIT © bagasdevs. See [LICENSE](./LICENSE).
