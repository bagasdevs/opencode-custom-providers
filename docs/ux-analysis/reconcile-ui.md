# Interactive UI Primitives — `better-custom-provider@1.6.0`

Study of the mature competitor's interactive layer:

- `ref/better-custom-main/src/ui/select.ts` — 404 lines: `selectOne`, `pickTriState`, `pickMany`
- `ref/better-custom-main/src/ui/prompts.ts` — 301 lines: 10 prompt helpers built on top

All three pickers are **not** primitives from the host. Each is a hand-rolled
`ctx.ui.custom((tui, theme, _kb, done) => ({ render, invalidate, handleInput }))`
component over `@mariozechner/pi-tui`, sharing one design: a bordered box, a
`Search:` line, a 12-row window, live type-to-search, and a footer key legend.

---

## 1. The tri-state picker (`pickTriState`) — the reconciler

### What it is

`select.ts:145` — the only picker with **three** states per row instead of two.
It is the surface used by *Re-probe* (`flows/edit.ts:648`) to reconcile a live
`/models` response against what is already stored in `models.json`.

```ts
export async function pickTriState(
	ctx: CommandContext,
	title: string,
	items: TriItem[],
	legend = "[ ] remove/skip • [-] keep without update • [x] keep/add with latest metadata",
): Promise<Map<string, TriState> | null> {
```

It returns a `Map<string, TriState>`, or `null` on ESC.

### The state type — the caller decides the meaning

```ts
export type TriState = "off" | "mid" | "on";
export type TriItem = {
	value: string;
	label: string;
	description?: string;
	searchText?: string;
	// States this item cycles through, in toggle order.
	states: TriState[];
	initial: TriState;
};
```

This is the key architectural move: **`pickTriState` knows nothing about
semantics.** The picker only knows how to cycle a row through `states`. The
meaning is supplied per item by the caller via `states` + `initial`, and
rendered by the caller's `legend`. This is why one widget serves both
"changed model" rows (3 states) and "new model" rows (2 states).

### The rendered glyphs

```ts
function box(s: TriState): string {
	if (s === "on") return theme.fg("success", "[x]");
	if (s === "mid") return theme.fg("warning", "[-]");
	return theme.fg("muted", "[ ]");
}
```

| glyph | state | color | meaning at the Re-probe call site |
|---|---|---|---|
| `[x]` | `on` | `success` (green) | **apply** — keep/add and write the latest probed metadata |
| `[-]` | `mid` | `warning` (yellow) | **keep** — leave the stored entry untouched, ignore the diff |
| `[ ]` | `off` | `muted` (grey) | **remove/skip** — delete it, or don't add it |

### The real legend strings (verbatim, `select.ts:149`, `:220`, `:221`)

Default legend parameter:

```
[ ] remove/skip • [-] keep without update • [x] keep/add with latest metadata
```

Footer key help, rendered on the line above the legend:

```
 Type to search • ↑↓ move (wraps) • space toggle • enter confirm • backspace delete • esc cancel
```

Header, for `title = "Re-probe my-relay"` with 5 items:

```
 Re-probe my-relay
 Search: -
 5 models
```

Empty-filter message (`select.ts:199`): ` No matching models.`

### The real key handling (`select.ts:230-273`)

```ts
handleInput(data: string) {
	const visibleItems = getVisibleItems();
	if (matchesKey(data, Key.up)) {
		if (visibleItems.length === 0) return;
		cursor = cursor === 0 ? visibleItems.length - 1 : cursor - 1;
		refresh();
		return;
	}
	if (matchesKey(data, Key.down)) {
		if (visibleItems.length === 0) return;
		cursor = cursor === visibleItems.length - 1 ? 0 : cursor + 1;
		refresh();
		return;
	}
	if (data === " ") {
		const item = visibleItems[cursor];
		if (!item) return;
		const current = state.get(item.value) ?? item.initial;
		const index = item.states.indexOf(current);
		state.set(item.value, item.states[(index + 1) % item.states.length]);
		refresh();
		return;
	}
	if (matchesKey(data, Key.enter)) {
		done(new Map(state));
		return;
	}
	if (matchesKey(data, Key.escape)) {
		done(null);
		return;
	}
	if (data === "007f" || data === "\b") {
		if (query.length > 0) {
			query = query.slice(0, -1);
			refresh();
		}
		return;
	}
	if (data >= " " && data !== "001b" && data !== "\r" && data !== "\n") {
		query += data;
		cursor = 0;
		refresh();
	}
}
```

Behaviour, all of it **verified by driving the real source**:

- **↑ / ↓** move the cursor and **wrap** at both ends (index 0 → last, last → 0).
- **Space** cycles the row through *its own* `states` array, modulo length.
- **Enter** resolves with a **copy** of the state map — `done(new Map(state))`.
- **ESC** resolves `null`.
- Any other printable char (`data >= " "`) appends to `query` and **resets
  `cursor = 0`** so the first match is always preselected.

### The cycle order is real, not assumed

Driving the real component with the call site's own `states: ["off","mid","on"]`,
`initial: "mid"`:

```
3-state item (initial mid): [-] -> [x] -> [ ] -> [-]
2-state item (initial on) : [x] -> [ ] -> [x]
```

Because `states` is `["off","mid","on"]`, one Space from `mid` lands on **`on`**
(apply), not on `off` (remove). The destructive state is *last* in the cycle —
you cannot reach "remove" by mashing Space once.

### Per-row state assignment at the Re-probe call site (`flows/edit.ts:603-646`)

This is what makes the widget a reconciler rather than a checkbox list. Four
classes of row, each with its own `states` and `initial`:

| row class | `states` | `initial` | why |
|---|---|---|---|
| **changed** (stored model with a real diff) | `["off","mid","on"]` | `"mid"` | A decision is needed → `mid` = safe "do nothing" |
| **new** (`novelIds`, not in config) | `["off","on"]` | `"off"` | Nothing stored, so "keep without update" is meaningless; default is *don't add* |
| **unsupported** (vanished from `/models`) | `["off","on"]` | `"on"` | Default is *keep* — a probe gap must not delete your config |
| **untouched** (in config, no diff) | `["off","on"]` | `"on"` | Default is *keep* |

Consumption (`edit.ts:651-660`) confirms the three buckets:

```ts
if (novelSet.has(item.value)) {
	if (state === "on") addIds.push(item.value);
	continue;
}
if (state === "off") removeIds.push(item.value);
else if (state === "on" && changeById.has(item.value)) updateIds.push(item.value);
// "mid": keep the stored entry unchanged
```

Note `mid` only exists for rows in `changeById`; for every other row `mid` is
unreachable because it is not in `states`.

### Search and scrolling

Search haystack (`select.ts:161-168`) — four fields OR-ed together:

```ts
const haystack = `${item.label} ${item.value} ${item.description ?? ""} ${item.searchText ?? ""}`.toLowerCase();
return haystack.includes(lowerQuery);
```

The call site exploits `searchText` as a **filterable category tag**:

```ts
searchText: `${id} updated`      // changed rows
searchText: `${id} new`          // novel rows
searchText: `${id} unsupported`  // unsupported rows
```

So typing `updated`, `new`, or `unsupported` isolates an entire decision class
without leaving the picker.

Scrolling is a centred 12-row window (`maxVisible = 12`):

```ts
const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), Math.max(0, visibleItems.length - maxVisible)));
const end = Math.min(visibleItems.length, start + maxVisible);
```

with an out-of-window footer when the list is longer:

```
 1-12 of 400
```

---

## 2. `selectOne` (`select.ts:8`)

Single-choice picker returning `value: string | null` (null on ESC or empty list).

- Accepts `Array<string | SelectItem>`; strings are normalized to `{value,label}`.
- `SelectItem = { value, label, suffix?, description?, searchText? }`.
- `options.initialIndex` preselects a row (used to park the cursor on the
  current value in edit menus).
- Returns `null` immediately if `items.length === 0`.

Legend (`:82`):

```
 Type to search • ↑↓ move (wraps) • enter confirm • backspace delete • esc cancel
```

Note: **no `space toggle`** — this is the only legend of the three without it.

Two rendering behaviours `pickTriState` does **not** have:

1. **`suffix`** — a right-hand value column, e.g. `Reasoning • xhigh`.
2. **Multi-line `description`** — split on `\n` and emitted as indented
   `muted` lines under the row (`:69-71`):

```ts
if (item.description) {
	for (const line of item.description.split("\n")) {
		add(`   ${theme.fg("muted", line)}`);
	}
}
```

`pickTriState` and `pickMany` instead flatten descriptions to one line
(`.replace(/\s*\n\s*/g, " ")`) to keep one row per model.

Search haystack: `label + suffix + description + searchText`.
Empty-filter message: ` No matches.` (vs ` No matching models.` in the other two).

---

## 3. `pickMany` (`select.ts:278`)

Plain two-state multi-select over `ProbeItem[]`, returning `string[] | null`.

- `selected: Set<string>`; Space toggles; no tri-state, no per-row `states`.
- Header counter (`:320`):

```ts
add(` ${theme.fg("muted", `${selected.size} selected • ${visibleItems.length}/${items.length} shown`)}`);
```

- **Guard**: Enter is a no-op with nothing selected (`:382`) —
  `if (selected.size > 0) done(Array.from(selected));` — with a warning line
  rendered until then (`:349`):

```
 Select at least one model before confirming.
```

- Search haystack: `label + value + description` — **no `searchText` field**
  (`ProbeItem` has none, unlike `SelectItem`/`TriItem`).

Used for the *add* flow (`flows/add.ts:105`, `:192`), where there is no prior
state to reconcile, so two states are genuinely sufficient.

---

## 4. Every prompt helper in `prompts.ts` and what it asks

All are `async`, return `null`/`undefined` on cancel, and are composed from
`selectOne` or `ctx.ui.input`.

| helper | line | asks | returns |
|---|---|---|---|
| `promptApiKey` | 8 | `selectOne` "API key": `API key` (stored in auth.json, like pi's own /login credentials) / `None` (no key; a placeholder is written so the provider still loads). If `API key` → `ctx.ui.input("API key", "saved in auth.json under the provider id")`. Blank input degrades to `{mode:"none"}`. | `{mode:"literal", value?}` \| `{mode:"none"}` \| `null` |
| `promptReasoning` | 33 | `selectOne` "Reasoning" over `REASONING_LEVELS` = `off, minimal, low, medium, high, xhigh, max`, with `initialIndex` parked on the current value. Labels are self-describing: `Off - no reasoning`, `xhigh - maximum (only if the model supports it)`, else `` `${level} - cap reasoning at ${level}` `` | `ReasoningCeiling \| null` |
| `promptCeilingProviderString` | 45 | `ctx.ui.input(`${level} provider value (blank = ${level})`, ...)` — optional override for the provider-facing string when a model is capped at `xhigh`/`max` (some providers name it `max`) | `string \| undefined` |
| `promptImage` | 55 | `selectOne` "Image input": `Yes - send text + images` (sets `input: [text, image]`) / `No - text only` (sets `input: [text]`); `initialIndex: 1` when current is `false` | `boolean \| null` |
| `promptContextWindow` | 68 | `ctx.ui.input("Context window (tokens)", current ? \`current: ${current} (blank = keep, 0 = clear)\` : "e.g. 128000 (blank = unset)")`. Strips `_`/`,` before `parseInt`. Bad input → `notify("Enter a whole number of tokens (0 to clear).", "warning")` and `null`. | `number` (0 = clear) \| `null` (keep/cancel) |
| `promptMaxTokens` | 86 | Same contract as above with "Max output tokens", placeholder `e.g. 8192 (blank = unset)` | `number` (0 = clear) \| `null` |
| `promptManualModels` | 108 | Loop: `ctx.ui.input(ids.length === 0 ? "Model id" : "Add another model id", placeholder)`. Placeholder is style-aware (`e.g. claude-sonnet-4-5`, `e.g. llama3.1:8b or qwen2.5-coder:7b`, `e.g. gemini-2.5-pro`, else `e.g. gpt-4o-mini or qwen/qwen3-coder`) — all ending `blank or esc to finish`. Each accepted id then enters a **per-model `selectOne` menu**: `Reasoning`, `Image input`, `Context window`, `Max output tokens`, `Done`, each row showing its live value via `suffix`. Duplicate id → `notify(\`Model already added: ${id}\`, "warning")`. | `{ids, options: Map<string, ModelOptions>} \| null` |
| `promptProviderStyle` | 182 | `selectOne` "Provider style": OpenAI-compatible (Chat Completions) / OpenAI Responses API / Anthropic-compatible / Gemini (Google generative AI) / Ollama-compatible, each with a `description` naming the exact `api:` value written | `{style, api} \| null` |
| `promptEndpoint` | 206 | `ctx.ui.input("Endpoint", style-aware example)` — `https://api.anthropic-proxy.com/v1`, `http://localhost:11434/v1`, `https://generativelanguage.googleapis.com/v1beta`, `https://api.openai.com/v1`, else `https://api.example.com/v1 or http://localhost:11434/v1`. Empty → `notify("Endpoint is required.", "error")`. Invalid → `notify(\`Invalid endpoint: ...\`, "error")` | `{normalized, raw} \| null` |
| `promptProviderId` | 238 | `ctx.ui.input(\`Provider name (blank = ${suggestion})\`, "e.g. custom-example-com")`, or `Provider name (must be unique)` when the suggestion is taken. Re-prompts on collision with an existing id; refuses built-in ids via `resolveBuiltinCollision`. Blank accepts the suggestion. | `string \| null` |
| `resolveBuiltinCollision` | 283 | `selectOne` `` `"${providerId}" collides with a built-in provider` ``: `Use "<id>-custom" instead` (recommended — models and key stay separate) / `Keep "<id>"` (extend the built-in on purpose, shows `BUILTIN_COLLISION_WARNING`) / `Pick another name` | the id to use, or `null` to re-prompt |

Two contract patterns worth copying:

- **0 = clear, blank = keep, null = cancel** for numeric prompts — one prompt
  expresses three intents without a confirm dialog.
- **Uniqueness is enforced at prompt time, never by overwrite.** `promptProviderId`
  loops rather than clobbering, and `persistProvider` re-checks and *refuses*
  (`shared.ts:207`: `Provider "..." already exists. Not overwriting.`).

---

## 5. How a long model list stays navigable

Six mechanisms, all verified against a real 400-model list:

1. **12-row window** (`maxVisible = 12`). The frame is a constant ~23 lines
   regardless of list size — measured 23 lines for 400 models.
2. **Centred scroll**: `start = clamp(cursor - 6, 0, len - 12)`, so the cursor
   sits mid-window and you always see context above and below. After 50× ↓ the
   footer reads ` 45-56 of 400`.
3. **Position footer**: ` ${start+1}-${end} of ${visibleItems.length}` — the
   only signal that the list is longer than the window, and it reflects the
   *filtered* count.
4. **Live type-to-search** narrowing on `label + value + description + searchText`,
   with `cursor = 0` after every keystroke so the top match is preselected.
   Typing `137` in the 400-model list reduces it to one row: `> [-] model-137 context 128000`.
5. **Semantic `searchText` tags** (`updated` / `new` / `unsupported`) turning the
   search box into a category filter.
6. **Wrapping arrows** — ↓ on the last row returns to the first, so no dead end.

Because all 400 rows default to `mid` and Enter commits the whole map, the
default action on a huge list is **safe**: 400/400 stay `mid`, 0 forced to `on`
(verified). You narrow, then touch only what you meant to touch.

---

## 6. Why tri-state beats a plain yes/no for reconciling a model list

A re-probe produces **three distinct populations** in one flat list, and yes/no
can only answer one question:

- models that exist in config **and** came back with different metadata,
- models that are **new** on the endpoint,
- models in config that **vanished** (unsupported).

With a binary `[ ] / [x]` widget, one checkbox has to mean two different things
depending on the row, and the destructive reading is always one keystroke away.
`pickTriState` fixes this structurally:

1. **It separates "keep" from "update".** A yes/no list forces "do you want
   this model?" — but for a *changed* row the real question is "do you want the
   *new metadata*?" Those are different questions with different blast radius.
   `[x]` = apply the diff, `[-]` = keep the model, ignore the diff, `[ ]` = drop
   the model. Only three states can express all three.

2. **The safe option is the default, and it is a distinct state.** Changed rows
   start at `mid`. A yes/no list must default either to "yes, overwrite" (data
   loss) or "no, remove" (data loss). `mid` means *leave my config alone* — the
   genuinely non-destructive choice — and it is what you get by pressing Enter
   without reading anything.

3. **Destruction is never one accidental keystroke away.** `states` is
   `["off","mid","on"]`, so from the `mid` default, Space goes to `on` first.
   You must cycle *through* the safe apply state to reach remove. In a yes/no
   toggle, every Space press is a coin flip between keep and delete.

4. **Per-row `states` means no meaningless options.** New models get
   `["off","on"]` — "keep without update" is nonsense for something not in your
   config. Unsupported models get `["off","on"]` with `initial: "on"`, so a
   probe gap defaults to *keeping* your config. One widget, three honest
   menus; a yes/no list would have to offer a state that does nothing and hope
   the user infers it.

5. **It turns a review into a single pass.** The diff is rendered inline next to
   the current value — `context 128000→1000000 · current: context 128000` — so
   the decision and its evidence are on one line, and Enter commits
   add/remove/update in one write. A yes/no flow needs a second confirmation
   dialog per changed model.

6. **The legend makes the semantics explicit.** The glyph meanings are
   caller-supplied text on screen, not a convention the user must guess:
   `[ ] remove/skip • [-] keep without update • [x] keep/add with latest metadata`.

In short: reconciling is a **three-way decision per row** (apply / keep / drop).
A two-state widget cannot represent it, so it either conflates two meanings into
one checkbox or pushes the third case into a separate confirmation — and both
of those make the destructive choice easier to reach by accident.

---

## 7. Defect found while verifying: `pickTriState` ignores the Backspace key

Discovered by driving the real source, reproduced in a real terminal. This is
not a doc-writing issue — it is a live bug in the competitor's code.

`selectOne` (`:114`) and `pickMany` (`:389`) both test the **escape sequence**:

```ts
if (data === "\u007f" || data === "\b") {
```

`pickTriState` (`:261`) tests the **four-character literal**:

```ts
if (data === "007f" || data === "\b") {
```

and the printable-char guard (`:268`) likewise:

```ts
if (data >= " " && data !== "001b" && ...)
```

`"007f"` ≠ `"\u007f"` (4 chars vs 1 char, code 127), so the delete branch never
matches the byte a real terminal sends for Backspace. Verified with
`"\u007f" === "007f" -> false`.

Consequence — 0x7f is a printable-ish char (`127 >= 32`), so it **falls through
to the append branch and is added to the query as an invisible character**:

```
### pickTriState (real pi-tui 0.73.1) ###
typed 'ab'      -> [a b] len=2
send 0x7f       -> [a b 0x7f] len=3   <-- appended, not deleted
send 0x7f       -> [a b 0x7f 0x7f] len=4
send 0x08 (\b)  -> [a b 0x7f] len=3   <-- only \b really deletes
```

Controls under the same real library:

```
selectOne  : "abc" --0x7f--> "ab"   OK
pickMany   : "abc" --0x7f--> "ab"   OK
pickTriState: "abc" --0x7f--> [a b c 0x7f]  *** BROKEN ***
```

Real-terminal reproduction (tmux, `BSpace` confirmed to emit `0x7f`):

- type `gpt` → 2 rows shown
- press **Backspace** → ` No matching models.` — the invisible 0x7f poisoned
  the query, and every row disappeared
- press **Ctrl-H** (0x08) → `Search: gp` — the only working delete

So in `pickTriState`, Backspace **corrupts** the search instead of editing it,
and the user's only recovery is Ctrl-H. This hits precisely the surface where
search matters most — the long reconcile list — and the advertised legend
`backspace delete` is wrong there.

---

## Appendix — verification method

Real source, not paraphrase. `src/ui/select.ts` was copied byte-identically
(md5 `b590e46a68aef6da15a6ff2dce841a95`, `diff` clean vs the original) into a
harness and driven two ways:

1. **Headless** — real `select.ts` against the real
   `@mariozechner/pi-tui@0.73.1` (`matchesKey`, `Key`, `truncateToWidth`),
   sending real keystroke bytes and asserting on real return values.
2. **Real TTY** — the same component run inside tmux with raw stdin and real
   SGR colour output, driven with real keys (`Space`, `Down`, `BSpace`, `Enter`).

tmux byte-probe confirming the key→byte mapping used above:
`BSpace` → `0x7f`, `C-H` → `0x8`, `Up` → `0x1b 0x5b 0x41`, `Enter` → `0xd`,
`Space` → `0x20`.
