# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
