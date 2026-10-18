import { isAuthoritative, probedToEnriched, type ProbedModel } from "./probe.js"
import type { DisplayStyle, EnrichedModel } from "./enrich.js"

// A reasoning model without advertised effort options gets the full set, so
// the levels the gateway reported are actually selectable.
const DEFAULT_REASONING_LEVELS = ["low", "medium", "high"] as const

export interface V2ModelDraft {
  name?: string
  family?: string
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
  variants?: unknown[]
  limit?: { context?: number; input?: number; output?: number }
  cost?: unknown
  status?: string
  enabled?: boolean
  [key: string]: unknown
}

export function applyEnrichedToDraft(draft: V2ModelDraft, model: EnrichedModel): void {
  draft.name = model.name
  if (model.family !== undefined) draft.family = model.family
  const modalities = model.modalities
  draft.capabilities = {
    tools: model.tool_call ?? true,
    input: modalities?.input?.length ? [...modalities.input] : ["text"],
    output: modalities?.output?.length ? [...modalities.output] : ["text"],
  }
  if (model.reasoning) {
    const levels = model.reasoningLevels?.length ? model.reasoningLevels : DEFAULT_REASONING_LEVELS
    draft.variants = levels.map(level => ({ id: level, label: level, thinkingLevel: level }))
  }
  // Write only measured limits. An absent context/output means "not measured"
  // and the host fills it; a 128000/4096 placeholder would read as a fact.
  const limit: { context?: number; input?: number; output?: number } = {}
  if (model.limit.context !== undefined) limit.context = model.limit.context
  if (model.limit.output !== undefined) limit.output = model.limit.output
  if (model.limit.input !== undefined) limit.input = model.limit.input
  draft.limit = limit
  if (model.cost) {
    draft.cost = [
      {
        input: model.cost.input,
        output: model.cost.output,
        cache: {
          read: model.cost.cache_read ?? 0,
          write: model.cost.cache_write ?? 0,
        },
      },
    ]
  }
  if (model.status !== undefined) draft.status = model.status
  draft.enabled = true
}

export function probedToDraft(probed: ProbedModel, displayStyle: DisplayStyle = "slug"): V2ModelDraft {
  const draft: V2ModelDraft = {}
  applyEnrichedToDraft(draft, probedToEnriched(probed, displayStyle))
  return draft
}

/** The fields the model editor owns. A re-probe must not undo them. */
const EDITOR_OWNED = ["capabilities", "limit", "reasoning", "thinkingLevelMap", "variants", "edited"] as const

/** Fields a re-probe may overwrite only with an authoritative source. Keys the
 * fresh probe leaves absent (a fallback or the image default) mean "not measured"
 * and must never clobber a stored value. */
const GATED: ReadonlySet<keyof V2ModelDraft> = new Set(["capabilities", "limit", "cost", "variants"])

/** Merge a probe into a stored draft without losing hand-edited fields.
 *
 * Editor-owned values (thinking level, image toggle, limits) survive; measured
 * fields update. This is the only probe-to-stored path in the v2 server. */
export function probedToDraftKeepingEdits(
  existing: V2ModelDraft | undefined,
  probed: ProbedModel,
  displayStyle: DisplayStyle = "slug",
): V2ModelDraft {
  const fresh = probedToDraft(probed, displayStyle)
  if (!existing) return fresh
  const kept = { ...fresh } as Record<string, unknown>
  const source = existing as Record<string, unknown>
  if (existing.edited === true) {
    // The editor wins outright, whatever the probe sources say.
    for (const key of EDITOR_OWNED) {
      if (source[key] !== undefined) kept[key] = source[key]
    }
    return kept as V2ModelDraft
  }
  // An unedited draft: a stored value survives unless the fresh probe measured
  // it with an authoritative source. A local rule or a fallback is a guess about
  // the model in general, not a measurement of this endpoint.
  for (const key of GATED) {
    if (source[key] === undefined) continue
    if (key === "limit") {
      // Merge per field: stored extras such as limit.input survive, and a
      // subfield the probe only guessed keeps the stored value.
      const merged = { ...(source.limit as NonNullable<V2ModelDraft["limit"]>) }
      if (fresh.limit?.context !== undefined && isAuthoritative(probed.contextSource)) {
        merged.context = fresh.limit.context
      }
      if (fresh.limit?.output !== undefined && isAuthoritative(probed.maxOutputSource)) {
        merged.output = fresh.limit.output
      }
      if (fresh.limit?.input !== undefined) merged.input = fresh.limit.input
      kept.limit = merged
      continue
    }
    const freshValue = fresh[key]
    const measured =
      key === "capabilities"
        ? isAuthoritative(probed.imageSource)
        : key === "variants"
          ? probed.reasoningLevels !== undefined
          : isAuthoritative(probed.costSource)
    // The image default, the reasoning level fallback and a guessed source are
    // not facts about this endpoint, so the stored block survives.
    kept[key] = freshValue !== undefined && measured ? freshValue : source[key]
  }
  return kept as V2ModelDraft
}

export function mergeDiscoveredIntoStored(target: Record<string, unknown>, fresh: V2ModelDraft): void {
  for (const [key, value] of Object.entries(fresh)) {
    if (value === undefined) continue
    const current = target[key]
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      // The host freezes the nested objects it hands us, so copy instead of writing into them.
      const copy = { ...(current as Record<string, unknown>) }
      mergeDiscoveredIntoStored(copy, value as Record<string, unknown>)
      target[key] = copy
      continue
    }
    target[key] = value
  }
}
