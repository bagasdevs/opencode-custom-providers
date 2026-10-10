# Joined Risk & Gap Plan — every safety net we lack, ranked by beginner hurt

> Sources: `safety-nets.md` (better-custom-provider@1.6.0 — every recovery path with verbatim strings) and `ours-vs-theirs.md` (gap table, 18 capabilities, lines from both codebases). Every item below cites both.
> How to read severity: **P0** = beginner is stuck with no path forward; **P1** = beginner is misled or silently loses work; **P2** = beginner succeeds but with degraded quality or extra manual work.

---

## 0. What we already do correctly — keep

| # | capability | theirs ref | ours ref | note |
|---|------------|------------|----------|------|
| K1 | **Per-field honest sourcing** ("reported by your provider" / "assumed default" / "estimated default") | `safety-nets.md` §12 — not a numbered safety net; `ours-vs-theirs.md` #17 (theirs tags `[models.dev]` / `[local rules]`, omits defaults) | `src/probe.ts:371-396 describeProbed` + `src/probe.ts:302-396` (5-tier source tracking) | Keep. Our copy is clearer than theirs. One inconsistency to fix: `apply` mode re-applies fresh values even under "keep" — see G2 below. |
| K2 | **Numbered beginner copy & actionable error text** ("Step 1 of 5", "Fix it with /edit-provider … then /reload-models") | `safety-nets.md` §2, §9 — theirs is terse ("Provider style", "Endpoint", "API key"); `ours-vs-theirs.md` #18 | `src/tui-v2.ts:141-230`, `src/server-v2.ts:341-455 probeHint/zeroModelsHint` | Keep, but fix factual errors: Anthropic catalog recommendation (#9) and stale "pending" hint. |
| K3 | **Error-message redaction / sanitization** | `safety-nets.md` §2, §9 — theirs surfaces raw endpoint messages with scheme hints | `src/security.ts:22-44 sanitizeErrorMessage` + `src/endpoint.ts:62 sanitizeErrorMessage` | Keep. Theirs leaks the raw error text into notifies; ours redacts URLs/tokens and truncates to 400 chars — strictly safer. |
| K4 | **Cost is never guessed** | `safety-nets.md` — no separate cost safety net; covered by `model-probe` metadata families | `src/probe.ts:302+ resolveModel` — cost only from `detected` or `models.dev`, never from rules/fallback | Keep. Both sides do this; ours is explicit in code. |
| K5 | **API key sanitization in logs** | `safety-nets.md` §9c — theirs resolves `env`/`shell` best-effort at probe time | `src/security.ts:28-35 sanitizeErrorMessage` + `src/server-v2.ts:296 credentialKey` | Keep. |

---

## 1. Ranked gaps — every safety net we lack (worst hurt first)

### P0 — beginner is stuck: no path forward

#### G1 — Manual model entry when probing fails or returns nothing
- **Safety nets**: `safety-nets.md` §2 (probe failure -> Retry / Add manually / Cancel) and §3 (empty list -> auto-switch to manual) and §10 (manual-entry escape hatch: `promptManualModels`, metadata menu, 256K default).
- **Gap ref**: `ours-vs-theirs.md` #3 — theirs `src/flows/add.ts:197-215` + `src/flows/add.ts:171-176` + `src/ui/prompts.ts:126-190`; ours v2 has no manual-entry code at all (`src/tui-v2.ts`, `src/server-v2.ts` contain no manual branch) — `src/server-v2.ts:437` instead returns `"Nothing was saved: the address … did not answer with a model list"` and aborts.
- **Theirs files/lines**: `ref/better-custom-main/src/flows/add.ts:171-215`, `ref/better-custom-main/src/ui/prompts.ts:126-190`, `ref/better-custom-main/src/model-entry.ts:186-198`.
- **Ours files/lines today**: `src/server-v2.ts:401-473 add` (abort path at `:437`), `src/tui-v2.ts:140-270 wizardAdd` (no retry/manual branch), `src/probe.ts:302-340 probeEndpoint` (throws on failure, no recovery).
- **Beginner hurt**: A local gateway behind a firewall, a provider that blocks /models without a key, or an endpoint with no /models route leaves the beginner with a dead end. Theirs lets them type ids and finish; ours tells them to try again or use a catalog that may not exist for their provider.
- **Concrete change to our plugin**:
  1. In `src/server-v2.ts:add` catch the throw from `probeEndpoint` and return a structured `{ status: "manual_required", message, endpoint }` so the TUI can branch.
  2. Add `src/server-v2.ts:manualAdd` RPC: `{ providerId, baseURL, modelIds: string[], displayStyle }` — reuses `previewManualModels` / `resolveModel` for defaults + `probedToDraft` to store; validates `isValidUrl` and `collisionSuggestion` before writing.
  3. In `src/tui-v2.ts:wizardAdd` after the `add` call, if `status === "manual_required"` show a `select` with Retry / Add manually / Cancel (mirrors `safety-nets.md` §2 labels) and on "Add manually" prompt comma-separated ids, then call `manualAdd`.
  4. Expose "Add manually" when `fresh.length === 0` (mirrors §3).
  5. Add an `Add models manually` action to `wizardEdit` for existing providers (mirrors §10).

#### G2 — Reconcile shows only id diffs; metadata diffs are invisible and cannot be applied
- **Safety nets**: `safety-nets.md` §11 (re-probe reconciliation: models with metadata diffs default to `[-] keep without update`, picker legend `[ ] remove/skip · [-] keep without update · [x] keep/add with latest metadata`, no-op `"No changes — everything … up to date."`).
- **Gap ref**: `ours-vs-theirs.md` #2 — theirs `src/flows/edit.ts:457-505 diffStoredModel/applyMetaChanges`; ours `src/server-v2.ts:600-638 reprobe` compares only ids — `"Up to date: the provider still lists the same 1 model. Nothing to do."` — and `apply` cannot update an existing model's context/cost.
- **Theirs files/lines**: `ref/better-custom-main/src/flows/edit.ts:457-505`, `ref/better-custom-main/src/reconcile.ts:describeUpdate` equivalent, `ref/better-custom-main/src/model-entry.ts`.
- **Ours files/lines today**: `src/server-v2.ts:606-640 reprobe` (only `added`/`vanished` sets), `src/server-v2.ts:641-710 apply` (decision map only handles add/keep/remove, never field-level update), `src/reconcile.ts` (already implements field diffs for v1 — unused in v2), `src/v2-models.ts:probedToDraft`.
- **Beginner hurt**: The provider silently raises context from 128K to 1M or changes price; the beginner sees "Up to date" and never learns stored limits are stale. Updates require deleting and re-adding the provider by hand.
- **Concrete change to our plugin**:
  1. In `src/server-v2.ts:reprobe` diff each fresh id against the stored draft field-by-field (`context`, `output`, `image`, `reasoning`, `cost`) and render `context 100000→200000`, `max-out 8192→16000`, `image [+]` per model (reuse `src/reconcile.ts:describeUpdate`).
  2. In `src/server-v2.ts:apply` add handling so `apply` for an already-stored id overwrites stored metadata with the fresh draft (today it defaults to `keep` and skips the update).
  3. In `src/tui-v2.ts:wizardApplyReconcile` render the metadata diff lines in the confirm dialog before the Apply/Keep choice.
  4. Regression test: store a model with `context 100k`, reprobe returns same id with `context 200k`, then `reprobe` must mention the diff and `apply` must update it.

#### G3 — Delete does not stick (and credential survives delete)
- **Safety nets**: `safety-nets.md` §11 (Delete provider: confirm dialog, on success `Deleted provider "${providerId}" from ${MODELS_JSON_PATH}` and `auth.json` entry dropped best-effort).
- **Gap ref**: `ours-vs-theirs.md` #14 (theirs deletes; ours `src/server-v2.ts:568-602 remove` sets `dynamic:false` but leaves host record — reappears as "NOT READY", `/reload-models` resurrects models, second delete says `"comes from your opencode config"`) + #4 (theirs `src/config.ts:160-192 removeProviderApiKey`; ours never deletes credential — proven in `logs/ours-zombie2.log`).
- **Theirs files/lines**: `ref/better-custom-main/src/flows/delete.ts`, `ref/better-custom-main/src/config.ts:160-192`.
- **Ours files/lines today**: `src/server-v2.ts:568-602 remove` (marks `dynamic:false`, removes discovered models but not the host provider record), no credential delete call.
- **Beginner hurt**: Beginner deletes a mistaken provider, sees "Removed", then finds it back on the next reload. Rotating a leaked key by "delete and re-add" leaves the old key in the credential store.
- **Concrete change to our plugin**:
  1. In `src/server-v2.ts:remove` after `managed.delete` + `persist()`, also deactivate/remove the host provider record so `candidateFrom` never resurrects it — verify `list` no longer returns it.
  2. Delete the stored credential via the integration connection API, best-effort with a warning on failure (mirrors `safety-nets.md` §9d).
  3. Keep the confirm dialog in `src/tui-v2.ts:wizardDelete` but surface the new post-delete semantics.
  4. Regression test: `add` -> `remove` -> `list` must not contain the id; credential lookup must be undefined.

#### G4 — Catalog add offers un-addable sites (including the Anthropic path the wizard recommends)
- **Safety nets**: `safety-nets.md` §11 (catalog unreachable -> `"Could not fetch the models.dev catalog: …"` — flow returns to menu); theirs additionally filters to usable `baseUrl` only.
- **Gap ref**: `ours-vs-theirs.md` #9 — theirs `src/flows/add.ts:80-90` lists only providers with a usable `baseUrl`; ours `src/catalog.ts:summarizeCatalog` lists all 226 sites including 25 with no `api` URL; choosing Anthropic/OpenAI/Google/Groq/Mistral fails `"no usable web address"` — proven in `logs/ours-catalog-broken.log`. The v2 wizard tells Claude users to use the catalog but the catalog itself cannot add that site.
- **Theirs files/lines**: `ref/better-custom-main/src/flows/add.ts:80-90`, `ref/better-custom-main/src/flows/shared.ts` (catalog tiers).
- **Ours files/lines today**: `src/catalog.ts:120-150 summarizeCatalog`, `src/server-v2.ts:728-770 catalog.list / catalog.add` (add at `:750` returns `"no usable web address"` after the user already picked it), `src/tui-v2.ts:271-290 wizardCatalogAdd`, `src/tui-v2.ts:220-230` Anthropic branch.
- **Beginner hurt**: The wizard tells Claude users to go to the catalog, where Anthropic cannot be added. Beginners pick OpenAI/Anthropic/Google from the list (biggest names) and get a dead-end error.
- **Concrete change to our plugin**:
  1. In `src/catalog.ts:summarizeCatalog` filter to `p.api && isValidUrl(p.api)` so `catalog.list` never offers a site that `catalog.add` will reject.
  2. Ship per-site base URLs for the top 5 missing sites (Anthropic, OpenAI, Google, Groq, Mistral) or keep them in the list with a note + a working base URL.
  3. In `src/tui-v2.ts:wizardAdd` fix the Anthropic flavor branch: instead of `"Run /add-from-catalog and pick Anthropic"`, either do the filtered catalog add inline or explain that Anthropic requires manual model entry.
  4. In `src/server-v2.ts:catalogAdd` include the filtered count in the error path so a future regression is obvious.

#### G5 — URL entry rejects bare hosts and pasted endpoint paths
- **Safety nets**: `safety-nets.md` §1a-1b — theirs repairs missing scheme (`src/url.ts:addDefaultScheme`: bare `example.com/v1` -> `https://`, local -> `http://`) and strips endpoint suffixes (`normalizeEndpoint`: `/chat/completions`, `/models`, `/responses`, `/messages` -> stripped; local detection by prefix `localhost`, `127.`, `192.168.`, etc.).
- **Gap ref**: `ours-vs-theirs.md` #12 — theirs `src/url.ts:1-45`; ours `src/security.ts:3-8 isValidUrl` requires `http(s)://` and `src/tui-v2.ts:186` + `src/server-v2.ts:412` reject `localhost:11434/v1` with `"That address could not be read"`.
- **Theirs files/lines**: `ref/better-custom-main/src/url.ts:1-45` (`addDefaultScheme`, `normalizeEndpoint`).
- **Ours files/lines today**: `src/security.ts:3-8 isValidUrl` (strict), `src/endpoint.ts:1,42 normalizeModelId / fetchEndpointModels` (no normalization before validation), `src/tui-v2.ts:160-190 wizardAdd URL loop`, `src/server-v2.ts:412 add` + `:485 edit`.
- **Beginner hurt**: Copy-paste from docs often includes no scheme (`api.example.com/v1`) or a full path (`https://api.example.com/v1/chat/completions`); local Ollama users type `localhost:11434`. Theirs accepts all; ours rejects them and makes the beginner guess the exact string format.
- **Concrete change to our plugin**:
  1. Add `src/endpoint.ts:normalizeBaseUrl(raw: string): string` — infer scheme (local -> `http://`, else `https://`) when missing, then strip known endpoint suffixes (`/chat/completions`, `/models`, `/responses`, etc.) per API flavor, mirroring `ref/better-custom-main/src/url.ts:1-45`.
  2. Call it at the top of `src/tui-v2.ts:wizardAdd` and `src/tui-v2.ts:wizardEdit` before `isValidUrl`, and in `src/server-v2.ts:add/edit` before validation — keep the strict check as a second pass.
  3. Reuse the normalized value as the stored `baseURL` so probing starts from the right path.
  4. Unit test table: `localhost:11434/v1` -> `http://localhost:11434/v1`, `api.example.com/v1/chat/completions` -> `https://api.example.com/v1`, etc.

#### G6 — Add-to-existing-provider silently overwrites
- **Safety nets**: `safety-nets.md` §7 — theirs `src/ui/prompts.ts:236-260` loops on duplicate id (`Provider "${id}" already exists. Choose a different name.`) and `src/flows/shared.ts:180-200 persistProvider` refuses to overwrite on a race.
- **Gap ref**: `ours-vs-theirs.md` #13 — theirs prompts + backstop; ours v2 TUI has no guard — re-running `/add-provider` with the same id silently replaces the managed entry and re-probes (proven in `logs/ours-final-checks.log G1/G2`, `logs/ours-overwrite.log D2`).
- **Theirs files/lines**: `ref/better-custom-main/src/ui/prompts.ts:236-260`, `ref/better-custom-main/src/flows/shared.ts:180-200`.
- **Ours files/lines today**: `src/tui-v2.ts:140-270 wizardAdd` (no existence check after id prompt), `src/server-v2.ts:401-473 add` (overwrites `managed.set` without confirming; only blocked for built-in ids via `collisionSuggestion`).
- **Beginner hurt**: Beginner mistypes a name, re-runs add, and unknowingly replaces the endpoint and models of an existing provider that was working.
- **Concrete change to our plugin**:
  1. In `src/tui-v2.ts:wizardAdd` after id validation, check `list` for an existing id and if found `confirm` "A provider named `${id}` already exists. Replace it?" — on No, re-prompt for a name.
  2. In `src/server-v2.ts:add` if `managed.has(providerId)` and not `input.overwrite`, return a confirm-style message (or require `overwrite=true`) instead of silently replacing.
  3. Headless test: `add("dup")` -> `add("dup")` without overwrite must not replace.

---

### P1 — beginner is misled or silently loses work

#### G7 — Reconcile TUI is not per-model (tri-state picker lives only on raw RPC)
- **Safety nets**: `safety-nets.md` §11 (re-probe picker: `[ ] remove/skip · [-] keep without update · [x] keep/add with latest metadata`; new models default `[ ]`, changed models default `[-]`; stale models listed with `· unsupported` suffix).
- **Gap ref**: `ours-vs-theirs.md` #5 — theirs `src/flows/edit.ts:600-660` tri-state; ours `src/tui-v2.ts:293-303 wizardApplyReconcile` offers only whole-provider "Apply everything" / "Keep what I have" while per-model decisions exist only as raw JSON on `src/server-v2.ts:641-665 apply`.
- **Theirs files/lines**: `ref/better-custom-main/src/flows/edit.ts:600-660`.
- **Ours files/lines today**: `src/tui-v2.ts:293-303 wizardApplyReconcile` (binary choice), `src/server-v2.ts:641-665 apply` (per-model decisions map exists but is TUI-inaccessible).
- **Beginner hurt**: Beginner cannot keep one new model without taking all of them, and cannot update metadata for one model without affecting others.
- **Concrete change to our plugin**:
  1. Replace the binary select in `src/tui-v2.ts:wizardApplyReconcile` with a per-model tri-state picker: for each added/vanished/changed id show a select of `Apply / Keep / Remove` (default: new -> Apply, vanished/changed -> Keep).
  2. Collect the resulting `decisions` map and pass it to `server-v2.ts:apply`'s `decisions` JSON param.

#### G8 — API key lifecycle holes: cannot clear a key, delete leaves it behind, no rename with migration
- **Safety nets**: `safety-nets.md` §9a-9d — theirs: `None` option -> `"dummy"`/`"ollama"` placeholder (`src/api-key.ts:serializeApiKey`), `persistApiKey` after `persistProvider` with `/login` hint on failure, best-effort credential migration on rename (`renameProviderApiKey`) and removal on delete (`removeProviderApiKey`), corrupt `auth.json` is non-fatal.
- **Gap ref**: `ours-vs-theirs.md` #4 + #10 — theirs `src/config.ts:160-192` full lifecycle; ours v2 `remove` never deletes credential (G3 covers delete), `edit` ignores empty string (`"Saved. 'twice' is unchanged."` — `src/tui-v2.ts:335` + `src/server-v2.ts:474-555 edit`), and there is no rename at all.
- **Theirs files/lines**: `ref/better-custom-main/src/api-key.ts`, `ref/better-custom-main/src/config.ts:160-192`, `ref/better-custom-main/src/flows/edit.ts:196-258 rename`.
- **Ours files/lines today**: `src/server-v2.ts:474-555 edit` (apiKey branch at `:495` — only acts when `input.apiKey` is truthy; empty string is ignored), `src/tui-v2.ts:317-345 wizardEdit` (apiKey prompt returns `undefined` on Esc but `""` on empty — both treated as "no change").
- **Beginner hurt**: Cannot switch a provider from authenticated to local/no-key without deleting it; a leaked key cannot be rotated by clearing then re-adding; renaming (when rename ships) would orphan the key.
- **Concrete change to our plugin**:
  1. In `src/tui-v2.ts:wizardEdit` for the `apiKey` field offer an explicit "Clear API key" option (or treat a sentinel / confirm dialog), then call `edit` with a dedicated `clearApiKey: true` flag.
  2. In `src/server-v2.ts:edit` handle that flag: delete the credential via the integration connection API, best-effort.
  3. When rename ships (G9), migrate the credential: read active connection for old id and `connect.key` for new id, best-effort.

#### G9 — Provider rename does not exist (v2)
- **Safety nets**: `safety-nets.md` §6 (collision handling on rename), §7 (rename duplicate check), §9d (credential migration on rename).
- **Gap ref**: `ours-vs-theirs.md` #10 — theirs `src/flows/edit.ts:196-258` (slugify, uniqueness, collision, position-preserving rewrite, credential migration); ours v2 has zero `rename` hits in `src/tui-v2.ts`/`src/server-v2.ts`; v1 `src/tui.ts:452-467` renames but leaves credential under old id.
- **Theirs files/lines**: `ref/better-custom-main/src/flows/edit.ts:196-258`.
- **Ours files/lines today**: no `rename` handler in `src/server-v2.ts`; `src/tui-v2.ts` has no rename entry.
- **Beginner hurt**: Typo in provider name is permanent without hand-editing the config file; collides with built-in names cannot be fixed without delete+re-add (loses models).
- **Concrete change to our plugin**:
  1. Add `src/server-v2.ts:rename` RPC: `{ from, to }` — validate id pattern, `collisionSuggestion(to)`, uniqueness, then move `managed` entry + discovered models + credential.
  2. Add `src/tui-v2.ts:wizardRename` + slash command `rename-provider` with same collision/duplicate guards as `wizardAdd`.

#### G10 — No per-model / bulk model delete
- **Safety nets**: `safety-nets.md` §6 (delete-model confirmation adds built-in collision note), §11 (model vanished / provider has no models warnings).
- **Gap ref**: `ours-vs-theirs.md` #8 — theirs `src/flows/edit.ts:265-305` (bulk) + `355-370` (single); ours v1 has it (`src/tui.ts:604-628`), v2 has no model-delete path — `remove` only deletes whole providers.
- **Theirs files/lines**: `ref/better-custom-main/src/flows/edit.ts:265-370`.
- **Ours files/lines today**: `src/server-v2.ts:568-602 remove` (provider only), `src/tui-v2.ts:wizardDelete` (provider only).
- **Beginner hurt**: Cannot remove a stale or bad model without deleting the whole provider and re-probing.
- **Concrete change to our plugin**:
  1. Add `src/server-v2.ts:deleteModels` RPC: `{ providerId, modelIds: string[] }` — remove from `discovered` + host provider record, reload.
  2. Add `src/tui-v2.ts:wizardDeleteModels` with multi-select list of current models + confirm dialog (reuses `pickProvider`).

#### G11 — Built-in id collision set is incomplete (12 vs 39)
- **Safety nets**: `safety-nets.md` §6 — theirs `src/config.ts:68-110 BUILTIN_PROVIDER_IDS` (39 ids: `amazon-bedrock` … `zai-coding-cn` incl. `openai`, `anthropic`, `deepseek`, `groq`, `openrouter`) + `BUILTIN_COLLISION_WARNING` + `resolveBuiltinCollision` (`src/ui/prompts.ts`).
- **Gap ref**: `ours-vs-theirs.md` #11 — theirs 39 ids; ours `src/flavors.ts:75-79 BUILT_IN_IDS` has 12 (misses `azure-openai-responses`, `opencode`, `github-copilot`, `mistral`, `zai`, `minimax`, `together`, `vercel-ai-gateway`, etc.).
- **Theirs files/lines**: `ref/better-custom-main/src/config.ts:68-110`.
- **Ours files/lines today**: `src/flavors.ts:75-79 BUILT_IN_IDS` (12 ids), `src/flavors.ts:80-86 collisionSuggestion` (reads that set).
- **Beginner hurt**: Naming a provider `mistral`, `zai`, `opencode`, etc. silently merges with the host's built-in provider and its model catalog; symptoms (models reappearing after delete, auth sharing) are baffling.
- **Concrete change to our plugin**:
  1. Sync `src/flavors.ts:BUILT_IN_IDS` to the 39 ids from `ref/better-custom-main/src/config.ts:68-110` (or derive it from the host's provider list at startup if an API exists).
  2. Add a comment citing the upstream source + date so the next sync is diffable.

#### G12 — No /v1 or http→https fallback completeness
- **Safety nets**: `safety-nets.md` §4 (/v1 fallback: `model-probe/src/probe.ts:probeBaseVariants` — tries base as-given, then with `/v1` added/removed; 404/timeout/non-JSON fall through) and §5 (http→https fallback for non-local hosts, local exempt).
- **Gap ref**: not a standalone gap-table row, but noted in `ours-vs-theirs.md` §16 (probing families) and implied by `safety-nets.md` §4-5.
- **Theirs files/lines**: `ref/better-custom-main model-probe@0.7.0 src/probe.ts:probeBaseVariants` (inside dependency, not our ref checkout — behavior proven via §12 A6 live servers).
- **Ours files/lines today**: `src/probe.ts:37-55 buildCandidateUrls` (adds `/v1` variant and `https` for non-local `http`) — BUT local-host check covers only `localhost`/`127.0.0.1`/`::1`, missing `10.`, `192.168.`, `172.16-31.`, `0.0.0.0`, `*.local`, `[` as in theirs; and `src/endpoint.ts:42-70 fetchEndpointModels` bypasses candidates entirely (direct fetch).
- **Beginner hurt**: Beginner pastes `https://api.example.com` (without `/v1`) or uses `http://` on a host that only serves `https`; probe fails even though the provider is reachable at the fallback variant. Local hosts incorrectly get https variants.
- **Concrete change to our plugin**:
  1. Expand `src/probe.ts:buildCandidateUrls` local-host check to match theirs (`10.`, `192.168.`, `172.16-31.`, `0.0.0.0`, `*.local`, `[::1]`) so `http→https` is not attempted for any local address.
  2. Ensure `src/probe.ts:probeEndpoint` is the sole fetch path — remove or deprecate `src/endpoint.ts:fetchEndpointModels` direct fetch that bypasses candidates.
  3. Verify `src/server-v2.ts:add/edit/reprobe/apply/refresh` all go through `discover()` -> `probeEndpoint` (they do today) so the fallback is exercised.

---

### P2 — beginner succeeds but with degraded quality or extra work

#### G13 — Probe failure / retry / cancel UX is a dead-end string, not a menu
- **Safety nets**: `safety-nets.md` §2 (probe failure menu: Retry / Add manually / Cancel — with scheme hint `"No http:// or https:// was provided."`), §1c (genuinely unparseable -> notify + abort cleanly, nothing persisted).
- **Gap ref**: implied by `ours-vs-theirs.md` #3 + #12; ours `src/server-v2.ts:437` returns a single error string with `probeHint` but no structured next-step choice.
- **Theirs files/lines**: `ref/better-custom-main/src/flows/add.ts:197-240` (`collectModelIds` menu), `ref/better-custom-main/src/ui/prompts.ts:promptEndpoint`.
- **Ours files/lines today**: `src/server-v2.ts:437 add` error path, `src/tui-v2.ts:wizardAdd` (shows alert with the string, no retry branch).
- **Beginner hurt**: After a typo in the URL the beginner must restart the whole wizard from Step 1 (re-type the name) instead of retrying just the probe.
- **Concrete change to our plugin**:
  1. Structured in G1 — the same Retry branch: in `src/tui-v2.ts:wizardAdd` on manual_required offer Retry (loop back to probe) without re-prompting the name/baseURL unless the user asks to edit it.
  2. Surface the scheme hint from `safety-nets.md` §2 when the baseURL has no explicit scheme.

#### G14 — Duplicate-endpoint is silent (no "already used by …" confirm)
- **Safety nets**: `safety-nets.md` §8 — theirs `src/flows/add.ts:49-64 confirmEndpointReuse` warns `"This endpoint is already used by: - mock-gw"`.
- **Gap ref**: `ours-vs-theirs.md` #15 — theirs warns; ours adds a second provider on the same baseURL silently (proven in `logs/ours-edge2.log H3`).
- **Theirs files/lines**: `ref/better-custom-main/src/flows/add.ts:49-64`.
- **Ours files/lines today**: `src/server-v2.ts:401-473 add` (no endpoint reuse check), `src/tui-v2.ts:wizardAdd` (no check).
- **Beginner hurt**: Beginner adds the same gateway twice under two names and gets duplicated models in the picker; deduping later is manual.
- **Concrete change to our plugin**:
  1. In `src/server-v2.ts:add` before probing, check `managed` values for an existing `baseURL` equal to the normalized candidate base; if found return `{ status: "confirm_endpoint_reuse", usedBy: [ids] }`.
  2. In `src/tui-v2.ts:wizardAdd` on that status show a `confirm` "This endpoint is already used by: … Add another provider with the same endpoint?" — No aborts, Yes continues (mirrors §8).

#### G15 — Per-model metadata editing does not exist (v2)
- **Safety nets**: `safety-nets.md` §11 (metadata refresh: explicit source choice, only real diffs, confirm `Apply ${n} change`).
- **Gap ref**: `ours-vs-theirs.md` #1 — theirs `src/flows/edit.ts:340-352` + `src/ui/prompts.ts:126-190` field picker; ours v2 edit covers only `baseURL/flavor/displayStyle/apiKey` (`src/tui-v2.ts:317-325`); v1 had a narrow version (`src/commands.ts:327-377`) but v2 has none.
- **Theirs files/lines**: `ref/better-custom-main/src/flows/edit.ts:340-380`, `ref/better-custom-main/src/ui/prompts.ts:126-190`.
- **Ours files/lines today**: `src/tui-v2.ts:317-345 wizardEdit` (4 fields), `src/server-v2.ts:474-555 edit` (no model field path).
- **Beginner hurt**: Fixing a single model's context window or image support requires re-probing the whole provider and losing local overrides.
- **Concrete change to our plugin**:
  1. Add `src/server-v2.ts:editModel` RPC: `{ providerId, modelId, patch: { context?, maxOutput?, reasoning?, image?, name? } }` — validate + persist.
  2. Add `src/tui-v2.ts:wizardEditModel` field picker mirroring v1's `ModelField` set at minimum (`name/context/output/reasoning/image`).

#### G16 — Developer-role probe not wired in v2
- **Safety nets**: not a numbered § but covered in `ours-vs-theirs.md` #6 (theirs `src/flows/add.ts:230-240` + `src/model-entry.ts:186-198` writes `compat.supportsDeveloperRole`).
- **Gap ref**: `ours-vs-theirs.md` #6 — theirs probes; ours v1 `src/commands.ts:184 probeDeveloperRole` does, v2 never writes `compat`.
- **Theirs files/lines**: `ref/better-custom-main/src/model-entry.ts:186-198`.
- **Ours files/lines today**: `src/probe.ts` has no developer-role probe; `src/server-v2.ts` never writes `compat`.
- **Beginner hurt**: Models that need `developer` role messages get the default `user` prefix and produce subtly wrong behavior; not a hard failure but a quality loss.
- **Concrete change to our plugin**:
  1. Port `probeDeveloperRole` from v1 into v2's `add` path (single tiny completion probe) and persist `compat: { supportsDeveloperRole: false }` when the probe indicates it.
  2. Expose the flag in `describeProbed` lines so the beginner sees it.

#### G17 — Reasoning effort levels not persisted to variants
- **Safety nets**: tied to `safety-nets.md` §10 (per-model metadata menu defaults reasoning to `xhigh`).
- **Gap ref**: `ours-vs-theirs.md` #7 — theirs `src/model-entry.ts:60-80` + `src/ui/prompts.ts:139-142` maps effort options -> `thinkingLevelMap` (default `xhigh`); ours `src/probe.ts:358 probedToEnriched` computes `reasoningLevels` but `applyEnrichedToDraft`/`probedToDraft` drops it (`variants: []`).
- **Theirs files/lines**: `ref/better-custom-main/src/model-entry.ts:60-80`.
- **Ours files/lines today**: `src/probe.ts:371-396 probedToEnriched` (sets `reasoningLevels`), `src/v2-models.ts:probedToDraft` (does not map it to `variants`), `src/enrich.ts`.
- **Beginner hurt**: Reasoning models lose their effort-level configurability in the opencode UI; they appear but cannot be tuned.
- **Concrete change to our plugin**:
  1. In `src/v2-models.ts:probedToDraft` map `probed.reasoningLevels` -> `draft.variants` (shape `{ id, label, thinkingLevel }` per v2 `Model` type).
  2. Default new reasoning models to `xhigh` when mapping, matching theirs.

#### G18 — Corrupt / unreadable config and catalog failures not all surfaced with the same copy
- **Safety nets**: `safety-nets.md` §11 (corrupt `models.json` -> `"Could not read …: Expected property name …"` abort without crashing host; catalog unreachable through all 3 tiers -> `"Could not fetch the models.dev catalog: …"`; YAML without `yaml` package -> install hint; every write is read-check-write with `Could not write …` error).
- **Gap ref**: not a standalone gap-table row, but referenced in `safety-nets.md` §11 evidence and implied by `ours-vs-theirs.md` §16 (three-tier catalog fetch).
- **Theirs files/lines**: `ref/better-custom-main/src/flows/shared.ts` (read-check-write), `ref/better-custom-main model-probe` (3-tier catalog).
- **Ours files/lines today**: `src/catalog.ts:fetchModelsDevCatalog` already has 2-tier fallback (live fetch -> stale cache); `src/server-v2.ts:setup` does not surface a "catalog unreachable" string — `catalog.list` just returns `[]` and the TUI says `"The built-in catalog is empty"`.
- **Beginner hurt**: Minor — both sides degrade gracefully; the remaining improvement is copy consistency (ensure the TUI says "catalog could not be fetched" rather than "is empty" when the cache is also absent).
- **Concrete change to our plugin**:
  1. In `src/server-v2.ts:catalog.list` propagate a `warning` field when falling back to stale cache or empty, and show it in `src/tui-v2.ts:wizardCatalogAdd` as a toast before the picker.

---

## 2. Summary checklist (copy to tracker)

- [ ] G1 manual entry (P0) — `src/server-v2.ts:add` + `src/tui-v2.ts:wizardAdd`
- [ ] G2 metadata diffs in reconcile (P0) — `src/server-v2.ts:reprobe/apply` + `src/reconcile.ts`
- [ ] G3 delete sticks + credential delete (P0) — `src/server-v2.ts:remove`
- [ ] G4 catalog filtering for un-addable sites (P0) — `src/catalog.ts` + `src/tui-v2.ts`
- [ ] G5 URL normalization before validation (P0) — `src/endpoint.ts:normalizeBaseUrl` + `src/tui-v2.ts` + `src/server-v2.ts`
- [ ] G6 duplicate-name guard (P0) — `src/tui-v2.ts:wizardAdd` + `src/server-v2.ts:add`
- [ ] G7 per-model tri-state picker in TUI (P1) — `src/tui-v2.ts:wizardApplyReconcile`
- [ ] G8 clear-key + credential migration (P1) — `src/server-v2.ts:edit` + `src/tui-v2.ts:wizardEdit`
- [ ] G9 provider rename (P1) — `src/server-v2.ts:rename` + `src/tui-v2.ts:wizardRename`
- [ ] G10 per-model / bulk model delete (P1) — `src/server-v2.ts:deleteModels` + `src/tui-v2.ts:wizardDeleteModels`
- [ ] G11 complete collision set 12->39 (P1) — `src/flavors.ts:BUILT_IN_IDS`
- [ ] G12 /v1 + http->https fallback completeness (P1) — `src/probe.ts:buildCandidateUrls` + `src/endpoint.ts`
- [ ] G13 probe retry without restarting wizard (P2) — G1's Retry branch
- [ ] G14 duplicate-endpoint confirm (P2) — `src/server-v2.ts:add` + `src/tui-v2.ts:wizardAdd`
- [ ] G15 per-model metadata editing (P2) — `src/server-v2.ts:editModel` + `src/tui-v2.ts:wizardEditModel`
- [ ] G16 developer-role probe in v2 (P2) — `src/probe.ts` + `src/server-v2.ts:add`
- [ ] G17 reasoning levels -> variants (P2) — `src/v2-models.ts:probedToDraft`
- [ ] G18 catalog/corrupt-config surfacing polish (P2) — `src/server-v2.ts:catalog.list` + `src/tui-v2.ts:wizardCatalogAdd`

---

## 3. Inputs cited

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/safety-nets.md` — 343 lines, 12 sections (A1–A21 evidence index). Every safety net above cites its § (e.g. §1a scheme repair, §2 probe menu, §6 collision, §8 duplicate endpoint, §11 edit/delete nets).
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/ours-vs-theirs.md` — 33 lines, 18-row gap table. Every gap above cites its # (e.g. #3 manual entry, #12 URL forgiving, #14 delete sticks) and the file:line pairs from both codebases.

---

## 4. How this document was built

Read both inputs in full + grepped our plugin (`src/security.ts:3-8`, `src/probe.ts:37-340`, `src/flavors.ts:75-86`, `src/server-v2.ts:401-710`, `src/tui-v2.ts:140-345`, `src/endpoint.ts:42`, `src/catalog.ts`) to confirm each safety net's present/missing status before ranking. Rank is by beginner hurt if the net is absent: P0 = stuck with no path, P1 = misled / silent data loss, P2 = succeeds with degraded quality.
