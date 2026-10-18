# opencode-custom-providers

[![npm version](https://img.shields.io/npm/v/opencode-custom-providers)](https://www.npmjs.com/package/opencode-custom-providers)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![CI](https://github.com/bagasdevs/opencode-custom-providers/actions/workflows/ci.yml/badge.svg)](https://github.com/bagasdevs/opencode-custom-providers/actions)
[![Socket Badge](https://badge.socket.dev/npm/package/opencode-custom-providers/1.0.3)](https://badge.socket.dev/npm/package/opencode-custom-providers/1.0.3)

Add your own AI model providers to OpenCode with a few questions. The plugin finds the
models for you, and you can change or remove them later from the same menu.

| If you use | Install | Menu |
| --- | --- | --- |
| **OpenCode v1** (`>= 1.14.0`) | Steps below | Separate slash commands, such as `/add-provider` |
| **OpenCode v2** (`>= 2.0.0`) | Steps below | One menu: `/custom-providers` |

Not sure which one you have? Check the version shown by `opencode`.

Both versions are served from one package: the plugin exports the OpenCode v1 hook and the
OpenCode v2 `Plugin.define({ id, setup })` entry point side by side, so the same install works
on either. On v2 the plugin loads through `@opencode/plugin`.

## Install

```bash
opencode plugin add opencode-custom-providers
```

Then check that it loaded and restart OpenCode:

```bash
opencode plugin list
```

It should appear in the list as `opencode-custom-providers`.

Installing from GitHub instead: `bun add github:bagasdevs/opencode-custom-providers && bun pm trust opencode-custom-providers`.

## Add your first provider

Use the same steps on both versions. Only the way you open the menu is different.

1. Open the menu:
   - **OpenCode v2:** type `/custom-providers`.
   - **OpenCode v1:** type `/add-provider`.
2. Choose **My own API**.
3. Enter the address (for example `https://api.example.com/v1`) and your API key.
4. Wait a few seconds. The models are found and saved for you.

The provider is ready as soon as those steps finish: it appears in the menu, its models
appear in the model picker, and checking it again compares against what was just saved.
You do not need to restart OpenCode in between.

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
| `/add-provider` | Adds a provider. Choose **My own API** or **Built-in list** |
| `/edit-provider` | Changes a provider |
| `/delete-provider` | Removes a provider and its models |
| `/reload-models` | Refreshes the models of every provider |
| `/reprobe-models` | Checks a provider again and shows what changed |

OpenCode v1 has no command for listing providers; `/edit-provider` shows them first.

Press Esc to cancel. Esc reports the cancellation once.

## Difference between the two versions

| | OpenCode v1 | OpenCode v2 |
| --- | --- | --- |
| Open the menu | Separate commands | `/custom-providers` |
| Reload | `/reload-models` | Reload all models in the menu |
| Review model changes | `/reprobe-models` | Use Reload, then Edit |
| Plugin entry points | `server` / `tui` exports | `./server` and `./tui`, each with `Plugin.define` |

An OpenCode v1 plugin does not run on OpenCode v2, and the reverse is also true. This package
ships both entry points, so one install covers whichever version you have. To move to OpenCode
v2, run `opencode upgrade --major`, then install the plugin again.

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

On OpenCode v1 a provider is saved in OpenCode's config. You can also write one by hand:

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

On OpenCode v2 the provider list is kept in the host's own plugin storage instead, and the
config block above is not read. Providers added on v1 do not appear on v2, and the reverse:
each version keeps its own list.

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

Two host packages are involved, and they are not interchangeable:

- `@opencode-ai/plugin` (v1) — the `server` and `tui` hooks.
- `@opencode/plugin` (v2) — `Plugin.define`, the context types, and the RPC/TUI surface.

Both are peer and dev dependencies, never runtime ones. Each host provides its own package when
loading a plugin, so nothing has to be installed alongside this one; publishing either as a
runtime dependency would pull `effect` and its chain (about 54 MB) into every consumer. The
package ships with an empty `dependencies`, and `tests/v2-contract.test.ts` fails if that
changes.

The bundles in `bundles/` alias `@opencode/plugin` to `scripts/v2-plugin-stub.mjs`, which
re-exports the same identity `define`. That keeps one bundle loadable on both hosts, because a
bundle is copied to a plugins directory that has no `node_modules`.

## License

MIT © bagasdevs. See [LICENSE](./LICENSE).
