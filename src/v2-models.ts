import { probedToEnriched, type ProbedModel } from "./probe.js"
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
      mergeDiscoveredIntoStored(current as Record<string, unknown>, value as Record<string, unknown>)
      continue
    }
    target[key] = value
  }
}
