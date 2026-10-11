import type { V2ModelDraft } from "./v2-models.js"

/** Reasoning ceiling of a model: "off" plus every thinking level pi supports. */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export const REASONING_LEVELS: readonly ReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

/** Levels that only exist when the map names them (opt-in), unlike the default
 * levels where an absent key means available and a null key means capped off. */
const OPT_IN_LEVELS = new Set<ReasoningLevel>(["xhigh", "max"])

type ThinkingLevelMap = Record<string, string | null>

export function reasoningLabel(level: ReasoningLevel): string {
  if (level === "off") return "Off - no reasoning"
  if (level === "xhigh") return "xhigh - maximum (only if the model supports it)"
  if (level === "max") return "max - maximum (only if the model supports it)"
  return `${level} - cap reasoning at ${level}`
}

/** The per-model knobs the editor owns. context/output are token counts; an
 * absent value means unset, so the host default applies. */
export interface ModelFields {
  image: boolean
  reasoning: ReasoningLevel
  context?: number
  output?: number
}

function readMap(draft: V2ModelDraft): ThinkingLevelMap | undefined {
  const raw = draft.thinkingLevelMap
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  return raw as ThinkingLevelMap
}

function isEnabled(value: unknown): boolean {
  return value !== undefined && value !== null
}

/** Highest level the map leaves available. No map at all means every default
 * level is available, so the ceiling is "high". */
function ceilingFromMap(map: ThinkingLevelMap | undefined): ReasoningLevel {
  if (!map) return "high"
  if (isEnabled(map.max)) return "max"
  if (isEnabled(map.xhigh)) return "xhigh"
  for (let index = REASONING_LEVELS.length - 1; index >= 1; index--) {
    const level = REASONING_LEVELS[index]
    if (OPT_IN_LEVELS.has(level)) continue
    if (map[level] === null) continue
    return level
  }
  return "high"
}

/** Derive the map for a ceiling, mirroring pi's getSupportedThinkingLevels: a
 * default level is available when its key is absent, so only the levels above the
 * ceiling are nulled, and an opt-in level appears only once the ceiling reaches it. */
function thinkingMapFor(ceiling: ReasoningLevel): ThinkingLevelMap {
  const ceilingIndex = REASONING_LEVELS.indexOf(ceiling)
  const map: ThinkingLevelMap = {}
  for (const level of REASONING_LEVELS) {
    if (level === "off") continue
    const index = REASONING_LEVELS.indexOf(level)
    if (OPT_IN_LEVELS.has(level)) {
      if (ceilingIndex >= index) map[level] = level
    } else if (index > ceilingIndex) {
      map[level] = null
    }
  }
  return map
}

/** Which thinking levels a ceiling leaves available, in ascending order.
 *
 * The host decides what a model offers from `variants`, not from `reasoning` or
 * `thinkingLevelMap`, so those two alone leave an edit invisible in the model
 * picker. The shape matches what the probe writes. */
export function variantsForCeiling(ceiling: ReasoningLevel): Array<{ id: string; label: string; thinkingLevel: string }> {
  if (ceiling === "off") return []
  const ceilingIndex = REASONING_LEVELS.indexOf(ceiling)
  return REASONING_LEVELS.slice(1, ceilingIndex + 1).map(level => ({ id: level, label: level, thinkingLevel: level }))
}

/** Thinking levels named by a stored `variants` list, in ascending order. The host
 * reads this list, so it is the truthful record of what the model offers. */
function ceilingFromVariants(draft: V2ModelDraft): ReasoningLevel | undefined {
  const raw = draft.variants
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  let best: ReasoningLevel | undefined
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== "string") continue
    const level = REASONING_LEVELS.find(candidate => candidate === id)
    if (level === undefined || level === "off") continue
    if (best === undefined || REASONING_LEVELS.indexOf(level) > REASONING_LEVELS.indexOf(best)) best = level
  }
  return best
}

/** The largest token limit worth storing. Well above any real context window, but low
 * enough to catch a mistyped digit count that would otherwise reach the host as a
 * real limit. */
export const MAX_TOKEN_LIMIT = 100_000_000

/** A token limit must be a whole number of tokens within a sane range. Anything else
 * is a typo, and a bad value gets persisted and then breaks the listModels output
 * schema, which rejects a non-number. Zero is allowed: it means "clear". */
function validTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_LIMIT
}

/** Read the editable fields out of a draft, permissively: a draft that names no
 * field reads as image on, reasoning off, both limits unset. */
export function readModelFields(draft: V2ModelDraft): ModelFields {
  const input = draft.capabilities?.input
  const limit = draft.limit
  // A probe writes variants but no `reasoning` key, and a model that names thinking
  // levels does reason, so the variants are the better signal than the key alone.
  const fromVariants = ceilingFromVariants(draft)
  return {
    image: Array.isArray(input) ? input.includes("image") : true,
    reasoning: draft.reasoning === true || fromVariants !== undefined
      ? (fromVariants ?? ceilingFromMap(readMap(draft)))
      : "off",
    // A stored value that is not a whole number reads as unset, so the editor shows
    // it as unset instead of carrying the bad value forward.
    context: validTokenLimit(limit?.context) ? limit.context : undefined,
    output: validTokenLimit(limit?.output) ? limit.output : undefined,
  }
}

/** Write the editable fields back, in place, preserving every other key. */
export function applyModelFields(draft: V2ModelDraft, fields: ModelFields): void {
  draft.capabilities = { ...draft.capabilities, input: fields.image ? ["text", "image"] : ["text"] }

  if (fields.reasoning === "off") {
    delete draft.reasoning
    delete draft.thinkingLevelMap
  } else {
    draft.reasoning = true
    const map = thinkingMapFor(fields.reasoning)
    // An empty map says nothing, so drop the key instead of writing {}.
    if (Object.keys(map).length > 0) draft.thinkingLevelMap = map
    else delete draft.thinkingLevelMap
  }
  draft.variants = variantsForCeiling(fields.reasoning)
  // Marks the draft as hand-edited, so a later re-probe knows not to overwrite it.
  draft.edited = true

  // 0 is the clear signal from the token prompts, same as leaving a field out.
  const setContext = typeof fields.context === "number" && fields.context > 0
  const setOutput = typeof fields.output === "number" && fields.output > 0
  if (!setContext && !setOutput && !draft.limit) return
  const limit = { ...draft.limit }
  if (setContext) limit.context = fields.context
  else delete limit.context
  if (setOutput) limit.output = fields.output
  else delete limit.output
  // An emptied limit says nothing, so drop the key instead of writing {}.
  if (Object.keys(limit).length > 0) draft.limit = limit
  else delete draft.limit
}

/** A token prompt has three outcomes, so blank can never be confused with 0. */
export type TokenEdit =
  | { action: "keep" }
  | { action: "clear" }
  | { action: "set"; value: number }
  | null

const TOKEN_DIGITS = /^\d+$/

/** Parse a raw token prompt. Returns null on blank or unusable text. */
export function parseTokenCount(raw: string): number | null {
  const edit = parseTokenEdit(raw)
  if (edit === null) return null
  if (edit.action === "clear") return 0
  if (edit.action === "keep") return null
  return edit.value
}

/** Classify a raw token prompt: blank keeps the current value, 0 clears it, a
 * plain non-negative integer sets it, anything else is null (caller warns). */
export function parseTokenEdit(raw: string): TokenEdit {
  const cleaned = raw.trim().replace(/[_,]/g, "")
  if (!cleaned) return { action: "keep" }
  if (!TOKEN_DIGITS.test(cleaned)) return null
  const parsed = Number.parseInt(cleaned, 10)
  if (!Number.isSafeInteger(parsed)) return null
  return parsed === 0 ? { action: "clear" } : { action: "set", value: parsed }
}

/** Next value for a token field: keep passes the current value through, clear
 * yields 0 (which applyModelFields turns into a key deletion). */
export function resolveTokenEdit(current: number | undefined, edit: TokenEdit): number | undefined {
  if (edit === null) return current
  if (edit.action === "keep") return current
  if (edit.action === "clear") return 0
  return edit.value
}
