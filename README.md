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
opencode plugin opencode-custom-providers
```

**3. Restart opencode, open the TUI, run `/custom-providers`, and follow the prompts:**
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

OpenCode 2 keeps the slash list short: one command opens a menu with every flow in it, and the
menu comes back after each action so several things can be done in one visit. OpenCode 1 still
registers the flows as separate commands, under the names in the right-hand column.

| `/custom-providers` menu entry | OpenCode 1 command | What it does |
| --- | --- | --- |
| Add a provider | `/add-provider` | Set up a new API provider step by step (probes the endpoint) |
| Add a known provider | `/add-known-provider` | Pick a provider from the built-in models.dev list (no probing) |
| List my providers | `/list-custom-providers` | Show every custom provider and its models |
| Check for new models | `/check-for-new-models` (`reprobe-models`) | Ask one provider whether it has new models |
| Review model changes | `/review-model-changes` (`apply-reconcile`) | See what changed and choose what to keep |
| Reload all models | `/reload-models` (`refresh-models`) | Refresh every provider from its own address |
| Edit a provider | `/edit-provider` | Change a provider's address, API type, key, or model naming |
| Delete a provider | `/delete-provider` | Remove a provider and its models |

Inside the wizards, Esc goes back one level instead of abandoning the whole flow: at a field it
returns to that wizard's menu, and at a step of a linear form it returns to the previous step.
Esc at the top menu is the only exit, and it reports the cancellation once.

OpenCode 1 has no list, catalog or review flow of its own; the catalog and reconcile flows live
inside its own wizards instead.

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
| : | `rename-provider` | Rename a provider, keeping its models, address and key |
| `delete-provider` | `delete-provider` | Remove a provider |
| `delete-models` | `delete-models` | Remove individual models (on v2, all of them or nothing) |

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
npm install && npm run build   # clean dist/, then tsc
npm test                       # build + node tests
npm run test:src               # vitest (202 tests)
npm run typecheck:tests        # typecheck src + tests
npm run lint                   # eslint
```

## Limits

- Bounded network per dynamic provider at startup (15s timeouts; failures never block)
- `reasoningLevels` is recorded, and a thinking-level edit does reach the model picker (`applyModelFields` writes `variants`, the field the host reads)
- `supportsDeveloperRole` is recorded but inert (opencode never reads that key)
- TUI dialogs are single-select, so review is sequential

## License

MIT © bagasdevs. See [LICENSE](./LICENSE).
