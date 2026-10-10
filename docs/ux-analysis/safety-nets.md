# Safety Nets: how `better-custom-provider@1.6.0` behaves when things go wrong

**Subject**: `C:/Users/Administrator/Documents/AI/opencode-dynamic-custom-providers/ref/better-custom-main` (`better-custom-provider` v1.6.0, `index.ts` → `/custom-provider`).
**Scope**: every recovery path in the Add / Edit / Delete flows: probe failure, wrong URL, `/v1` fallback, `http→https` fallback, built-in id collision (`resolveBuiltinCollision`), duplicate name, duplicate endpoint, missing key, manual-entry escape, retry, cancel: with the real user-facing strings.
**Method**: source reading of `src/flows/add.ts`, `src/flows/edit.ts`, `src/flows/shared.ts`, `src/url.ts`, `src/api-key.ts`, `src/ui/prompts.ts`, `src/config.ts`, `src/model-entry.ts`; the probing fallbacks additionally live in the `model-probe@0.7.0` dependency and were executed against real local HTTP servers (see §12 for the evidence index). Live TUI runs used the real `pi` v0.73.1 host with the unmodified extension.

All quotes below are verbatim source strings (template placeholders shown as `${...}`).

---

## 1. Wrong URL / invalid endpoint

### 1a. Missing scheme is repaired, not rejected
`addDefaultScheme()` (`src/url.ts`) prepends a scheme when none was typed: local hosts get `http://`, everything else `https://`.

- `example.com/v1` → `https://example.com/v1`
- `localhost:11434/v1` → `http://localhost:11434/v1`
- `192.168.1.5:8080` → `http://192.168.1.5:8080`
- `10.0.0.5:8000` → `http://10.0.0.5:8000`

Local is detected by hostname prefix (`localhost`, `127.`, `0.0.0.0`, `10.`, `192.168.`, `172.16.`–`172.31.`, `[`).

### 1b. Path suffixes are stripped so users can paste any URL they copied
`normalizeEndpoint()` strips the endpoint suffixes per API flavor:

- `https://x.com/v1/chat/completions` → `https://x.com/v1` (openai-completions)
- `https://x.com/v1/models` → `https://x.com/v1`
- `https://x.com/v1/responses` → `https://x.com/v1` (openai-responses)
- `https://x.com/v1/messages` → `https://x.com/v1` (anthropic-messages)
- `https://x.com/v1beta/models` → `https://x.com/v1beta` (google-generative-ai)

### 1c. Genuinely unparseable URL → error notify, flow aborts cleanly
`promptEndpoint()` (`src/ui/prompts.ts`):

```ts
if (!raw) {
    ctx.ui.notify("Endpoint is required.", "error");
    return null;
}
try {
    return { normalized: normalizeEndpoint(raw, api), raw };
} catch (error) {
    ctx.ui.notify(`Invalid endpoint: ${error instanceof Error ? error.message : String(error)}`, "error");
    return null;
}
```

Observed headlessly with the real flow code: empty input → `Error: Endpoint is required.` (add flow returns immediately, nothing saved). In the edit flow the same shape appears as `Invalid endpoint: ${message}` (`src/flows/edit.ts`, `changeProviderEndpoint`).

**Recovery**: the flow returns to the caller without writing anything; nothing is persisted.

---

## 2. Probe failure: retry / manual / cancel

When auto-detect fails, `collectModelIds()` (`src/flows/add.ts`) catches the error, appends a scheme hint, and offers a three-way recovery menu:

```ts
const schemeHint = hasExplicitScheme(trimmedEndpointInput) ? "" : " No http:// or https:// was provided.";
ctx.ui.notify(`Auto probe failed: ${error instanceof Error ? error.message : String(error)}.${schemeHint}`, "warning");
const action = await selectOne(ctx, "Probe failed: what next?", [
    { value: "retry", label: "Retry", description: "Probe again" },
    { value: "manual", label: "Add models manually", description: "Enter model ids by hand" },
    { value: "cancel", label: "Cancel", description: "Abort adding this provider" },
]);
if (action === "retry") continue;
if (action === "manual") {
    const manual = await promptManualModels(ctx, style);
    return manual ? { ...manual, baseUrl } : null;
}
return null;
```

Observed live in the real pi TUI (endpoint `localhost:59999/v1`, dead port):

```
Probing http://localhost:59999/v1/models ...
Warning: Auto probe failed: fetch failed. No http:// or https:// was provided.

Probe failed: what next?
> Retry            Probe again
  Add models manually   Enter model ids by hand
  Cancel           Abort adding this provider
```

- **Retry** loops back to `while (true)` and probes again (verified: second identical attempt, same warning).
- **Cancel** returns `null` → the add flow aborts; verified no provider entry was written.
- **Manual** drops into `promptManualModels()` (see §7).

Edit-flow variant (`reprobeProvider`, `refreshModelMetadata`) has no retry menu: it reports and returns:

```
Probe failed: ${error instanceof Error ? error.message : String(error)}    (error)
```

Note: `model-probe` wraps timeouts, network errors and 404s as *retryable* so they fall through to the next base variant; auth/client errors (e.g. 401) abort immediately without variant fallback: verified live (§12 A6).

---

## 3. Probe succeeded but returned no models

`collectModelIds()` (`src/flows/add.ts`):

```ts
if (probed.ids.length === 0) {
    ctx.ui.notify("Probe succeeded but returned no models. Switching to manual entry.", "warning");
    const manual = await promptManualModels(ctx, style);
    return manual ? { ...manual, baseUrl } : null;
}
```

Observed live against a local gateway answering `{"data": []}`:

```
Probing http://127.0.0.1:18091/models ...
Warning: Probe succeeded but returned no models. Switching to manual entry.

Model id
>
```

**Recovery**: automatic switch to manual entry; esc/blank exits and the add flow aborts.

---

## 4. `/v1` fallback (path-adaptive probing)

Lives in the `model-probe@0.7.0` dependency (`src/probe.ts`, `probeBaseVariants`): the base as given is tried first, then the variant with a trailing `/v1` added or removed. 404 / timeout / network errors / non-JSON responses (e.g. a console HTML page at `/models`) are retryable and fall through to the next variant; the variant that actually answered is returned as `baseUrl` and becomes the provider's stored `baseUrl`.

Verified live against real local servers:

| given baseUrl | server mounts | requests observed | result |
|---|---|---|---|
| `http://127.0.0.1:18081/v1` | `/models` only (root) | `/v1/models` (404) → `/models` (200) | `baseUrl=http://127.0.0.1:18081`, ids found |
| `http://127.0.0.1:18082` | `/v1/models` only | `/models` (404) → `/v1/models` (200) | `baseUrl=http://127.0.0.1:18082/v1`, ids found |
| `http://127.0.0.1:18083` | `/models` returns HTML, `/v1/models` JSON | `/models` (200 HTML → non-JSON) → `/v1/models` (200) | ids found |

Verified end-to-end in the real TUI: endpoint typed as `127.0.0.1:18090` (no `/v1`), the gateway 404s at `/models` and serves `/v1/models`: the picker listed the 3 models and the saved provider stored `"baseUrl": "http://127.0.0.1:18090/v1"`.

The add flow announces each attempt first:

```
Probing ${buildProbeUrl(baseUrl)} ...
```

**Recovery**: silent: the user sees the probe succeed and the model picker; the corrected base URL is stored.

---

## 5. `http→https` fallback

Same dependency (`probeBaseVariants`): for non-local `http://` URLs, `https://` variants of every candidate are appended after the plain variants, because public hosts that don't listen on `:80` hang until timeout. Local hosts (`localhost`, `*.local`, `127.*`, `0.0.0.0`, `10.*`, `192.168.*`, `172.16-31.*`, `[::1]`) are exempt.

Verified against a non-local TEST-NET address (`http://192.0.2.1:18077/v1`, unreachable): the final error named the **https** variant after the http attempts timed out:

```
Probe timed out after 4s: https://192.0.2.1:18077/models
```

elapsed ≈ 16s = 4 variants × 4s `PROBE_TIMEOUT_MS`, proving both schemes and both path variants were attempted.

**Recovery**: silent scheme upgrade; if the https host serves the API, the probe succeeds and the https URL becomes the stored baseUrl. If everything fails, the §2 menu appears.

---

## 6. Built-in id collision (`resolveBuiltinCollision`)

`src/config.ts` ships `BUILTIN_PROVIDER_IDS` (39 pi built-in ids, `amazon-bedrock` … `zai-coding-cn`, incl. `openai`, `anthropic`, `deepseek`, `groq`, `openrouter`) plus the full warning text:

```ts
export const BUILTIN_COLLISION_WARNING =
    "This id matches a built-in provider. pi merges the built-in model catalog into it, built-in models stay visible even if you delete them here, and /login & /logout for this id share the same auth.json entry, so logging out wipes your key too. Consider a distinct id (e.g. suffix -relay) unless you deliberately want to extend the built-in.";
```

`resolveBuiltinCollision()` (`src/ui/prompts.ts`) offers a one-click way out: used by both the Add name prompt and the Edit → Rename path:

```ts
const suggested = `${providerId}-custom`;
const choice = await selectOne(ctx, `"${providerId}" collides with a built-in provider`, [
    { value: "rename", label: `Use "${suggested}" instead`, description: "Recommended: your models and key stay fully separate from the built-in provider" },
    { value: "keep", label: `Keep "${providerId}"`, description: `Extend the built-in on purpose. ${BUILTIN_COLLISION_WARNING}` },
    { value: "back", label: "Pick another name", description: "Go back and enter a different provider name" },
]);
if (choice === "rename") return suggested;
if (choice === "keep") return providerId;
return null;
```

Observed live in the real TUI, typing `openai` at the Add name prompt:

```
"openai" collides with a built-in provider
> Use "openai-custom" instead
    Recommended: your models and key stay fully separate from the built-in provider
  Keep "openai"
    Extend the built-in on purpose. This id matches a built-in provider. pi merges the built-in model catalog into it, built-in models stay visible even if you delete them here, and /login & /logout for this id share...
  Pick another name
    Go back and enter a different provider name
```

- **rename** → the id becomes `<id>-custom`; if that id already exists, `Provider "${resolved}" already exists. Choose a different name.` re-prompts.
- **keep** → provider is written under the colliding id (deliberate extension). Verified: renaming to `groq` with Keep produced `Renamed "deepseek-custom" → "groq".` and the provider list shows `groq • ... • ⚠ built-in id`.
- **back** → `Pick another name` re-prompts for the name (verified live).

Collision ids are flagged in every provider list via `describeProviderInline()`: suffix `• ⚠ built-in id`. Delete-model and Delete-models confirmations add: `Note: "${providerId}" shares its id with a built-in provider: models that also ship in pi's built-in catalog will still appear in /model after deletion.`

In the Edit → Rename path the same menu is reached (verified live with `deepseek`), and a resolved rename is announced: `Renamed "${providerId}" → "${newId}".`: after which the auth.json entry is carried over best-effort (§9).

---

## 7. Duplicate provider name

Add flow, `promptProviderId()` (`src/ui/prompts.ts`) loops instead of overwriting:

```ts
if (existingIds.has(providerId)) {
    ctx.ui.notify(`Provider "${providerId}" already exists. Choose a different name.`, "warning");
    continue;
}
```

Observed live: after saving `custom-localhost-59999`, re-using the name produced the warning and re-prompted with title `Provider name (must be unique)`. Empty slug also loops: `Provider name is required.` (error).

Backstop in `persistProvider()` (`src/flows/shared.ts`), in case the config changed underneath the prompt: exercised for real with a simulated concurrent writer that creates the id between the name prompt and the save:

```ts
if (config.providers[providerId]) {
    ctx.ui.notify(`Provider "${providerId}" already exists. Not overwriting.`, "error");
    return false;
}
```

Edit → Rename duplicate: `Provider "${newId}" already exists. Choose a different name.` (verified live with `mock-gw`): the rename is refused, nothing written.

---

## 8. Duplicate endpoint (not an error: a confirm)

`confirmEndpointReuse()` (`src/flows/add.ts`) detects providers already using the normalized endpoint and asks:

```
Endpoint already exists
This endpoint is already used by:
- mock-gw

Add another provider with the same endpoint?
```

Verified live with `http://127.0.0.1:18090/v1` (already used by `mock-gw`). `No` aborts the add (config unchanged); `Yes` continues to naming/key/model selection. Two providers may share an endpoint deliberately (e.g. different model subsets).

---

## 9. Missing / unwritable API key

### 9a. "None" is a first-class choice: a placeholder keeps the provider loadable
`promptApiKey()` offers `API key` (literal) or `None`; a blank literal input is treated as `none`. `serializeApiKey()` (`src/api-key.ts`) maps none → `"dummy"` (or `"ollama"` for the Ollama style), and the flow notifies:

```
No API key selected. Using "dummy" automatically in auth.json.
```

(style `ollama`: `No API key selected. Using "ollama" automatically in auth.json.`) Verified live and in the saved file: `auth.json` got `{"custom-localhost-59999": {"type": "api_key", "key": "dummy"}}`.

### 9b. auth.json write failure does not lose the provider
`persistApiKey()` (`src/flows/shared.ts`) is called **after** `persistProvider()` succeeded:

```ts
ctx.ui.notify(
    `Provider saved, but the API key could not be written to auth.json: ${error instanceof Error ? error.message : String(error)}. Run "/login ${providerId}" to set it.`,
    "warning",
);
```

Verified live by corrupting `auth.json` before the save: the provider landed in `models.json`, and the warning appeared with the exact recovery hint `Run "/login mock-gw-2" to set it.`

### 9c. env/shell key references resolve best-effort at probe time
`resolveApiKeyForProbe()` (`src/api-key.ts`): `env` mode returns `undefined` when the variable is unset/blank; `shell` mode swallows a failing command and returns `undefined`. Probes then run unauthenticated instead of crashing; the saved key stays the `$VAR` / `!cmd` reference so pi resolves it at request time.

### 9d. Corrupt auth.json during edit/delete is non-fatal
`removeProviderApiKey` / `renameProviderApiKey` swallow unreadable auth.json (best-effort); the caller wraps them and warns without undoing the config change:

- delete: `Provider deleted, but its auth.json entry could not be removed: ${message}` (warning)
- rename: `Renamed, but the auth.json entry could not be moved: ${message}` (warning)

---

## 10. Manual-entry escape hatch

`promptManualModels()` (`src/ui/prompts.ts`) is the universal no-network path, reachable from: the probe-failure menu, the empty-model-list path, the models picker choice `Add manually`, and Edit → `Add models manually`.

- Id prompt: `Model id` (first) / `Add another model id` (subsequent); blank enter or esc finishes. Nothing entered → returns `null` → flow aborts.
- Duplicate id inside the same session: `Model already added: ${id}` (warning) and re-prompts (verified live).
- Each id lands in its own metadata menu (`Reasoning • xhigh`, `Image input • off`, `Context window • 258000`, `Max output tokens • 32000`, `Done`) whose values start from `resolveModelInfo`: local rules + defaults, since manual ids have no probe data.
- Invalid numbers: `Enter a whole number of tokens (0 to clear).` (warning, verified headlessly via the context prompt with input `abc`).
- Unknown models get a 256K context starting point instead of staying unset (`contextWindow: resolved.contextWindow ?? 262144`).
- Adding ids that already exist in the provider: `Nothing to add: all selected models already exist.` (info).

---

## 11. Edit / Delete flow safety nets

- **No providers at all**: `No providers found in ${MODELS_JSON_PATH}` (warning): edit and delete flows return to the caller.
- **Provider vanished under the cursor**: `Provider "${providerId}" no longer exists.` (warning): every mutator (`mutateProvider`, `removeProvider`, `renameProvider`, …) re-reads and bails.
- **Model vanished**: `Model "${modelId}" no longer exists.` (warning).
- **Provider has no models**: `Provider "${providerId}" has no models.` (warning).
- **Every write is read-check-write**: `loadModelsConfig()` → mutate → `saveModelsConfig()`; read failures produce `Could not read ${MODELS_JSON_PATH}: ${message}` (error), write failures `Could not write ${MODELS_JSON_PATH}: ${message}` (error), and the mutation reports `false` so callers do not claim success.
- **Re-probe reconciliation** never silently drops models: models the endpoint no longer returns are listed with a `• unsupported` suffix, tri-state default **keep** (`[x]`); models with metadata diffs default to `[-]` (keep without update). Picker legend: `[ ] remove/skip • [-] keep without update • [x] keep/add with latest metadata`. A no-op run reports `No changes: everything the endpoint returned is already configured and up to date.`
- **Metadata refresh** (`refreshModelMetadata`) requires an explicit source choice and applies only real diffs; a matching entry reports `${modelId}: the selected entry matches the stored config.` and changes are confirmed first: `Apply ${n} change${s}?`.
- **Registry refresh is best-effort**: `refreshModelRegistry()` swallows failures: the config is already on disk; a stale in-memory snapshot fixes itself on restart.
- **Delete provider**: confirm dialog `Delete provider?` with the provider summary (id, api, model count, endpoint); cancel just returns. On success: `Deleted provider "${providerId}" from ${MODELS_JSON_PATH}` and the auth.json entry is dropped best-effort (only `api_key` entries; an oauth login under the same id is left alone).
- **Corrupt models.json** (live test, file containing `{ this is not json`): `Error: Could not read C:\...\models.json: Expected property name or '}' in JSON at position 2 (line 1 column 3)`: the flow aborts without crashing the host.
- **Catalog unreachable** (live test with all three model-probe catalog tiers broken: live API, CDN snapshot, bundled snapshot): `Error: Could not fetch the models.dev catalog: models.dev catalog contained no usable providers`: flow returns to the menu. (In normal operation model-probe degrades through three tiers before this can happen.)
- **YAML config without the `yaml` package** (OMP): `"${MODELS_JSON_PATH} is YAML, but the "yaml" package is not installed. Run "npm install" in the better-custom folder, or reinstall the extension with "pi install", to edit YAML configs.` (error).

---

## 12. Evidence index (artifacts)

All paths under `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/artifacts/`.

| id | artifact | what it proves |
|---|---|---|
| A1 | `01-add-probe-fail-manual-escape.txt` | live TUI: probe failed → manual escape → provider saved |
| A2 | `02-models-json-saved.json`, `03-auth-json-dummy.json` | saved provider + `"key": "dummy"` placeholder |
| A3 | `06-dupname-retry-prompt.txt` | duplicate-name warning + re-prompt |
| A4 | `07-builtin-collision-menu.txt`, `12-rename-collision.txt` | collision menu (add + rename paths) |
| A5 | `10-empty-models-switch-manual.txt` | "Probe succeeded but returned no models…" |
| A6 | `26-probe-fallback-test.mjs` (run output in transcript) | real servers: `/v1` fallback both directions, HTML→retry, 401 abort, unreachable error, https variant attempt |
| A7 | `11-duplicate-endpoint-confirm.txt` | duplicate-endpoint confirm text |
| A8 | `14-corrupt-config-error.txt` | corrupt models.json error, clean abort |
| A9 | `16-auth-fail-save.txt` | auth.json write failure → provider kept + `/login` hint |
| A10 | `20-catalog-fetch-failure.txt` | catalog unreachable error, clean return |
| A11 | `31-headless-add-flow-500.txt` | verbatim notifies incl. "Could not probe developer-role support : defaulting to off (safe for every endpoint)." |
| A12 | `32-headless-retry-flow.txt` | retry loop, duplicate-model warning, verbatim notifies |
| A13 | `33-headless-collision-rename.txt`, `35-headless-collision-keep.txt` | collision rename/keep branches, saved ids |
| A14 | `34-headless-probe-cancel.txt` | Cancel writes nothing |
| A15 | `36-headless-validations.txt` | "Endpoint is required.", invalid token-number warning, delete notify |
| A16 | `37-headless-delete.txt` | delete removes provider + auth entry, keeps others |
| A17 | `18-devrole-path.txt`, `19-url-key-results.json`, `27-devrole-test.mjs`, `28-url-key-test.mjs` | developer-role probe outcomes (false/undefined/true), URL normalization + key serialization tables |
| A18 | `gateway-requests.jsonl`, `gateway-500-requests.jsonl`, `gateway-empty-requests.jsonl` | raw request logs of the mock gateways (probe sequences incl. `/v1/models`, `/model/info`, `/api/models/public`, per-model, chat/completions) |
| A19 | `21-rename-to-existing-warning.txt`, `22-devrole-inconclusive.txt`, `30-inc5-samples.txt` | rename-to-existing refusal; transient notify sampling |
| A20 | `00-shell-history-full.txt`, `09-full-session-scrollback.txt` | raw TUI scrollback transcripts |
| A21 | `38-headless-race-guard.txt` | concurrent-writer race: `persistProvider` refuses with `Provider "race-name" already exists. Not overwriting.`, concurrent file left intact, no auth write |
