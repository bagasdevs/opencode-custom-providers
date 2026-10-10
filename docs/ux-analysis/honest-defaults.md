# Honesty/Defaults Discipline — `better-custom-provider` (ref/better-custom-main)

Studied: `src/flows/shared.ts`, `src/model-entry.ts`, `src/config.ts`, `README.md` (package.json identifies the package as `better-custom-provider@1.6.0`).
Cross-checked call-sites: `src/flows/add.ts`, `src/flows/edit.ts`, `src/ui/prompts.ts`, `src/types.ts`.

---

## 1. How does it mark a value as detected vs guessed vs defaulted?

Three distinct channels, deliberately separated so the UI never blurs them.

### 1a. A strict priority ladder, enforced by resolution order (not by flags)

`README.md`, "How metadata is resolved" — the ladder is documented as tiers, highest first:

> 1. **Detected** — real data from the gateway: LiteLLM `/model/info` and `/model_group/info`, ...
> 2. **models.dev** — exact per-model catalog entries, tagged `[models.dev]`.
> 3. **Local rules** — a built-in known-model table ..., tagged `[local rules]`. ...
> 4. **API fallback** — protocol-level limits (anthropic 200K/32K, google 1M/64K, openai 258K/32K) when nothing else knows them.
> 5. **Defaults** — `image: false`, `video: false`, `reasoning: true`.

The enforcement is structural, not advisory. `src/flows/shared.ts`, `collectProbedModelInfo`:

```ts
	// Merge (later maps win) and resolve: models.dev, then local rules, then
	// the api fallback, then defaults.
	return finalizeModelInfo(ids, [listInfo, gw, details], { modelsDev: dev, api });
```

and `model-entry.ts`, `buildProviderConfig`:

```ts
			// resolveModelInfo layers detected metadata over models.dev, the local
			// rules, the api fallback, and the built-in defaults — including for
			// manually added models, which have no probe info at all.
			const info = resolveModelInfo(id, infoById?.get(id), undefined, api);
```

A *detected* value wins purely by being later/first in the merge order — there is no code path where a default can shadow a detection.

### 1b. Guessed values get a visible provenance tag; detected values do not

`src/flows/shared.ts`, `probePickerItems`:

```ts
// Build picker items for probed model ids, resolved through the models.dev
// catalog, the local rules, and defaults. describeProbeInfo only renders values
// that differ from the defaults, tagged [models.dev] / [local rules] by source.
export function probePickerItems(
	ids: string[],
	infoById: Map<string, ModelProbeInfo>,
	modelsDev?: Map<string, ModelProbeInfo>,
	api?: ProviderApi,
): ProbeItem[] {
	return ids.map((id) => ({
		value: id,
		label: id,
		description: describeProbeInfo(resolveModelInfo(id, infoById.get(id), modelsDev, api)),
	}));
}
```

The rule: **tier-1 detected values are rendered bare; tier-2/3 guesses carry their source tag** (`[models.dev]` / `[local rules]`). The tagging formatter itself lives in the external `model-probe` dependency (re-exported at `shared.ts:2`; `package.json` pins `"model-probe": "^0.7.0"`), so only its contract is visible here — the repo's comment states it, and every call-site relies on it (`add.ts:137`, `add.ts:280`, `edit.ts:622`, `ui/prompts.ts:149`).

### 1c. "Detected" is counted by observable non-emptiness, then reported as a count

`src/flows/shared.ts`, `addModelEntriesToProvider`:

```ts
	const mergedInfo = resolveModelInfo(id, infoById?.get(id), undefined, api);
	if (probeInfoSummary(mergedInfo).length > 0) detectedCount++;
```

```ts
	if (saved) {
		const detail =
			detectedCount > 0 ? ` — auto-detected metadata for ${detectedCount} model${detectedCount === 1 ? "" : "s"}` : "";
		ctx.ui.notify(`Added ${fresh.length} model${fresh.length === 1 ? "" : "s"} to "${providerId}"${detail}.`, "info");
	}
```

The honest detail: detection is measured by `probeInfoSummary(...).length > 0` — i.e. "something non-default was actually learned" — never claimed when the summary is empty. And `add.ts:280` gates a UI affordance on `!info.inferred`:

```ts
return info && !info.inferred && probeInfoSummary(info).length > 0;
```

so *inferred* is a third state, distinct from detected, and it suppresses the affordance.

### 1d. What lands on disk is a decision, not an echo

`src/model-entry.ts`, `buildModelEntry`:

```ts
	const entry: any = {
		id,
		// image comes from the probe (default: off). Text-only models have
		// images silently dropped by pi, so this must match reality. pi's
		// input union has no "video", so video never lands here.
		input: opts.image ? ["text", "image"] : ["text"],
	};

	if (typeof opts.contextWindow === "number" && opts.contextWindow > 0) {
		entry.contextWindow = opts.contextWindow;
	}
	if (typeof opts.maxTokens === "number" && opts.maxTokens > 0) {
		entry.maxTokens = opts.maxTokens;
	}
```

`buildModelEntry` writes `input`/`reasoning`/`thinkingLevelMap` faithfully, but writes `contextWindow`/`maxTokens` **only when they are real positive numbers** — an unknown value stays *absent* from the entry rather than being stored as a placeholder. When the probe learned exact effort levels, those are stored verbatim instead of a derived ceiling:

```ts
	if (opts.thinkingLevelMap) {
		// The probe knew the provider's exact thinking levels (e.g. OpenAI
		// effort_options) — write that map verbatim instead of deriving one.
		entry.reasoning = true;
		entry.thinkingLevelMap = opts.thinkingLevelMap;
	}
```

`README.md` states the same for cost:

> Cost is never guessed: no local rule, no default.

and `buildModelEntry` writes it only `if (opts.cost)`. The only honored override is a *user* override, never a guess (`shared.ts:283`, `model-entry.ts:179`): `contextWindow: override.contextWindow ?? mergedInfo.contextWindow` — "Explicit per-model options ... win over the resolved values".

---

## 2. What does it deliberately NOT show the user?

Two distinct silences, both explicit in comments:

**Defaults are not rendered at all.** `src/flows/shared.ts:316-317`:

```ts
// Build picker items for probed model ids, resolved through the models.dev
// catalog, the local rules, and defaults. describeProbeInfo only renders values
// that differ from the defaults, tagged [models.dev] / [local rules] by source.
```

Backed by `README.md`:

> **Sensible, honest defaults** — detected values win; guesses are tagged (`[models.dev]` / `[local rules]`) in the picker; **default-filled values are
> not shown at all.**

Rationale: showing `image: false` for every model would be noise that implies a *measurement* where only a default exists. Absence = default; bare value = detected; tagged value = guess. Three states, zero ambiguity.

**Degenerate limits are hidden rather than surfaced** (see §3), and in the re-probe reconcile list, stored metadata a user chose to keep is shown as `[-]` "keep stored metadata" (`README.md`) — the tool never pretends a user decision is a detection.

Also deliberately not shown: video metadata in stored config. `model-entry.ts`:

```ts
		// pi's input union has no "video", so video never lands here.
```

`README.md`: video "is tracked and shown as a picker tag, but pi's model config has no video slot, so it is **display-only**" — honesty about capability boundaries (never persist a field the host cannot honor).

---

## 3. How does it clamp nonsense values?

Two layers, at the write boundary:

**Layer 1 — absurd numbers are dropped, not stored.** `model-entry.ts`, `buildModelEntry` (quoted in §1d):

```ts
	if (typeof opts.contextWindow === "number" && opts.contextWindow > 0) {
		entry.contextWindow = opts.contextWindow;
	}
```

`0`, negative, and non-numeric values never reach `models.json`. The same guard exists on user input in the per-model prompts (`ui/prompts.ts:168-172`): `opts.contextWindow = v > 0 ? v : undefined` — typing `0` *clears* the field ("0 -> clear contextWindow (user typed 0)", `prompts.ts:66-67`) rather than storing a zero. This also means an unset context window genuinely reads as unknown: `readModelOptions` mirrors it back as `undefined` (`model-entry.ts:208`).

**Layer 2 — degenerate catalog values are clamped at resolution time.** `README.md`:

> Degenerate catalog limits (`maxTokens == contextWindow`) are clamped automatically.

The clamp implementation is inside the `model-probe` dependency (invoked via `resolveModelInfo` / `finalizeModelInfo` above); the local repo *documents and relies on* the contract rather than reimplementing it — I verified there is no local clamp of `maxTokens == contextWindow` (grep over `src/` finds no such comparison). Honest framing: the repo's guarantee is that everything passes through `resolveModelInfo` before storage, so the dependency's clamping cannot be bypassed.

---

## 4. How does it migrate legacy keys?

All migration lives in `src/config.ts`, is event-driven (on save, not on install), and is atomic-ish in a defined order.

**The target state** — pi's official split (keys in `auth.json`, declarations in `models.json`), only on pi (not OMP):

```ts
// pi's official split: credentials live in auth.json (the file /login writes),
// model declarations in models.json. ...
// OMP's key handling is kept inline (models.yml) since its auth.json semantics
// are not verified.
export const AUTH_JSON_PATH = join(AGENT_DIR, "auth.json");
export const SPLIT_AUTH = !IS_OMP;
```

**The trigger** — every config save funnels through one function:

```ts
export function saveModelsConfig(config: ModelsConfig) {
	ensureConfigDir();
	migrateInlineApiKeys(config);
	...
}
```

**The migration itself** (`config.ts`, `migrateInlineApiKeys`), with the honesty-critical rules inlined:

```ts
// Move inline apiKeys into auth.json and strip them from the models config, so
// the files end up split the way pi itself writes them. An existing auth.json
// entry always wins over the inline value (pi resolves stored credentials
// first anyway). auth.json is written BEFORE models.json so a failed write
// never strands a key.
function migrateInlineApiKeys(config: ModelsConfig) {
	if (!SPLIT_AUTH) return;
	const providers = config.providers ?? {};
	const inline: Array<[string, string]> = [];
	for (const [id, provider] of Object.entries(providers)) {
		const key = (provider as any)?.apiKey;
		if (typeof key === "string" && key) inline.push([id, key]);
	}
	if (inline.length === 0) return;

	const auth = loadAuthFile();
	for (const [id, key] of inline) {
		if (!(id in auth)) auth[id] = { type: "api_key", key };
	}
	saveAuthFile(auth);
	for (const [id] of inline) {
		delete (providers[id] as any).apiKey;
	}
}
```

The discipline encoded here:
1. **Never overwrite what the user already has in `auth.json`** — `if (!(id in auth))` skips existing entries; "An existing auth.json entry always wins over the inline value".
2. **Write order is a crash-safety guarantee** — auth.json first, then strip from models.json, so a mid-way failure can lose at most the cleanup, never the key ("a failed write never strands a key").
3. **Other auth entries survive** — `loadAuthFile()` re-reads the whole file and preserves unrelated providers/oauth logins.
4. **No-op when nothing to do** — early return with zero writes (empty inline list; `SPLIT_AUTH === false` on OMP).

**Companion lifecycle handling** (same honesty rules): deletion removes only the migrated entry and only if it's an api_key —

```ts
// Drop a provider's auth.json entry along with the provider. Only api_key
// entries are touched — an oauth login under the same id is left alone.
export function removeProviderApiKey(providerId: string) {
	if (!SPLIT_AUTH) return;
	...
	if (auth[providerId]?.type !== "api_key") return;
	delete auth[providerId];
```

— and rename carries the entry across (`renameProviderApiKey`: `if (!(newId in auth)) auth[newId] = auth[oldId]; delete auth[oldId];`). On the read side the legacy shape stays valid until the next save (`storedApiKey`: "auth.json wins ... with the legacy inline apiKey as fallback"), and even deletion-failure honesty is preserved in `shared.ts`: "Provider deleted, but its auth.json entry could not be removed" as a *warning*, not a silent partial success.

---

## Verdict summary (what to steal)

| Discipline | Mechanism |
|---|---|
| detected vs guessed | strict merge-order resolution (`finalizeModelInfo` / `resolveModelInfo`); bare value = detected, `[tag]` = guess |
| defaulted | defaults are **never rendered** and positive-number-guarded fields are **omitted from disk** when unknown |
| nonsense clamping | drop/`0`-clears at the write boundary (`> 0` guards); degenerate `maxTokens == contextWindow` clamped in the resolver dependency |
| legacy keys | event-driven migration on every save; auth.json wins; write-before-strip; scope-limited to `type: "api_key"` |
