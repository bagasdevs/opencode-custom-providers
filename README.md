# opencode-custom-providers

[![npm version](https://img.shields.io/npm/v/opencode-custom-providers)](https://www.npmjs.com/package/opencode-custom-providers)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/bagasdevs/opencode-custom-providers/actions/workflows/ci.yml/badge.svg)](https://github.com/bagasdevs/opencode-custom-providers/actions)

Interactive wizard for managing custom LLM providers in OpenCode: add providers,
re-probe their models, and edit everything afterwards from the TUI or via agent tools.

Works on OpenCode 1 and OpenCode 2. The default export serves both hosts
(`{ id, server, setup }`); v1 resolves `./server` and `./tui`, v2 resolves `.`
and `./tui`.

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

- **OpenCode 2 support** - v2 server plugin (provider registry + credentials + agent tools) and v2 TUI plugin (palette and slash commands); v1 keeps its own entrypoints
- **Wizard** - TUI slash commands and agent tools over one shared layer
- **Catalog add** - take a models.dev site's URL and model list, no probing
- **5 flavors** - OpenAI Chat/Responses, Anthropic, Gemini, Ollama
- **Tiered metadata** - gateway > models.dev > local rules > fallback; cost is never guessed
- **Tri-state reconcile** - apply / keep / remove per model; stored fields survive
- **Full edit** - rename, endpoint, flavor, key, display style, per-model fields, bulk delete
- **Honest security** - auth-store keys, fail loudly, rotation purges inline copies

## Commands

Slash commands are what you type; agent tools are what the model calls. They are separate
namespaces: an agent tool never appears in the palette, and a slash command is never callable
by the model.

### TUI slash commands

OpenCode 2 uses the names on the left. OpenCode 1 registers the same flows under the names in
parentheses.

| Command | What it does |
| --- | --- |
| `/add-provider` | Set up a new API provider step by step (probes the endpoint) |
| `/add-known-provider` | Pick a provider from the built-in models.dev list (no probing) |
| `/list-custom-providers` | Show every custom provider and its models |
| `/check-for-new-models` (`reprobe-models`) | Ask one provider whether it has new models |
| `/review-model-changes` (`apply-reconcile`) | See what changed and choose what to keep |
| `/reload-models` (`refresh-models`) | Refresh every provider from its own address |
| `/edit-provider` | Change a provider's address, API type, key, or model naming |
| `/delete-provider` | Remove a provider and its models |

OpenCode 1 has no `/list-custom-providers`, `/add-known-provider` or `/review-model-changes`;
the catalog and reconcile flows live inside its own wizards instead.

### Agent tools

| OpenCode 1 | OpenCode 2 | What it does |
| --- | --- | --- |
| `add-provider` | `add-provider` | Add a provider by probing its endpoint |
| `add-from-catalog` | `add-from-catalog` | Add a provider from the models.dev catalog (no probing) |
| `list-catalog-sites` | `list-catalog-sites` | List catalog sites to pick from |
| : | `manual-add-models` | Add model ids by hand when an endpoint cannot list them |
| : | `list-custom-providers` | List configured providers and their models |
| `reprobe-models` | `reprobe-models` | Re-probe one provider and list model changes |
| `apply-reconcile` | `apply-reconcile` | Persist reconcile decisions |
| `refresh-models` | `refresh-models` | Re-discover models for every provider |
| `edit-provider` | : | Edit an existing provider |
| `delete-provider` | `delete-provider` | Remove a provider |
| `delete-models` | : | Remove individual models |

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
