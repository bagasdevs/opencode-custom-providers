# Beginner-Experience Blueprint: merged from three inputs

Goal: one deduplicated, ordered list of experience changes for **our** plugin
(`opencode-custom-providers`, `C:/Users/Administrator/Documents/AI/opencode-dynamic-custom-providers`).

Inputs merged:

1. `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md` (735 lines): end-to-end wizard flow of `better-custom-provider@1.6.0`
2. `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md` (266 lines): detected-vs-guessed-vs-defaulted discipline
3. `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md` (478 lines): interactive primitives, tri-state reconciler, long-list navigation

Deduplication notes (overlaps collapsed on purpose):

- "metadata tiers / provenance" appears in all three files. Kept once at **J2** (`honest-defaults.md:47`, the canonical rule), with the picker-rendering consequence folded in from `wizard-flow.md:146` and `reconcile-ui.md:63`.
- "tri-state reconcile" appears in `wizard-flow.md:442-461` (call-site semantics) and `reconcile-ui.md:36-192,355-395` (widget + rationale). Both are needed but they are one item at **J1**; `wizard-flow.md` supplies *what each row class defaults to*, `reconcile-ui.md` supplies *why* and *the cycle order*.
- "re-probe" is described as a flow step in `wizard-flow.md:435` and as the widget's reason for existing in `reconcile-ui.md:355`. One item (**J1**), not two.
- "uniqueness / built-in collision" appears in `wizard-flow.md:226`, `reconcile-ui.md:319`. One item (**J4**).
- "12-row window / search / wrapping" is a single navigability cluster in `reconcile-ui.md:329-342`; kept as one item (**J9**) rather than six.
- `reconcile-ui.md:404-460` (Backspace bug in the competitor's `pickTriState`) is **not** copied: it is a defect in *their* code, not an experience concept. It is recorded once at **J13** as a "do not copy / regression-test" note, because our dialogs are host widgets and never reimplement key handling.

Ordering rule: beginner impact = (how early a first-time user hits it) × (how much confusion or data loss it causes when wrong). Highest first.

---

## J1. Make the reconcile default non-destructive per row, and stop defaulting changed models to "apply"

**Beginner impact: highest.** Re-probe is the moment a beginner can silently lose a working model. Today a changed/added model defaults to `apply` and a vanished model to `keep`, so "press Enter and go" overwrites metadata the user may have hand-tuned, and the only escape is a per-model `Cancel` that aborts the whole run.

**Concept:** reconciliation is a **three-way decision per row** (apply / keep / drop), and the safe option must be the *default and a distinct state*. The picker itself must not know semantics: the caller supplies each row's allowed `states` and `initial`, so a "changed" row gets 3 states and a "new" row gets 2. Destruction must never be one accidental keystroke away: cycle order puts the safe state before the destructive one.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:49`: `pickTriState` "knows nothing about semantics"; per-item `states` + `initial`.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:172-177`: the four row classes and their defaults: changed `["off","mid","on"]`/`initial "mid"`; new `["off","on"]`/`initial "off"`; unsupported `["off","on"]`/`initial "on"`; untouched `["off","on"]`/`initial "on"`.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:369`: "The safe option is the default, and it is a distinct state."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:375`: "Destruction is never one accidental keystroke away… from the `mid` default, Space goes to `on` first."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:448-451`: the same four row classes with their plain-language meanings (`[-]` keep without updating, `[x]` apply, `[ ]` remove/skip).
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:393`: legend is caller-supplied text on screen: `[ ] remove/skip • [-] keep without update • [x] keep/add with latest metadata`.

**Change to OUR plugin:**

1. `src/reconcile.ts:106`: `const decision = decisions[p.id] ?? "apply"` is the bug. Change the default to depend on whether the model is already stored:
   ```ts
   const storedEntry = current[p.id]
   const decision = decisions[p.id] ?? (storedEntry ? "keep" : "apply")
   ```
   This makes "no decision expressed" mean *leave my config alone* for anything already stored, and *add* only for genuinely new ids: matching `reconcile-ui.md:174` and `:176`.
2. `src/reconcile.ts:117`: `const decision = decisions[id] ?? "keep"` is already correct (vanished ⇒ keep). Keep it, and add a comment citing the reason ("a probe gap must not delete your config", `reconcile-ui.md:176`).
3. `src/tui.ts:364-368`: the `N change(s) found` menu offers `Apply all` / `Review each` / `Cancel`. Rename and re-default: make the first option `Keep what I have (safest)` and add a third row class to the review loop so `Review each` presents `Apply update` / `Keep stored` / `Remove` **in that order**, with `Keep stored` preselected. Never offer `Apply all` as the top option.
4. `src/tui.ts:377-381`: reorder the per-model options from `Apply, Keep stored, Remove` to `Keep stored (default), Apply update, Remove` so the destructive choice is last.
5. `src/server-v2.ts:682`: `decisions[probed.id] ?? (stored.has(probed.id) ? "keep" : "apply")` already gets this right; `src/tui.ts` and `src/reconcile.ts` must be brought in line with it so v1 TUI, v2 server and agent tools cannot disagree.
6. `src/tui-v2.ts:293-301`: the v2 reconcile menu offers only `Apply everything` / `Keep what I have`. Add the per-model path (`Review each`) that `src/tui.ts:372-384` already implements, so v2 users are not forced into an all-or-nothing choice.

---

## J2. Three visible provenance states: bare = detected, tagged = guess, absent = default

**Beginner impact: highest.** A beginner's first question after adding a provider is "where did these numbers come from, and can I trust them?" Our `describeProbed` already prints a prose source per field, but the picker rows and stored entries do not distinguish "measured" from "assumed", so a guessed 128K context reads identically to a reported one.

**Concept:** tier-1 detected values render **bare**; tier-2/3 guesses carry their source tag (`[models.dev]` / `[local rules]`); defaults are **not rendered at all**. Absence = default, bare value = detected, tagged value = guess: three states, zero ambiguity. Showing `image: false` for every model "would be noise that implies a *measurement* where only a default exists".

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:63`: "tier-1 detected values are rendered bare; tier-2/3 guesses carry their source tag".
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:147`: "Absence = default; bare value = detected; tagged value = guess. Three states, zero ambiguity."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:47`: `describeProbeInfo only renders values that differ from the defaults`.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:146` and `:279`: picker item descriptions are `describeProbeInfo(...)`, "only non-default metadata shown, tagged `[models.dev]` / `[local rules]`".
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:265`: "defaults are **never rendered**".

**Change to OUR plugin:**

1. `src/probe.ts:370-394`: `describeProbed` renders every field with a prose source (`from built-in rules`, `assumed default`). Add a compact sibling `describeProbedShort(probed)` used for single-line picker rows, emitting the competitor's format: bare number for `detected`, `128K [models.dev]` for catalog, `context 128K [local rules]` for rules, and **nothing** for `default`/`api-fallback`. Map our `MetadataSource` union (`src/probe.ts:12-17`) to `[models.dev]` / `[local rules]` and drop the tag for `detected`.
2. `src/probe.ts:384-388`: suppress the whole `Context window:` / `Longest reply:` line when `contextSource`/`maxOutputSource` is `"default"` or `"api-fallback"`, instead of printing `assumed default`. Absence must mean default.
3. `src/probe.ts:387`: `Thinking: ${probed.reasoning ? "supported" : "not supported"} (${sourceWord(...)})`: when `reasoningSource === "default"` (set at `src/probe.ts:247-249`), omit the line entirely rather than asserting a capability we did not measure.
4. `src/tui.ts:376` and `src/server.ts:240`: use `describeProbedShort` in the reconcile row description and in the `reprobe-models` agent tool output, so one line carries both the diff and its provenance (`context 128000 -> 1000000 [models.dev]`).

---

## J3. A failed probe must offer Retry / Add manually / Cancel: never end in a dead toast

**Beginner impact: highest.** This is the single most common first-run failure (wrong URL, missing `/v1`, key required). Today a failed probe throws, the message is shown as a `warning` toast, and the flow returns: the user must restart `/add-provider` from scratch and retype everything.

**Concept:** on probe failure, offer plain-language recovery in one screen: `Retry` / `Add models manually` / `Cancel`. The user never sees HTTP status codes or auth headers. The beginner never has to know which exact path the server expects.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:286-292`, `Probe failed, what next?` with `Retry` / `Add models manually` / `Cancel`.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:717`: "On failure the wizard offers Retry / Manual / Cancel in plain language; the user never sees HTTP status codes or auth headers."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:269`: the info notice before probing, and "non-local `http://` falls back to `https://`".

**Change to OUR plugin:**

1. `src/tui.ts:304-309`: wrap `addProvider(params)` so that a failed discovery (`result.success === false`) opens a `showSelect` with three options instead of `api.ui.toast({ message: result.message, variant: "warning" })` and `return`:
   - `Retry` → re-invoke `addProvider(params)` in a loop (bounded, e.g. 3 attempts).
   - `Add models manually` → jump to the manual-id path already implemented for Edit (`src/tui.ts:571-604`, `previewManualModels` + `showConfirm`) and finish the add with those ids.
   - `Cancel` → return with no writes.
2. `src/probe.ts:337-339`, the thrown `Probe failed for ${baseURL}: ${lastError}` message carries the sanitized technical detail. Keep it for the `Retry` screen's *secondary* line only; the primary line must be the plain-language hint already built in `src/server-v2.ts:140-152` (`probeHint`). Reuse `probeHint` in `src/tui.ts`, it currently exists only in `src/server-v2.ts`, so v1 TUI users never see it.
3. `src/tui.ts:302`: the `Discovering models from ${baseURL}...` toast is the right shape (mirrors `wizard-flow.md:269`); keep it and re-show it on each `Retry`.

---

## J4. Uniqueness and built-in collision are resolved at prompt time, never by overwrite

**Beginner impact: high.** Naming a provider `openai` or `anthropic` silently merges with a built-in. Today we emit a *toast* about it and then, depending on path, still ask `Overwrite it?`: which is the wrong question, because the damage is the id collision, not the overwrite.

**Concept:** enforce uniqueness at prompt time by **re-prompting**, never by clobbering; on a built-in id collision offer `Use "<id>-custom" instead` (recommended) / `Keep "<id>"` (deliberate) / `Pick another name`, with a one-line explanation of what keeping it costs.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:319`: "Uniqueness is enforced at prompt time, never by overwrite. `promptProviderId` loops rather than clobbering".
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:226-236`: the 3-option collision picker and the `BUILTIN_COLLISION_WARNING` text.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:110-113`: `"Provider name (blank = <suggestion>)"`, re-prompt on `already exists`, delegate built-in collision.

**Change to OUR plugin:**

1. `src/tui.ts:176-179`: replace the passive toast (`'${providerId}' merges with a built-in id; '${suggestion}' stays separate.`) with a `showSelect` offering `${providerId}-custom` (recommended, first) / keep `${providerId}` / re-enter a name, and loop until a non-colliding id is chosen. `collisionSuggestion` (`src/flavors.ts:80-85`) already computes the suggestion; it is currently only *reported*, never *applied*.
2. `src/tui.ts:263-271` and `:182-184`: the `Provider already exists` / `Overwrite it?` confirm must not be the resolution. Make "already exists" re-prompt for a different id (matching `reconcile-ui.md:319`), reserving `overwrite` for explicit programmatic callers (`AddProviderParams.overwrite`, `src/commands.ts:148`).
3. `src/flavors.ts:75-78`: `BUILT_IN_IDS` is only 12 entries and our collision warning does not state the consequence. Add the consequence text from `wizard-flow.md:235` (built-in catalog stays visible, credentials shared) so "Keep" is a deliberate act, not a default.
4. `src/tui.ts:449-461`: the rename path already offers a confirm; make it the same 3-way picker and, when the user keeps a colliding id, keep the existing warning (`src/commands.ts:309-314`) as the confirmation that the choice was understood.

---

## J5. "0 = clear, blank = keep, cancel = no change" for every numeric prompt

**Beginner impact: high.** Numeric fields (context window, max output) are the most-edited per-model values. Our current prompt has no way to *clear* a value or to *keep* it: every prompt is a forced entry, and a blank string is an error.

**Concept:** one prompt expresses three intents without a confirm dialog: `0` clears the field, blank keeps the current value, cancel/`esc` changes nothing. Typing `0` clears rather than storing a zero, so an unset context window genuinely reads as unknown.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:317-318`, "0 = clear, blank = keep, null = cancel for numeric prompts, one prompt expresses three intents without a confirm dialog."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:168-172`: `opts.contextWindow = v > 0 ? v : undefined`; "typing `0` *clears* the field rather than storing a zero".
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:661`: blank behavior is documented per caller and is never an error when it means "keep".

**Change to OUR plugin:**

1. `src/commands.ts:352-362`: `editModelField` rejects `Number.isInteger(n) || n <= 0` with `'${field}' must be a positive integer`. Change the contract: `value.trim() === ""` → return `null` with **no mutation** (keep); `n === 0` → `delete model.limit[field]` (clear); `n > 0` → set; anything else → existing error.
2. `src/tui.ts:559`: `showPrompt(api, \`${field} (current: ${current})\`)` must state the contract in the title, e.g. `Context window (blank = keep ${current}, 0 = clear)`.
3. `src/tui.ts:560`: `if (raw === null) return` is correct for cancel; keep it, and ensure the *blank* path now falls through to `editModelField`'s keep branch instead of being treated as a value.

---

## J6. Never write a placeholder number when the real value is unknown

**Beginner impact: high.** This is a correctness issue disguised as UX: a beginner sees `context 128000` in their config and believes it was measured. It was not: it is our fallback.

**Concept:** write `contextWindow`/`maxTokens` **only when they are real positive numbers**; an unknown value stays *absent* from the entry rather than being stored as a placeholder. Cost is never guessed: no local rule, no default.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:103-111`: `if (typeof opts.contextWindow === "number" && opts.contextWindow > 0)`, and "an unknown value stays *absent* from the entry rather than being stored as a placeholder".
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:124`: "Cost is never guessed: no local rule, no default."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:264`: "positive-number-guarded fields are **omitted from disk** when unknown".

**Change to OUR plugin:**

1. `src/probe.ts:350-351`, `probedToEnriched` hard-codes `context: probed.context ?? 128_000` and `output: probed.maxOutput ?? 4_096`. Make the fallback conditional on provenance: when `contextSource` is `"default"` or `"api-fallback"`, omit `limit.context`; same for `maxOutput`. `EnrichedModel.limit` (`src/enrich.ts`) must allow `context`/`output` to be absent for this to typecheck, OpenCode's own fallback chain then applies (the same reasoning already used at `src/enrich.ts:120-126` for booleans).
2. `src/enrich.ts:85` and `:87`: `epContext ?? meta?.limit.context ?? 128_000` / `epOutput ?? meta?.limit.output ?? 4096`: same change. Only fall back when there is *some* evidence; otherwise leave the field off.
3. `src/enrich.ts:100-106`: `model.cost` is written with `meta.cost?.input ?? 0`, i.e. a real-looking `0` when the catalog has no price. Move to the `if (meta.cost)` guard so an unknown price stays absent (mirrors `honest-defaults.md:124`).
4. `src/enrich.ts:110-115`: the endpoint-cost branch is already correctly guarded on `typeof item.input_cost === "number"`; keep it as the model for the others.

---

## J7. Clamp degenerate limits at resolution time, and never surface the nonsense

**Beginner impact: medium-high.** `maxTokens == contextWindow` (a real catalog defect) would otherwise make every reply impossible. We already clamp; the rule is to keep the clamp at the single resolution choke point so no new call site can bypass it, and to hide rather than surface degenerate values.

**Concept:** degenerate catalog limits are clamped automatically; everything passes through one resolver before storage, so the clamp cannot be bypassed. Absurd values (`0`, negative, non-numeric) are dropped at the write boundary, not stored.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:177`: "Degenerate catalog limits (`maxTokens == contextWindow`) are clamped automatically."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:179`: "the repo's guarantee is that everything passes through `resolveModelInfo` before storage, so the dependency's clamping cannot be bypassed."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:265`: "drop/`0`-clears at the write boundary (`> 0` guards)".
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:733`: "unknown models default to 256K context rather than 'unset'. The user sees sensible starting numbers, not protocol math."

**Change to OUR plugin:**

1. `src/probe.ts:234-236`, the clamp `if (probed.maxOutput >= probed.context) probed.maxOutput = Math.max(1, Math.floor(probed.context / 2))` lives inside `resolveModel`. Add an explicit comment that `resolveModel` is the **only** resolver and every write path must route through it, then assert that: `src/probe.ts:483` (manual ids) and `src/probe.ts:330` (probed) both already call it, the one gap is `src/enrich.ts:67` `buildEnrichedModel`, which computes `epContext ?? meta?.limit.context ?? 128_000` **without** clamping. Either route `buildEnrichedModel` through `resolveModel` or delete it (it is exported from `src/discovery.ts:8` but has no other in-repo consumer; the stored path uses `probedToEnriched`).
2. `src/commands.ts:356`: the `!Number.isInteger(n) || n <= 0` guard is the write-boundary `> 0` guard; keep it (see J5 for the `0`-clears semantics).

---

## J8. Legacy inline keys migrate on every save, auth store wins, and the copy is purged after the store accepts

**Beginner impact: medium-high.** Users who hand-wrote `options.apiKey` into their config hit this on first edit. We already do this: the change is to make it *event-driven on every save* rather than only when the user opens Edit Provider, and to guarantee the failure mode is a loud warning instead of a silent partial success.

**Concept:** migration is event-driven (on save, not on install); an existing auth-store entry **always wins** over the inline value; the auth store is written **before** the inline copy is stripped so a failed write never strands a key; scope is limited to the migrated entry only.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:238`, "Never overwrite what the user already has in `auth.json`, `if (!(id in auth))` skips existing entries."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:246-249`, "Only `api_key` entries are touched, an oauth login under the same id is left alone."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:214`: "auth.json is written BEFORE models.json so a failed write never strands a key."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:725`: "Legacy inline `apiKey`s migrate automatically."

**Change to OUR plugin:**

1. `src/commands.ts:404-421`: `migrateInlineKey` is correct in shape (store first, then `delete provider.options.apiKey` at `:419`). It is only invoked from `src/tui.ts:411`. Call it from `reloadAllProviders` / the shared save path so *any* write migrates, not just opening Edit Provider.
2. `src/commands.ts:419`: the strip happens only after `storeApiKey` returns truthy; keep that ordering and add the comment from `honest-defaults.md:214` so a future refactor cannot reorder it.
3. `src/commands.ts:229-237`, `rotateProviderApiKey` persists then drops the inline copy; on store failure it throws (`src/commands.ts:221-226`), which is the "fail loudly" behavior. Keep. Add the equivalent *warning-not-silence* path for deletion: `src/tui.ts:649-655` deletes the provider without touching the credential, and `src/opencode-client.ts` exposes `removeApiKey` only on the TUI bridge, wire it so a failed credential removal surfaces a warning like `honest-defaults.md:246`'s "Provider deleted, but its auth.json entry could not be removed".

---

## J9. Long model lists: bounded window, live search, semantic category filter

**Beginner impact: medium-high.** A gateway returns 400 models. Our `DialogSelect` is host-rendered, so we cannot add a window: but we *can* stop feeding it 400 rows and give the user a way to narrow by decision class.

**Concept:** keep the visible frame constant regardless of list size; centred scroll; a position footer that reflects the *filtered* count; live type-to-search with the cursor reset to the top match; **semantic `searchText` tags** (`updated` / `new` / `unsupported`) so typing a category isolates a whole decision class without leaving the picker; wrapping arrows so there is no dead end.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:329-342`: the six mechanisms, verified against a real 400-model list.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:203-211`: `searchText: \`${id} updated\`` / `new` / `unsupported`; "typing `updated`, `new`, or `unsupported` isolates an entire decision class without leaving the picker."
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:334`: position footer reflects the *filtered* count.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:344`: "the default action on a huge list is **safe**: 400/400 stay `mid`, 0 forced to `on`".

**Change to OUR plugin:**

1. `src/reconcile.ts:7-13`, `ModelChange` has `id`, `kind`, `detail`. Add a `searchText` field populated as `` `${id} ${kind}` `` so the host dialog's filter matches `added`/`updated`/`removed` as category words. The v1 `TuiDialogSelectOption` has a `category` field (`node_modules/@opencode-ai/plugin/dist/tui.d.ts:93`), populate `category` with the kind label in `src/tui.ts:364-384` so the host groups them, and `description` with the searchable `detail`.
2. `src/tui.ts:374`: `for (const change of rep.changes)` iterates *every* change with one dialog each. Order the list by decision class (changed first, then new, then unsupported) as `wizard-flow.md:442` does, and cap the sequential review with a summary dialog when `rep.changes.length` exceeds ~12, so a 400-model gateway does not produce 400 dialogs.
3. `src/server.ts:235-246`: the `reprobe-models` agent tool already emits `- [${c.kind}] ${c.detail}`; add the kind as a filterable token there too.
4. `src/server-v2.ts:993-1012`: the `apply-reconcile` tool description should state the default-per-row-class rule from J1 so an agent caller does not have to guess.

---

## J10. Endpoint normalization and write-back of the variant that actually answered

**Beginner impact: medium-high.** "Does my URL need `/v1`?" is the #1 beginner question. We probe candidates but never *persist* the one that worked, so every later re-probe re-guesses.

**Concept:** strip trailing slashes and known suffixes (`/chat/completions`, `/models`, `/messages`), add `https://` (or `http://` for local hosts) when the scheme is missing, try the `/v1` variant automatically, and **write back** the base URL variant that answered. The user types an endpoint; they never have to know which exact path the server expects.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:216`: `normalizeEndpoint` contract: "strips trailing slashes, strips known suffixes like `/chat/completions`, `/models`, `/messages`… adds `https://` for non-local hosts, `http://` for local hosts if no scheme".
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:272`: "On success `baseUrl` is updated to `probed.baseUrl` (the variant that answered)".
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:716`: "the wizard … picks the `/v1` variant that actually answers".

**Change to OUR plugin:**

1. `src/probe.ts:34-59`: `buildCandidateUrls` already tries as-given → `+/v1` → http→https. It returns `string[]` but `probeEndpoint` (`src/probe.ts:326-330`) discards which candidate won except for `origin`. Return the winning `baseURL` alongside `ProbedModel[]`.
2. `src/commands.ts:158-161`: `addProvider` trims trailing slashes and then uses `params.baseURL` for both `api` and `options.baseURL`. Add: (a) a `normalizeEndpoint` that strips `/models`, `/chat/completions`, `/messages` suffixes (`src/endpoint.ts:46-48` already strips `/models` *for the request URL* but not for storage); (b) if no scheme, prepend `https://` (or `http://` for `localhost`/`127.0.0.1`/`::1`, matching `src/probe.ts:49-53`); (c) store the **winning candidate** from step 1 when it differs.
3. `src/tui.ts:465-477`: the Endpoint edit path `raw.trim().replace(/\/+$/, "")` then `isValidUrl`. Route it through the same `normalizeEndpoint` so edit and add cannot diverge.
4. `src/probe.ts:336`: `if (FLAVORS[flavor].listShape === "none") return []` (anthropic has no list API). Follow `wizard-flow.md:429`: surface `"This provider's API doesn't expose /models. Use Add models manually."` rather than silently returning zero models.

---

## J11. Tell the user what to do next after every save

**Beginner impact: medium.** After a successful add, our toast is `Provider 'x' added with N model(s).`: factually true, but the beginner then has to discover on their own that they must open the model picker.

**Concept:** after every save, the wizard says what to do next in one line, and reports what it actually learned vs. defaulted as *counts*.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:171` and `:374`: `"Open /model to use your new provider."`
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:372`: summary counts: `detected <N>` / `inferred from known models <N>` / `defaults <N>`.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:74-79`, detection is counted by "something non-default was actually learned" and the count is only reported when non-zero: `detectedCount > 0 ? \`, auto-detected metadata for ${detectedCount} model(s)\` : ""`.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/honest-defaults.md:82-86`: *inferred* is a third state that suppresses the affordance.

**Change to OUR plugin:**

1. `src/commands.ts:193`: `Provider '${params.providerId}' added with ${modelCount} model(s).` → append the next-step line: `"Open the model picker and choose one to start using it."` (`src/server-v2.ts:449` already has this for v2; v1 `src/tui.ts:330` does not).
2. `src/commands.ts:161`, after `discoverAndEnrich`, count models whose `contextSource`/`maxOutputSource`/`imageSource`/`costSource` is `"detected"` vs `"models.dev"`/`"local-rules"` vs `"default"`/`"api-fallback"` (all already tracked on `ProbedModel`, `src/probe.ts:19-31`) and append `, detected N, from models.dev M, defaults K` only when the count is non-zero, exactly as `honest-defaults.md:77` gates the suffix.
3. `src/tui.ts:571-604`: the manual "Add models" confirm already shows `describeProbed` previews; add the same counted suffix using `previewManualModels`' returned `probed` sources.

---

## J12. Probe failure and zero-model results need distinct, actionable hints

**Beginner impact: medium.** "No models found" has two very different causes: the endpoint is unreachable/wrong, or it needs a key before it will list anything. We collapse both.

**Concept:** distinguish the empty-but-successful result from the failed request, and give each its own plain-language hint: probe succeeded but returned nothing → switch to manual entry; endpoint needs auth → say so.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:274-276`: `"Probe succeeded but returned no models. Switching to manual entry."` (warning) → falls through to `promptManualModels`.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:150`, empty catalog → `"models.dev lists no models for <provider.name>, enter ids by hand."`
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/wizard-flow.md:717`: "the user never sees HTTP status codes or auth headers".

**Change to OUR plugin:**

1. `src/commands.ts:163-169`, `modelCount === 0` returns `"No models found at the given endpoint. Provider not added."` Give it the two-cause split already written for v2 at `src/server-v2.ts:154-158` (`zeroModelsHint(hasKey)`): with a key → "check the base URL, it usually ends with /v1"; without → "most gateways need an API key before they list models: add one and re-probe." Then offer the manual-id path instead of returning.
2. `src/tui.ts:306-309`: the same message is rendered as a plain `warning` toast; route both branches through the J3 recovery menu.
3. `src/probe.ts:336`: `listShape === "none"` returning `[]` is the third distinct case (flavor has no list API, e.g. anthropic). Handle it separately with `wizard-flow.md:429`'s wording.

---

## J13. Do NOT copy: the competitor's `pickTriState` Backspace bug: and do not reimplement key handling

**Beginner impact: n/a (defensive).** Recorded so we do not inherit the defect and do not reintroduce it if we ever build our own list widget.

**Concept:** a search box that silently appends the delete key corrupts the query and empties the list; the only recovery is another key the user does not know. Any control we advertise (`backspace delete`) must actually work: and we should not be writing key handlers at all while the host provides dialogs.

**Reference (exact):**

- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:404-429`: `data === "007f"` vs `data === "\u007f"`, "the delete branch never matches", `0x7f` is appended to the query as an invisible character.
- `C:/Users/Administrator/AppData/Local/Temp/ocp-ux/reconcile-ui.md:460`: "the advertised legend `backspace delete` is wrong there."

**Change to OUR plugin:**

1. No key-handling code to fix: `src/tui.ts:31-80` (`showPrompt`/`showConfirm`/`showSelect`) and `src/tui-v2.ts:21-30` delegate to the host `Dialog*` / `dialog.*` widgets. Keep it that way; do not port `select.ts`.
2. Add a regression test asserting our dialogs never see a raw `\u007f` in the search field (i.e. we never construct a `searchText`/`placeholder` containing a raw control char): `src/reconcile.ts` `detail` strings and `src/probe.ts` `describeProbed` output flow into dialog filters, so sanitize them the way `src/security.ts:22-35` already sanitizes error text.

---

## Cut list: explicitly out of scope for a beginner

These are in the inputs and are deliberately **not** in the blueprint, because a beginner never reaches them (the competitor says the same at `wizard-flow.md:711-735`):

- Per-model HTTP headers / per-model `baseUrl` override (`wizard-flow.md:732`, `editModelOverride`). Our `ProviderConfig.options` has an index signature but no per-model override; adding one is not a beginner win.
- `$ENV` / `!command` auth serialization (`wizard-flow.md:726`). Our `getApiKey` (`src/types.ts:30-33`) already reads `OPENCODE_LOCAL_<ID>_API_KEY`; adding shell-command keys is a security surface, not UX.
- `models.yml` multi-runtime file selection (`wizard-flow.md:725`). We target OpenCode only.
- Video input display (`honest-defaults.md:155-159`). We have no video field; the lesson, *never persist a field the host cannot honor*, is already applied at `src/enrich.ts:120-126` and needs no new work.
