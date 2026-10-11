import type { DisplayStyle, EnrichedModel } from "./enrich.js"
import { isAuthoritative, probedToEnriched, type MetadataSource, type ProbedModel } from "./probe.js"

// Tri-state reconcile: apply takes the fresh value, keep preserves stored metadata,
// remove drops the model. Missing decisions default to apply (new/changed) or keep.

export type ChangeKind = "added" | "updated" | "removed"
export type TriDecision = "apply" | "keep" | "remove"

export interface ModelChange {
  id: string
  kind: ChangeKind
  /** Human-readable summary, e.g. "context 128000 -> 1000000, image [+]". */
  detail: string
  /** Lowercase filter text: lets a host dialog isolate one decision class. */
  searchText?: string
}

function hasImage(model: EnrichedModel): boolean {
  return model.modalities?.input.includes("image") ?? false
}

/** Probe sources for the fields a merge may apply, so a guess cannot overwrite
 * a stored measurement. Built from a ProbedModel by applyDecisions/diffModels. */
export interface FreshSources {
  contextSource?: MetadataSource
  maxOutputSource?: MetadataSource
  costSource?: MetadataSource
  imageSource?: MetadataSource
}

function sourcesOf(probed: ProbedModel): FreshSources {
  return {
    contextSource: probed.contextSource,
    maxOutputSource: probed.maxOutputSource,
    costSource: probed.costSource,
    imageSource: probed.imageSource,
  }
}

/** Legacy callers pass no sources, so they keep the old overwrite behaviour;
 * with sources present, only a measurement or a catalog value may win. */
function freshWins(sources: FreshSources | undefined, source: MetadataSource | undefined): boolean {
  return sources === undefined || isAuthoritative(source)
}

function describeUpdate(
  id: string,
  current: EnrichedModel,
  fresh: EnrichedModel,
  sources?: FreshSources,
): string | null {
  const parts: string[] = []
  // A field the fresh probe did not measure, or may not overwrite, is not an update.
  if (
    fresh.limit.context !== undefined &&
    (current.limit.context === undefined || freshWins(sources, sources?.contextSource)) &&
    current.limit.context !== fresh.limit.context
  ) {
    parts.push(`context ${current.limit.context} -> ${fresh.limit.context}`)
  }
  if (
    fresh.limit.output !== undefined &&
    (current.limit.output === undefined || freshWins(sources, sources?.maxOutputSource)) &&
    current.limit.output !== fresh.limit.output
  ) {
    parts.push(`max-out ${current.limit.output} -> ${fresh.limit.output}`)
  }
  if (current.name !== fresh.name) {
    parts.push(`name "${current.name}" -> "${fresh.name}"`)
  }
  if (!!current.reasoning !== !!fresh.reasoning) {
    parts.push(fresh.reasoning ? "reasoning [+]" : "reasoning [-]")
  }
  if (
    fresh.modalities !== undefined &&
    (current.modalities === undefined || freshWins(sources, sources?.imageSource)) &&
    hasImage(current) !== hasImage(fresh)
  ) {
    parts.push(hasImage(fresh) ? "image [+]" : "image [-]")
  }
  if (parts.length === 0) return null
  return `${id}: ${parts.join(", ")}`
}

/** Fresh wins for the fields it reports; stored-only metadata survives. The
 * merge is explicit because a blind spread would wipe stored limit.input and cost.
 *
 * With `sources` given, a fresh value only replaces a stored one when its probe
 * source is authoritative (detected or models.dev); a local rule or a fallback is
 * a guess and keeps the stored measurement. Without `sources` the legacy
 * overwrite behaviour is kept, so existing callers stay valid. */
export function mergeAppliedModel(stored: EnrichedModel, fresh: EnrichedModel, sources?: FreshSources): EnrichedModel {
  const limit: EnrichedModel["limit"] = { ...stored.limit }
  if (fresh.limit.context !== undefined && (stored.limit.context === undefined || freshWins(sources, sources?.contextSource))) {
    limit.context = fresh.limit.context
  }
  if (fresh.limit.input !== undefined) limit.input = fresh.limit.input
  if (fresh.limit.output !== undefined && (stored.limit.output === undefined || freshWins(sources, sources?.maxOutputSource))) {
    limit.output = fresh.limit.output
  }
  const modalities =
    fresh.modalities !== undefined && (stored.modalities === undefined || freshWins(sources, sources?.imageSource))
      ? fresh.modalities
      : stored.modalities
  const merged: EnrichedModel = {
    name: fresh.name,
    limit,
    modalities,
  }
  if (stored.family !== undefined) merged.family = stored.family
  if (stored.release_date !== undefined) merged.release_date = stored.release_date
  if (stored.status !== undefined) merged.status = stored.status
  if (stored.attachment !== undefined) merged.attachment = stored.attachment
  if (stored.temperature !== undefined) merged.temperature = stored.temperature
  if (stored.tool_call !== undefined) merged.tool_call = stored.tool_call
  if (fresh.reasoning) merged.reasoning = true
  if (fresh.cost && (stored.cost === undefined || freshWins(sources, sources?.costSource))) {
    merged.cost = { ...fresh.cost }
  } else if (stored.cost) {
    merged.cost = { ...stored.cost }
  }
  if (fresh.reasoningLevels?.length) {
    merged.reasoningLevels = [...fresh.reasoningLevels]
  } else if (merged.reasoning && stored.reasoningLevels?.length) {
    merged.reasoningLevels = [...stored.reasoningLevels]
  }
  return merged
}

/** Diff stored models against a fresh probe. */
export function diffModels(
  current: Record<string, EnrichedModel>,
  fresh: ProbedModel[],
  displayStyle: DisplayStyle,
): ModelChange[] {
  const changes: ModelChange[] = []
  const seen = new Set<string>()
  for (const p of fresh) {
    // An endpoint can list the same id twice. Without this, the user was asked the same
    // question twice and only their last answer reached the decision map.
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const stored = current[p.id]
    if (!stored) {
      changes.push({ id: p.id, kind: "added", detail: `${p.id}: new model`, searchText: `${p.id} added` })
      continue
    }
    const detail = describeUpdate(p.id, stored, probedToEnriched(p, displayStyle), sourcesOf(p))
    if (detail) changes.push({ id: p.id, kind: "updated", detail, searchText: `${p.id} updated` })
  }
  for (const id of Object.keys(current)) {
    if (!seen.has(id)) {
      changes.push({ id, kind: "removed", detail: `${id}: vanished upstream (unsupported)`, searchText: `${id} removed` })
    }
  }
  return changes
}

/** Apply tri-state decisions, returning the new stored model map. */
export function applyDecisions(
  current: Record<string, EnrichedModel>,
  fresh: ProbedModel[],
  decisions: Record<string, TriDecision>,
  displayStyle: DisplayStyle,
): Record<string, EnrichedModel> {
  const next: Record<string, EnrichedModel> = { ...current }
  const freshById = new Map(fresh.map(p => [p.id, p]))
  for (const p of fresh) {
    const decision = decisions[p.id] ?? "apply"
    if (!current[p.id]) {
      if (decision === "apply") next[p.id] = probedToEnriched(p, displayStyle)
    } else if (decision === "apply") {
      next[p.id] = mergeAppliedModel(current[p.id], probedToEnriched(p, displayStyle), sourcesOf(p))
    } else if (decision === "remove") {
      delete next[p.id]
    }
  }
  for (const id of Object.keys(current)) {
    if (!freshById.has(id)) {
      const decision = decisions[id] ?? "keep"
      if (decision !== "keep") delete next[id]
    }
  }
  return next
}
