import { discoverAndEnrich, clearModelsDevCache, type DisplayStyle } from "./discovery.js"
import { isValidUrl, sanitizeErrorMessage } from "./security.js"
import { getApiKey, shouldDiscover, type ProviderConfig } from "./types.js"

export interface ReloadResult {
  totalModels: number
  failures: number
  providerCount: number
  warnings: string[]
  errors: string[]
}

interface ProviderReloadOutcome {
  providerId: string
  models: Record<string, unknown> | null
  warning?: string
  error?: string
}

async function reloadOneProvider(
  providerId: string,
  providerConfig: ProviderConfig,
): Promise<ProviderReloadOutcome> {
  const baseURL = providerConfig.options!.baseURL!
  const apiKey = getApiKey(providerConfig, providerId)
  const displayStyle: DisplayStyle = providerConfig.displayStyle ?? "slug"

  try {
    const models = await discoverAndEnrich(baseURL, apiKey, displayStyle, getProviderFlavor(providerConfig))
    const count = Object.keys(models).length

    if (count > 0) {
      return { providerId, models }
    }

    if (providerConfig.models && Object.keys(providerConfig.models).length > 0) {
      return {
        providerId,
        models: null,
        warning: `${providerId} returned 0 models (keeping previous models). Check endpoint status.`,
      }
    }

    return { providerId, models: null }
  } catch (error) {
    return {
      providerId,
      models: null,
      error: `Failed to reload ${providerId}: ${sanitizeErrorMessage(error)}`,
    }
  }
}

export async function chunkedAllSettled<T>(
  tasks: Array<() => Promise<T>>,
  size = 4,
): Promise<Array<PromiseSettledResult<T>>> {
  const outcomes: Array<PromiseSettledResult<T>> = []
  for (let i = 0; i < tasks.length; i += size) {
    const settled = await Promise.allSettled(tasks.slice(i, i + size).map(fn => fn()))
    outcomes.push(...settled)
  }
  return outcomes
}

export async function reloadAllProviders(
  providers: Record<string, ProviderConfig>,
): Promise<ReloadResult> {
  const dynamicProviders = Object.entries(providers).filter(
    ([, p]) => shouldDiscover(p),
  )

  const result: ReloadResult = {
    totalModels: 0,
    failures: 0,
    providerCount: dynamicProviders.length,
    warnings: [],
    errors: [],
  }

  if (dynamicProviders.length === 0) return result

  clearModelsDevCache()

  const outcomes = await chunkedAllSettled(
    dynamicProviders.map(([id, cfg]) => () => reloadOneProvider(id, cfg)),
    4,
  )

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      result.failures++
      result.errors.push(`Unexpected error: ${sanitizeErrorMessage(outcome.reason)}`)
      continue
    }

    const { providerId, models, warning, error } = outcome.value

    if (error) {
      result.failures++
      result.errors.push(error)
    } else if (warning) {
      result.warnings.push(warning)
    }

    if (models) {
      const providerConfig = providers[providerId]
      providerConfig.models = models
      result.totalModels += Object.keys(models).length
    }
  }

  return result
}

export interface AddProviderParams {
  providerId: string
  baseURL: string
  apiKey?: string
  displayStyle?: DisplayStyle
  overwrite?: boolean
  flavor?: ProviderFlavor
}

export interface AddProviderResult {
  success: boolean
  modelCount: number
  message: string
  providerEntry?: ProviderConfig
}

export function validateProviderId(providerId: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
    return "Invalid Provider ID. Use alphanumeric, hyphens, or underscores only."
  }
  return null
}

export function validateAddProviderParams(
  params: AddProviderParams,
  existingProviders: Record<string, ProviderConfig>,
): string | null {
  const idError = validateProviderId(params.providerId)
  if (idError) return idError
  if (!isValidUrl(params.baseURL)) {
    return "Invalid Base URL. Please enter a full URL (including https://)."
  }
  if (existingProviders[params.providerId] && !params.overwrite) {
    return `A provider with ID '${params.providerId}' already exists. Set overwrite to true to replace it.`
  }
  return null
}

export async function addProvider(
  params: AddProviderParams,
): Promise<AddProviderResult> {
  const displayStyle = params.displayStyle ?? "slug"
  const baseURL = params.baseURL.trim().replace(/\/+$/, "")

  try {
    const models = await discoverAndEnrich(baseURL, params.apiKey, displayStyle, params.flavor ?? DEFAULT_FLAVOR)
    const modelCount = Object.keys(models).length

    if (modelCount === 0) {
      return {
        success: false,
        modelCount: 0,
        message: "No models found at the given endpoint. Provider not added.",
      }
    }

    const providerEntry: ProviderConfig = {
      name: params.providerId,
      npm: "@ai-sdk/openai-compatible",
      api: baseURL,
      options: { baseURL },
      dynamic: true,
      displayStyle,
      models,
    }
    if (params.flavor) providerEntry.flavor = params.flavor

    if (params.apiKey) {
      const role = await probeDeveloperRole(baseURL, params.apiKey)
      if (role === false) {
        providerEntry.compat = { supportsDeveloperRole: false }
      }
    }

    return {
      success: true,
      modelCount,
      message: `Provider '${params.providerId}' added with ${modelCount} model(s).`,
      providerEntry,
    }
  } catch (error) {
    return {
      success: false,
      modelCount: 0,
      message: `Failed to discover models: ${sanitizeErrorMessage(error)}`,
    }
  }
}

export type StoreApiKeyFn = (providerId: string, apiKey: string) => Promise<boolean>

export async function persistProviderApiKey(
  providerEntry: ProviderConfig,
  providerId: string,
  apiKey: string | undefined,
  storeApiKey: StoreApiKeyFn,
): Promise<void> {
  if (!apiKey) return

  let storedInAuthStore = false
  try {
    storedInAuthStore = await storeApiKey(providerId, apiKey)
  } catch {
    storedInAuthStore = false
  }
  if (!storedInAuthStore) {
    // Fail loudly: never fall back to storing the key in plain text.
    throw new Error(
      `Failed to persist API key for provider '${providerId}' in auth store`,
    )
  }
}

/** Persist the new key, then drop any legacy inline copy; throws if the store rejects the write. */
export async function rotateProviderApiKey(
  providerEntry: ProviderConfig,
  providerId: string,
  apiKey: string | undefined,
  storeApiKey: StoreApiKeyFn,
): Promise<void> {
  await persistProviderApiKey(providerEntry, providerId, apiKey, storeApiKey)
  if (providerEntry.options) delete providerEntry.options.apiKey
}


import { probeEndpoint, type ProbedModel } from "./probe.js"
import { probeDeveloperRole } from "./deep-probe.js"
import { diffModels, applyDecisions, type ModelChange, type TriDecision } from "./reconcile.js"
import {
  DEFAULT_FLAVOR,
  FLAVORS,
  collisionSuggestion,
  parseFlavor,
  type ProviderFlavor,
} from "./flavors.js"
import type { EnrichedModel } from "./enrich.js"

export function getProviderFlavor(provider: ProviderConfig): ProviderFlavor {
  const raw = provider.flavor
  return (typeof raw === "string" ? parseFlavor(raw) : null) ?? DEFAULT_FLAVOR
}

export interface ReprobeResult {
  changes: ModelChange[]
  fresh: ProbedModel[]
}

export async function reprobeProvider(
  providerId: string,
  provider: ProviderConfig,
): Promise<ReprobeResult> {
  const baseURL = provider.options?.baseURL
  if (!baseURL || !isValidUrl(baseURL)) {
    throw new Error(`Provider '${providerId}' has no valid baseURL to probe.`)
  }
  const apiKey = getApiKey(provider, providerId)
  const displayStyle: DisplayStyle = provider.displayStyle ?? "slug"
  const flavor = getProviderFlavor(provider)
  if (FLAVORS[flavor].listShape === "none") {
// Flavor has no list API.
    return { changes: [], fresh: [] }
  }
  const fresh = await probeEndpoint(baseURL, apiKey, flavor)
  const current = (provider.models ?? {}) as unknown as Record<string, EnrichedModel>
  return { changes: diffModels(current, fresh, displayStyle), fresh }
}

export function applyReconcile(
  provider: ProviderConfig,
  fresh: ProbedModel[],
  decisions: Record<string, TriDecision>,
): Record<string, EnrichedModel> {
  const displayStyle: DisplayStyle = provider.displayStyle ?? "slug"
  const current = (provider.models ?? {}) as unknown as Record<string, EnrichedModel>
  return applyDecisions(current, fresh, decisions, displayStyle)
}

export function renameProviderEntry(
  providers: Record<string, ProviderConfig>,
  oldId: string,
  newId: string,
): { error?: string; warning?: string } {
  const clean = newId.trim()
  const idError = validateProviderId(clean)
  if (idError) return { error: idError }
  const entry = providers[oldId]
  if (!entry) return { error: `Unknown provider '${oldId}'.` }
  if (clean !== oldId && providers[clean]) {
    return { error: `A provider with ID '${clean}' already exists.` }
  }
  delete providers[oldId]
  entry.name = clean
  providers[clean] = entry
  const suggestion = collisionSuggestion(clean)
  if (suggestion && suggestion !== clean) {
    return {
      warning: `'${clean}' matches a well-known built-in id and will merge with it. Consider '${suggestion}' for a fully separate provider.`,
    }
  }
  return {}
}

export function deleteProviderEntry(
  providers: Record<string, ProviderConfig>,
  providerId: string,
): string | null {
  if (!providers[providerId]) return `Unknown provider '${providerId}'.`
  delete providers[providerId]
  return null
}

export type ModelField = "name" | "context" | "output" | "reasoning" | "image"

function parseToggle(value: string): boolean | null {
  const v = value.trim().toLowerCase()
  if (["true", "1", "yes", "on"].includes(v)) return true
  if (["false", "0", "no", "off"].includes(v)) return false
  return null
}

/** Returns an error string or null. */
export function editModelField(
  models: Record<string, EnrichedModel>,
  modelId: string,
  field: ModelField,
  value: string,
): string | null {
  const model = models[modelId]
  if (!model) return `Unknown model '${modelId}'.`
  switch (field) {
    case "name": {
      const name = value.trim()
      if (!name) return "Name must not be empty."
      model.name = name
      return null
    }
    case "context":
    case "output": {
      // `limit` exists but its fields may be absent when unmeasured, so the
      // editor seeds the object rather than refusing to edit.
      model.limit ??= {}
      const n = Number(value)
      if (!Number.isInteger(n) || n <= 0) {
        return `'${field}' must be a positive integer (got '${value}').`
      }
      if (field === "context") model.limit.context = n
      else model.limit.output = n
      return null
    }
    case "reasoning": {
      const b = parseToggle(value)
      if (b === null) return `Use true/false for 'reasoning' (got '${value}').`
      if (b) model.reasoning = true
      else delete model.reasoning
      return null
    }
    case "image": {
      const b = parseToggle(value)
      if (b === null) return `Use true/false for 'image' (got '${value}').`
      model.modalities = b
        ? { input: ["text", "image"], output: ["text"] }
        : { input: ["text"], output: ["text"] }
      return null
    }
  }
}

export function getStoredModels(provider: ProviderConfig): Record<string, EnrichedModel> {
  return (provider.models ?? {}) as unknown as Record<string, EnrichedModel>
}

export function deleteModels(
  models: Record<string, EnrichedModel>,
  ids: string[],
): { deleted: string[]; missing: string[] } {
  const deleted: string[] = []
  const missing: string[] = []
  for (const raw of ids) {
    const id = raw.trim()
    if (!id) continue
    if (models[id]) {
      delete models[id]
      deleted.push(id)
    } else {
      missing.push(id)
    }
  }
  return { deleted, missing }
}

export async function migrateInlineKey(
  provider: ProviderConfig,
  providerId: string,
  storeApiKey: StoreApiKeyFn,
): Promise<{ migrated: boolean; note: string }> {
  const inline = provider.options?.apiKey
  if (!inline) return { migrated: false, note: "" }
  try {
    const ok = await storeApiKey(providerId, inline)
    if (!ok) {
      return { migrated: false, note: `Kept inline API key for '${providerId}' (auth store declined).` }
    }
  } catch {
    return { migrated: false, note: `Kept inline API key for '${providerId}' (auth store unavailable).` }
  }
  if (provider.options) delete provider.options.apiKey
  return { migrated: true, note: `Migrated inline API key for '${providerId}' to the auth store.` }
}
