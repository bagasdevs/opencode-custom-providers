import { isValidUrl, sanitizeErrorMessage, sanitizeModelId } from "./security.js"
import { normalizeModelId, fetchEndpointModels, type EndpointModelResponse } from "./endpoint.js"
import { getLookupMap, getCatalog, type ModelsDevModel } from "./catalog.js"
import { matchLocalRule, loadCustomRules, type RuleMeta } from "./rules.js"
import { FLAVORS, DEFAULT_FLAVOR, type ProviderFlavor } from "./flavors.js"
import { deepenEndpointItems } from "./deep-probe.js"
import type { DisplayStyle, EnrichedModel } from "./enrich.js"

// Tiered resolution: detected > models.dev > local-rules > api-fallback > default.
// Cost is only ever taken from detected data or models.dev.
//
// Non-goals, kept out on purpose (not oversights, so do not add them here):
// per-model HTTP headers / per-model baseURL override, $ENV and !command auth
// serialization, models.yml runtime selection, video-input display.

export type MetadataSource =
  | "detected"
  | "models.dev"
  | "local-rules"
  | "api-fallback"
  | "default"

export interface ProbedModel {
  id: string
  name?: string
  context?: number
  contextSource?: MetadataSource
  maxOutput?: number
  maxOutputSource?: MetadataSource
  reasoning?: boolean
  reasoningSource?: MetadataSource
  /** Exact effort options advertised by the gateway, when known. */
  reasoningLevels?: string[]
  image?: boolean
  imageSource?: MetadataSource
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number }
  costSource?: MetadataSource
}

/** Loopback, private LAN ranges and mDNS: never upgraded to https. */
function isLocalHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0") return true
  if (host.endsWith(".local")) return true
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true
  const second = /^172\.(\d+)\./.exec(host)
  return second !== null && Number(second[1]) >= 16 && Number(second[1]) <= 31
}

/** Path-adaptive candidates: as-given → +/v1 → http→https (non-local only). */

export function buildCandidateUrls(baseURL: string): string[] {
  const out: string[] = []
  const push = (u: string) => {
    const clean = u.replace(/\/+$/, "")
    if (clean && !out.includes(clean)) out.push(clean)
  }
  push(baseURL)
  try {
    const url = new URL(baseURL)
    const cleanPath = url.pathname.replace(/\/+$/, "")
    if (!cleanPath.endsWith("/v1")) {
      push(new URL(`${cleanPath}/v1`, url.origin).toString())
    }
    const host = url.hostname.toLowerCase()
    if (url.protocol === "http:" && !isLocalHost(host)) {
      const https = new URL(url.toString())
      https.protocol = "https:"
      push(https.toString())
    }
  } catch {
  }
  return out
}

function parseCapabilities(item: EndpointModelResponse) {
  let toolCall = false
  let reasoning = false
  let temperature = false
  if (item.capabilities) {
    if (item.capabilities.function_calling || item.capabilities.tool_choice) toolCall = true
    if (item.capabilities.reasoning) reasoning = true
    if (item.capabilities.temperature) temperature = true
  }
  if (item.supported_parameters) {
    if (item.supported_parameters.includes("tools") || item.supported_parameters.includes("tool_choice")) {
      toolCall = true
    }
    if (item.supported_parameters.includes("temperature")) temperature = true
  }
  return { toolCall, reasoning, temperature }
}

function parseEffortOptions(item: EndpointModelResponse): string[] | undefined {
  const raw = item.capabilities?.reasoning
  if (typeof raw !== "object" || raw === null) return undefined
  const opts = (raw as { effort_options?: unknown }).effort_options
  if (!Array.isArray(opts)) return undefined
  const levels = opts.filter((e): e is string => typeof e === "string" && e.length > 0)
  return levels.length > 0 ? levels : undefined
}

async function fetchFlavorModels(
  base: string,
  apiKey: string | undefined,
  flavor: ProviderFlavor,
): Promise<EndpointModelResponse[]> {
  const spec = FLAVORS[flavor]
  if (spec.listShape === "none" || spec.listPaths.length === 0) return []

  if (spec.listShape === "openai-list") {
    // fetchEndpointModels appends /models itself when missing.
    const errors: string[] = []
    for (const p of spec.listPaths) {
      try {
        const url = new URL(base)
        const clean = url.pathname.replace(/\/+$/, "")
        const target = clean.endsWith(p) ? base : new URL(`${clean}${p}`, url.origin).toString()
        const models = await fetchEndpointModels(target, apiKey)
        if (models.length > 0) return models
      } catch (error) {
        errors.push(sanitizeErrorMessage(error))
      }
    }
    if (errors.length > 0) throw new Error(errors[errors.length - 1])
    return []
  }

  // ollama-tags / gemini-list: direct fetch + shape normalization.
  for (const p of spec.listPaths) {
    try {
      const url = new URL(base)
      const clean = url.pathname.replace(/\/+$/, "")
      const target = clean.endsWith(p) ? base : new URL(`${clean}${p}`, url.origin).toString()
      // Google lists models with a ?key= query param (no Authorization header),
      // and any pre-existing query params on the candidate URL are preserved.
      const listUrl = geminiListUrl(target, spec.listShape, apiKey)
      const res = await fetch(listUrl, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) continue
      const raw = await res.json() as Record<string, unknown>
      const items = normalizeListShape(raw, spec.listShape)
      if (items.length > 0) return items
    } catch {
    }
  }
  return []
}

/** Append the Google API key param for gemini-list URLs; other shapes pass through. */
function geminiListUrl(target: string, shape: string, apiKey: string | undefined): string {
  if (shape !== "gemini-list" || !apiKey) return target
  try {
    const url = new URL(target)
    url.searchParams.set("key", apiKey)
    return url.toString()
  } catch {
    return `${target}${target.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`
  }
}

function normalizeListShape(
  raw: Record<string, unknown>,
  shape: string,
): EndpointModelResponse[] {
  if (shape === "ollama-tags") {
    const models = raw["models"]
    if (!Array.isArray(models)) return []
    return models
      .filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && typeof (m as Record<string, unknown>)["name"] === "string")
      .map(m => ({ id: (m["name"] as string).split(":")[0].trim() || (m["name"] as string) }))
      .filter(m => m.id.length > 0)
  }
  if (shape === "gemini-list") {
    const models = raw["models"]
    if (!Array.isArray(models)) return []
    const out: EndpointModelResponse[] = []
    for (const m of models) {
      if (typeof m !== "object" || m === null) continue
      const rec = m as Record<string, unknown>
      const name = rec["name"]
      if (typeof name !== "string" || name.length === 0) continue
      const id = name.startsWith("models/") ? name.slice(7) : name
      const item: EndpointModelResponse = { id }
      if (typeof rec["displayName"] === "string") item.name = rec["displayName"] as string
      if (typeof rec["inputTokenLimit"] === "number") item.context_length = rec["inputTokenLimit"] as number
      if (typeof rec["outputTokenLimit"] === "number") item.max_output_tokens = rec["outputTokenLimit"] as number
      out.push(item)
    }
    return out
  }
  return []
}

export function resolveModel(
  item: EndpointModelResponse,
  lookup: Map<string, { limit: { context: number; output: number; input?: number }; modalities?: { input: string[]; output: string[] }; reasoning: boolean; temperature: boolean; tool_call: boolean; cost?: { input: number; output: number; cache_read?: number; cache_write?: number }; name: string }>,
  flavor: ProviderFlavor,
  customs: Record<string, RuleMeta>,
): ProbedModel {
  const spec = FLAVORS[flavor]
  const id = sanitizeModelId(item.id)
  const key = normalizeModelId(id)
  const meta = lookup.get(key)
  const custom = customs[key]
  const rule = custom ? { meta: custom, pattern: `custom:${key}` } : matchLocalRule(id)
  const caps = parseCapabilities(item)
  const levels = parseEffortOptions(item)

  const probed: ProbedModel = { id }
  if (item.name && item.name !== item.id) probed.name = item.name
  else if (meta) probed.name = meta.name

  // Context window.
  const epContext = [item.context_window, item.max_model_len, item.context_length]
    .find((v): v is number => typeof v === "number")
  if (epContext !== undefined) {
    probed.context = epContext
    probed.contextSource = "detected"
  } else if (meta) {
    probed.context = meta.limit.context
    probed.contextSource = "models.dev"
  } else if (rule) {
    probed.context = rule.meta.context
    probed.contextSource = "local-rules"
  } else {
    probed.context = spec.fallbackLimits.context
    probed.contextSource = "api-fallback"
  }

  // Max output, clamped so a degenerate catalog limit cannot collapse output
  // onto context (which makes every reply impossible).
  // resolveModel is the ONLY resolver: every write path (probe, manual entry,
  // catalog) routes through it, so this clamp cannot be bypassed.
  const epOutput = [item.max_completion_tokens, item.max_output_tokens]
    .find((v): v is number => typeof v === "number")
  if (epOutput !== undefined) {
    probed.maxOutput = epOutput
    probed.maxOutputSource = "detected"
  } else if (meta) {
    probed.maxOutput = meta.limit.output
    probed.maxOutputSource = "models.dev"
  } else if (rule) {
    probed.maxOutput = rule.meta.output
    probed.maxOutputSource = "local-rules"
  } else {
    probed.maxOutput = spec.fallbackLimits.output
    probed.maxOutputSource = "api-fallback"
  }
  if (probed.maxOutput !== undefined && probed.context !== undefined && probed.maxOutput >= probed.context) {
    probed.maxOutput = Math.max(1, Math.floor(probed.context / 2))
  }

  // Reasoning. Advertised effort options count as detected. No "default on" tier.
  if (caps.reasoning || meta?.reasoning) {
    probed.reasoning = true
    probed.reasoningSource = caps.reasoning ? "detected" : "models.dev"
  } else if (levels && levels.length > 0) {
    probed.reasoning = true
    probed.reasoningSource = "detected"
  } else if (rule) {
    probed.reasoning = rule.meta.reasoning
    probed.reasoningSource = "local-rules"
  }
  // No tier produced evidence: `reasoning` and `reasoningSource` stay undefined.
  // Absence is the statement "not measured" and lets the host's own fallback
  // decide; asserting true or false here would invent a capability.
  if (levels && levels.length > 0) probed.reasoningLevels = levels

  // Image input (default off).
  const vision = item.capabilities?.vision === true
  const metaImage = meta?.modalities?.input.includes("image") ?? false
  if (vision || metaImage) {
    probed.image = true
    probed.imageSource = vision ? "detected" : "models.dev"
  } else if (rule) {
    probed.image = rule.meta.image
    probed.imageSource = "local-rules"
  } else {
    probed.image = false
    probed.imageSource = "default"
  }

  // Cost is never guessed.
  const hasEndpointCost = typeof item.input_cost === "number" || typeof item.output_cost === "number"
  if (hasEndpointCost) {
    probed.cost = {
      input: typeof item.input_cost === "number" ? item.input_cost : 0,
      output: typeof item.output_cost === "number" ? item.output_cost : 0,
    }
    probed.costSource = "detected"
  } else if (meta?.cost) {
    probed.cost = {
      input: meta.cost.input ?? 0,
      output: meta.cost.output ?? 0,
      cache_read: meta.cost.cache_read,
      cache_write: meta.cost.cache_write,
    }
    probed.costSource = "models.dev"
  }

  return probed
}

function modelsUrlFor(candidate: string, flavor: ProviderFlavor): string {
  const first = FLAVORS[flavor].listPaths[0] ?? "/models"
  try {
    const url = new URL(candidate)
    const clean = url.pathname.replace(/\/+$/, "")
    if (clean.endsWith(first)) return candidate
    return new URL(`${clean}${first}`, url.origin).toString()
  } catch {
    return candidate
  }
}

/** The winning candidate is the variant that actually answered, so the
 * caller can store that URL instead of re-guessing `/v1` on every re-probe.
 * `listUnsupported` is the distinct third outcome: the flavor exposes no model
 * list at all, which must not be folded into "it answered but listed nothing". */
export interface ProbeOutcome {
  models: ProbedModel[]
  baseURL: string
  listUnsupported: boolean
}

/** Probe an endpoint across adaptive URL candidates. Throws when nothing answers. */
export async function probeEndpointOutcome(
  baseURL: string,
  apiKey?: string,
  flavor: ProviderFlavor = DEFAULT_FLAVOR,
): Promise<ProbeOutcome> {
  if (!isValidUrl(baseURL)) {
    throw new Error("Invalid Base URL. Please enter a full URL (including https://).")
  }
  if (FLAVORS[flavor].listShape === "none") {
    return { models: [], baseURL, listUnsupported: true }
  }
  const lookup = await getLookupMap()
  const customs = loadCustomRules()
  const candidates = buildCandidateUrls(baseURL)
  let lastError: string | null = null
  for (const candidate of candidates) {
    try {
      const items = await fetchFlavorModels(candidate, apiKey, flavor)
      if (items.length > 0) {
        let origin = ""
        try {
          origin = new URL(candidate).origin
        } catch {
          origin = candidate
        }
        const deep = await deepenEndpointItems(items, {
          modelsUrl: modelsUrlFor(candidate, flavor),
          origin,
          apiKey,
          flavor,
        })
        return {
          models: deep.map(item => resolveModel(item, lookup, flavor, customs)),
          baseURL: candidate,
          listUnsupported: false,
        }
      }
    } catch (error) {
      lastError = sanitizeErrorMessage(error)
    }
  }
  throw new Error(
    `Probe failed for ${baseURL}` + (lastError ? `: ${lastError}` : ". No models found: retry or add models manually."),
  )
}

/** Convenience wrapper: the models only, for callers that do not store the URL. */
export async function probeEndpoint(
  baseURL: string,
  apiKey?: string,
  flavor: ProviderFlavor = DEFAULT_FLAVOR,
): Promise<ProbedModel[]> {
  return (await probeEndpointOutcome(baseURL, apiKey, flavor)).models
}

/** Convert a resolved probe into a stored model entry. */
export function probedToEnriched(
  probed: ProbedModel,
  displayStyle: DisplayStyle,
): EnrichedModel {
  // `limit` carries only measured fields. A fallback ("api-fallback") or an
  // assumption ("default") is not a measurement, so it is left absent and the
  // host's own limit fallback applies instead of a real-looking invented number.
  const limit: { context?: number; output?: number } = {}
  if (hasEvidence(probed.contextSource)) limit.context = probed.context
  if (hasEvidence(probed.maxOutputSource)) limit.output = probed.maxOutput
  const model: EnrichedModel = {
    name: displayStyle === "slug" ? probed.id : probed.name ?? probed.id,
    limit,
    modalities: probed.image
      ? { input: ["text", "image"], output: ["text"] }
      : { input: ["text"], output: ["text"] },
  }
  if (probed.reasoning) model.reasoning = true
  if (probed.reasoningLevels?.length) model.reasoningLevels = [...probed.reasoningLevels]
  if (probed.cost) {
    model.cost = {
      input: probed.cost.input,
      output: probed.cost.output,
      cache_read: probed.cost.cache_read,
      cache_write: probed.cost.cache_write,
    }
  }
  return model
}

/** `default` means "no measurement". `api-fallback` is a protocol guess,
 * which is also not a measurement of this model - both are unevidenced. */
function hasEvidence(source: MetadataSource | undefined): boolean {
  return source !== undefined && source !== "default" && source !== "api-fallback"
}

export function describeProbed(probed: ProbedModel): string {
  // bare = measured here, tagged = sourced from elsewhere (a guess about
  // *this* endpoint), absent = no measurement at all.
  const lines = [`Model: ${probed.id}`]
  if (hasEvidence(probed.contextSource)) {
    lines.push(`  Context window: ${probed.context?.toLocaleString("en-US") ?? "unknown"} tokens${tag(probed.contextSource)}`)
  }
  if (hasEvidence(probed.maxOutputSource)) {
    lines.push(`  Longest reply: ${probed.maxOutput?.toLocaleString("en-US") ?? "unknown"} tokens${tag(probed.maxOutputSource)}`)
  }
  if (probed.reasoning !== undefined) {
    const levels = probed.reasoningLevels?.length ? ` (${probed.reasoningLevels.join("/")})` : ""
    lines.push(`  Thinking: ${probed.reasoning ? "supported" : "not supported"}${levels}${tag(probed.reasoningSource)}`)
  }
  if (hasEvidence(probed.imageSource)) {
    lines.push(`  Image input: ${probed.image ? "supported" : "not supported"}${tag(probed.imageSource)}`)
  }
  if (probed.cost) {
    lines.push(
      `  Price: $${probed.cost.input} per million input tokens, $${probed.cost.output} per million output tokens${tag(probed.costSource)}`,
    )
  }
  return lines.join("\n")
}

/** Nothing for a value measured on this endpoint, `[source]` for one taken
 * from a database or a rule, i.e. a guess about this endpoint. */
function tag(source: MetadataSource | undefined): string {
  return source === "detected" || source === undefined ? "" : ` [${source}]`
}

/** One-liner for picker rows: `128K [models.dev]`, `context 128K [local rules]`,
 * and nothing at all when the value was never measured. */
export function describeProbedShort(probed: ProbedModel): string {
  const parts: string[] = []
  if (hasEvidence(probed.contextSource)) {
    parts.push(`context ${compactNum(probed.context)}${tag(probed.contextSource)}`)
  }
  if (hasEvidence(probed.maxOutputSource)) {
    parts.push(`out ${compactNum(probed.maxOutput)}${tag(probed.maxOutputSource)}`)
  }
  if (probed.reasoning !== undefined && hasEvidence(probed.reasoningSource)) {
    parts.push(`thinking ${probed.reasoning ? "on" : "off"}${tag(probed.reasoningSource)}`)
  }
  if (hasEvidence(probed.imageSource)) {
    parts.push(`image ${probed.image ? "on" : "off"}${tag(probed.imageSource)}`)
  }
  return parts.join(", ")
}

function compactNum(value: number | undefined): string {
  if (value === undefined) return "?"
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`
  if (value >= 1_000) return `${trimZero(value / 1_000)}K`
  return String(value)
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function catalogToProbed(model: ModelsDevModel): ProbedModel {
  const probed: ProbedModel = { id: model.id, name: model.name }
  probed.context = model.limit.context
  probed.contextSource = "models.dev"
  probed.maxOutput = model.limit.output
  probed.maxOutputSource = "models.dev"
  probed.reasoning = model.reasoning
  probed.reasoningSource = "models.dev"
  const image = model.modalities?.input.includes("image") ?? false
  probed.image = image
  probed.imageSource = "models.dev"
  if (model.cost) {
    probed.cost = {
      input: model.cost.input ?? 0,
      output: model.cost.output ?? 0,
      cache_read: model.cost.cache_read,
      cache_write: model.cost.cache_write,
    }
    probed.costSource = "models.dev"
  }
  return probed
}

/** Returns undefined when omitted (= all models) and [] when provided but empty;
 * callers must reject the empty selection. */
export function parseModelIds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  return raw.split(",").map(s => s.trim()).filter(s => s.length > 0)
}

export interface CatalogBuild {
  baseURL: string
  models: Record<string, EnrichedModel>
  resolved: ProbedModel[]
  missing: string[]
}

/** Build stored models purely from the models.dev catalog (no probing). */
export async function buildCatalogModels(
  siteId: string,
  modelIds: string[] | undefined,
  displayStyle: DisplayStyle,
): Promise<CatalogBuild> {
  const catalog = await getCatalog()
  const site = catalog[siteId]
  if (!site) throw new Error(`Unknown catalog site '${siteId}'.`)
  if (!site.api || !isValidUrl(site.api)) {
    throw new Error(`Catalog site '${siteId}' has no usable API endpoint.`)
  }
  const wanted = modelIds && modelIds.length > 0
    ? new Set(modelIds.map(m => m.trim()).filter(m => m.length > 0))
    : null
  const models: Record<string, EnrichedModel> = {}
  const resolved: ProbedModel[] = []
  const matched = new Set<string>()
  for (const model of Object.values(site.models ?? {})) {
    const id = sanitizeModelId(model.id)
    if (wanted) {
      const hit = wanted.has(id) || wanted.has(model.id)
      if (!hit) continue
      if (wanted.has(id)) matched.add(id)
      if (wanted.has(model.id)) matched.add(model.id)
    }
    const probed = catalogToProbed({ ...model, id })
    resolved.push(probed)
    models[id] = probedToEnriched(probed, displayStyle)
  }
  const missing = wanted ? [...wanted].filter(raw => !matched.has(raw)) : []
  return { baseURL: site.api, models, resolved, missing }
}

/** Resolve hand-typed ids against the local rules and the models.dev lookup.
 *
 * Contract, which callers depend on and must not break:
 *  - network-free with respect to the provider endpoint: no request is made to
 *    the user's baseURL. (models.dev is a public metadata DB, not the endpoint.)
 *  - an empty `ids` list resolves to an empty result; the helper does NOT fall
 *    back to "every known model". The caller (manualAdd) rejects an empty
 *    selection before calling, and must keep doing so. */

export async function previewManualModels(
  ids: string[],
  flavor?: ProviderFlavor,
  displayStyle?: DisplayStyle,
): Promise<Array<{ id: string; probed: ProbedModel; model: EnrichedModel }>> {
  const lookup = await getLookupMap()
  const customs = loadCustomRules()
  const resolvedFlavor = flavor ?? DEFAULT_FLAVOR
  const style = displayStyle ?? "slug"
  const out: Array<{ id: string; probed: ProbedModel; model: EnrichedModel }> = []
  for (const raw of ids) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const probed = resolveModel({ id: trimmed }, lookup, resolvedFlavor, customs)
    out.push({ id: probed.id, probed, model: probedToEnriched(probed, style) })
  }
  return out
}
