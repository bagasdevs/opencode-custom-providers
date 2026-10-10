import { DEFAULT_FLAVOR, collisionSuggestion, parseFlavor, type ProviderFlavor } from "./flavors.js"
import { isValidUrl, sanitizeErrorMessage, sanitizeModelId } from "./security.js"
import { normalizeBaseUrl } from "./endpoint.js"
import {
  catalogToProbed,
  describeProbed,
  parseModelIds,
  previewManualModels,
  probeEndpoint,
  type ProbedModel,
} from "./probe.js"
import { getCatalog, listCatalogSites } from "./catalog.js"
import { mergeDiscoveredIntoStored, probedToDraft, type V2ModelDraft } from "./v2-models.js"
import { diffModels } from "./reconcile.js"
import type { DisplayStyle, EnrichedModel } from "./enrich.js"

import { id } from "./ids.js"
export { id }

const STORAGE_KEY = "providers"
// Providers the user removed. Persisted because a transform's settings are not durable:
// without this, the next replay re-derives the provider from the models still on its record.
const REMOVED_KEY = "removed"
const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible"
const DISCOVERED = "discovered"

type Draft = Record<string, unknown>

interface ProviderInfoDraft {
  id: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package?: string
  integrationID?: string
  settings?: Record<string, unknown>
}

interface ProviderRecord {
  provider: ProviderInfoDraft
  models: ReadonlyMap<string, Draft>
}

interface ProviderEditor {
  list(): readonly ProviderRecord[]
  get(providerID: string): ProviderRecord | undefined
  update(providerID: string, update: (provider: ProviderInfoDraft) => void): void
  models: {
    update(providerID: string, modelID: string, update: (model: Draft) => void): void
    remove(providerID: string, modelID: string): void
  }
}

interface IntegrationEditor {
  update(integrationID: string, update: (integration: { id: string; name: string }) => void): void
  method: {
    update(input: { integrationID: string; method: Record<string, unknown> }): void
  }
}

interface ToolEditor {
  namespace(namespace: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (input: unknown, context?: unknown) => Promise<{ content: string }>
  }): void
}

interface ConnectionInfo {
  readonly type: "credential" | "env"
  readonly id?: string
  readonly name?: string
}

export interface V2Context {
  provider: {
    transform(callback: (providers: ProviderEditor) => void | Promise<void>): Promise<unknown>
    reload(): Promise<void>
  }
  integration: {
    transform(callback: (integrations: IntegrationEditor) => void | Promise<void>): Promise<unknown>
    reload(): Promise<void>
    connect: { key(input: { integrationID: string; key: string }): Promise<void> }
    connection: {
      active(integrationID: string): Promise<ConnectionInfo | undefined>
      resolve(connection: ConnectionInfo): Promise<{ type: string; key?: string } | undefined>
    }
  }
  tool: { transform(callback: (tools: ToolEditor) => void | Promise<void>): Promise<unknown> }
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
  }
  rpc: {
    register(
      definition: Record<string, unknown>,
      handlers: Record<string, (input: unknown, context?: unknown) => Promise<unknown>>,
    ): Promise<unknown>
  }
}

interface ManagedProvider {
  baseURL: string
  flavor?: ProviderFlavor
  displayStyle?: DisplayStyle
}

interface Candidate {
  providerId: string
  baseURL: string
  apiKey?: string
  /** Probe with this key instead of the stored credential (validates a key before storing it). */
  overrideKey?: string
  flavor: ProviderFlavor
  displayStyle: DisplayStyle
}

export interface ProviderRow {
  id: string
  baseURL: string
  flavor: string
  displayStyle: string
  models: number
  pending: number
}

export interface SiteRow {
  id: string
  name: string
  modelCount: number
}

export type AddProviderResult =
  | { readonly status: "ok"; readonly message: string }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "unreachable"; readonly message: string; readonly detail?: string }
  | { readonly status: "manual_required"; readonly message: string }
  | { readonly status: "confirm_endpoint_reuse"; readonly usedBy: string[]; readonly message: string }

export type ManualAddResult =
  | { readonly status: "ok"; readonly message: string }
  | { readonly status: "invalid"; readonly message: string }

const RPC_ID = id

const EMPTY_INPUT = { type: "object", properties: {}, additionalProperties: false }
const MESSAGE_OUTPUT = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
}
const ADD_OUTPUT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "invalid", "unreachable", "manual_required", "confirm_endpoint_reuse"] },
    message: { type: "string" },
    detail: { type: "string" },
    usedBy: { type: "array", items: { type: "string" } },
  },
  required: ["status", "message"],
  additionalProperties: false,
}
const MANUAL_ADD_OUTPUT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ok", "invalid"] },
    message: { type: "string" },
  },
  required: ["status", "message"],
  additionalProperties: false,
}

function envKeyNames(providerId: string): string[] {
  return [`OPENCODE_LOCAL_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`]
}

function validId(providerId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(providerId)
}

function probeHint(error: unknown): string {
  const text = sanitizeErrorMessage(error)
  if (/\b(401|403)\b|revoked|unauthorized|invalid api key/i.test(text)) {
    return "The endpoint rejected the API key. Check that the key is correct and still active, then try again."
  }
  if (/\b404\b/.test(text)) {
    return "The endpoint answered 404 (not found). Check the base URL - for OpenAI-compatible APIs it usually ends with /v1."
  }
  if (/timed out|timeout|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(text)) {
    return "The endpoint could not be reached. Check the base URL and your internet connection."
  }
  return "Check the base URL and the API key, then try again."
}

function zeroModelsHint(hasKey: boolean): string {
  return hasKey
    ? "The endpoint listed no models. Check the base URL - it usually ends with /v1."
    : "The endpoint listed no models. Most gateways need an API key before they list models: add one and re-probe."
}

/** The stored draft as the diff helpers see it (only the fields they compare).
 * A record may hold a v2 draft (capabilities as id lists), a host model
 * (capabilities as capability flags) or a v1 entry (modalities), so read all three. */
function storedModelView(modelId: string, draft: Draft): EnrichedModel {
  const model: EnrichedModel = { name: typeof draft.name === "string" ? draft.name : modelId, limit: {} }
  const limit = draft.limit
  if (typeof limit === "object" && limit !== null) {
    const values = limit as Record<string, unknown>
    if (typeof values.context === "number") model.limit.context = values.context
    if (typeof values.input === "number") model.limit.input = values.input
    if (typeof values.output === "number") model.limit.output = values.output
  }
  const modalities = draft.modalities
  if (typeof modalities === "object" && modalities !== null) {
    const values = modalities as Record<string, unknown>
    const input = stringList(values.input)
    const output = stringList(values.output)
    if (input.length > 0 || output.length > 0) {
      model.modalities = { input: input.length > 0 ? input : ["text"], output: output.length > 0 ? output : ["text"] }
    }
  } else {
    const capabilities = draft.capabilities
    if (typeof capabilities === "object" && capabilities !== null) {
      const caps = capabilities as Record<string, unknown>
      const input = stringList(caps.input)
      const output = stringList(caps.output)
      if (input.length > 0 || output.length > 0) {
        model.modalities = { input: input.length > 0 ? input : ["text"], output: output.length > 0 ? output : ["text"] }
      }
    }
  }
  const capabilitiesForReasoning = draft.capabilities
  const capsReasoning =
    typeof capabilitiesForReasoning === "object" &&
    capabilitiesForReasoning !== null &&
    (capabilitiesForReasoning as Record<string, unknown>).reasoning === true
  if (draft.reasoning === true || capsReasoning || (Array.isArray(draft.variants) && draft.variants.length > 0)) {
    model.reasoning = true
  }
  return model
}

/** Id lists stay as written; a capability-flag map keeps the flags that are on. */
function stringList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((value): value is string => typeof value === "string")
  if (typeof raw === "object" && raw !== null) {
    return Object.entries(raw as Record<string, unknown>).filter(([, on]) => on === true).map(([name]) => name)
  }
  return []
}

function candidateFrom(record: ProviderRecord, managed: ManagedProvider | undefined): Candidate | undefined {
  const provider = record.provider
  const settings = provider.settings ?? {}
  const baseURL =
    typeof settings.baseURL === "string" ? settings.baseURL : managed?.baseURL
  if (!baseURL || !isValidUrl(baseURL)) return undefined
  // "dynamic: false" is the marker remove() writes, so a removed provider stays removed.
  if (!managed && settings.dynamic === false) return undefined
  if (!managed && settings.dynamic !== true) {
    const stored = [...record.models.values()].filter(model => model[DISCOVERED] !== true && model.enabled !== false)
    if (stored.length > 0) return undefined
  }
  const flavor =
    parseFlavor(typeof settings.flavor === "string" ? settings.flavor : undefined) ??
    managed?.flavor ??
    DEFAULT_FLAVOR
  const displayStyle =
    settings.displayStyle === "name" || managed?.displayStyle === "name" ? "name" : "slug"
  return {
    providerId: provider.id,
    baseURL,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey : undefined,
    flavor,
    displayStyle,
  }
}

function parseManaged(raw: unknown): Map<string, ManagedProvider> {
  const result = new Map<string, ManagedProvider>()
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return result
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.baseURL !== "string" || !isValidUrl(entry.baseURL)) continue
    result.set(providerId, {
      baseURL: entry.baseURL,
      flavor: parseFlavor(typeof entry.flavor === "string" ? entry.flavor : undefined) ?? undefined,
      displayStyle: entry.displayStyle === "name" ? "name" : "slug",
    })
  }
  return result
}

export const setup = async (ctx: V2Context): Promise<void> => {
  const managed = parseManaged(await ctx.storage.get(STORAGE_KEY).catch(() => undefined))
  const removed = new Set<string>(await ctx.storage.get(REMOVED_KEY).catch(() => undefined) as string[] | undefined ?? [])
  const candidates = new Map<string, Candidate>()
  const discovered = new Map<string, Map<string, V2ModelDraft>>()
  const storedIds = new Map<string, Set<string>>()
  const storedModels = new Map<string, Map<string, EnrichedModel>>()

  const modelsFor = (providerId: string) => {
    let models = discovered.get(providerId)
    if (!models) {
      models = new Map()
      discovered.set(providerId, models)
    }
    return models
  }

  // A re-added provider must be able to come back, so its removal marker has to go.
  const clearRemoval = async (providerId: string) => {
    if (!removed.delete(providerId)) return
    await ctx.storage.set(REMOVED_KEY, [...removed])
  }

  const persist = async () => {
    await ctx.storage.set(STORAGE_KEY, Object.fromEntries(managed))
  }

  // Transforms replay on every reload: keep them pure (no I/O).
  await ctx.provider.transform((providers) => {
    const found = new Map<string, Candidate>()
    for (const record of providers.list()) {
      if (removed.has(record.provider.id)) continue
      const candidate = candidateFrom(record, managed.get(record.provider.id))
      if (candidate) found.set(candidate.providerId, candidate)
    }
    for (const [providerId, entry] of managed) {
      if (found.has(providerId) || removed.has(providerId)) continue
      const candidate = candidateFrom(
        { provider: { id: providerId, name: providerId, activation: "enabled" }, models: new Map() },
        entry,
      )
      if (candidate) found.set(providerId, candidate)
    }
    // A skipped record is not a deleted record: opencode keeps its own provider row, and the
    // transform can only disable it. Without this, a removed provider returns on the next load.
    for (const providerId of removed) {
      providers.update(providerId, (provider) => {
        provider.activation = "disabled"
      })
    }
    for (const candidate of found.values()) {
      providers.update(candidate.providerId, (provider) => {
        provider.activation = "enabled"
        // The host creates providers with package: "", so a nullish check is not enough:
        // without a real package the models never reach the model list.
        if (!provider.package) provider.package = OPENAI_COMPATIBLE
        provider.settings = { ...(provider.settings ?? {}), baseURL: candidate.baseURL }
        provider.integrationID = undefined
      })
    }
    for (const [providerId, models] of discovered) {
      for (const [modelId, draft] of models) {
        providers.models.update(providerId, modelId, (model) => {
          mergeDiscoveredIntoStored(model, draft)
          model[DISCOVERED] = true
        })
      }
    }
    candidates.clear()
    for (const [providerId, candidate] of found) candidates.set(providerId, candidate)
    storedIds.clear()
    storedModels.clear()
    for (const record of providers.list()) {
      if (!found.has(record.provider.id)) continue
      storedIds.set(record.provider.id, new Set([...record.models.keys()]))
      storedModels.set(record.provider.id, new Map([...record.models].map(([modelId, draft]) => [modelId, storedModelView(modelId, draft)])))
    }
    for (const providerId of [...discovered.keys()]) {
      if (!found.has(providerId)) discovered.delete(providerId)
    }
  })

  await ctx.integration.transform((integrations) => {
    for (const providerId of candidates.keys()) {
      integrations.update(providerId, (integration) => {
        integration.name = integration.name || providerId
      })
      integrations.method.update({
        integrationID: providerId,
        method: { type: "key", label: "Manually enter API Key" },
      })
      integrations.method.update({
        integrationID: providerId,
        method: { type: "env", names: envKeyNames(providerId) },
      })
    }
  })

  const credentialKey = async (providerId: string): Promise<string | undefined> => {
    try {
      const connection = await ctx.integration.connection.active(providerId)
      if (!connection) return undefined
      const credential = await ctx.integration.connection.resolve(connection)
      return credential?.type === "key" ? credential.key : undefined
    } catch {
      return undefined
    }
  }

  const discover = async (candidate: Candidate): Promise<ProbedModel[]> => {
    // overrideKey lets a caller validate a proposed key before it is stored; without it the
    // stored credential wins, so a rejected key would be persisted and then probed as the old one.
    const apiKey = candidate.overrideKey ?? (await credentialKey(candidate.providerId)) ?? candidate.apiKey
    const fresh = await probeEndpoint(candidate.baseURL, apiKey, candidate.flavor)
    return fresh.map(item => ({ ...item, id: sanitizeModelId(item.id) }))
  }

  const registerIntegration = async (providerId: string) => {
    await ctx.integration.transform((integrations) => {
      integrations.update(providerId, (integration) => {
        integration.name = integration.name || providerId
      })
      integrations.method.update({
        integrationID: providerId,
        method: { type: "key", label: "Manually enter API Key" },
      })
      integrations.method.update({
        integrationID: providerId,
        method: { type: "env", names: envKeyNames(providerId) },
      })
    })
    await ctx.integration.reload()
  }

  const applyModels = async (providerId: string, fresh: ProbedModel[], displayStyle: DisplayStyle) => {
    const models = modelsFor(providerId)
    for (const probed of fresh) models.set(probed.id, probedToDraft(probed, displayStyle))
    await ctx.provider.reload()
  }

  interface RefreshOutcome {
    checked: number
    updated: string[]
    unchanged: string[]
    empty: string[]
    failed: string[]
  }

  const refresh = async (only?: string): Promise<RefreshOutcome> => {
    const outcome: RefreshOutcome = { checked: 0, updated: [], unchanged: [], empty: [], failed: [] }
    let changed = false
    for (const candidate of [...candidates.values()]) {
      if (only !== undefined && candidate.providerId !== only) continue
      outcome.checked++
      let fresh: ProbedModel[]
      try {
        fresh = await discover(candidate)
      } catch {
        outcome.failed.push(candidate.providerId)
        continue
      }
      lastProbe.set(candidate.providerId, fresh.length)
      lastProbeModels.set(candidate.providerId, fresh)
      if (fresh.length === 0) {
        outcome.empty.push(candidate.providerId)
        continue
      }
      const models = modelsFor(candidate.providerId)
      // Compare content, not just the count: a model can change limits or price without changing the total.
      const before = fingerprint(models)
      for (const probed of fresh) models.set(probed.id, probedToDraft(probed, candidate.displayStyle))
      if (fingerprint(models) === before) outcome.unchanged.push(candidate.providerId)
      else outcome.updated.push(candidate.providerId)
      changed = true
    }
    if (changed) await ctx.provider.reload()
    return outcome
  }

  const fingerprint = (models: Map<string, unknown>): string => {
    const parts: string[] = []
    for (const [key, value] of [...models.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      parts.push(key + ":" + JSON.stringify(value))
    }
    return parts.join("|")
  }

  // Raw probe output per provider, so a cosmetic edit (name style) needs no network round trip.
  const lastProbeModels = new Map<string, ProbedModel[]>()

  // Models the endpoint offered on the last probe that are not in the provider yet.
  // Populated by reprobe/refresh only, so it stays accurate without extra traffic.
  const lastProbe = new Map<string, number>()

  const pendingCount = (providerId: string): number => {
    const probed = lastProbe.get(providerId)
    if (probed === undefined) return 0
    return Math.max(0, probed - (discovered.get(providerId)?.size ?? 0))
  }

  const ops = {
    list: async (): Promise<{ providers: ProviderRow[] }> => {
      await ctx.provider.reload()
      const providers: ProviderRow[] = []
      for (const [providerId, candidate] of candidates) {
        providers.push({
          id: providerId,
          baseURL: candidate.baseURL,
          flavor: candidate.flavor,
          displayStyle: candidate.displayStyle,
          models: discovered.get(providerId)?.size ?? 0,
          pending: pendingCount(providerId),
        })
      }
      providers.sort((a, b) => a.id.localeCompare(b.id))
      return { providers }
    },

    add: async (input: {
      providerId: string
      baseURL: string
      apiKey?: string
      flavor?: string
      displayStyle?: DisplayStyle
      overwrite?: boolean
      confirmReuse?: boolean
    }): Promise<AddProviderResult> => {
      if (!validId(input.providerId)) {
        return { status: "invalid", message: "The provider name may only contain letters, numbers, hyphens and underscores. Example: my-proxy" }
      }
      // Repair a bare host or a pasted endpoint path before validating, so the wizard and the
      // RPC accept exactly the same strings.
      input.baseURL = normalizeBaseUrl(input.baseURL)
      if (!isValidUrl(input.baseURL)) {
        return { status: "invalid", message: "That does not look like a web address. Enter the full base URL, including https://. Example: https://api.example.com/v1" }
      }
      // Every other entry point guards this; without it, adding "openai" would overwrite the
      // built-in provider's settings and point its models at this custom address.
      const clash = collisionSuggestion(input.providerId)
      if (clash && !input.overwrite) {
        return {
          status: "invalid",
          message:
            `'${input.providerId}' is the name of a provider opencode already has, so adding it would change that provider.\n` +
            `Use '${clash}' instead, or add the same provider again with overwrite=true if you really mean to replace it.`,
        }
      }
      // The same address under two names duplicates every model in the picker.
      const reused = [...managed.entries()].filter(
        ([id, entry]) => id !== input.providerId && entry.baseURL.replace(/\/+$/, "") === normalizeBaseUrl(input.baseURL),
      )
      if (reused.length > 0 && !input.confirmReuse) {
        const usedBy = reused.map(([id]) => id)
        return {
          status: "confirm_endpoint_reuse",
          usedBy,
          message: `This address is already used by: ${usedBy.join(", ")}. Adding another provider on the same address means every model will appear twice in the picker.`,
        }
      }
      const candidate: Candidate = {
        providerId: input.providerId,
        baseURL: input.baseURL,
        apiKey: input.apiKey,
        overrideKey: input.apiKey,
        flavor: parseFlavor(input.flavor) ?? DEFAULT_FLAVOR,
        displayStyle: input.displayStyle === "name" ? "name" : "slug",
      }
      let fresh: ProbedModel[]
      try {
        fresh = await discover(candidate)
      } catch (error) {
        return {
          status: "unreachable",
          message: `Nothing was saved: the address ${candidate.baseURL} did not answer with a model list.\n${probeHint(error)}`,
          detail: sanitizeErrorMessage(error),
        }
      }
      if (fresh.length === 0) {
        return {
          status: "manual_required",
          message: `The address ${candidate.baseURL} answered but listed no models. Nothing was saved; you can enter model names manually.`,
        }
      }
      await clearRemoval(candidate.providerId)
      managed.set(candidate.providerId, {
        baseURL: candidate.baseURL,
        flavor: candidate.flavor,
        displayStyle: candidate.displayStyle,
      })
      await persist()
      await registerIntegration(candidate.providerId)
      await applyModels(candidate.providerId, fresh, candidate.displayStyle)
      const lines = [
        `Done. '${candidate.providerId}' is ready with ${fresh.length} model${fresh.length === 1 ? "" : "s"}. Open the model picker and choose one to start using it.`,
        `First model: ${fresh[0].id}`,
        `Details: ${describeProbed(fresh[0])}`,
      ]
      if (input.apiKey) {
        try {
          await ctx.integration.connect.key({ integrationID: candidate.providerId, key: input.apiKey })
          lines.push("The API key was saved securely. You will not need to type it again.")
        } catch (error) {
          lines.push(
            `The API key could NOT be saved, so this provider cannot sign in yet.\nRun /edit-provider and choose "API key" to add one before using it.\n\nTechnical detail: ${sanitizeErrorMessage(error)}`,
          )
        }
      } else {
        lines.push(
          "No API key was given, so this provider may not be able to sign in. " +
            "If it needs one, run /edit-provider and choose \"API key\" — nothing else has to be redone.",
        )
      }
      // Without a key the provider is stored but unusable, so the first line must not read as
      // an unqualified success: that is what makes a half-finished setup look complete.
      if (!input.apiKey) {
        lines[0] = `Saved '${candidate.providerId}' with ${fresh.length} model${fresh.length === 1 ? "" : "s"}, but it has no API key yet so it cannot sign in.`
      }
      return { status: "ok", message: lines.join("\n") }
    },

    manualAdd: async (input: {
      providerId: string
      baseURL: string
      modelIds: string
      apiKey?: string
      flavor?: string
      displayStyle?: DisplayStyle
      overwrite?: boolean
    }): Promise<ManualAddResult> => {
      if (!validId(input.providerId)) {
        return { status: "invalid", message: "Use a provider name with letters, numbers, hyphens, or underscores." }
      }
      input.baseURL = normalizeBaseUrl(input.baseURL)
      if (!isValidUrl(input.baseURL)) {
        return { status: "invalid", message: "Enter a complete address starting with https:// (or http:// for a local server)." }
      }
      const clash = collisionSuggestion(input.providerId)
      if (clash && !input.overwrite) {
        return {
          status: "invalid",
          message: `'${input.providerId}' is a built-in provider name. Use '${clash}' instead.`,
        }
      }
      const modelIds = parseModelIds(input.modelIds)
      if (!modelIds?.length) {
        return { status: "invalid", message: "Enter at least one model id, separated by commas." }
      }
      const flavor = input.flavor === undefined ? DEFAULT_FLAVOR : parseFlavor(input.flavor)
      if (!flavor) {
        return { status: "invalid", message: `'${input.flavor}' is not a known API type. Pick one from the list.` }
      }
      const displayStyle: DisplayStyle = input.displayStyle === "name" ? "name" : "slug"
      const previews = await previewManualModels(modelIds, flavor, displayStyle)
      if (previews.length === 0) {
        return { status: "invalid", message: "No usable model ids were entered. Add at least one model id and try again." }
      }
      const unique = [...new Map(previews.map(preview => [preview.id, preview.probed])).values()]
      const candidate: Candidate = {
        providerId: input.providerId,
        baseURL: input.baseURL,
        apiKey: input.apiKey,
        overrideKey: input.apiKey,
        flavor,
        displayStyle,
      }
      await clearRemoval(candidate.providerId)
      managed.set(candidate.providerId, {
        baseURL: candidate.baseURL,
        flavor: candidate.flavor,
        displayStyle: candidate.displayStyle,
      })
      await persist()
      await registerIntegration(candidate.providerId)
      await applyModels(candidate.providerId, unique, displayStyle)
      let keyMessage = ""
      if (input.apiKey) {
        try {
          await ctx.integration.connect.key({ integrationID: candidate.providerId, key: input.apiKey })
          keyMessage = " The API key was saved securely."
        } catch (error) {
          keyMessage =
            ` The API key could NOT be saved, so this provider cannot sign in yet. ` +
            `Run /edit-provider and choose "API key" to add one before using it. ` +
            `Technical detail: ${sanitizeErrorMessage(error)}`
        }
      } else {
        keyMessage = " No API key was given; add one later if this provider requires it."
      }
      return {
        status: "ok",
        message: `Added ${unique.length} model${unique.length === 1 ? "" : "s"} to '${candidate.providerId}'.${keyMessage}`,
      }
    },

    edit: async (input: {
      providerId: string
      baseURL?: string
      flavor?: string
      displayStyle?: DisplayStyle
      apiKey?: string
    }): Promise<{ message: string }> => {
      const current = managed.get(input.providerId)
      if (!current && !candidates.has(input.providerId)) {
        return { message: `There is no provider named '${input.providerId}'. Run /list-custom-providers to see your providers.` }
      }
      if (input.baseURL !== undefined) input.baseURL = normalizeBaseUrl(input.baseURL)
      if (input.baseURL !== undefined && !isValidUrl(input.baseURL)) {
        return { message: "That does not look like a web address. Enter the full base URL, including https://. Example: https://api.example.com/v1" }
      }
      const flavor = input.flavor === undefined ? current?.flavor : (parseFlavor(input.flavor) ?? undefined)
      if (input.flavor !== undefined && !flavor) {
        return { message: `'${input.flavor}' is not a known API type. Pick one from the list.` }
      }
      const previousURL = current?.baseURL ?? candidates.get(input.providerId)?.baseURL ?? ""
      const next: ManagedProvider = {
        baseURL: input.baseURL ?? current?.baseURL ?? candidates.get(input.providerId)?.baseURL ?? "",
        flavor,
        displayStyle: input.displayStyle ?? current?.displayStyle ?? "slug",
      }
      managed.set(input.providerId, next)
      await persist()
      let keyWarning: string | undefined
      if (input.apiKey) {
        try {
          await ctx.integration.connect.key({ integrationID: input.providerId, key: input.apiKey })
        } catch (error) {
          keyWarning = `The new API key could NOT be saved, so the old one is still in use.\nRun /edit-provider and choose "API key" to try again.\n\nTechnical detail: ${sanitizeErrorMessage(error)}`
        }
      }
      // Only re-probe when a value actually differs, so a no-op edit cannot fail on the network.
      const endpointChanged =
        (input.baseURL !== undefined && input.baseURL !== previousURL) ||
        (input.flavor !== undefined && input.flavor !== current?.flavor)
      if (endpointChanged) {
        const candidate: Candidate = {
          providerId: input.providerId,
          baseURL: next.baseURL,
          flavor: next.flavor ?? DEFAULT_FLAVOR,
          displayStyle: next.displayStyle ?? "slug",
        }
        try {
          const fresh = await discover(candidate)
          await applyModels(input.providerId, fresh, candidate.displayStyle)
        } catch (error) {
          await ctx.provider.reload()
          return {
            message:
              `Saved. '${input.providerId}' now uses the new address, but it did not answer with a model list yet.\n${probeHint(error)}\n` +
              `The address used before was: ${previousURL || "(none)"}. Run /edit-provider and paste it back if the provider stops working.\n\n` +
              `Technical detail: ${sanitizeErrorMessage(error)}`,
          }
        }
      } else if (input.displayStyle !== undefined) {
        // Names come from the probe data, so re-derive them from the cached probe when possible
        // instead of hitting the network for a cosmetic change.
        const raw = lastProbeModels.get(input.providerId)
        if (raw) {
          await applyModels(input.providerId, raw, next.displayStyle ?? "slug")
        } else {
          const candidate: Candidate = {
            providerId: input.providerId,
            baseURL: next.baseURL,
            flavor: next.flavor ?? DEFAULT_FLAVOR,
            displayStyle: next.displayStyle ?? "slug",
          }
          try {
            await applyModels(input.providerId, await discover(candidate), candidate.displayStyle)
          } catch (error) {
            return { message: `Saved the new name style, but the provider could not be re-read to apply it.\n${probeHint(error)}\n\nTechnical detail: ${sanitizeErrorMessage(error)}` }
          }
        }
        await ctx.provider.reload()
      } else {
        await ctx.provider.reload()
      }
      const changed: string[] = []
      if (input.baseURL !== undefined) changed.push("a new address")
      if (input.flavor !== undefined) changed.push("a new API type")
      if (input.displayStyle !== undefined) changed.push("a new model name style")
      if (input.apiKey) changed.push("a new API key (stored securely, used the next time you chat)")
      if (keyWarning) return { message: keyWarning }
      return {
        message:
          changed.length > 0
            ? `Saved. '${input.providerId}' now has ${changed.join(", ")}.`
            : `Saved. '${input.providerId}' is unchanged.`,
      }
    },

    remove: async (providerId: string): Promise<{ message: string }> => {
      const wasManaged = managed.delete(providerId)
      if (!wasManaged && !candidates.has(providerId)) {
        return { message: `There is no provider named '${providerId}'. Run /list-custom-providers to see your providers.` }
      }
      if (!wasManaged) {
        // Derived from a host config record, so this plugin has nothing of its own to remove.
        return {
          message:
            `'${providerId}' comes from your opencode config, not from this plugin, so it was left alone.\n` +
            `Remove its entry from your opencode config to stop using it, or use /edit-provider to point it elsewhere.`,
        }
      }
      removed.add(providerId)
      await ctx.storage.set(REMOVED_KEY, [...removed])
      await persist()
      storedIds.delete(providerId)
      lastProbe.delete(providerId)
      lastProbeModels.delete(providerId)
      candidates.delete(providerId)
      // Drop the model entries too: deleting only the managed entry left every discovered
      // model attached to the live provider, so they survived remove and a later re-add.
      // The live record is read inside the transform, before the in-memory map is cleared.
      // discovered still holds the model ids at this point; the transform's record may not.
      const staleModels = [...(discovered.get(providerId)?.keys() ?? [])]
      await ctx.provider.transform((providers) => {
        providers.update(providerId, (provider) => {
          provider.settings = { ...(provider.settings ?? {}), dynamic: false }
        })
        for (const modelId of staleModels) providers.models.remove(providerId, modelId)
      })
      discovered.delete(providerId)
      await ctx.provider.reload()
      return {
        message:
          `Removed '${providerId}' and its ${staleModels.length} model${staleModels.length === 1 ? "" : "s"}. ` +
          `Your other opencode settings are not touched. You can add it again later with /add-provider.`,
      }
    },

    reprobe: async (providerId: string): Promise<{ message: string }> => {
      const candidate = candidates.get(providerId)
      if (!candidate) return { message: `There is no provider named '${providerId}'. Run /list-custom-providers to see your providers.` }
      let fresh: ProbedModel[]
      try {
        fresh = await discover(candidate)
      } catch (error) {
        return { message: `Nothing was saved: the address ${candidate.baseURL} did not answer with a model list.\n${probeHint(error)}\n\nTechnical detail: ${sanitizeErrorMessage(error)}` }
      }
      lastProbe.set(providerId, fresh.length)
      lastProbeModels.set(providerId, fresh)
      const stored = [...(storedIds.get(providerId) ?? [])]
      if (fresh.length === 0) {
        return { message: `The provider listed no models.\n${zeroModelsHint(Boolean(await credentialKey(providerId) ?? candidate.apiKey))}\n\nStored models were kept, so nothing broke.` }
      }
      // Field-level diff, so a metadata change upstream is not reported as "up to date".
      const current = Object.fromEntries(storedModels.get(providerId) ?? new Map<string, EnrichedModel>())
      const changes = diffModels(current, fresh, candidate.displayStyle)
      const added = changes.filter(change => change.kind === "added")
      const updated = changes.filter(change => change.kind === "updated")
      const vanished = changes.filter(change => change.kind === "removed")
      const lines = [
        changes.length === 0
          ? `Up to date: the provider still lists the same ${fresh.length} model${fresh.length === 1 ? "" : "s"}. Nothing to do.`
          : `Found ${fresh.length} model${fresh.length === 1 ? "" : "s"} at the provider (you had ${stored.length}).`,
      ]
      const PREVIEW = 5
      for (const change of added.slice(0, PREVIEW)) lines.push(`  + new: ${change.id}`)
      if (added.length > PREVIEW) lines.push(`  + ...and ${added.length - PREVIEW} more new model(s)`)
      for (const change of updated.slice(0, PREVIEW)) lines.push(`  ~ ${change.detail}`)
      if (updated.length > PREVIEW) lines.push(`  ~ ...and ${updated.length - PREVIEW} more changed model(s)`)
      for (const change of vanished.slice(0, PREVIEW)) lines.push(`  - no longer offered: ${change.id}`)
      if (vanished.length > PREVIEW) lines.push(`  - ...and ${vanished.length - PREVIEW} more removed`)
      if (changes.length > 0) {
        lines.push('')
        lines.push('Nothing has changed yet. Run "Reload all models" to apply everything, or "Review model changes" to choose.')
      }
      return { message: lines.join("\n") }
    },

    apply: async (input: { providerId: string; decisions?: string; mode?: string }): Promise<{ message: string }> => {
      const candidate = candidates.get(input.providerId)
      if (!candidate) return { message: `There is no provider named '${input.providerId}'. Run /list-custom-providers to see your providers.` }
      // "keep" mode is the non-destructive escape hatch: it never rewrites stored
      // models, so the caller does not have to express "do nothing" through the
      // per-model decision map (where an absent key means apply).
      const keepOnly = input.mode === "keep"
      const decisions: Record<string, "apply" | "keep" | "remove"> = {}
      if (input.decisions !== undefined && input.decisions !== "") {
        let parsed: unknown
        try {
          parsed = JSON.parse(input.decisions)
        } catch {
          return { message: "That is not valid JSON. Use the shape shown in the box, for example {\"model-id\": \"apply\"}." }
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { message: "That is not valid JSON. Use the shape shown in the box, for example {\"model-id\": \"apply\"}." }
        }
        for (const [modelId, decision] of Object.entries(parsed as Record<string, unknown>)) {
          if (decision !== "apply" && decision !== "keep" && decision !== "remove") {
            return { message: `'${modelId}' has an unknown choice. Use "apply" (take the new values), "keep" (leave it alone), or "remove".` }
          }
          decisions[modelId] = decision
        }
      }
      let fresh: ProbedModel[]
      try {
        fresh = await discover(candidate)
      } catch (error) {
        return { message: `Nothing was saved: the address ${candidate.baseURL} did not answer with a model list.\n${probeHint(error)}\n\nTechnical detail: ${sanitizeErrorMessage(error)}` }
      }
      if (keepOnly) {
        return { message: `Kept your ${storedIds.get(input.providerId)?.size ?? 0} stored model(s) for '${input.providerId}'. Nothing was changed.` }
      }
      const models = modelsFor(input.providerId)
      // The live map is authoritative here; storedIds only fills in after a transform replay.
      const stored = new Set(models.keys())
      const freshIds = new Set(fresh.map(item => item.id))
      let removed = 0
      for (const probed of fresh) {
        // Absent means "keep" for a model the user already tuned; only new models default to apply.
        const decision = decisions[probed.id] ?? (stored.has(probed.id) ? "keep" : "apply")
        if (decision === "remove") {
          models.delete(probed.id)
          removed++
          continue
        }
        if (decision === "keep" && stored.has(probed.id)) continue
        models.set(probed.id, probedToDraft(probed, candidate.displayStyle))
      }
      for (const modelId of stored) {
        if (freshIds.has(modelId)) continue
        if ((decisions[modelId] ?? "keep") === "keep") continue
        models.delete(modelId)
        removed++
      }
      await ctx.provider.reload()
      const total = [...models.values()].length
      return {
        message:
          `Done. '${input.providerId}' now has ${total} model${total === 1 ? "" : "s"} from the provider` +
          (removed > 0 ? `, and ${removed} old one(s) were removed.` : ".") +
          "\nOpen the model picker and choose one to start using it.",
      }
    },

    refresh: async (): Promise<{ message: string }> => {
      await ctx.provider.reload()
      const outcome = await refresh()
      const lines: string[] = [`Checked ${outcome.checked} provider(s).`]
      if (outcome.updated.length > 0) lines.push(`Updated: ${outcome.updated.join(", ")}.`)
      if (outcome.unchanged.length > 0) lines.push(`Already up to date: ${outcome.unchanged.join(", ")}.`)
      if (outcome.empty.length > 0) {
        lines.push(`Answered but listed no models: ${outcome.empty.join(", ")}.`)
      }
      if (outcome.failed.length > 0) {
        lines.push(
          `Could not reach: ${outcome.failed.join(", ")}. Their saved models were kept.\n` +
            "Fix with /edit-provider (check the address and the API key), then run /reload-models again.",
        )
      }
      if (outcome.updated.length === 0 && outcome.failed.length === 0 && outcome.empty.length === 0) {
        lines.push("Nothing to change — every provider already lists the same models.")
      }
      return { message: lines.join("\n") }
    },

    catalogList: async (): Promise<{ sites: SiteRow[] }> => ({ sites: await listCatalogSites() }),

    catalogAdd: async (input: {
      site: string
      providerId: string
      models?: string
      apiKey?: string
      displayStyle?: DisplayStyle
    }): Promise<{ message: string }> => {
      if (!validId(input.providerId)) {
        return { message: "The provider name may only contain letters, numbers, hyphens and underscores. Example: my-proxy" }
      }
      const catalog = await getCatalog()
      const site = catalog[input.site]
      if (!site) return { message: `'${input.site}' is not in the catalog list. Pick one from the list.` }
      const wanted = input.models
        ? input.models.split(",").map(value => value.trim()).filter(Boolean)
        : Object.keys(site.models)
      const missing = wanted.filter(modelId => !site.models[modelId])
      const chosen = wanted.filter(modelId => site.models[modelId])
      if (chosen.length === 0) return { message: "None of the ids you typed exist in that catalog site. Leave the field empty to add every model." }
      if (!site.api || !isValidUrl(site.api)) {
        return { message: `The catalog entry for '${input.site}' has no usable web address, so it cannot be added. Pick another site.` }
      }
      const displayStyle: DisplayStyle = input.displayStyle === "name" ? "name" : "slug"
      await clearRemoval(input.providerId)
      managed.set(input.providerId, { baseURL: site.api, flavor: DEFAULT_FLAVOR, displayStyle })
      await persist()
      await registerIntegration(input.providerId)
      await applyModels(
        input.providerId,
        chosen.map(modelId => catalogToProbed(site.models[modelId])),
        displayStyle,
      )
      const lines = [`Done. '${input.providerId}' is ready with ${chosen.length} model${chosen.length === 1 ? "" : "s"} from '${input.site}'.`]
      if (missing.length > 0) lines.push(`Skipped (not in this catalog site): ${missing.join(", ")}.`)
      if (input.apiKey) {
        try {
          await ctx.integration.connect.key({ integrationID: input.providerId, key: input.apiKey })
          lines.push("The API key was saved securely. You will not need to type it again.")
        } catch (error) {
          lines.push(`The API key could NOT be saved, so this provider cannot sign in yet.\nRun /edit-provider and choose "API key" to add one before using it.\n\nTechnical detail: ${sanitizeErrorMessage(error)}`)
        }
      }
      return { message: lines.join("\n") }
    },
  }

  await ctx.rpc.register(
    {
      id: RPC_ID,
      methods: {
        list: {
          input: EMPTY_INPUT,
          output: {
            type: "object",
            properties: {
              providers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    baseURL: { type: "string" },
                    flavor: { type: "string" },
                    displayStyle: { type: "string" },
                    models: { type: "number" },
                    pending: { type: "number" },
                  },
                  required: ["id", "baseURL", "flavor", "displayStyle", "models", "pending"],
                  additionalProperties: false,
                },
              },
            },
            required: ["providers"],
            additionalProperties: false,
          },
        },
        add: {
          input: {
            type: "object",
            properties: {
              providerId: { type: "string" },
              baseURL: { type: "string" },
              apiKey: { type: "string" },
              flavor: { type: "string" },
              displayStyle: { type: "string", enum: ["slug", "name"] },
              overwrite: { type: "boolean" },
              confirmReuse: { type: "boolean" },
            },
            required: ["providerId", "baseURL"],
            additionalProperties: false,
          },
          output: ADD_OUTPUT,
        },
        manualAdd: {
          input: {
            type: "object",
            properties: {
              providerId: { type: "string" },
              baseURL: { type: "string" },
              modelIds: { type: "string" },
              apiKey: { type: "string" },
              flavor: { type: "string" },
              displayStyle: { type: "string", enum: ["slug", "name"] },
              overwrite: { type: "boolean" },
            },
            required: ["providerId", "baseURL", "modelIds"],
            additionalProperties: false,
          },
          output: MANUAL_ADD_OUTPUT,
        },
        edit: {
          input: {
            type: "object",
            properties: {
              providerId: { type: "string" },
              baseURL: { type: "string" },
              flavor: { type: "string" },
              displayStyle: { type: "string", enum: ["slug", "name"] },
              apiKey: { type: "string" },
            },
            required: ["providerId"],
            additionalProperties: false,
          },
          output: MESSAGE_OUTPUT,
        },
        remove: {
          input: {
            type: "object",
            properties: { providerId: { type: "string" } },
            required: ["providerId"],
            additionalProperties: false,
          },
          output: MESSAGE_OUTPUT,
        },
        reprobe: {
          input: {
            type: "object",
            properties: { providerId: { type: "string" } },
            required: ["providerId"],
            additionalProperties: false,
          },
          output: MESSAGE_OUTPUT,
        },
        apply: {
          input: {
            type: "object",
            properties: {
              providerId: { type: "string" },
              decisions: { type: "string" },
              mode: { type: "string", enum: ["apply", "keep"] },
            },
            required: ["providerId"],
            additionalProperties: false,
          },
          output: MESSAGE_OUTPUT,
        },
        refresh: { input: EMPTY_INPUT, output: MESSAGE_OUTPUT },
        "catalog.list": {
          input: EMPTY_INPUT,
          output: {
            type: "object",
            properties: {
              sites: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    modelCount: { type: "number" },
                  },
                  required: ["id", "name", "modelCount"],
                  additionalProperties: false,
                },
              },
            },
            required: ["sites"],
            additionalProperties: false,
          },
        },
        "catalog.add": {
          input: {
            type: "object",
            properties: {
              site: { type: "string" },
              providerId: { type: "string" },
              models: { type: "string" },
              apiKey: { type: "string" },
              displayStyle: { type: "string", enum: ["slug", "name"] },
            },
            required: ["site", "providerId"],
            additionalProperties: false,
          },
          output: MESSAGE_OUTPUT,
        },
      },
      events: {},
    },
    {
      list: () => ops.list(),
      add: input => ops.add(input as Parameters<typeof ops.add>[0]),
      manualAdd: input => ops.manualAdd(input as Parameters<typeof ops.manualAdd>[0]),
      edit: input => ops.edit(input as Parameters<typeof ops.edit>[0]),
      remove: input => ops.remove((input as { providerId: string }).providerId),
      reprobe: input => ops.reprobe((input as { providerId: string }).providerId),
      apply: input => ops.apply(input as { providerId: string; decisions: string }),
      refresh: () => ops.refresh(),
      "catalog.list": () => ops.catalogList(),
      "catalog.add": input => ops.catalogAdd(input as Parameters<typeof ops.catalogAdd>[0]),
    },
  )

  await ctx.tool.transform((tools) => {
    tools.namespace({
      name: "custom-providers",
      description: "Add and manage your own AI providers (custom API addresses).",
    })

    tools.add({
      name: "refresh-models",
      description:
        "Re-discover models from every dynamic provider and update the live catalog. " +
        "Fetches /models from each provider with a baseURL and enriches it with models.dev metadata.",
      input: EMPTY_INPUT,
      execute: async () => ({ content: (await ops.refresh()).message }),
    })

    tools.add({
      name: "list-custom-providers",
      description: "Show your saved providers with their address and number of models.",
      input: EMPTY_INPUT,
      execute: async () => {
        const { providers } = await ops.list()
        const lines = providers.map(
          provider =>
            `- ${provider.id}: ${provider.baseURL} [${provider.flavor}] ${provider.models} discovered model(s)`,
        )
        return { content: lines.length ? lines.join("\n") : "No dynamic providers configured." }
      },
    })

    tools.add({
      name: "list-catalog-sites",
      description: "List the well-known providers you can add without typing a URL.",
      input: EMPTY_INPUT,
      execute: async () => {
        const { sites } = await ops.catalogList()
        return {
          content: sites.length
            ? sites.map(site => `- ${site.id}: ${site.name} (${site.modelCount} model(s))`).join("\n")
            : "Catalog is empty.",
        }
      },
    })

    tools.add({
      name: "add-provider",
      description:
        "Add a new OpenAI-compatible provider with dynamic model discovery. Validates the endpoint, " +
        "discovers its models, enriches them with models.dev metadata, and activates the provider.",
      input: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "Short name for this provider (letters, numbers, hyphens and underscores only)" },
          baseURL: { type: "string", description: "Address of the provider's API (usually ends in /v1)" },
          apiKey: { type: "string", description: "API key for this provider (optional for local servers)" },
          flavor: {
            type: "string",
            enum: ["openai-chat", "openai-responses", "anthropic", "gemini", "ollama"],
            description: "Which API style the provider speaks (default: openai-chat)",
          },
          displayStyle: { type: "string", enum: ["slug", "name"], description: "How model names are shown (default: slug = the short id)" },
          confirmReuse: { type: "boolean", description: "Add even though another provider already uses this address" },
        },
        required: ["providerId", "baseURL"],
        additionalProperties: false,
      },
      execute: async (raw) => ({ content: (await ops.add(raw as Parameters<typeof ops.add>[0])).message }),
    })

    tools.add({
      name: "manual-add-models",
      description: "Add models by id when a provider does not list them automatically. Does not contact the provider endpoint.",
      input: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "Short provider name" },
          baseURL: { type: "string", description: "Provider API address" },
          modelIds: { type: "string", description: "Comma-separated model ids; at least one is required" },
          apiKey: { type: "string", description: "Optional API key for this provider" },
          flavor: {
            type: "string",
            enum: ["openai-chat", "openai-responses", "anthropic", "gemini", "ollama"],
            description: "Which API style the provider speaks (default: openai-chat)",
          },
          displayStyle: { type: "string", enum: ["slug", "name"] },
          overwrite: { type: "boolean", description: "Allow replacing a built-in provider with the same id" },
        },
        required: ["providerId", "baseURL", "modelIds"],
        additionalProperties: false,
      },
      execute: async (raw) => ({
        content: (await ops.manualAdd(raw as Parameters<typeof ops.manualAdd>[0])).message,
      }),
    })

    tools.add({
      name: "reprobe-models",
      description:
        "Re-probe a provider's endpoint and list model changes (added, vanished, metadata updated). Read-only — " +
        "apply-reconcile persists decisions. Defaults per row: changed/vanished → keep, new → apply.",
      input: {
        type: "object",
        properties: { providerId: { type: "string", description: "Which provider to check" } },
        required: ["providerId"],
        additionalProperties: false,
      },
      execute: async (raw) => ({ content: (await ops.reprobe((raw as { providerId: string }).providerId)).message }),
    })

    tools.add({
      name: "apply-reconcile",
      description: "Choose which model changes to accept (apply / keep / remove per model). Omitted ids default to keep when the model is already stored and apply when it is new.",
      input: {
        type: "object",
        properties: {
          providerId: { type: "string", description: "Which provider to update" },
          decisions: { type: "string", description: 'JSON object mapping model id to "apply", "keep", or "remove"' },
        },
        required: ["providerId", "decisions"],
        additionalProperties: false,
      },
      execute: async (raw) => ({
        content: (await ops.apply(raw as { providerId: string; decisions: string })).message,
      }),
    })

    tools.add({
      name: "add-from-catalog",
      description:
        "Add a provider from the models.dev catalog: takes the site's base URL and model list with catalog " +
        "metadata. No probing.",
      input: {
        type: "object",
        properties: {
          site: { type: "string", description: "Which known provider to add (see list-catalog-sites)" },
          providerId: { type: "string", description: "Short name for this provider (letters, numbers, hyphens and underscores only)" },
          apiKey: { type: "string", description: "API key for this provider (optional for local servers)" },
          displayStyle: { type: "string", enum: ["slug", "name"], description: "How model names are shown (default: slug = the short id)" },
          models: { type: "string", description: "Model names separated by commas; omit to add every model this provider offers" },
        },
        required: ["site", "providerId"],
        additionalProperties: false,
      },
      execute: async (raw) => ({ content: (await ops.catalogAdd(raw as Parameters<typeof ops.catalogAdd>[0])).message }),
    })

    tools.add({
      name: "delete-provider",
      description: "Remove a provider and its models from opencode.",
      input: {
        type: "object",
        properties: { providerId: { type: "string", description: "Provider ID to delete" } },
        required: ["providerId"],
        additionalProperties: false,
      },
      execute: async (raw) => ({ content: (await ops.remove((raw as { providerId: string }).providerId)).message }),
    })
  })

  await ctx.provider.reload()
  await refresh().catch(() => undefined)
}
