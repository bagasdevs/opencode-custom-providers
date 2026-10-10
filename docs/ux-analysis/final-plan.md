# Final Plan — making `opencode-custom-providers` beginner-friendly

One ordered list, grouped **Blocker > Major > Minor**. Every item names `our file:line`, the **exact current text**, the **exact replacement**, and **why** (one line).

Sources merged: `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/join-experience.md` (J1–J13, cut list) and `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/join-safety.md` (G1–G18, K1–K5). Overlapping items are collapsed to their strictest requirement and the higher severity; the merge key is given in each item.

Convention: quoted `current:` blocks reproduce the source text exactly; inside a markdown list item the block's leading indentation is normalised (TypeScript is whitespace-insensitive), and every token is otherwise byte-identical to the working tree. Verified by the audit transcripts in §Evidence, which report 0 textual differences after whitespace normalisation.

Grounding: every `file:line` below was read from the working tree on 2026-10-10 and every behavioural claim was reproduced against the real compiled plugin surface (`dist/`, identical to `src/` on every cited anchor) — see the verification transcripts listed in §Evidence.

**Reading order:** B1–B7 are the "beginner is stuck or silently loses work" set. M1–M11 are "misled / degraded". m1–m8 are polish and defensive notes.

---

## Blocker

### B1. A failed or empty probe must offer Retry / Add manually / Cancel instead of a dead-end alert
- **Merged from:** J3 + J12 + G1 + G13 + G12(4) — one recovery surface for all four probe outcomes.
- **`src/tui-v2.ts:225-232`**
  - current:
    ```ts
    const { message } = await call<{ message: string }>(ctx, "add", {
      providerId,
      baseURL,
      flavor,
      apiKey: apiKey || undefined,
      displayStyle,
    })
    await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message })
    ```
  - replacement: call `add` in a bounded loop and branch on a structured status. The server returns `{ status: "ok" | "manual_required" | "unreachable", message }`; on anything but `"ok"`, show `ctx.ui.dialog.select({ title: "That address did not answer. What next?", options: [{title:"Try again", value:"retry"},{title:"Add models manually", value:"manual"},{title:"Cancel", value:"cancel"}] })`. `retry` re-runs the same `call("add", …)` (max 3 attempts, re-showing `Discovering models from …` each time), `manual` prompts for comma-separated ids and calls the new `manualAdd` RPC (B2), `cancel` shows `Cancelled. Nothing was saved.`.
- **`src/server-v2.ts:436-438`**
  - current:
    ```ts
    return { message: `Nothing was saved: the address ${candidate.baseURL} did not answer with a model list.\n${probeHint(error)}\n\nTechnical detail: ${sanitizeErrorMessage(error)}` }
    ```
  - replacement: `return { status: "unreachable", message: \`Nothing was saved: the address ${candidate.baseURL} did not answer with a model list.\n${probeHint(error)}\` }` and move the raw detail to a `detail` field the TUI shows only under "Technical detail (for bug reports)".
- **`src/server-v2.ts:448-456`**
  - current: the `'…' was saved, but it did not return any models yet …` block listing `/edit-provider` → `/reload-models`.
  - replacement: `return { status: "manual_required", message: \`The address answered, but it listed no models. You can type the model names yourself.\` }` — and delete the "run /reload-models to try again" advice, which cannot succeed while the endpoint lists nothing.
- **Why:** a wrong URL, a missing `/v1`, or a key-gated `/models` is the most common first-run failure and today the wizard ends in an alert with no way forward except restarting from Step 1.
- **Evidence:** T1 (401 → alert, no recovery menu), T2 (0 models → same dead end), G3 (d) — the zero-model guidance block is unreachable for listable flavors because `probeEndpoint` throws first; it is only reachable via `flavor=anthropic`, where the advice ("ends in /v1") is wrong.

### B2. Manual model entry must exist in v2 at all
- **Merged from:** G1(2) + J3(1b) + G10(1) — one RPC that writes a provider without a successful probe.
- **`src/server-v2.ts:401-473`** (the `add` op)
  - current: `add` is the only creation path and it always requires `await discover(candidate)` to succeed.
  - replacement: add a sibling op
    ```ts
    manualAdd: async (input: { providerId: string; baseURL: string; modelIds: string; flavor?: string; displayStyle?: DisplayStyle }): Promise<{ status: string; message: string }> => { /* validate id + url + collision, then: */ const previews = await previewManualModels(ids, flavor, displayStyle); /* managed.set + persist + registerIntegration + applyModels(providerId, previews.map(p => p.probed), displayStyle) */ }
    ```
    reusing `previewManualModels` (`src/probe.ts:468-486`), which resolves hand-typed ids against the local rules and the models.dev lookup with no endpoint traffic, exactly as v1 does at `src/tui.ts:571-604`. Note the contract at `src/probe.ts:472-475`: an omitted id list means "all models", and an explicitly empty one must be rejected by the caller — `manualAdd` must therefore require at least one id. Register it in the RPC method table (`src/server-v2.ts:767-900`) and as a `custom-providers` tool (`src/server-v2.ts:1008-1050`).
- **Why:** with no `/models` route, a blocked gateway, or a key that cannot be obtained yet, the beginner currently cannot add a provider at all; the raw RPC surface confirms there is no manual method (`["list","add","edit","remove","reprobe","apply","refresh","catalog.list","catalog.add"]`).
- **Evidence:** G3 (d) — `manual entry method present? NO`.

### B3. Deleting a provider must stick, and must not leave the credential behind
- **Merged from:** G3 + G8(2) + J8(3).
- **`src/server-v2.ts:591-596`**
  - current:
    ```ts
    await ctx.provider.transform((providers) => {
      providers.update(providerId, (provider) => {
        provider.settings = { ...(provider.settings ?? {}), dynamic: false }
      })
      for (const modelId of staleModels) providers.models.remove(providerId, modelId)
    })
    ```
  - replacement: also strip the address that lets `candidateFrom` resurrect the record:
    ```ts
    await ctx.provider.transform((providers) => {
      providers.update(providerId, (provider) => {
        const settings = { ...(provider.settings ?? {}) }
        delete settings.baseURL
        delete settings.dynamic
        provider.settings = settings
      })
      for (const modelId of staleModels) providers.models.remove(providerId, modelId)
    })
    ```
    then, best-effort, remove the credential and append a warning line to the message when that fails: `Provider deleted, but its saved API key could not be removed — check opencode's credential store.` The v2 `integration` interface today exposes only `connect.key`, `connection.active` and `connection.resolve` (`src/server-v2.ts:69-77`) — there is **no** removal method — so the item requires adding one (e.g. `connect.remove({ integrationID })` or `connection.remove(connection)`) to `V2Context` first, and degrading gracefully (warning, not throw) if the host does not provide it.
- **`src/tui-v2.ts:363`**
  - current: `` message: `Remove '${provider.id}' and its ${provider.models} model(s)?\n\nThis cannot be undone. Your other opencode settings are not touched. You can add it again later with /add-provider.` ``
  - replacement: append `\n\nIts saved API key is removed too, so it will not be left behind.` once the credential removal is wired, so the confirm matches what actually happens.
- **Why:** after "Removed", the provider is still listed, `/reload-models` re-adds its models, a second delete says it "comes from your opencode config", and the API key survives — verified end to end.
- **Evidence:** G6 (a) — after `remove`: `list ids = ["zombie"]`, live settings `{"baseURL":"…","dynamic":false}`, `refresh` → `"Updated: zombie."`, `list after refresh: ["zombie(2)"]`, credential still `"sk-gone"`; G6 (b) proves the `delete settings.baseURL` replacement makes `list` and `refresh` both return empty.

### B4. A typed URL that is nearly right must be repaired, not rejected
- **Merged from:** G5 + J10 + G12(1) — one normaliser in front of every entry point.
- **New:** `src/endpoint.ts` — add `export function normalizeBaseUrl(raw: string): string` (infer `http://` for `localhost`/`127.`/`::1`/`10.`/`192.168.`/`172.16-31.`/`*.local`/`0.0.0.0`/`[…]` and `https://` otherwise when no scheme is present, then strip trailing `/` and a trailing `/chat/completions`, `/models`, `/responses`, `/messages`).
- **`src/tui-v2.ts:186`**
  - current: `if (isValidUrl(baseURL)) break`
  - replacement:
    ```ts
    baseURL = normalizeBaseUrl(baseURL)
    if (isValidUrl(baseURL)) break
    ```
- **`src/server-v2.ts:412-414`**
  - current:
    ```ts
    if (!isValidUrl(input.baseURL)) {
      return { message: "That does not look like a web address. Enter the full base URL, including https://. Example: https://api.example.com/v1" }
    }
    ```
  - replacement: `input.baseURL = normalizeBaseUrl(input.baseURL)` before the check, so the RPC and the wizard cannot diverge; keep the strict check as the second pass.
- **`src/tui-v2.ts:340-345`**
  - current:
    ```ts
    value = await ctx.ui.dialog.prompt({
      title: "New Base URL",
      description: "Must start with https:// (or http:// for something on this computer) and usually ends in /v1",
      value: provider.baseURL,
    })
    ```
  - replacement: same prompt, then `value = normalizeBaseUrl(value)` before the `edit` call, so Edit and Add accept the same strings.
- **Why:** the two most common beginner inputs — a bare host and a copy-pasted full endpoint path — are rejected today even though the plugin can trivially repair both.
- **Evidence:** G1 `reject-bare-host` (`isValidUrl("localhost:11434/v1") = false`), S4 (bare host rejected; pasted path stored verbatim), G6 (c) (pasted path against a working gateway → `HTTP 404`; the same gateway with a clean `/v1` succeeds).

### B5. Re-running Add with an existing name must ask before replacing it
- **Merged from:** G6 + J4(2) — one guard at the prompt, one backstop on the RPC.
- **`src/tui-v2.ts:150-157`** (after the id-pattern check)
  - current: the id is validated and the flow proceeds straight to Step 2.
  - replacement: insert
    ```ts
    const { providers } = await call<{ providers: ProviderRow[] }>(ctx, "list")
    if (providers.some(p => p.id === providerId)) {
      const replace = await ctx.ui.dialog.confirm({ title: "You already have a provider with this name", message: `'${providerId}' is already set up with ${providers.find(p => p.id === providerId)?.models ?? 0} model(s).\n\nReplacing it keeps the same name but changes its address and models.`, label: { confirm: "Replace it", cancel: "Pick another name" } })
      if (!replace) { cancelled(ctx); return }
    }
    ```
- **`src/server-v2.ts:439-443`**
  - current:
    ```ts
    managed.set(candidate.providerId, {
      baseURL: candidate.baseURL,
      flavor: candidate.flavor,
      displayStyle: candidate.displayStyle,
    })
    ```
  - replacement: `if (managed.has(candidate.providerId) && !input.overwrite) return { status: "confirm_replace", message: \`A provider named '${candidate.providerId}' already exists. Add overwrite=true to replace it.\` }` before the `managed.set`, so a programmatic caller cannot silently replace either.
- **Why:** a mistyped-then-retyped name silently repoints a working provider and mixes the old and new model lists — the beginner sees "Done" and no indication anything was replaced.
- **Evidence:** S5 — after the second add with the same id: managed baseURL replaced, models became `["a-1","a-2","b-1"]` (old and new mixed), no prompt of any kind.

### B6. The reconcile default must never overwrite a hand-tuned model
- **Merged from:** J1 + G2(2) + G7(1) — the v1 destructive default, plus the v2 unreachable per-model path, plus the missing metadata diff.
- **`src/reconcile.ts:106`**
  - current: `const decision = decisions[p.id] ?? "apply"`
  - replacement: `const stored = current[p.id]; const decision = decisions[p.id] ?? (stored ? "keep" : "apply")`
- **`src/reconcile.ts:117`**
  - current: `const decision = decisions[id] ?? "keep"`
  - replacement: keep as-is and add the comment `// A probe gap must not delete your config.`
- **`src/tui-v2.ts:294-303`**
  - current:
    ```ts
    await ctx.ui.dialog.alert({ title: `What was found for ${provider.id}`, message })
    ```
    followed by a two-option select `["Apply everything","Keep what I have"]`.
  - replacement: show the per-model diff first (see M4) and offer three options — `Review each model` (first), `Apply everything`, `Keep what I have` — then, for `Review each`, loop one select per changed model with options in the order `Keep stored (default)`, `Apply update`, `Remove`, collecting a `decisions` map passed as JSON to the existing `apply` RPC (`src/server-v2.ts:641-705`).
- **`src/server-v2.ts:625-627`**
  - current: `` added.length === 0 && vanished.length === 0 ? `Up to date: the provider still lists the same ${fresh.length} model${fresh.length === 1 ? "" : "s"}. Nothing to do.` : … ``
  - replacement: compute a field-level diff per shared id (`context`, `output`, `image`, `reasoning`, `cost`) using `diffModels`/`describeUpdate` from `src/reconcile.ts:20-48`, list the changes as `  ~ ${id}: context 100000 -> 200000`, and only print "Up to date" when there is genuinely no field difference.
- **Why:** today "press Enter and go" overwrites metadata the user hand-tuned, a provider that silently raises a context window is reported as "Up to date", and the v2 TUI offers no per-model path at all.
- **Evidence:** G1 `absent-decision-overwrites-stored` (stored `128000` → `1000000` with no decision expressed), C4 (hand-tuned `1234` → `200000`), S7 (provider raised `100000`→`200000`; reprobe said `"Up to date … Nothing to do."` and `apply(mode=apply)` left the stored `100000` untouched), T5 (`per-model path offered? NO - binary only`).

### B7. The catalog must not offer sites that cannot be added
- **Merged from:** G4 + J3(2, third case) + J10(4).
- **`src/catalog.ts:176`**
  - current: `.filter(p => p && typeof p.id === "string" && p.models && Object.keys(p.models).length > 0)`
  - replacement: `.filter(p => p && typeof p.id === "string" && p.api && isValidUrl(p.api) && p.models && Object.keys(p.models).length > 0)` (import `isValidUrl` from `./security.js`), so `catalog.list` never offers a site that `catalog.add` will reject.
- **`src/tui-v2.ts:203-209`**
  - current: the Anthropic branch alerting `"Anthropic APIs cannot list their models here, so this wizard cannot finish.\n\nRun /add-from-catalog and pick Anthropic from the list.\n\nNothing was saved."`
  - replacement: since B1/B2 land first, replace this dead end with the manual path: `Anthropic APIs cannot list their models here. Type the model names you use and they will be added with metadata from the public model database.` → jump to the B2 manual prompt instead of aborting.
- **Why:** the wizard sends Claude users to the catalog, and the catalog cannot add Anthropic, OpenAI, Google, Groq or Mistral — 25 of 226 sites have no `api` URL, and they are exactly the biggest names a beginner picks.
- **Evidence:** S8 — `sites offered: 226`, `anthropic: offered=true add="The catalog entry for 'anthropic' has no usable web address…"` (same for `openai`, `google`, `mistral`); T4 shows the wizard's own instruction to use that catalog; the cache count is `with api: 201, without api: 25`.

---

## Major

### M1. Show provenance the way a beginner can read it: bare = measured, tagged = guessed, absent = default
- **Merged from:** J2 + K1(1) + G16(2) + G17(1).
- **`src/probe.ts:382-396`**
  - current: `describeProbed` renders every field with a prose source, e.g. `` `  Context window: ${probed.context?.toLocaleString("en-US") ?? "unknown"} tokens (${sourceWord(probed.contextSource)})` ``, so an unmeasured value reads as `estimated default`.
  - replacement: keep `describeProbed` for the long form and add `describeProbedShort(probed): string` for single-line picker rows emitting `128K [models.dev]` / `context 128K [local rules]` and **nothing** for `api-fallback`/`default`; in the long form, omit the whole `Context window:` / `Longest reply:` / `Thinking:` line when the corresponding source is `"default"` or `"api-fallback"` rather than asserting a capability that was never measured.
- **`src/tui.ts:378`** — current: `` { title: "Apply", value: "apply", description: `${change.detail}${source}` } `` — replacement: `description: \`${change.detail}${source}\`` where `source` is now `describeProbedShort(fresh)` so the diff and its provenance share one line.
- **Why:** a guessed 128K context currently reads exactly like a reported one, and `Thinking: supported (assumed default)` asserts a capability the plugin never measured.
- **Evidence:** G1 `placeholder-written` and `prose-asserts-default` (`"Thinking: supported (assumed default)"`).

### M2. Never write a placeholder number when the real value is unknown
- **Merged from:** J6 + G1(3).
- **`src/probe.ts:349-352`**
  - current:
    ```ts
    limit: {
      context: probed.context ?? 128_000,
      output: probed.maxOutput ?? 4_096,
    },
    ```
  - replacement: emit `limit` with only the fields that have evidence — `const limit: { context?: number; output?: number } = {}; if (probed.context !== undefined && probed.contextSource !== "default" && probed.contextSource !== "api-fallback") limit.context = probed.context;` (same for `output`) — and widen `EnrichedModel.limit` (`src/enrich.ts:22-26`) so `context`/`output` may be absent.
- **`src/enrich.ts:85,87`** — current: `context: epContext ?? meta?.limit.context ?? 128_000,` / `output: epOutput ?? meta?.limit.output ?? 4096,` — replacement: `...(epContext ?? meta?.limit.context) !== undefined ? { context: epContext ?? meta!.limit.context } : {}` (same for output), so no invented number reaches disk.
- **`src/enrich.ts:100-105`**
  - current:
    ```ts
    model.cost = {
      input: meta.cost?.input ?? 0,
      output: meta.cost?.output ?? 0,
      cache_read: meta.cost?.cache_read,
      cache_write: meta.cost?.cache_write,
    }
    ```
  - replacement: move inside `if (meta.cost)` so an unknown price stays absent instead of a real-looking `0`.
- **Why:** a beginner reads `context 128000` in their config as measured fact; it is the plugin's fallback, and OpenCode's own fallback chain already handles a genuinely absent value.
- **Evidence:** G1 `placeholder-written` (`unknown provenance still stored context=128000 output=4096`).

### M3. One resolver, one clamp, at the single write boundary
- **Merged from:** J7 + G2(1).
- **`src/probe.ts:234-236`**
  - current:
    ```ts
    if (probed.maxOutput !== undefined && probed.context !== undefined && probed.maxOutput >= probed.context) {
      probed.maxOutput = Math.max(1, Math.floor(probed.context / 2))
    }
    ```
  - replacement: keep the clamp and add the contract comment `// resolveModel is the ONLY resolver: every write path (probe, manual, catalog) must route through it, so this clamp cannot be bypassed.` Then delete the unclamped duplicate at `src/enrich.ts:67` `buildEnrichedModel` (exported from `src/discovery.ts:8`, no other in-repo consumer) so there is exactly one resolver.
- **Why:** a catalog entry with `maxTokens == contextWindow` makes every reply impossible; two resolvers means one of them can be reached without the clamp.
- **Evidence:** `src/enrich.ts:85,87` compute `128_000`/`4096` with no `>=` clamp; `src/probe.ts:234` clamps; both are exported write paths.

### M4. The reconcile screen must say what changed and default to the safe row
- **Merged from:** G2(1,3) + J1(3,4) + J9(2) + J9(4).
- **`src/server-v2.ts:992-994`** (the `reprobe-models` tool description)
  - current:
    ```ts
    "Re-probe a provider's endpoint and list model changes (added, vanished). Read-only — " +
    "apply-reconcile persists decisions.",
    ```
  - replacement: `"Re-probe a provider's endpoint and list model changes (added, vanished, metadata updated). Read-only — apply-reconcile persists decisions. Defaults per row: changed/vanished → keep, new → apply."`
- **`src/server-v2.ts:1004-1005`** (the `apply-reconcile` tool description)
  - current: `description: "Choose which model changes to accept (apply / keep / remove per model).",`
  - replacement: `description: "Choose which model changes to accept (apply / keep / remove per model). Omitted ids default to keep when the model is already stored and apply when it is new.",`
- **`src/reconcile.ts:10-15`**
  - current:
    ```ts
    export interface ModelChange {
      id: string
      kind: ChangeKind
      /** Human-readable summary, e.g. "context 128000 -> 1000000, image [+]". */
      detail: string
    }
    ```
  - replacement: add `searchText?: string` populated as `` `${id} ${kind}` `` so the host dialog's filter can isolate a whole decision class by typing `added` / `updated` / `removed`.
- **`src/tui.ts:364-368`**
  - current:
    ```ts
    const mode = await showSelect(api, `${rep.changes.length} change(s) found`, [
      { title: "Apply all", value: "all", description: "Take every fresh value, keep vanished" },
      { title: "Review each", value: "each", description: "Decide per model" },
      { title: "Cancel", value: "cancel", description: "Change nothing" },
    ])
    ```
  - replacement: order the options `Review each` (first), `Keep what I have (safest)`, `Cancel`, and delete the `Apply all` entry so no screen offers "overwrite everything" as the top choice; in the per-model loop at `src/tui.ts:377-381`, reorder to `Keep stored` (first), `Apply update`, `Remove`.
- **Why:** "Apply all" as the default teaches beginners to overwrite their own tuning, and a 400-model gateway currently produces 400 sequential dialogs with no category filter.
- **Evidence:** T5 (binary-only v2 choice), G1 `diff-has-updated` (the field-level diff machinery already exists but is unused in v2).

### M5. Clamp and guard every numeric prompt: blank = keep, 0 = clear, Esc = no change
- **Merged from:** J5 + J7(2).
- **`src/commands.ts:355-358`**
  - current:
    ```ts
    const n = Number(value)
    if (!Number.isInteger(n) || n <= 0) {
      return `'${field}' must be a positive integer (got '${value}').`
    }
    ```
  - replacement:
    ```ts
    if (value.trim() === "") return null                      // keep
    const n = Number(value)
    if (n === 0) { if (field === "context") delete model.limit.context; else delete model.limit.output; return null }  // clear
    if (!Number.isInteger(n) || n < 0) return `'${field}' must be a whole number of tokens, or 0 to clear it (got '${value}').`
    ```
- **`src/tui.ts:559`**
  - current:
    ```ts
    const raw = await showPrompt(api, `${field} (current: ${current})`)
    ```
  - replacement: for the numeric fields only, `const raw = await showPrompt(api, field === "context" || field === "output" ? \`${field} (blank = keep ${current}, 0 = clear)\` : \`${field} (current: ${current})\`)`
- **Why:** the most-edited per-model values currently have no way to be kept or cleared — a blank line is an error and `0` is rejected — so fixing a wrong context window means retyping a number the user may not know.
- **Evidence:** G1 `zero-rejected` (`'context' must be a positive integer (got '0').`), `blank-rejected` (same for `''`).

### M6. The API key must be removable, and the legacy inline key must migrate on every save
- **Merged from:** G8(1) + J8(1,2,3).
- **`src/server-v2.ts:501`**
  - current: `if (input.apiKey) {` — an empty string is ignored, so `edit` with `apiKey: ""` reports "Saved … is unchanged".
  - replacement:
    ```ts
    if (input.apiKey !== undefined) {
      if (input.apiKey === "") {
        // best-effort: remove the stored credential, append a warning line on failure
      } else {
        await ctx.integration.connect.key({ integrationID: input.providerId, key: input.apiKey })
      }
    }
    ```
    Clearing needs a removal method on the host surface, which does not exist today (`src/server-v2.ts:69-77` exposes only `connect.key` / `connection.active` / `connection.resolve`), so this item depends on the same interface extension as B3.
- **`src/tui-v2.ts:322-323`**
  - current: `{ title: "API key", value: "apiKey", description: "Replace the saved key" },`
  - replacement: `{ title: "API key", value: "apiKey", description: "Replace or clear the saved key" },` and in the `apiKey` branch add a fourth option `Clear the saved key` that calls `edit` with `apiKey: ""`.
- **`src/commands.ts:404-421`**
  - current:
    ```ts
    export async function migrateInlineKey(
      provider: ProviderConfig,
      providerId: string,
      storeApiKey: StoreApiKeyFn,
    ): Promise<{ migrated: boolean; note: string }> {
      const inline = provider.options?.apiKey
      if (!inline) return { migrated: false, note: "" }
    ```
    The ordering is already right — it stores first (`:412`) and strips the inline copy only after a truthy result (`:419`) — but it is reached from just two interactive edit paths, `src/tui.ts:411` and `src/server.ts:364`, and never from the add path.
  - replacement: call it from the shared save path (`reloadAllProviders`, `src/commands.ts:66-125`) so any write migrates, and add the comment `// auth store first, inline copy second: a failed write must never strand a key.`
- **Why:** a beginner who switches a provider to a local no-key server, or who leaks a key, cannot clear it — "Saved. 'x' is unchanged." is the whole response, and the credential survives delete (B3).
- **Evidence:** S9 — `edit apiKey:'' -> "Saved. 'keys' is unchanged."`, credential after `edit('')` still `"sk-first"`; G3 (e) — no key/credential method exists in the v2 RPC table.

### M7. Provider rename (v2), with the credential moved with it
- **Merged from:** G9 + J8(3).
- **`src/tui-v2.ts:312-324`**
  - current: the field picker offers only `Base URL`, `API type`, `How models are listed`, `API key`.
  - replacement: add `{ title: "Name", value: "providerId", description: \`Currently: ${provider.id}\` }` and a `wizardRename` path that validates the id, runs `collisionSuggestion`, checks `list` for a duplicate, then calls a new `rename` RPC.
- **`src/server-v2.ts`** (new op beside `edit`, `src/server-v2.ts:474-555`)
  - replacement: `rename: async (input: { from: string; to: string }) => { /* validId, collisionSuggestion, managed.has(to) guard, then move the managed entry + discovered models + credential (read connection for `from`, connect.key for `to`) */ }` and register it in the RPC table and tool set.
- **Why:** a typo in a provider name is currently permanent without hand-editing config, and the v1 rename path warns that the credential is stranded — the beginner has no rename at all in v2.
- **Evidence:** v2 RPC methods list has no `rename`; `src/tui.ts:462` shows v1's own warning that the credential stays keyed by the old id.

### M8. Per-model metadata editing and per-model deletion in v2
- **Merged from:** G15 + G10 + J5(1) + G17.
- **`src/server-v2.ts`** (new ops beside `apply`, `src/server-v2.ts:641`)
  - replacement: add `editModel: async (input: { providerId: string; modelId: string; patch: string }) => { /* validate the id exists, parse the patch JSON, merge into the live draft, provider.reload() */ }` and `deleteModels: async (input: { providerId: string; modelIds: string }) => { /* split, filter, ctx.provider.transform + models.remove + reload */ }`, then register both in the RPC table (`src/server-v2.ts:767-900`) and expose them as tools.
- **`src/tui-v2.ts:317-325`**
  - current:
    ```ts
    const field = await ctx.ui.dialog.select({
      title: `What do you want to change for ${provider.id}?`,
      options: [
        { title: "Base URL", value: "baseURL", description: `Currently: ${provider.baseURL}` },
        { title: "API type", value: "flavor", description: `Currently: ${flavorLabel}` },
        { title: "How models are listed", value: "displayStyle", description: `Currently: ${styleLabel}` },
        { title: "API key", value: "apiKey", description: "Replace the saved key" },
      ],
    })
    ```
  - replacement: extend the field picker with `Edit a model` and `Delete models`, mirroring v1's `ModelField` set (`src/commands.ts:331`) — `name/context/output/reasoning/image` — and reusing the M5 prompt contract for the numeric ones.
- **Why:** fixing one model's context window or dropping a stale model currently requires re-probing the whole provider (which cannot update metadata at all — see B6) or deleting and re-adding it.
- **Evidence:** v2 RPC table has no model-level write method; `src/tui-v2.ts` has no model field in the Edit picker (T6 option list).

### M9. Reasoning effort levels must survive into the stored model
- **Merged from:** G17 + J2(3).
- **`src/v2-models.ts:29`**
  - current: `if (model.reasoning) draft.variants = []`
  - replacement: `if (model.reasoning) draft.variants = (model.reasoningLevels?.length ? model.reasoningLevels : ["low","medium","high"]).map(level => ({ id: level, label: level, thinkingLevel: level }))` so the effort options the gateway advertised are actually selectable, defaulting a reasoning model to the full set rather than an empty list.
- **Why:** a reasoning model appears in the picker but cannot be tuned — the probe collects `reasoningLevels` and the v2 draft throws them away.
- **Evidence:** G1 `variants-dropped` — `reasoningLevels [low,medium,high] -> draft.variants = []`.

### M10. Endpoint normalisation must also write back the variant that answered
- **Merged from:** J10(1,2) + G12(2) + G12(3).
- **`src/probe.ts:37-58`**
  - current: `buildCandidateUrls` returns `string[]`, so `probeEndpoint` (`src/probe.ts:310-330`) discards which candidate answered.
  - replacement: have `probeEndpoint` also return the winning candidate (`{ models, baseURL }` or an added `probedBaseUrl` on the result) and thread it back to `add`/`edit` so the stored `baseURL` is the one that actually answered.
- **`src/probe.ts:51`**
  - current: `if (url.protocol === "http:" && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {`
  - replacement: widen the local-host test to `localhost`, `127.`, `::1`, `[::1]`, `0.0.0.0`, `10.`, `192.168.`, `172.16`–`172.31`, `*.local`, so a LAN host is never probed over https.
- **`src/probe.ts:336`**
  - current: `if (FLAVORS[flavor].listShape === "none") return []`
  - replacement: `return []` stays, but `add` must report it as the distinct third outcome from B1 (`This provider's API does not expose /models. Use Add models manually.`) rather than folding it into the zero-model message.
- **Why:** "does my URL need `/v1`?" is the number-one beginner question, and the plugin currently guesses at probe time but forgets the answer, so every later re-probe re-guesses.
- **Evidence:** G6 (b) — `add` without `/v1` stored `"http://127.0.0.1:60285"` while the gateway only answers at `/v1/models`; the probe found the right candidate and the stored value was not updated. G6 (d) shows `http://192.168.1.5:8000/v1` and `http://10.0.0.7:8000/v1` still get an https variant.

### M11. After every save, say what to do next and what was actually learned
- **Merged from:** J11 + J12(1) + J9(4).
- **`src/commands.ts:193`**
  - current:
    ```ts
    message: `Provider '${params.providerId}' added with ${modelCount} model(s).`,
    ```
  - replacement: `` message: `Provider '${params.providerId}' added with ${modelCount} model(s). Open the model picker and choose one to start using it.` + (detected > 0 ? ` — metadata detected for ${detected} model(s)` : "") ``, where `detected` counts models whose `contextSource`/`maxOutputSource` is `"detected"`.
- **`src/commands.ts:168`**
  - current: `message: "No models found at the given endpoint. Provider not added.",`
  - replacement: split the two causes the way `zeroModelsHint` already does (`src/server-v2.ts:154-158`): with a key → `The endpoint answered but listed no models. Check that the address ends with /v1.`; without → `The endpoint answered but listed no models. Most gateways need an API key before they list models — add one and try again.`, and hand the flow to the B1 recovery menu instead of returning.
- **`src/tui.ts:306-308`**
  - current:
    ```ts
    if (!result.success || !result.providerEntry) {
      api.ui.toast({ message: result.message, variant: "warning" })
      return
    }
    ```
  - replacement: open the B1-style select (`Try again` / `Add models manually` / `Cancel`) instead of a toast, so the v1 TUI gets the same recovery as v2.
- **Why:** "Provider added with 3 model(s)." is true but useless — the beginner does not know that the next step is the model picker, and a failed probe tells them nothing actionable.
- **Evidence:** S1/T1/T2 — the failure copy is either a bare alert or a toast with no next action; `src/commands.ts:168` collapses "unreachable" and "empty list" into one sentence.

### M12. Adding a second provider on an endpoint you already use must say so
- **Merged from:** G14 + J10(2).
- **`src/server-v2.ts:425-432`**
  - current:
    ```ts
    const candidate: Candidate = {
      providerId: input.providerId,
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      overrideKey: input.apiKey,
      flavor: parseFlavor(input.flavor) ?? DEFAULT_FLAVOR,
      displayStyle: input.displayStyle === "name" ? "name" : "slug",
    }
    ```
  - replacement: before the probe, look for another managed entry with the same normalised address and, unless `input.confirmReuse` is set, return
    ```ts
    const reused = [...managed.entries()].filter(([id, entry]) => id !== input.providerId && entry.baseURL.replace(/\/+$/, "") === normalizeBaseUrl(input.baseURL))
    if (reused.length > 0 && !input.confirmReuse) {
      return { status: "confirm_endpoint_reuse", usedBy: reused.map(([id]) => id), message: `This address is already used by: ${reused.map(([id]) => id).join(", ")}. Adding another provider on the same address means every model will appear twice in the picker.` }
    }
    ```
- **`src/tui-v2.ts:225-232`**
  - current: the single `call("add", …)` followed by `await ctx.ui.dialog.alert({ title: \`Add provider: ${providerId}\`, message })`.
  - replacement: when the response carries `status === "confirm_endpoint_reuse"`, show `ctx.ui.dialog.confirm({ title: "That address is already in use", message: \`This address is already used by: ${usedBy.join(", ")}.

Add another provider on the same address?\`, label: { confirm: "Add it anyway", cancel: "Cancel" } })` and only then re-call `add` with `confirmReuse: true`.
- **Why:** a beginner who adds the same gateway twice under two names gets every model duplicated in the picker, with no warning and no easy way to tell the entries apart afterwards.
- **Evidence:** the v2 RPC `add` performs no endpoint-reuse check (S5 used two distinct addresses to prove the *name* collision; the same code path accepts a repeated address silently), and `list` reports per-provider counts with no duplicate-address signal.
---

## Minor

### m1. The built-in id collision set must be complete
- **Merged from:** G11 + J4(3).
- **`src/flavors.ts:75-78`**
  - current:
    ```ts
    const BUILT_IN_IDS = new Set([
      "openai", "anthropic", "google", "gemini", "deepseek", "xai",
      "groq", "ollama", "openrouter", "azure", "bedrock", "vertex",
    ])
    ```
  - replacement: extend to the full host list (`amazon-bedrock`, `azure-openai-responses`, `github-copilot`, `mistral`, `minimax`, `opencode`, `together`, `vercel-ai-gateway`, `zai`, `zai-coding-cn`, …) with a comment naming the source and date, or derive it from the host provider list at startup if such an API exists.
- **Why:** naming a provider `mistral` or `opencode` silently merges it with a built-in, and the symptoms (models reappearing after delete, shared credentials) are baffling.
- **Evidence:** G1 `collision-misses-mistral` (`null`), `collision-misses-opencode` (`null`), `collision-hits-openai` (`"openai-custom"`).

### m2. Collision and duplicate resolution must be a picker, not a toast
- **Merged from:** J4(1,2,4) + G6(1).
- **`src/tui.ts:176-179`**
  - current:
    ```ts
    const suggestion = collisionSuggestion(providerId)
    if (suggestion && suggestion !== providerId) {
      api.ui.toast({ message: `'${providerId}' merges with a built-in id; '${suggestion}' stays separate.`, variant: "warning" })
    }
    ```
  - replacement: `const use = await showSelect(api, "That name belongs to a built-in provider", [{ title: \`Use ${suggestion} (recommended)\`, value: "suggested", description: "Keeps your setup separate" }, { title: \`Keep ${providerId}\`, value: "keep", description: "Shares credentials and the model list with the built-in provider" }, { title: "Pick another name", value: "other" }])` and loop until a non-colliding id is chosen, replacing the `Overwrite it?` confirm at `src/tui.ts:263-271`.
- **Why:** the suggestion is computed and then only reported; the wrong question ("Overwrite it?") is asked instead of resolving the id collision.
- **Evidence:** `collisionSuggestion` is applied in `src/tui-v2.ts:159-169` (confirm) but only toasted in `src/tui.ts:176-179`; `src/tui.ts:263-271` asks about overwriting.

### m3. The v2 wizard's "Add from catalog" name prompt must validate
- **Merged from:** G4(4) + J4.
- **`src/tui-v2.ts:258-266`**
  - current: the provider name prompt accepts any string, then calls `catalog.add` with it.
  - replacement: run `ID_PATTERN.test(providerId)` and `collisionSuggestion` in the wizard before the call, mirroring `wizardAdd` (`src/tui-v2.ts:151-169`).
- **Why:** the RPC does reject a bad name, but the beginner only learns after the whole flow, at the final alert.
- **Evidence:** `src/server-v2.ts:737-739` is the only guard; the TUI path has none.

### m4. Surface a catalog warning when the fetch falls back or is empty
- **Merged from:** G18.
- **`src/server-v2.ts:728`**
  - current: `catalogList: async (): Promise<{ sites: SiteRow[] }> => ({ sites: await listCatalogSites() }),`
  - replacement: include a `warning?: string` in the payload when the catalog came from stale cache or is empty, and show it as a toast in `wizardCatalogAdd` before the picker.
- **Why:** "The built-in catalog is empty" is shown when the truth is "the catalog could not be fetched", which sends the beginner looking for a problem that is not theirs.
- **Evidence:** `src/catalog.ts:112-116` silently returns the stale `entry.data`, or `{}` when there is no cache, with no way for the caller to tell the two apart; `src/tui-v2.ts:238` then reports the empty result as `"The built-in catalog is empty…"`.

### m5. State the reconcile default rule where agents read it
- **Merged from:** J9(4) + G2.
- **`src/server-v2.ts:923-926`**
  - current:
    ```ts
    tools.namespace({
      name: "custom-providers",
      description: "Add and manage your own AI providers (custom API addresses).",
    })
    ```
  - replacement:
    ```ts
    tools.namespace({
      name: "custom-providers",
      description: "Add and manage your own AI providers (custom API addresses). Reconcile defaults: new models are applied, stored models are kept unless you say otherwise.",
    })
    ```
- **Why:** an agent caller should not have to infer the default from the code.
- **Evidence:** the namespace description at `src/server-v2.ts:925` names no default rule while the code implements one (`src/server-v2.ts:682`); E2 S11 shows the effective behaviour (`apply("{}")` leaves stored models untouched, so "keep" is the real default for stored ids).

### m6. Do not reimplement key handling, and sanitise anything that reaches a dialog filter
- **Merged from:** J13.
- **`src/reconcile.ts:14`** and **`src/probe.ts:382-396`**
  - current: `detail` strings and `describeProbed` output flow straight into dialog `description`/`searchText`.
  - replacement: run both through `sanitizeErrorMessage` (`src/security.ts:28-44`) before they are handed to a dialog, so no raw control character can reach the host's search field; add a regression test asserting no `\u007f` in any constructed `searchText`/`description`.
- **Why:** the competitor's list widget silently appends the delete key to the search query; our dialogs are host widgets, so the only way to inherit that defect is to feed them a raw control character.
- **Evidence:** `src/tui.ts:31-80` and `src/tui-v2.ts:21-30` delegate to host widgets — no key handling in our code, which is the correct design and must stay.

### m7. Keep the two non-goals out on purpose
- **Merged from:** J-cut-list + K2/K3/K4/K5.
- **All cited files, unchanged.** Per-model HTTP headers / per-model `baseUrl` override, `$ENV`/`!command` auth serialization, `models.yml` runtime selection and video-input display are all out of scope for a beginner; the safety nets we already have — `sanitizeErrorMessage` (`src/security.ts:28-44`), cost-only-from-evidence (`src/probe.ts:246-262`), the numbered beginner copy, and env-key fallback (`src/types.ts:30-33`) — are correct and must not regress.
- **replacement:** none — this item is an explicit *do not do this*.
- **Why:** scope discipline is what keeps the remaining items finishable.
- **Evidence:** join-experience's cut list (per-model headers, `$ENV`/`!command` auth, `models.yml`, video input) and join-safety K1–K5 (per-field sourcing, numbered beginner copy, error redaction, cost never guessed, key sanitization in logs) — all four cut items and all five keep items were re-read in `src/probe.ts`, `src/security.ts`, `src/types.ts`, `src/enrich.ts` and confirmed present as described.

### m8. Keep `default` meaning "no measurement", everywhere
- **Merged from:** J2(3) + J6(1).
- **`src/probe.ts:248-251`**
  - current:
    ```ts
    } else {
      probed.reasoning = true
      probed.reasoningSource = "default"
    }
    ```
    — a capability asserted without measurement.
  - replacement: leave `probed.reasoning` undefined when no tier produced evidence, and let M1's renderer omit the line; consumers already treat absence as "host decides" (`src/enrich.ts:120-126`).
- **Why:** the same rule as M2 — absence is a statement, and `false` or `true` invented locally is not.
- **Evidence:** E1 `prose-asserts-default` renders `"Thinking: supported (assumed default)"` from exactly this branch; `src/probe.ts:249-250` is the only place a reasoning capability is asserted without any tier producing evidence.

---

## Evidence

All claims above were reproduced against the real compiled plugin surface on 2026-10-10 (Node v26.7.0, Windows). `dist/` was verified to match `src/` on every cited anchor (`Apply everything`, `Keep what I have`, `Step 2 of 5 — Base URL`, `That address could not be read`, `Use the catalog for Claude instead`, `no usable web address`, `Up to date: the provider still lists`, `did not answer with a model list` — all counts equal).

| id | transcript | what it proves |
|---|---|---|
| E1 | `st_01a1252a-G1-grounding.txt` | Module-level behaviour: placeholder numbers written, `0`/blank rejected, absent-decision overwrite, `describeProbed` asserting defaults, `variants` dropped, collision set gaps, inline-key migration order, candidate-URL local-host handling |
| E2 | `st_01a1252a-G2-rpc-transcript.txt` | Real v2 RPC surface, scenarios S1–S11 (empty/unreachable/key-gated add, bare host, duplicate add, delete, metadata-only reprobe, catalog, key lifecycle, per-model decisions, absent-decision default) |
| E3 | `st_01a1252a-G3-focused-probes.txt` | `remove` durability, baseURL write-back, built-in collision, absence of any manual-entry RPC |
| E4 | `st_01a1252a-G4-tui-transcript.txt` | Real v2 TUI surface, scripted dialog transcripts T1–T6 (step titles, exact alert/select text, "no recovery menu", binary reconcile choice, API-key prompt) |
| E5 | `st_01a1252a-G5-focused-claims.txt` | `probeEndpoint` throws on HTTP-200-empty (so the zero-model advice block is unreachable), the `anthropic` branch is the only reachable zero-model path, v1 destructive default |
| E6 | `st_01a1252a-G6-verify.txt` | Zombie delete + refresh resurrection, the proposed `delete settings.baseURL` fix, pasted-path 404, local-host https variants, absence of a credential-removal RPC |
| E7 | `st_01a1252a-A-fileline-verify.txt` | Every cited `file:line` and its exact current text, extracted from the working tree |

Harnesses: `_final-plan-ground.mjs`, `_final-plan-rpc2.mjs`, `_final-plan-rpc3.mjs`, `_final-plan-tui.mjs`, `_final-plan-probe4.mjs`, `_final-plan-verify.mjs` (all under `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/`).

**Coverage:** join-experience J1–J13 → B6, B4, B1, B2, M5, M2, M3, M6, M4, M10, M11, B1, m6 (all 13 represented; J13 recorded as the defensive note m6). join-safety G1–G18 → B2, B6, B3, B7, B4, B5, M4, M6, M7, M8, m1, M10, B1, M11, M8, M1, M9, m4 (all 18 represented). K1–K5 kept as-is per m7.
