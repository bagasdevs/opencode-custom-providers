# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-10-10

Re-probing stops overwriting hand-tuned models, and the v2 write path refuses, remembers and reports honestly.

OpenCode 2 support, and a beginner-proof setup path on both hosts.

### Added
- On OpenCode 2, the Edit menu has "Add models manually" (adds typed model ids, keeps the existing ones) and clears the saved API key when the key field is left empty, after a confirmation
- Bulk model delete on OpenCode 2: the `delete-models` agent tool and the "Delete models" entry in the v2 edit menu. It is all-or-nothing, so one id that does not exist deletes nothing
- Provider rename on OpenCode 2: the `rename-provider` agent tool and the "Rename provider" entry in the v2 edit menu. The renamed entry keeps its slot, and an id of `__proto__` survives the write
- OpenCode 2 server plugin (`src/server-v2.ts`): provider discovery through the v2 provider registry, credential-backed API keys, and nine agent tools
- OpenCode 2 TUI plugin (`src/tui-v2.ts`): palette and slash commands for add, catalog add, re-probe, reconcile, edit, delete, refresh, list
- Manual model entry for endpoints that cannot list models (no `/models` route, blocked gateway, or a key that is not available yet)
- A failed or empty probe now offers retry / add-models-manually / cancel instead of a dead-end alert
- URL repair: a bare host or a pasted endpoint path is normalised before it is validated
- Confirmation before replacing an existing provider, and before adding a second provider on an address already in use
- Wizard state persists through host storage; the server exposes it to the TUI over RPC

### Changed
- On OpenCode 2, an edited model whose endpoint limits differ shows "Use the endpoint's values" in the edit menu. It writes only the context and reply limits and keeps the rest of the model's settings
- Reload says which hand-edited models kept their values while the endpoint reports other limits, and how to take the endpoint's values
- On OpenCode 2, Reload removes a model the endpoint no longer lists, and says so in its message. A failed or empty answer from the endpoint removes nothing
- Re-probe no longer overwrites stored model data with a guess. Only a gateway measurement or a catalog lookup counts as authoritative, so a stored thinking level, image toggle or token limit survives the next probe, and a guess is no longer reported as an update
- The v2 edit wizard is a loop: Esc inside a field returns to the menu, and only Esc at the menu leaves. An empty value writes nothing instead of a half-finished field
- The v2 write path asks before it replaces an existing provider on every path (`add-provider`, `manual-add-models`, `add-from-catalog`), and it asks about a provider declared in opencode's own config, not only in the plugin's storage
- The address that answered is remembered, so a bare host becomes the `/v1` variant that worked instead of re-walking the candidate list on every probe
- A re-probe that cannot read its stored-model snapshot says so, rather than diffing against an empty map and reporting six saved models as six new ones
- A vanished model's review row reads "Remove this model" instead of "Take the new values", since the decision behind it deletes the model, and the review option comes first so the safest choice sits under the cursor
- `catalog.add` refuses a provider id that matches a built-in provider, the way `add` and `manual-add-models` already did
- `editModel` validates a token limit at the RPC, and a stored value that is not a whole number reads as unset rather than being carried forward
- A failed storage read no longer counts as an empty store, so a transient failure cannot delete every provider on the next write
- A failed remove reports its failure instead of a success toast, and a failed reload is no longer reported as a failed write
- The v1 surface repairs addresses the way v2 does: a bare host is normalised, and a string that is not a host is no longer given an invented scheme
- A credential in a URL fragment is stripped before anything is logged
- The build clears `dist/` before compiling, so a file whose source is gone can no longer ship
- Reconcile defaults to the safe row: an omitted per-model decision keeps a stored model and applies only a new one
- `/add-from-catalog` is no longer an alias of `/add-known-provider`. It never was a TUI command in an earlier release, no message pointed users at it, and it only duplicated one palette entry. `add-from-catalog` remains the model-facing agent tool.
- The README command reference now separates slash commands from agent tools, states which names belong to OpenCode 1, and documents the v2 commands that were missing
- The catalog only offers sites that can actually be added (those without a usable address are filtered out)
- Removing a provider also removes its models, and it stays removed across a restart
- The API key can be cleared, and a failed key save no longer claims the key survives a restart
- `postinstall` writes one plugin directory with the same file names the README documents, and clears the loose bundles an earlier release left behind
- Comments trimmed across `src/` to the minimal senior style

### Fixed
- `applyModelFields` writes `variants` as well as `reasoning` and `thinkingLevelMap`, so editing a model's thinking level reaches the model picker. `readModelFields` reads the ceiling back from `variants` first, so a probed model no longer reads as "off" when the endpoint names thinking levels
- A rebuild of the provider key order no longer drops a `__proto__` provider: the rebuild and the write-back both use `defineProperty`
- Esc during the catalog flow no longer turns an escaped model list into "add every model"
- A probe that returned the same number of models reported "Up to date" even when a model's metadata had changed
- Adding a built-in provider name (for example `openai`) overwrote that provider instead of warning

### Note
- `1.0.1` was published from a tree whose `dist/` predated the OpenCode 2 work, so that release shipped without `dist/server-v2.js` and `dist/tui-v2.js`. `1.0.2` is the first published release that actually contains them.

## [1.0.0] - 2026-10-10

First release as an independent project (rebuilt from opencode-dynamic-custom-providers).

### Added
- Full provider wizard (TUI + agent tools): add, edit, rename, re-probe, bulk delete, per-model edit, manual entry with resolved previews
- Add-from-catalog flow: pick a models.dev site, add all or selected models without probing
- Endpoint flavors: openai-chat, openai-responses, anthropic, gemini, ollama (list paths, fallback limits, built-in id collision warning)
- Tiered metadata resolution (detected > models.dev > local rules > API fallback > defaults) with per-field source tags; cost is never guessed
- Deep gateway sources: per-model detail, LiteLLM info, public catalogs, inline pricing, Ollama show, reasoning effort options, developer-role probe
- Tri-state reconcile (apply / keep / remove) with stored-field carry-forward on apply
- Static v1/v2 client bridges (`src/opencode-client.ts`); zero `as never` in `src/`
- Bounded probing (per-model pool, provider chunks, TTL-aware cache, memoized catalog/rules)
- Postinstall auto-place: `bun add`/`npm i`/`pnpm add` copies prebuilt bundles into the opencode plugins dir (opt-out via `OPENCODE_NO_AUTOPLACE`)
- One-line installers (`install.ps1`, `install.sh`) + prebuilt bundles per release
- Vitest suites (104 tests), ESLint gate, `typecheck:tests`, CI workflow, git hooks

### Security
- API keys fail loudly instead of falling back to plain text; rotation deletes the legacy inline copy; clearing the key in the TUI removes the stored credential
