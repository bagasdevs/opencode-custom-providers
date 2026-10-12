# opencode-custom-providers

[![npm version](https://img.shields.io/npm/v/opencode-custom-providers)](https://www.npmjs.com/package/opencode-custom-providers)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/bagasdevs/opencode-custom-providers/actions/workflows/ci.yml/badge.svg)](https://github.com/bagasdevs/opencode-custom-providers/actions)

Add your own AI model providers to OpenCode with a few questions. The plugin finds the
models for you, and you can change or remove them later from the same menu.

Supported API types: OpenAI-compatible (most services), OpenAI Responses, Google Gemini,
and Ollama. Models are found automatically for these. For Anthropic (Claude), pick models
from the built-in list or add them by name.

| If you use | Install | Menu |
| --- | --- | --- |
| **OpenCode v1** (`>= 1.14.0`) | Steps below | Separate slash commands, such as `/add-provider` |
| **OpenCode v2** (`>= 2.0.0`) | Steps below | One menu: `/custom-providers` |

Not sure which one you have? Check the version shown by `opencode`.

## Install

```bash
opencode plugin add opencode-custom-providers
```

Then check that it loaded and restart OpenCode:

```bash
opencode plugin opencode-custom-providers
```

Installing from GitHub instead: `bun add github:bagasdevs/opencode-custom-providers && bun pm trust opencode-custom-providers`.

## Add your first provider

Use the same steps on both versions. Only the way you open the menu is different.

1. Open the menu:
   - **OpenCode v2:** type `/custom-providers`.
   - **OpenCode v1:** type `/add-provider`.
2. Choose **My own API**.
3. Enter the address (for example `https://api.example.com/v1`) and your API key.
4. Wait a few seconds. The models are found and saved for you.

Want a provider without checking the address? Choose **Built-in list** instead.

## Using the menu

### OpenCode v2: one menu

Type `/custom-providers` and pick one of these:

| Choice | What it does |
| --- | --- |
| List my providers | Shows each provider and its models |
| Add a provider | Adds one. Choose **My own API** or **Built-in list** |
| Edit a provider | Changes a provider (see the list below) |
| Delete a provider | Removes a provider and its models |
| Reload all models | Refreshes the models of every provider |

The menu stays open after each action, so you can do several things in one visit. Press Esc to go back one step. Press Esc at the top menu to leave.

**Edit a provider** has these choices: Base URL, API key, API type, Model names, Add models manually, Delete models, Model settings, and Rename.

### OpenCode v1: separate commands

OpenCode v1 has one command per task. Type the command name:

| Command | What it does |
| --- | --- |
| `/list-custom-providers` | Shows each provider and its models |
| `/add-provider` | Adds a provider. Choose **My own API** or **Built-in list** |
| `/edit-provider` | Changes a provider |
| `/delete-provider` | Removes a provider and its models |
| `/reload-models` | Refreshes the models of every provider |
| `/add-known-provider` | Adds a provider from the built-in list |
| `/reprobe-models` | Checks a provider again and shows what changed |

Press Esc to cancel. Esc reports the cancellation once.

## Difference between the two versions

| | OpenCode v1 | OpenCode v2 |
| --- | --- | --- |
| Open the menu | Separate commands | `/custom-providers` |
| Reload | `/reload-models` | Reload all models in the menu |
| Review model changes | `/reprobe-models` | Use Reload, then Edit |
| Plugin entry points | `./server`, `./tui` | `.` (server), `./tui` |

An OpenCode v1 plugin does not run on OpenCode v2. To move to OpenCode v2, run `opencode upgrade --major`, then install the plugin again.

## For the AI assistant (agent tools)

The model can call these tools. You do not type them yourself. Ask in plain words, for example "add a provider at this address".

| Tool | OpenCode v1 | OpenCode v2 | What it does |
| --- | --- | --- | --- |
| `add-provider` | yes | yes | Adds a provider by checking its address |
| `add-from-catalog` | yes | yes | Adds a provider from the models.dev catalog, without checking |
| `list-catalog-sites` | yes | yes | Lists the catalog sites to choose from |
| `manual-add-models` | | yes | Adds model ids by hand when the provider cannot list them |
| `list-custom-providers` | | yes | Lists providers and their models |
| `reprobe-models` | yes | yes | Checks one provider and lists model changes |
| `apply-reconcile` | yes | yes | Saves your decisions about model changes |
| `refresh-models` | yes | yes | Refreshes the models of every provider |
| `edit-provider` | yes | | Edits a provider |
| `rename-provider` | | yes | Renames a provider and keeps its models, address and key |
| `delete-provider` | yes | yes | Removes a provider |
| `delete-models` | yes | yes | Removes models (on OpenCode v2, all of them or none) |

## Configuration

A provider is saved in OpenCode's config. You can also write one by hand:

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

The plugin looks for models on providers that have `options.baseURL` and either `"dynamic": true` or no saved models.

**Where the API key is stored**, in order of preference:

1. OpenCode's own credential store (the menu saves here).
2. An environment variable: `OPENCODE_LOCAL_<ID>_API_KEY`, where `<ID>` is the provider id in capitals.
3. An old inline `apiKey` in the config. It moves to the credential store the next time you edit the provider, and is never written again.

Model rules are kept in `~/.opencode-custom-providers-rules.json`.

## Security

- Keys are kept in OpenCode's credential store, not in plain text in your project.
- Error messages hide keys and tokens before they are shown or logged.
- A provider that comes from OpenCode's own config is shown but not changed by the plugin.

## For developers

```bash
npm install && npm run build   # clear dist/, then compile with tsc
npm test                       # build, then run the node tests
npm run test:src               # run the vitest suite
npm run typecheck:tests        # type-check src and tests
npm run lint                   # run eslint
npm run bundles                # rebuild the bundles in bundles/
```

## License

MIT © bagasdevs. See [LICENSE](./LICENSE).
