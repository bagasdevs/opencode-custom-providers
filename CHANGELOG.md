# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-10-10

OpenCode 2 support, and a beginner-proof setup path on both hosts.

### Added
- OpenCode 2 server plugin (`src/server-v2.ts`): provider discovery through the v2 provider registry, credential-backed API keys, and eight agent tools
- OpenCode 2 TUI plugin (`src/tui-v2.ts`): palette and slash commands for add, catalog add, re-probe, reconcile, edit, delete, refresh, list
- Manual model entry for endpoints that cannot list models (no `/models` route, blocked gateway, or a key that is not available yet)
- A failed or empty probe now offers retry / add-models-manually / cancel instead of a dead-end alert
- URL repair: a bare host or a pasted endpoint path is normalised before it is validated
- Confirmation before replacing an existing provider, and before adding a second provider on an address already in use
- Wizard state persists through host storage; the server exposes it to the TUI over RPC

### Changed
- Reconcile defaults to the safe row: an omitted per-model decision keeps a stored model and applies only a new one
- The catalog only offers sites that can actually be added (those without a usable address are filtered out)
- Removing a provider also removes its models, and it stays removed across a restart
- The API key can be cleared, and a failed key save no longer claims the key survives a restart
- `postinstall` writes one plugin directory with the same file names the README documents, and clears the loose bundles an earlier release left behind
- Comments trimmed across `src/` to the minimal senior style

### Fixed
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
