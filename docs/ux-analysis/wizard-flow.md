# better-custom-provider v1.6.0: End-to-End Wizard Flow

> Reference: `ref/better-custom-main` ("better-custom" / `better-custom-provider@1.6.0`).
> Entry point: `index.ts` → `src/flows/{add,edit,delete}.ts` → `src/ui/{select,prompts}.ts` → `src/flows/shared.ts`.
> The wizard is invoked as `/custom-provider` inside Pi / Oh My Pi.

---

## 0. Invocation & Top-Level Branch

**Command:** `/custom-provider`  
Registered in `index.ts`:

```ts
pi.registerCommand("custom-provider", {
  description: "Wizard for adding, editing, or deleting custom providers in ~/.pi/agent/models.json",
  ...
})
```

**Step 0: Custom providers** (`index.ts:12`, `src/ui/select.ts:selectOne`):

- Title: `"Custom providers"`
- Items (no `description` on this level: labels only):
  - `"Add provider"`
  - `"Edit provider"`
  - `"Delete provider"`
- Widget: `selectOne`: searchable single-select list. Behavior: type to filter, `↑`/`↓` move (wraps), `enter` confirm, `backspace` delete filter, `esc` cancel (aborts the whole wizard, returns to Pi). Window shows 12 items max, with ` 1-12 of N` pagination footer.
- Help footer on every `selectOne` screen: `" Type to search • ↑↓ move (wraps) • enter confirm • backspace delete • esc cancel"`
- Escape hatch: `esc` at this screen exits the wizard with no side effects. Selecting none (`null`) also exits.

Routing:

- `"Add provider"` → `addProviderFlow` (`src/flows/add.ts`)
- `"Edit provider"` → `editProviderFlow` (`src/flows/edit.ts`)
- `"Delete provider"` → `deleteProviderFlow` (`src/flows/delete.ts`)

---

## 1. Add Provider (`src/flows/add.ts:addProviderFlow`)

### Step 1.1: Add provider source

Title: `"Add provider"`: `selectOne` with two rich items:

| value | label | description |
|-------|-------|-------------|
| `catalog` | `"From models.dev catalog"` | `"Known API providers (OpenRouter, DeepSeek, ...) : model list and metadata from models.dev, no probing"` |
| `custom` | `"Custom endpoint"` | `"Any compatible endpoint : auto-detect models, or add them by hand"` |

Escape: `esc` → cancel add flow.

---

### Branch A: From models.dev catalog (`addFromCatalog`)

This branch never probes the gateway. Metadata comes from `models.dev`.

#### Step A1: Fetching the models.dev provider catalog

Info notification before the network call:

> `"Fetching the models.dev provider catalog ..."`

On failure:

> `"Could not fetch the models.dev catalog: <error>"` (error style) → returns `null`, exits branch.

#### Step A2: models.dev providers picker

Title: `"models.dev providers"`: `selectOne` over every catalog entry sorted alphabetically by `name`.

Each item:

- `label`: `p.name` (e.g. `"OpenRouter"`, `"DeepSeek"`)
- `suffix`: `" • <p.baseUrl>"`
- `description` (if `p.env.length > 0`): `"env: <p.env.join(" / ")>"` e.g. `"env: OPENROUTER_API_KEY"`
- `searchText`: `"<p.id> <p.name> <p.baseUrl>"`

Escape: `esc` → cancel.

#### Step A3: Catalog endpoint normalization

Derived internally: `normalizeEndpoint(provider.baseUrl, "openai-completions")`  
(`style` is hard-coded to `"openai"`, `api` to `"openai-completions"`: comment: *"Catalog providers are OpenAI-compatible by construction (they carry a baseUrl); chat completions is the flavor every one of them supports."*)

On invalid baseUrl:

> `"Invalid catalog endpoint "<provider.baseUrl>": <error>"` → exit.

#### Step A4: Endpoint reuse check (`confirmEndpointReuse`)

If `normalizedEndpoint` is already used by any existing provider:

- Title: `"Endpoint already exists"`
- Message: `"This endpoint is already used by:\n- <id>\n- <id>\n\nAdd another provider with the same endpoint?"`
- Widget: `ctx.ui.confirm` (yes/no). `No` exits branch; `Yes` continues.

#### Step A5: Env var hint

If `provider.env.length > 0`:

> `"<provider.name> expects the <env> env var."` (info)

#### Step A6: Provider name (`promptProviderId`)

Function: `promptProviderId(ctx, endpoint.normalized, provider.id)` (`src/ui/prompts.ts:promptProviderId`)

- Input prompt label: if `suggestionTaken` (suggested id already exists) then `"Provider name (must be unique)"` else `"Provider name (blank = <suggestion>)"`
- Placeholder: `"e.g. custom-example-com"`
- Suggested id: `suggestion` arg (`provider.id` from catalog) or derived via `suggestProviderId(endpoint)` → `"custom-<slugified host>"` (e.g. `"custom-api-openrouter-ai"`). User input is `slugify`'d (lowercase, non-alphanumerics → `-`).
- Validation:
  - Empty after slugify → `"Provider name is required."` (error) → re-prompt.
  - Already exists (`existingIds.has(providerId)`) → `"Provider "<id>" already exists. Choose a different name."` (warning) → re-prompt.
  - Built-in id collision (`BUILTIN_PROVIDER_IDS.has(providerId)`) → delegates to `resolveBuiltinCollision` (see Step 1.6.1 below). If user picks `null`/back → re-prompt.
- Escape: `esc` on input → cancel (returns `null`).

#### Step A7: API key (`promptApiKey`)

Title: `"API key"`: `selectOne`:

| value | label | description |
|-------|-------|-------------|
| `literal` | `"API key"` | `"Stored in auth.json, like pi's own /login credentials"` |
| `none` | `"None"` | `"No key; a placeholder is written so the provider still loads"` |

If `"None"` → returns `{ mode: "none" }`. Info notification shown later:

> `"No API key selected. Using "dummy" automatically in auth.json."` (info)

If `"API key"` → input:

- Label: `"API key"`
- Placeholder: `"saved in auth.json under the provider id"`
- `esc` → cancel; empty/whitespace → treated as `none`.

#### Step A8: Fetch model list from models.dev

Info:

> `"Fetching the model list for <provider.name> from models.dev ..."` (info)

Then `fetchModelsDevModels(provider.id)`:

- If catalog has models (`catalog.size > 0`):
  - Title: `"Select models"`: `pickMany` (multi-select checklist). Each item's description is `describeProbeInfo(...)` (only non-default metadata shown, tagged `[models.dev]`). Footer: `" Type to search • ↑↓ move (wraps) • space toggle • enter confirm • backspace delete • esc cancel"` plus `" Select at least one model before confirming."` when nothing selected. `enter` requires `selected.size > 0`; else no-op. `esc` cancels. Header shows `"<selected> selected • <visible>/<total> shown"` and `Search: <query>`.
  - If user picks nothing or cancels → exit.
  - `ids = picked`; `infoById = finalizeModelInfo(picked, [], { modelsDev: catalog, api })`
- Else (empty catalog):
  - Warning: `"models.dev lists no models for <provider.name>: enter ids by hand."`
  - Falls through to `promptManualModels` (see Step C1 below).
    - If manual entry cancelled/empty → exit.
    - `ids = manual.ids`, `overrides = manual.options`

Note: *"No gateway calls on this path: developer-role support stays at the safe default (off). Flip it later via Edit provider if the endpoint supports it."*

#### Step A9: Save

Calls `buildProviderConfig(style="openai", api="openai-completions", endpoint, apiKey, dedupe(ids), { reasoning: "xhigh", image: true }, undefined, infoById, undefined, overrides)`, then `persistProvider` + `persistApiKey`.

On `persistProvider` failure (concurrent duplicate):

> `"Provider "<id>" already exists. Not overwriting."` (error)

On success, key written to `~/.pi/agent/auth.json` as `{ type: "api_key", key: serialized }` (or `"dummy"` for `none`). Info:

> `"Saved provider "<id>" to <MODELS_JSON_PATH>: models and metadata from models.dev"` + if `withMeta > 0`: `" (<N> model(s) with metadata)"`

Then:

> `"Open /model to use your new provider."` (info)

Wizard ends (returns to Pi).

---

### Branch B: Custom endpoint (`addCustom`)

#### Step B1: Provider style (`promptProviderStyle`)

Title: `"Provider style"`: `selectOne`, 5 items:

| value | label | description |
|-------|-------|-------------|
| `openai` | `"OpenAI-compatible (Chat Completions)"` | `'api: "openai-completions" : most OpenAI-compatible servers'` |
| `openai-responses` | `"OpenAI Responses API"` | `'api: "openai-responses" : the newer /responses endpoint'` |
| `anthropic` | `"Anthropic-compatible"` | `'api: "anthropic-messages"'` |
| `gemini` | `"Gemini (Google generative AI)"` | `'api: "google-generative-ai" : native Gemini format, baseUrl includes /v1beta'` |
| `ollama` | `"Ollama-compatible"` | `'api: "openai-completions" with Ollama-specific compat defaults'` |

Maps to `style` + `api`:

- `anthropic` → `anthropic-messages`
- `openai-responses` → `openai-responses`
- `gemini` → `google-generative-ai`
- `openai` / `ollama` → `openai-completions`

Escape: `esc` → cancel.

#### Step B2: Endpoint (`promptEndpoint`)

Input label: `"Endpoint"`  
Placeholder varies by style:

- `anthropic`: `"e.g. https://api.anthropic-proxy.com/v1"`
- `ollama`: `"e.g. http://localhost:11434/v1"`
- `gemini`: `"e.g. https://generativelanguage.googleapis.com/v1beta"`
- `openai-responses`: `"e.g. https://api.openai.com/v1"`
- default (`openai`): `"e.g. https://api.example.com/v1 or http://localhost:11434/v1"`

Validation:

- `esc` → cancel (returns `null`).
- Empty/whitespace → `"Endpoint is required."` (error) → cancel (returns `null`).
- Invalid URL → `"Invalid endpoint: <error>"` (error) → cancel.
- On success returns `{ normalized, raw }` where `normalized = normalizeEndpoint(raw, api)` (strips trailing slashes, strips known suffixes like `/chat/completions`, `/models`, `/messages` depending on `api`; adds `https://` for non-local hosts, `http://` for local hosts if no scheme).

#### Step B3: Endpoint reuse check

Same as Step A4: `confirmEndpointReuse(ctx, endpoint.normalized)`: if duplicate, shows `"Endpoint already exists"` confirm dialog.

#### Step B4: Provider name

Same as Step A6: `promptProviderId(ctx, endpoint.normalized)`: suggestion is `suggestProviderId(normalizedEndpoint)` → `"custom-<host-slug>"`. Same validation/collision handling.

##### Step 1.6.1: Built-in id collision (`resolveBuiltinCollision`)

Triggered whenever `BUILTIN_PROVIDER_IDS.has(providerId)` (at add or rename).

Title: `"<id>" collides with a built-in provider"`: `selectOne` with 3 items:

| value | label | description |
|-------|-------|-------------|
| `rename` | `'Use "<id>-custom" instead'` | `"Recommended : your models and key stay fully separate from the built-in provider"` |
| `keep` | `'Keep "<id>"'` | `"Extend the built-in on purpose. <BUILTIN_COLLISION_WARNING>"` (full warning: *"This id matches a built-in provider. pi merges the built-in model catalog into it : built-in models stay visible even if you delete them here : and /login & /logout for this id share the same auth.json entry, so logging out wipes your key too. Consider a distinct id (e.g. suffix -relay) unless you deliberately want to extend the built-in."*) |
| `back` | `"Pick another name"` | `"Go back and enter a different provider name"` |

Returns `"${id}-custom"` / `"<id>"` / `null` (re-prompt). The provider list also marks colliding ids inline with suffix `" • ⚠ built-in id"` (see `describeProviderInline`).

#### Step B5: API key

Same as Step A7: `promptApiKey` → `selectOne` `"API key"` with `"API key"` / `"None"` items.

If `none` and `style === "ollama"`:

> `"No API key selected. Using "ollama" automatically in auth.json."` (info)

Else if `none`:

> `"No API key selected. Using "dummy" automatically in auth.json."` (info)

#### Step B6: Models (`collectModelIds`)

Two-stage:

**Sub-step B6a: Models mode**

Title: `"Models"`: `selectOne` with two string items:

- `"Auto-detect from the endpoint"`
- `"Add manually"`

`esc` → cancel. `"Add manually"` jumps to `promptManualModels` (Step C1).

**Sub-step B6b: Auto-detect loop** (if user chose Auto-detect)

Loop until success or user bails:

1. Info: `"Probing <buildProbeUrl(baseUrl)> ..."` (info): `buildProbeUrl` appends `/models` (e.g. `https://api.example.com/v1/models`). Internally tries baseUrl and `/v1` variant automatically; non-local `http://` falls back to `https://`.
2. Calls `probeModels(baseUrl, apiKey)`: probes `GET <baseUrl>/models`.
3. On success:
   - `baseUrl` is updated to `probed.baseUrl` (the variant that answered).
   - If `probed.ids.length === 0`:
     > `"Probe succeeded but returned no models. Switching to manual entry."` (warning) → falls through to `promptManualModels`; returns `{ ...manual, baseUrl }` or `null`.
   - Else fetches gateway-wide metadata **before** the picker so it shows real detected values:
     > `"Fetching model metadata (context, max-out, image/video, reasoning) ..."` (info)  
     Calls `fetchGatewayWideInfo(style, apiKey, probed.baseUrl, AUTO_PROBE_PROFILE)` (LiteLLM `/model/info`, `/model_group/info`, `GET {site}/api/models/public`, etc.): skipped for `ollama`/`gemini`. Merges into `probed.infoById`.
   - Then `fetchModelsDevInfoForBaseUrl(probed.baseUrl)` (for `style !== "ollama" && style !== "gemini"`): catalog tier above local rules, below detected values.
   - `pickMany`, Title: `"Select models"`, checklist of `probePickerItems(probed.ids, infoById, modelsDev, api)` where each description is `describeProbeInfo(resolveModelInfo(id...))` (only non-default fields shown, tagged `[models.dev]` / `[local rules]`). Same `pickMany` footer/help as catalog branch.
     - `esc` or empty pick → cancel (returns `null`).
     - On pick: `collectProbedModelInfo(ctx, style, apiKey, probed.baseUrl, picked, probed.infoById, gatewayWide, modelsDev, api)` is called: internally shows again:
       > `"Fetching model metadata (context, max-out, image/video, reasoning) ..."` (info)
     - Returns `{ ids: picked, infoById, baseUrl }`.
4. On failure (probe throws):
   - Warning: `"Auto probe failed: <error>. No http:// or https:// was provided."` (the trailing hint appears only when input had no explicit scheme): style `warning`.
   - Title: `"Probe failed, what next?"`, `selectOne` with 3 items:

     | value | label | description |
     |-------|-------|-------------|
     | `retry` | `"Retry"` | `"Probe again"` |
     | `manual` | `"Add models manually"` | `"Enter model ids by hand"` |
     | `cancel` | `"Cancel"` | `"Abort adding this provider"` |

   - `retry` → loop again.
   - `manual` → `promptManualModels` (Step C1); returns `manual ? { ...manual, baseUrl } : null`.
   - `cancel` / `esc` → `null`.

---

#### Step C1: Manual model entry (`promptManualModels` in `src/ui/prompts.ts`)

Used by both Add branches and by `Edit → Add models manually`. Signature: `promptManualModels(ctx, style)`.

Placeholder varies by `style`:

- `anthropic`: `"e.g. claude-sonnet-4-5 (blank or esc to finish)"`
- `ollama`: `"e.g. llama3.1:8b or qwen2.5-coder:7b (blank or esc to finish)"`
- `gemini`: `"e.g. gemini-2.5-pro (blank or esc to finish)"`
- default: `"e.g. gpt-4o-mini or qwen/qwen3-coder (blank or esc to finish)"`

Loop:

1. Input:
   - First iteration label: `"Model id"`
   - Subsequent: `"Add another model id"`
   - Placeholder as above.
   - `esc` → break loop (finish). Blank/whitespace input (enter with no text) → break loop (finish).
   - If `id` already in `ids` list → `"Model already added: <id>"` (warning) → re-prompt same id (does not advance).
2. For each new `id`, resolve starting values via `resolveModelInfo(id, undefined, undefined, api)` (local rules + defaults: manual ids have no probe data). Derives `api` from `style` same mapping as B1. Starting `ModelOptions`:
   - `reasoning`: `"off"` if `resolved.reasoning === false`, else `"xhigh"`
   - `image`: `resolved.image ?? false`
   - `contextWindow`: `resolved.contextWindow ?? 262144` (256K default for unknown models)
   - `maxTokens`: `resolved.maxTokens`
   - `summary`: `describeProbeInfo(resolved)` (e.g. `"context 128K • reasoning [local rules]"`)
3. Per-model metadata menu, `selectOne` title is `"<id>, <summary>"` if `summary` non-empty, else `"<id>"`. Items:

   | value | label | suffix | description |
   |-------|-------|--------|-------------|
   | `reasoning` | `"Reasoning"` | `" • <opts.reasoning>"` (e.g. `" • xhigh"`) | `"Set the reasoning ceiling (off → max)"` |
   | `image` | `"Image input"` | `" • on"` or `" • off"` | `"Toggle image input (text+image vs text-only)"` |
   | `context` | `"Context window"` | `" • <n>"` or `" • unset"` | `"Max context tokens for this model"` |
   | `maxtokens` | `"Max output tokens"` | `" • <n>"` or `" • unset"` | `"Max tokens this model may generate"` |
   | `done` | `"Done"` | : | `"Confirm this model and continue"` |

   Each field opens its own prompt (see Field Prompts below) and then returns to this per-model menu. `esc` or `done` confirms the model and pushes it into `ids`/`options`; next outer iteration asks for the next model id.
4. On outer loop exit, returns `{ ids, options }` if `ids.length > 0`, else `null` (treated as cancel).

Field prompts inside manual menu (all in `src/ui/prompts.ts`):

- **Reasoning** (`promptReasoning`): Title `"Reasoning"`: `selectOne` over `REASONING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`, labels via `reasoningLabel(level)`:
  - `"Off - no reasoning"` / `"<level> - cap reasoning at <level>"` / `"xhigh - maximum (only if the model supports it)"` / `"max - maximum (only if the model supports it)"`
  - `initialIndex` set to current value. `esc` → `null` (no change).

- **Image** (`promptImage`): Title `"Image input"`: `selectOne` with `"Yes - send text + images"` (`"Sets input: [text, image]"`) / `"No - text only"` (`"Sets input: [text]"`), initial index reflects current. `esc` → `null`.

- **Context window** (`promptContextWindow`): Input label `"Context window (tokens)"`, placeholder: if `current` then `"current: <n> (blank = keep, 0 = clear)"` else `"e.g. 128000 (blank = unset)"`. Accepts integers with `_`/`,` separators; `0` means clear (return `0`), blank → `null` (no change), `esc` → `null`. On invalid: `"Enter a whole number of tokens (0 to clear)."` (warning) → returns `null` (no change, re-shows menu: does not re-prompt inline).

- **Max output tokens** (`promptMaxTokens`): Same contract as context window. Label `"Max output tokens"`, same placeholder logic.

Note: The manual `Add manually` path skips all network calls: no probing at all.

#### Step B7: Developer-role probe

Only for `style === "openai"` or `"openai-responses"`:

- Internally `probeDeveloperRole(probeBase, apiKey, collected.ids[0])`: sends a tiny completion to test if endpoint accepts `developer` role (pi sends system messages as `developer` for reasoning models).
- If `false`:
  > `"This endpoint rejects the developer role: it will be disabled in the provider config."` (info)
- If `undefined` (could not probe):
  > `"Could not probe developer-role support: defaulting to off (safe for every endpoint)."` (info)
- If `true`: silent (no notification), `supportsDeveloperRole: true` is written.
- For all other styles, `developerRole` stays `undefined` → `supportsDeveloperRole: false` in config.

#### Step B8: Save (custom)

Calls `buildProviderConfig(style, api, collected.baseUrl ?? endpoint.normalized, apiKey, dedupe(ids), { reasoning: "xhigh", image: true }, undefined, collected.infoById, developerRole, collected.options)`.

Notes in code: *"After a successful probe this is the base variant that actually answered; otherwise the endpoint as entered."* and *"The reasoning ceiling for thinking models defaults to xhigh; image/context/reasoning come from the probe (models.dev, local rules, then model-probe defaults). Tune per model later via Edit provider → Edit a model."*

Then `persistProvider` + `persistApiKey` (same as catalog branch). Success notices:

- Summary counts: `probedCount` (detected, not inferred), `inferredCount` (`[local rules]`), `defaultedCount` (remaining). Labels: `"detected <N>"`, `"inferred from known models <N>"`, `"defaults <N>"`.
- Info: `"Saved provider "<id>" to <path>"` + if summary non-empty: `": context/image/reasoning: <summary>"`
- Info: `"Open /model to use your new provider."`

`persistApiKey` for `none` writes `"dummy"` (or `"ollama"` for ollama style) to `auth.json`.

Escape/cancel at any point before save → no files are written.

---

## 2. Edit Provider (`src/flows/edit.ts:editProviderFlow`)

Top-level loop: shows provider list, then drills into one provider's action menu, then returns to the list (cursor preserved). `refreshModelRegistry` is called after every write so ` /model` shows changes without restart.

### Step E0: Provider list

Title: `"Edit provider"`: `selectOne` over `Object.keys(config.providers).sort()`.

Each item via `describeProviderInline(providerId, provider)` (`src/flows/shared.ts`):

- `label`: `providerId`
- `suffix`: `" • <api> • <baseUrl> • <N> model(s) • ⚠ built-in id"` (last part only if `BUILTIN_PROVIDER_IDS.has(providerId)`)
- `searchText`: `"<providerId> <api> <baseUrl> <N>"`

If `config.providers` empty:

> `"No providers found in <path>"` (warning) → exit.

`esc` → exit edit flow. Otherwise sets `cursor = providerIds.indexOf(choice)` and calls `editSingleProvider(ctx, choice)`. Loop re-reads config each iteration (handles external edits).

---

### Step E1: Per-provider action menu (`editSingleProvider`)

Title: `"Edit <providerId>"`: `selectOne` with 9 items:

| value | label | suffix | description |
|-------|-------|--------|-------------|
| `probe` | `"Re-probe for models"` | : | `"Query /models again: add new models, flag vanished ones as unsupported, offer metadata updates"` |
| `models` | `"Edit per model"` | : | `"<N> model(s) : reasoning, image input, context, max tokens, headers, delete"` |
| `deletemodels` | `"Delete models"` | : | `"Remove multiple models at once"` |
| `add` | `"Add models manually"` | : | `"Type model ids to add"` |
| `api` | `"API flavor"` | `" • <provider.api>"` or `" • unset"` | `"Switch between Chat Completions, Responses, Anthropic Messages, and Gemini"` |
| `endpoint` | `"Endpoint"` | `" • <provider.baseUrl>"` or `" • unset"` | `"Change the provider's baseUrl"` |
| `rename` | `"Rename provider"` | : | `"Change the provider name in the models config"` |
| `delete` | `"Delete provider"` | : | `"Remove this provider from the models config"` |
| `back` | `"Back"` | : | `"Return to the provider list"` |

`esc` or `back` → return to provider list. Otherwise dispatches to handler below.

---

### Step E1a: Re-probe for models (`reprobeProvider`)

Pre-checks:

- If `api` not one of `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`:
  > `"This provider's API doesn't expose /models. Use 'Add models manually'."` (warning) → return.
- If no `baseUrl`:
  > `"Provider "<id>" has no baseUrl to probe."` (error) → return.

Flow:

1. Info: `"Probing <buildProbeUrl(baseUrl)> ..."` (info), then `probeModels(baseUrl, apiKey)`.
2. On failure: `"Probe failed: <error>"` (error) → return.
3. Compute diff: `storedIds` vs `probed.ids` → `novelIds` (new), `overlapIds` (both), `unsupportedIds` (vanished).
4. Gateway-wide fetch before picker: `fetchGatewayWideInfo(style, apiKey, probed.baseUrl, AUTO_PROBE_PROFILE)` (always uses `AUTO_PROBE_PROFILE` during re-probe; skipped for `ollama`). Info:
   > `"Fetching model metadata (context, max-out, image/video, reasoning) ..."` (info)
   Then `fetchModelsDevInfoForBaseUrl(probed.baseUrl)` (catalog tier).
5. `collectProbedModelInfo(ctx, style, apiKey, probed.baseUrl, [...novelIds, ...overlapIds], ...)`: again shows that same fetching notice; resolves final `infoById`.
6. Build tri-state list: one entry per model, ordered: **updated models first**, then **novel models**, then **unsupported**, then **unchanged**.

   Tri-state widget: `pickTriState` (`src/ui/select.ts:pickTriState`).
   - Title: `"Re-probe <providerId>"`
   - Header shows `Search: <query>`, `"<N> models"`.
   - Each item cycles through its own allowed `states` on `space`:
     - Updated overlap (has changes): `states: ["off","mid","on"]`, `initial: "mid"`. Meaning: `[ ]` remove, `[-]` keep without updating, `[x]` apply metadata update.
     - Novel: `states: ["off","on"]`, `initial: "off"`. Meaning: `[ ]` skip, `[x]` add.
     - Unsupported (vanished): `states: ["off","on"]`, `initial: "on"`. Meaning: `[ ]` remove, `[x]` keep.
     - Unchanged overlap: `states: ["off","on"]`, `initial: "on"`. Meaning: `[ ]` remove, `[x]` keep.
   - Box rendering: `[ ]` (muted), `[-]` (warning yellow), `[x]` (success green).
   - Help footer: `" Type to search • ↑↓ move (wraps) • space toggle • enter confirm • backspace delete • esc cancel"` and legend: `"[ ] remove/skip • [-] keep without update • [x] keep/add with latest metadata"`.
   - Pagination footer when `> 12` items.
   - `esc` → cancel (returns `null`, no changes).
   - `enter` → confirms `Map<value, TriState>`.

   Item descriptions:

   - Updated: `"<changes> • current: <storedModelSummary>"` where changes are like `"context 128000→1000000 • max-out 8192→32000 • cost $1.32/$3.96→$0.44/$0.87 • image [+] • reasoning [-]"`. `storedModelSummary` shows current config like `"reasoning:xhigh • image • context 128000 • max-out 8192 • $1.32/$3.96 per 1M"` or `""` if empty.
   - Novel: `describeProbeInfo(infoById.get(id))` (e.g. `"context 128K [models.dev] • image"`).
   - Unsupported: `"<storedModelSummary>"` or `"no metadata stored"`, label shows `"<id> • unsupported"`.
   - Unchanged: `storedModelSummary` or `"no changes"`.

7. Apply:

   - `removeIds` + `updateIds` handled in one `mutateProvider` call:
     - Filters out `removeSet`, converts string entries to objects where needed, calls `applyMetaChanges` (writes `contextWindow`/`maxTokens`/`input`/`cost`/`reasoning` from probed info; `inferredFields`/`defaultedFields` are ignored: only authoritative detected/catalog values rewrite stored config).
     - Info on success: `"Re-probe: updated metadata for <N>, removed <M> in "<id>"."`.
   - `addIds` via `addModelEntriesToProvider(ctx, providerId, addIds, infoById)`, info: `"Added <N> model(s) to "<id>", auto-detected metadata for <K> model(s)."` or without suffix.
   - If nothing changed: `"No changes: everything the endpoint returned is already configured and up to date."` (info).

Only tiers 1–2 (detected / `models.dev`) ever rewrite existing entries; guesses and defaults are starting points for new models only (enforced via `info.inferredFields` / `info.defaultedFields` in `diffStoredModel`).

---

### Step E1b: Edit per model (`editProviderModels`)

Title: `"Edit model in <providerId>"`: `selectOne` over `providerModelItems(provider)` (each model shows suffix `" • reasoning:<ceiling> • image • context <N> • max-out <N> • $<in>/$<out> per 1M"` where applicable; search includes id + details). `cursor` preserved across loop iterations. Empty → `"Provider "<id>" has no models."` (warning). `esc` → back to action menu.

On pick, calls `editSingleModel(ctx, providerId, modelId)` (see E1b1). If model was deleted inside that screen, cursor adjusts `max(0, cursor-1)`.

#### Step E1b1: Per-model field menu (`editSingleModel`)

Title: `"Edit <modelId>"`: `selectOne` with 8 items (loop until `back`/`esc` or model deletion):

| value | label | suffix | description |
|-------|-------|--------|-------------|
| `reasoning` | `"Reasoning"` | `" • <ceiling>"` (e.g. `" • xhigh"`) | `"Set the reasoning ceiling (off → xhigh)"` |
| `image` | `"Image input"` | `" • on"` or `" • off"` | `"Toggle image input (text+image vs text-only)"` |
| `context` | `"Context window"` | `" • <n>"` or `" • unset"` | `"Max context tokens for this model"` |
| `maxtokens` | `"Max output tokens"` | `" • <n>"` or `" • unset"` | `"Max tokens this model may generate"` |
| `override` | `"Headers / endpoint override"` | `" • headers"` if `model.headers` present, else `" • set"` if `baseUrl`/`api` override, else `" • unset"` | `"Per-model HTTP headers and api/baseUrl override"` |
| `refresh` | `"Refresh metadata"` | : | `"Pull context/image/reasoning from models.dev or the endpoint's /models"` |
| `delete` | `"Delete this model"` | : | `"Remove this model from the provider"` |
| `back` | `"Back"` | : | `"Return to the model list"` |

Each field (except `back`/`delete`/`refresh`/`override`) mutates in place so other fields (`headers`, `cost`, `overrides`) are preserved. Saving goes through `mutateModel` (string entries become `{ id, input: ["text","image"] }` objects before mutation). Success inside `mutateModel` additionally:

> `"Updated "<modelId>"." ` (info): shown for every field edit (including those routed through `editSingleModel`).

Details per field:

- **Reasoning** → `promptReasoning(ctx, opts.reasoning)` (Title `"Reasoning"`, same items as manual menu). If `"xhigh"` or `"max"` chosen, follow-up: `promptCeilingProviderString(ctx, reasoning, readCeilingString(model, reasoning))`: Input label `"<level> provider value (blank = <level>)"`, placeholder either `"current: <current>"` or `'e.g. max (leave blank to send "<level>")'`. Then `applyReasoning(m, reasoning, ceilingOverrides)`.

- **Image input** → `promptImage(ctx, opts.image)` (Title `"Image input"`, `"Yes - send text + images"` / `"No - text only"`). Then `m.input = image ? ["text","image"] : ["text"]`.

- **Context window** → `promptContextWindow(ctx, contextWindow)` (label `"Context window (tokens)"`, same contract as manual: `0` clears). Then `if (result===0) delete m.contextWindow; else m.contextWindow = result`. `null`/cancel → no change (back to field menu).

- **Max output tokens** → `promptMaxTokens` (label `"Max output tokens"`). Same `0`-to-clear contract.

- **Headers / endpoint override** → `editModelOverride`:
  - Two sequential inputs:
    1. Label: `"baseUrl override (blank = use provider, "-" to clear)"`, initial/placeholder `currentBase` or `"e.g. https://api.example.com/v1"`.
    2. Label: `"Headers as JSON (blank = keep, "-" to clear)"`, initial/placeholder `JSON.stringify(model.headers)` or `'e.g. {"x-api-version":"2024-01"}'`.
  - `esc` on either → cancel (no mutation).
  - Headers `"-"` → delete `m.headers`; blank → keep; otherwise `JSON.parse` (must be non-array object) or `"Invalid headers JSON: <error>"` (error) → return without saving.
  - baseUrl `"-"` → delete `m.baseUrl`; truthy trimmed string → `m.baseUrl = trimmedBase`; blank → keep (no change).

- **Refresh metadata** → `refreshModelMetadata(ctx, providerId, modelId)` (see E1b2).

- **Delete this model** → confirm:
  - Title: `"Delete model?"`
  - Message: `"Remove "<modelId>" from "<providerId>"?"` + if `BUILTIN_PROVIDER_IDS.has(providerId)`: `" Note: "<id>" shares its id with a built-in provider: if this model also ships in pi's built-in catalog, it will still appear in /model after deletion."`
  - `No`/`esc` → no-op. `Yes` → `mutateProvider` removes the entry, then `"Deleted "<modelId>"." ` (info). Returns `true` to signal deletion to caller (cursor correction).

---

#### Step E1b2: Refresh metadata (`refreshModelMetadata`)

Two-source picker before fetching:

Title: `"Refresh metadata for <modelId>"`: `selectOne` with up to 2 items:

| value | label | description |
|-------|-------|-------------|
| `modelsdev` | `"models.dev"` | `"Official metadata from the models.dev catalog, matched across all providers"` |
| `endpoint` | `"Endpoint /models"` | `"Probe the endpoint's /models and the gateway-wide metadata sources"` (only if `probeBase` non-empty; `probeBase` is `model.baseUrl` if set, else `provider.baseUrl`, normalized) |

`esc` → cancel.

**Source: `models.dev`**

1. Info: `"Fetching the models.dev catalog ..."` (info); `fetchModelsDevOptionsForModel(modelId)` (matches across all catalog providers, including vendor-prefixed/relay-decorated ids by dropping leading segments; e.g. `bailian/deepseek-v4` still matches `deepseek-v4`).
2. If none: `"models.dev has no entry for this model."` (warning) → return.
3. Otherwise list every match: Title `"models.dev entries for <modelId>"`: `selectOne` with one item per match:
   - `label`: `"<providerId>/<key>"` (e.g. `"openai/gpt-4o-mini"`)
   - `description`: `"<changes>"` or `"no changes: entry matches the stored config"` + if `current` summary non-empty: `" · current: <current>"`. Changes shown as `diffStoredModel(stored, info)` labels (e.g. `"context 128000→1000000 • max-out 8192→32000"`).
   - Plus final item: `"Cancel"` / `"Keep the stored config"`.
4. On `"Cancel"`/`esc` → return. If `changes.length === 0` → `"<modelId>: the selected entry matches the stored config."` (info) → return.
5. Else `mutateModel` with `applyMetaChanges(m, chosen.info, changes)` → `"Updated "<modelId>" from models.dev (<providerId>)."` (info).

**Source: `Endpoint /models`**

1. If `api` not probeable → `"This provider's API doesn't expose /models."` (warning) → return.
2. Info: `"Probing <buildProbeUrl(probeBase)> ..."` (info); `probeModels(probeBase, apiKey)`.
3. On failure: `"Probe failed: <error>"` (error) → return.
4. If endpoint didn't return the model: `"The endpoint did not return "<modelId>"." ` (warning) → return.
5. `fetchGatewayWideInfo` + `fetchModelsDevInfoForBaseUrl` + `collectProbedModelInfo` for `[modelId]`.
6. If no `resolved` info: `"The endpoint returned no metadata for this model."` (warning) → return.
7. `diffStoredModel(stored, resolved)`: if empty → `"<modelId>: already up to date."` (info) → return.
8. Confirm: `ctx.ui.confirm("Apply <N> change(s)?", "<modelId>: <labels>")`: `No`/`esc` → return.
9. `mutateModel` with `applyMetaChanges` → `"Updated "<modelId>" with <N> change(s)."` (info).

---

### Step E1c: Delete models (bulk) (`deleteModelsFromProvider`)

1. `providerModelItems(provider)`: same suffix rendering as E1b. If empty → `"Provider "<id>" has no models."` (warning).
2. Title: `"Delete models from <providerId>"`: `pickMany` multi-select (same widget as add branches: search, space toggle, enter requires `≥1` selected, esc cancel).
3. `esc`/empty → return. Else confirm:
   - Title: `"Delete models?"`
   - Message: `"Remove <N> model(s) from "<id>":\n- <id>\n- <id>"` + if built-in collision: `"\nNote: "<id>" shares its id with a built-in provider: models that also ship in pi's built-in catalog will still appear in /model after deletion."`
   - `No`/`esc` → return.
4. `mutateProvider` filters out `removeSet` → `"Deleted <N> model(s) from "<id>"." ` (info).

---

### Step E1d: Add models manually (`addModelsToProvider`)

Same `promptManualModels(ctx, style)` loop as Step C1 (style derived from `providerStyleOf(provider)`: see below):

- Style detection: `anthropic` if `api === "anthropic-messages"`, `gemini` if `api === "google-generative-ai"`, `ollama` if `compat.supportsDeveloperRole === false && compat.supportsReasoningEffort === false`, else `openai`.
- On `manual` result: `addModelEntriesToProvider(ctx, providerId, manual.ids, undefined, manual.options)`, deduplicates, skips existing ids → `"Nothing to add, all selected models already exist."` (info) if none fresh; otherwise `"Added <N> model(s) to "<id>" auto-detected metadata for <K> model(s)."` (detected counts only non-default metadata).

---

### Step E1e: API flavor (`changeProviderApi`)

Title: `"API flavor for <providerId>"`: `selectOne` over `API_OPTIONS` sorted with current first:

| value | label | suffix (if current) | description |
|-------|-------|---------------------|-------------|
| `openai-completions` | `"OpenAI Chat Completions"` | `" • current"` | `'api: "openai-completions" : most OpenAI-compatible servers'` |
| `openai-responses` | `"OpenAI Responses API"` | `" • current"` | `'api: "openai-responses" : the newer /responses endpoint'` |
| `anthropic-messages` | `"Anthropic Messages"` | `" • current"` | `'api: "anthropic-messages" : requires an Anthropic-style endpoint'` |
| `google-generative-ai` | `"Gemini (Google generative AI)"` | `" • current"` | `'api: "google-generative-ai" : native Gemini format; baseUrl must include the version path (/v1beta)'` |

- `esc` or picking current → no-op.
- Otherwise `mutateProvider` sets `p.api = choice` → `"Changed "<id>" to <choice>."` (info).

---

### Step E1f: Endpoint (`changeProviderEndpoint`)

1. Input label: `"Endpoint"`, initial/placeholder `current` or `"e.g. https://api.example.com/v1"`.
2. `esc` → return; empty or same as `current` → no-op.
3. `normalizeEndpoint(trimmed, api)` → on error: `"Invalid endpoint: <error>"` (error) → return.
4. `mutateProvider` sets `p.baseUrl = normalized` → `"Endpoint for "<id>" set to <normalized>."` (info).

---

### Step E1g: Rename provider (`renameProvider`)

1. Input label: `"Rename provider"`, placeholder `"current: <providerId>"`.
2. `esc` → `null`; slugify input; empty or same as `providerId` → `null` (no-op, back to menu without notification).
3. If target `newId` already exists in `config.providers` → `"Provider "<newId>" already exists. Choose a different name."` (warning) → `null`.
4. If `BUILTIN_PROVIDER_IDS.has(newId)` → `resolveBuiltinCollision` (same 3-option picker as Step 1.6.1); `null`/back → `null`; if resolved id already exists → warning → `null`.
5. Rebuilds `config.providers` key-by-key to preserve file order (not delete+re-add), `saveModelsConfig`, `refreshModelRegistry`, then `renameProviderApiKey(oldId, newId)` (moves `auth.json` entry; best-effort).
   - On save failure: `"Could not write <path>: <error>"` (error) → `null`.
   - On auth move failure: `"Renamed, but the auth.json entry could not be moved: <error>"` (warning): rename itself already succeeded.
6. Success: `"Renamed "<oldId>" → "<newId>"." ` (info) → returns `newId` so `editSingleProvider` keeps editing the same logical provider under the new name (menu title updates without returning to the list).

Note: Only touches `models.json`; a currently selected model pinned to the old provider id must be reselected via `/model` afterwards (not done by the wizard).

---

### Step E1h: Delete provider (inside Edit) (`removeProvider` path in `editSingleProvider`)

- Confirm: Title `"Delete provider?"`, message `describeProvider(providerId, provider)` (see below: `"<id>\n<api> • <N> model(s)\n<baseUrl>"`).
- `No`/`esc` → no-op.
- `Yes` → `removeProvider(ctx, providerId)`:
  - Deletes from `config.providers`, `saveModelsConfig`, `refreshModelRegistry`, then `removeProviderApiKey` (only `api_key` entries; oauth left alone). On auth delete failure: `"Provider deleted, but its auth.json entry could not be removed: <error>"` (warning).
  - On success: `"Deleted provider "<id>" from <path>"` (info). Then `editSingleProvider` returns immediately (control goes back to the E0 provider list).

---

## 3. Delete Provider (`src/flows/delete.ts:deleteProviderFlow`)

Separate top-level command: loop over provider list, deleting one at a time.

- Title: `"Delete provider"`: `selectOne` with same `describeProviderInline` items as E0 (including `" • ⚠ built-in id"` suffix). `cursor` preserved; `initialIndex: min(cursor, len-1)`.
- If empty at entry: `"No providers found in <path>"` (warning) → exit. If empty after deletions: `"No providers left in <path>"` (info) → exit.
- `esc` → exit (no deletion). Otherwise:
  - Confirm: Title `"Delete provider?"`, message `describeProvider(choice, provider)` → `"<id>\n<api> • <N> model(s)\n<baseUrl>"`. `No`/`esc` → loop (no deletion), `cursor` stays.
  - `Yes` → delete from `config.providers`, `saveModelsConfig`, `refreshModelRegistry`, `removeProviderApiKey` (best-effort).
    - Write failure: `"Could not write <path>: <error>"` (error) → return (exit flow).
    - Auth failure: `"Provider deleted, but its auth.json entry could not be removed: <error>"` (warning): deletion still succeeded.
  - `cursor = selectedIndex + 1` (so next provider is highlighted).
  - `deletedAny = true`.
  - Info: `"Deleted provider "<id>" from <path>"` (info). Loop continues (re-reads config, shows updated list).

---

## 4. Global UX & Escape Hatches (applies everywhere)

### Input widget (`ctx.ui.input`)

- First arg is label (shown as prompt), second is placeholder/hint.
- `esc` always returns `undefined` → caller treats as "cancel / go back" (no side effect, no error toast).
- Blank/whitespace handling varies per caller: sometimes treated as "keep current" (e.g. per-model overrides), sometimes as "finish" (manual model loop), sometimes as "invalid" (top-level endpoint / provider name): each step documents its blank behavior above.

### Single-select (`selectOne`)

- Up/down wraps. Typing filters `label + suffix + description + searchText` case-insensitively; `cursor` resets to 0 on filter change.
- `enter` confirms the highlighted visible item. `esc` cancels (returns `null`).
- Footer always: `" Type to search • ↑↓ move (wraps) • enter confirm • backspace delete • esc cancel"`

### Multi-select (`pickMany`)

- Checklist: `space` toggles `[x]`/`[ ]`. Header shows `"<selected> selected • <visible>/<total> shown"`.
- `enter` only works when `selected.size > 0` (otherwise no-op). `esc` cancels (returns `null`).
- Footer: `" Type to search • ↑↓ move (wraps) • space toggle • enter confirm • backspace delete • esc cancel"` plus warning when nothing selected.

### Tri-state (`pickTriState`)

- Each item has its own cycle: `["off","mid","on"]` or `["off","on"]`. `space` advances cycle. Boxes: `[ ]` muted, `[-]` warning, `[x]` success.
- Legend footer: `"[ ] remove/skip • [-] keep without update • [x] keep/add with latest metadata"` (only on re-probe; other tri-state uses would pass a custom legend).

### Notifications (`ctx.ui.notify`)

- Levels: `info` / `warning` / `error` (affects styling only; none block).
- Confirm dialogs: `ctx.ui.confirm(title, message)` → boolean (ok/cancel).

### Config I/O & Live Reload

- Every mutation path goes through `mutateProvider` / `mutateModel` / `saveModelsConfig` → `refreshModelRegistry()` (`ctx.modelRegistry?.refresh()`). Changes appear in `/model` without restarting Pi. Refresh failure is silent (best-effort).
- `saveModelsConfig` also migrates any legacy inline `apiKey` entries from `models.json` into `auth.json` before writing (auth written first so a failed write never strands a key).
- `models.json` path: `~/.pi/agent/models.json` on Pi; `~/.pi/agent/models.yml` (or `.yaml`/`.json` whichever exists, default `.yml`) on Oh My Pi. YAML requires the `yaml` npm package; without it JSON is accepted as a YAML subset (genuine YAML with a missing package errors explicitly).
- Auth path: `~/.pi/agent/auth.json` (Pi only; OMP keeps keys inline). Keys stored as `{ type: "api_key", key: "..." }` keyed by provider id. `!cmd` prefix runs a shell command, `$VAR` reads env var, else literal.

### Built-in Collision Everywhere

- Any time a user-supplied id collides with `BUILTIN_PROVIDER_IDS` (36 ids including `"openai"`, `"anthropic"`, `"deepseek"`, `"google"`, `"groq"`, `"openrouter"`, etc.), `resolveBuiltinCollision` offers `"<id>-custom"` / `Keep "<id>"` / `Pick another name`. Keeping it intentionally merges with the built-in (catalog stays visible, `/login` shares the key). Lists mark colliding ids with `" • ⚠ built-in id"` and confirm dialogs add the full `BUILTIN_COLLISION_WARNING`.

---

## 5. Storage & Post-Save Behavior (what the wizard writes)

- **Auth:** `~/.pi/agent/auth.json`: one entry per provider id: `{"type":"api_key","key":"<serialized>"}`. Selecting `"None"` writes `"dummy"` (or `"ollama"` for ollama style) so the provider still loads. Serializes as `!<cmd>` for shell mode, `$<VAR>` for env mode, raw string for literal.
- **Models:** `~/.pi/agent/models.json` (or `.yml` on OMP): provider object with `baseUrl`, `api`, optional `compat: { supportsDeveloperRole, supportsReasoningEffort? }`, and `models: Array<{ id, input:[text]| [text,image], reasoning?, thinkingLevelMap?, contextWindow?, maxTokens?, cost?, baseUrl?, headers?, api? }>`
  - Ollama: `compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }`
  - OpenAI/Responses: `compat: { supportsDeveloperRole: <probed> }` (defaults `false` if probe inconclusive)
  - Reasoning ceiling mapping: `"off"` → no `reasoning`/`thinkingLevelMap`; otherwise `reasoning:true` plus `thinkingLevelMap` that nulls levels above the ceiling and (for `xhigh`/`max`) sets those levels to the provider's string (or the literal `"xhigh"`/`"max"` if no override).
  - Image: `input: ["text","image"]` vs `["text"]`.
  - Cost: only when gateway or `models.dev` reported real prices; never guessed.
- After every save: `ctx.modelRegistry?.refresh()` + info `"Open /model to use your new provider."` (on Add) or per-action toasts above.

---

## What a beginner never has to know

The wizard hides all of the following: a newcomer can add and use an OpenAI-compatible provider by just picking it from a list or pasting an endpoint URL, naming it, and selecting models:

- **What `models.dev` is**: a catalog of known API providers. Picking `"From models.dev catalog"` fetches names and model lists automatically; the user never sees base URLs are normalized, nor that metadata is pre-filled from the catalog without any network probe of their own endpoint.
- **Base URL normalization**: the wizard strips paths like `/chat/completions`, `/models`, `/messages`, adds `https://` where missing, and picks the `/v1` variant that actually answers. The user types (or picks) an endpoint; they never have to know which exact path the server expects.
- **Probe mechanics**: auto-detect tries `GET /models`, adapts `/v1`, falls back from `http` to `https`, and knows to retry. On failure the wizard offers Retry / Manual / Cancel in plain language; the user never sees HTTP status codes or auth headers.
- **Gateway-wide vs per-model metadata sources**: the wizard fetches `GET /model/info`, `GET /model_group/info`, `GET {site}/api/models/public`, `GET /models/{id}`, Ollama `/api/tags` + `/api/show` behind the scenes. The user only sees that context sizes and image support "appear" in the picker.
- **Metadata tiers (detected > models.dev > local rules > API fallback > defaults)**: the wizard always shows the best value it has, tagging guesses `[models.dev]` / `[local rules]` in the picker. The user never chooses a tier; re-probe only overwrites a stored entry when an authoritative source (detected or catalog) disagrees.
- **Local rules & relay-decorated ids**: ids like `bailian/deepseek-v4-pro`, `gpt-5@20250807`, `claude-sonnet-4-6[1m]` are normalized so they still match known-model tables. Custom rules via `~/.model-probe-rules.json` extend this table. The user just sees that most models already have context/reasoning filled in.
- **Thinking levels & `thinkingLevelMap`**: reasoning models get a ceiling (`off`→`max`) mapped to Pi's `off/minimal/low/medium/high/xhigh/max` levels, with provider-specific strings like `"max"` handled automatically. The user picks a readable label (`"xhigh - maximum (only if the model supports it)"`) and never sees the JSON map. Probes that learn exact `effort_options` write the map verbatim.
- **Developer role (`supportsDeveloperRole`)**: Pi sends system messages as `developer` for some models; some endpoints reject that with `400`. The wizard probes this with a tiny completion and sets `compat.supportsDeveloperRole` automatically. The user never hears about the `developer` vs `system` distinction.
- **Ollama compat flags**: `compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }` is what makes Pi speak Ollama's dialect. The user just picks `"Ollama-compatible"`.
- **API flavors**, four values (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`) map to protocol differences (Gemini needs `/v1beta` in the base URL, Anthropic uses `/messages`). The user picks a label like `"Gemini (Google generative AI), native Gemini format, baseUrl includes /v1beta"`.
- **Files: `models.json` vs `models.yml` vs `auth.json`**: the wizard reads/writes the correct file per runtime (Pi → `models.json` + `auth.json`; OMP → `models.yml`). API keys go to `auth.json` like `/login` does; the user never chooses a file. Legacy inline `apiKey`s migrate automatically.
- **Auth serialization (`$ENV` / `!command`)**: keys are stored as `"$MY_KEY"` or `"!op read ..."` and resolved at runtime. The wizard exposes this as a simple `"API key"` input with a `"None"` escape hatch (writes `"dummy"`/`"ollama"` so the provider still loads).
- **Built-in provider ids & merging**: naming a provider `openai` or `anthropic` would collide with built-ins; Pi would merge catalogs and share auth. The wizard detects this and offers `"<id>-custom"` with a one-line explanation; otherwise the user never needs to know the 36 built-in ids.
- **Cost (`input`/`output`/`cacheRead`/`cacheWrite` per 1M tokens)**: when reported by the gateway or catalog, it is written as `cost` so Pi can estimate session spend. The user never enters a price; cost is never guessed.
- **Video input**: tracked and shown as a picker tag, but Pi's config has no video slot so it is display-only. The user doesn't have to decide anything.
- **Endpoint reuse**, two providers can share an endpoint; the wizard just warns `"Endpoint already exists, This endpoint is already used by: …"` and asks to confirm.
- **Model list evolution (re-probe tri-state)**: the wizard can re-query `/models` and present new/updated/vanished/unchanged models in one screen with `[x]` / `[-]` / `[ ]` toggles. The user doesn't manage diffs by hand; they toggle and confirm.
- **Per-model overrides (headers / `baseUrl`)**: advanced routing like per-model headers (`'{"x-api-version":"2024-01"}'`) or a per-model `baseUrl` override exists under `Edit per model → Headers / endpoint override`. A beginner never opens that menu.
- **`contextWindow` / `maxTokens` clamping & degenerate fallbacks**: limits like `maxTokens == contextWindow` are clamped; unknown models default to 256K context rather than "unset". The user sees sensible starting numbers, not protocol math.
- **Refresh source choice**: `Refresh metadata` lets the user pull fresh numbers either from `models.dev` (across all providers, with relay-prefix handling) or from the live endpoint. A beginner never refreshes at all; added models already arrive with good defaults.

