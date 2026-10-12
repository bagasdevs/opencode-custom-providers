import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { discoverAndEnrich } from "./discovery.js"
import { sanitizeErrorMessage, sanitizeUrl, isValidUrl } from "./security.js"
import {
  reloadAllProviders,
  addProvider,
  validateAddProviderParams,
  validateProviderId,
  persistProviderApiKey,
  rotateProviderApiKey,
  reprobeProvider,
  reprobeAndReconcile,
  renameProviderEntry,
  deleteProviderEntry,
  deleteModels,
  getStoredModels,
  migrateInlineKey,
} from "./commands.js"
import { describeProbed, buildCatalogModels, parseModelIds } from "./probe.js"
import { listCatalogSites } from "./catalog.js"
import { parseFlavor, FLAVORS, DEFAULT_FLAVOR } from "./flavors.js"
import type { TriDecision } from "./reconcile.js"
import { shouldDiscover, getApiKey, type ProviderConfig, type OpenCodeConfig } from "./types.js"
import { createServerBridge } from "./opencode-client.js"
import { setup as setupV2 } from "./server-v2.js"

import { id } from "./ids.js"
export { id }

export type { ProviderConfig, OpenCodeConfig } from "./types.js"
export { getApiKey } from "./types.js"

export const server: Plugin = async ({ client }) => {
  const bridge = createServerBridge(client)
  await client.app.log({
    body: {
      level: "info",
      message: "Plugin initialized",
      service: id,
    },
  })

  return {
    config: async (cfg: OpenCodeConfig) => {
      if (!cfg.provider) return

      const eligible = Object.entries(cfg.provider).filter(
        (entry): entry is [string, ProviderConfig] => shouldDiscover(entry[1]),
      )
// Concurrent discovery, 4 in flight; no logs here so log order stays sequential.
      const outcomes: PromiseSettledResult<Awaited<ReturnType<typeof discoverAndEnrich>>>[] = []
      for (let i = 0; i < eligible.length; i += 4) {
        const chunk = eligible.slice(i, i + 4)
        const settled = await Promise.allSettled(
          chunk.map(([providerId, providerConfig]) => {
            const baseURL = providerConfig.options!.baseURL!
            const apiKey = getApiKey(providerConfig, providerId)
            const displayStyle = providerConfig.displayStyle ?? "slug"
            const flavor = parseFlavor(providerConfig.flavor) ?? DEFAULT_FLAVOR
            return discoverAndEnrich(baseURL, apiKey, displayStyle, flavor)
          }),
        )
        outcomes.push(...settled)
      }

      for (let i = 0; i < eligible.length; i++) {
        const [providerId, providerConfig] = eligible[i]
        const outcome = outcomes[i]
        const baseURL = providerConfig.options!.baseURL!

        try {
          await client.app.log({
            body: {
              level: "info",
              message: `Discovering models from ${providerId} at ${sanitizeUrl(baseURL)}`,
              service: id,
            },
          })

          if (outcome.status === "rejected") throw outcome.reason
          const models = outcome.value
          const count = Object.keys(models).length

          if (count === 0) {
            await client.app.log({
              body: {
                level: "warn",
                message: `No models discovered from ${providerId}`,
                service: id,
              },
            })
            continue
          }

          providerConfig.models = { ...(providerConfig.models as Record<string, unknown> ?? {}), ...models }
          providerConfig.npm = providerConfig.npm ?? "@ai-sdk/openai-compatible"
          providerConfig.api = providerConfig.api ?? baseURL

          await client.app.log({
            body: {
              level: "info",
              message: `Discovered ${count} model(s) from ${providerId}`,
              service: id,
            },
          })
        } catch (error) {
          await client.app.log({
            body: {
              level: "warn",
              message: `Failed to discover models from ${providerId}: ${sanitizeErrorMessage(error)}`,
              service: id,
            },
          })
        }
      }
    },

    tool: {
      "refresh-models": tool({
        description:
          "Re-discover models from all dynamic providers and update the live config. " +
          "Fetches /models from every provider " +
          "with a baseURL, enriches them, and persists the updated config.",
        args: {},
        async execute() {
          const providers = await bridge.getProviders()

          const result = await reloadAllProviders(providers)

          if (result.providerCount === 0) {
            return "No dynamic providers configured. Add a provider with a baseURL first."
          }

          if (result.totalModels > 0) {
            await bridge.updateProviders(providers)
          }

          const lines: string[] = []
          if (result.failures === 0) {
            lines.push(
              `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`,
            )
          } else {
            lines.push(
              `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s).`,
            )
          }
          for (const w of result.warnings) lines.push(`Warning: ${w}`)
          for (const e of result.errors) lines.push(`Error: ${e}`)

          return lines.join("\n")
        },
      }),

      "add-provider": tool({
        description:
          "Add a new OpenAI-compatible provider with dynamic model discovery. " +
          "Validates the endpoint, discovers available models, enriches them with " +
          "models.dev metadata, and persists the provider to the config.",
        args: {
          providerId: tool.schema
            .string()
            .describe("Unique provider ID (alphanumeric, hyphens, underscores only)"),
          baseURL: tool.schema
            .string()
            .describe("Base URL of the OpenAI-compatible API endpoint (e.g. https://api.example.com/v1)"),
          apiKey: tool.schema
            .string()
            .optional()
            .describe("API key for authentication (optional)"),
          displayStyle: tool.schema
            .enum(["slug", "name"])
            .optional()
            .describe("How to display model names: 'slug' for full ID (default), 'name' for friendly name"),
          flavor: tool.schema
            .enum(["openai-chat", "openai-responses", "anthropic", "gemini", "ollama"])
            .optional()
            .describe("Endpoint flavor to probe with (default: openai-chat)"),
          overwrite: tool.schema
            .boolean()
            .optional()
            .describe("Overwrite if a provider with this ID already exists (default: false)"),
        },
        async execute(args) {
          const providers = await bridge.getProviders()

          const validationError = validateAddProviderParams(args, providers)
          if (validationError) return validationError

          const result = await addProvider(args)
          if (!result.success || !result.providerEntry) return result.message

          try {
            await persistProviderApiKey(
              result.providerEntry,
              args.providerId,
              args.apiKey,
              async (id, key) => {
                await bridge.setApiKey(id, key)
                return true
              },
            )
          } catch (error) {
            return `Failed to add provider: ${sanitizeErrorMessage(error)}`
          }

          providers[args.providerId] = result.providerEntry
          await bridge.updateProviders(providers)

          return result.message
        },
      }),

      "reprobe-models": tool({
        description:
          "Re-probe a provider's endpoint and list model changes (added, updated with old -> new values, vanished). Read-only: call apply-reconcile with decisions to save.",
        args: {
          providerId: tool.schema.string().describe("Provider ID to re-probe"),
        },
        async execute(args) {
          const providers = await bridge.getProviders()
          const provider = providers[args.providerId]
          if (!provider) return `Unknown provider '${args.providerId}'.`

          let rep
          try {
            rep = await reprobeProvider(args.providerId, provider)
          } catch (error) {
            return `Re-probe failed: ${sanitizeErrorMessage(error)}`
          }
          if (rep.changes.length === 0) {
            return `No changes for '${args.providerId}': ${rep.fresh.length} model(s) already in sync.`
          }
          const lines = [`${rep.changes.length} change(s) for '${args.providerId}':`]
          const freshById = new Map(rep.fresh.map(p => [p.id, p]))
          for (const c of rep.changes) {
            lines.push(`- [${c.kind}] ${c.detail}`)
            const fresh = freshById.get(c.id)
            if (fresh) lines.push(`    fresh: ${describeProbed(fresh)}`)
          }
          lines.push(
            `Call apply-reconcile with a decisions object mapping model id to "apply", "keep", or "remove". ` +
            `Defaults when omitted: added/updated -> apply, vanished -> keep.`,
          )
          return lines.join("\n")
        },
      }),

      "apply-reconcile": tool({
        description:
          "Apply tri-state reconcile decisions from reprobe-models and persist the updated config.",
        args: {
          providerId: tool.schema.string().describe("Provider ID to reconcile"),
          decisions: tool.schema
            .string()
            .describe('JSON object mapping model id to "apply", "keep", or "remove"'),
        },
        async execute(args) {
          const providers = await bridge.getProviders()
          const provider = providers[args.providerId]
          if (!provider) return `Unknown provider '${args.providerId}'.`

          let parsed: unknown
          try {
            parsed = JSON.parse(args.decisions)
          } catch {
            return `Invalid decisions JSON.`
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return `Invalid decisions JSON.`
          }
          const decisions: Record<string, TriDecision> = {}
          for (const [id, d] of Object.entries(parsed as Record<string, unknown>)) {
            if (d !== "apply" && d !== "keep" && d !== "remove") {
              return `Invalid decision for '${id}': must be "apply", "keep", or "remove".`
            }
            decisions[id] = d
          }

          let result
          try {
            result = await reprobeAndReconcile(args.providerId, provider, decisions)
          } catch (error) {
            return `Re-probe failed: ${sanitizeErrorMessage(error)}`
          }
          provider.models = result.models
          await bridge.updateProviders(providers)
          return `Reconciled '${args.providerId}': ${result.rep.fresh.length} model(s) probed, ${Object.keys(result.models).length} stored.`
        },
      }),

      "edit-provider": tool({
        description:
          "Edit a provider: rename, change endpoint/flavor/display style, or rotate the API key. Re-probes models when the endpoint or flavor changes.",
        args: {
          providerId: tool.schema.string().describe("Provider ID to edit"),
          rename: tool.schema.string().optional().describe("New provider ID"),
          baseURL: tool.schema.string().optional().describe("New base URL"),
          flavor: tool.schema
            .string()
            .optional()
            .describe("New endpoint flavor (openai-chat, openai-responses, anthropic, gemini, ollama)"),
          apiKey: tool.schema.string().optional().describe("New API key"),
          displayStyle: tool.schema
            .enum(["slug", "name"])
            .optional()
            .describe("Model display style"),
        },
        async execute(args) {
          const providers = await bridge.getProviders()
          const provider = providers[args.providerId]
          if (!provider) return `Unknown provider '${args.providerId}'.`
          const notes: string[] = []
          let targetId = args.providerId

          if (args.rename !== undefined && args.rename !== args.providerId) {
            const oldId = args.providerId
            const { error, warning } = renameProviderEntry(providers, oldId, args.rename)
            if (error) return error
            targetId = args.rename.trim()
            if (warning) notes.push(warning)
          }
          const entry = providers[targetId]

          if (args.baseURL !== undefined) {
            const baseURL = args.baseURL.trim().replace(/\/+$/, "")
            if (!isValidUrl(baseURL)) {
              return "Invalid Base URL. Please enter a full URL (including https://)."
            }
            entry.options = { ...entry.options, baseURL }
            entry.api = baseURL
          }
          if (args.flavor !== undefined) {
            const flavor = parseFlavor(args.flavor)
            if (!flavor) {
              return `Unknown flavor '${args.flavor}'. Valid: ${Object.keys(FLAVORS).join(", ")}.`
            }
            entry.flavor = flavor
          }
          if (args.displayStyle !== undefined) entry.displayStyle = args.displayStyle

          if (args.apiKey !== undefined) {
            try {
              await rotateProviderApiKey(
                entry,
                targetId,
                args.apiKey || undefined,
                async (id, key) => {
                  await bridge.setApiKey(id, key)
                  return true
                },
              )
            } catch (error) {
              return `Failed to update provider: ${sanitizeErrorMessage(error)}`
            }
          }

          if (args.apiKey === undefined) {
            const migration = await migrateInlineKey(entry, targetId, async (id, key) => {
              await bridge.setApiKey(id, key)
              return true
            })
            if (migration.note) notes.push(migration.note)
          }

          if (args.baseURL !== undefined || args.flavor !== undefined) {
            try {
              const result = await reprobeAndReconcile(targetId, entry, {})
              entry.models = result.models
              notes.push(`Re-probed: ${Object.keys(entry.models).length} model(s) stored.`)
            } catch (error) {
              notes.push(`Models unchanged (probe failed: ${sanitizeErrorMessage(error)}).`)
            }
          }

          await bridge.updateProviders(providers)
          return [`Provider '${targetId}' updated.`, ...notes].join(" ")
        },
      }),

      "delete-provider": tool({
        description: "Delete a provider and its models from the config.",
        args: {
          providerId: tool.schema.string().describe("Provider ID to delete"),
        },
        async execute(args) {
          const providers = await bridge.getProviders()
          const error = deleteProviderEntry(providers, args.providerId)
          if (error) return error
          await bridge.updateProviders(providers)
          return `Provider '${args.providerId}' deleted. Remove its stored credential separately if one was saved.`
        },
      }),

      "delete-models": tool({
        description: "Bulk delete stored models from a provider (comma-separated ids).",
        args: {
          providerId: tool.schema.string().describe("Provider ID"),
          modelIds: tool.schema.string().describe("Comma-separated model ids to delete"),
        },
        async execute(args) {
          const providers = await bridge.getProviders()
          const provider = providers[args.providerId]
          if (!provider) return `Unknown provider '${args.providerId}'.`
          const models = getStoredModels(provider)
          if (Object.keys(models).length === 0) {
            return `Provider '${args.providerId}' has no stored models.`
          }
          const ids = args.modelIds.split(",").map(s => s.trim()).filter(s => s.length > 0)
          const unknown = ids.filter(id => !models[id])
          if (unknown.length > 0) return `Unknown model(s): ${unknown.join(", ")}.`
          const { deleted } = deleteModels(models, ids)
          provider.models = models
          await bridge.updateProviders(providers)
          return `Deleted ${deleted.length} model(s) from '${args.providerId}': ${deleted.join(", ")}.`
        },
      }),

      "list-catalog-sites": tool({
        description:
          "List known API sites from the models.dev catalog (id, name, model count) for add-from-catalog.",
        args: {},
        async execute() {
          let sites
          try {
            sites = await listCatalogSites()
          } catch (error) {
            return `Catalog failed: ${sanitizeErrorMessage(error)}`
          }
          if (sites.length === 0) return "Catalog is empty."
          return sites.map(s => `- ${s.id}: ${s.name} (${s.modelCount} model(s))`).join("\n")
        },
      }),

      "add-from-catalog": tool({
        description:
          "Add a provider from the models.dev catalog: takes the site's base URL and model list with catalog metadata. No probing.",
        args: {
          site: tool.schema.string().describe("Catalog site id (see list-catalog-sites)"),
          providerId: tool.schema
            .string()
            .describe("Unique provider ID (alphanumeric, hyphens, underscores only)"),
          apiKey: tool.schema.string().optional().describe("API key for authentication (optional)"),
          displayStyle: tool.schema
            .enum(["slug", "name"])
            .optional()
            .describe("How to display model names (default: slug)"),
          models: tool.schema
            .string()
            .optional()
            .describe("Comma-separated model ids; omit to add every catalog model"),
          overwrite: tool.schema
            .boolean()
            .optional()
            .describe("Overwrite if a provider with this ID already exists (default: false)"),
        },
        async execute(args) {
          const providers = await bridge.getProviders()

          const idError = validateProviderId(args.providerId)
          if (idError) return idError
          if (providers[args.providerId] && !args.overwrite) {
            return `A provider with ID '${args.providerId}' already exists. Set overwrite to true to replace it.`
          }

          const modelIds = parseModelIds(args.models)
          if (args.models !== undefined && (!modelIds || modelIds.length === 0)) {
            return "No model ids provided. Pass at least one comma-separated id, or omit 'models' to add every catalog model."
          }

          let built
          try {
            built = await buildCatalogModels(
              args.site,
              modelIds,
              args.displayStyle ?? "slug",
            )
          } catch (error) {
            return `Catalog add failed: ${sanitizeErrorMessage(error)}`
          }

          const providerEntry: ProviderConfig = {
            name: args.providerId,
            npm: "@ai-sdk/openai-compatible",
            api: built.baseURL,
            options: { baseURL: built.baseURL },
            dynamic: true,
            displayStyle: args.displayStyle ?? "slug",
            models: built.models,
          }
          try {
            await persistProviderApiKey(
              providerEntry,
              args.providerId,
              args.apiKey,
              async (id, key) => {
                await bridge.setApiKey(id, key)
                return true
              },
            )
          } catch (error) {
            return `Failed to add provider: ${sanitizeErrorMessage(error)}`
          }

          providers[args.providerId] = providerEntry
          await bridge.updateProviders(providers)

          const stored = Object.keys(built.models).length
          const lines = [
            `Provider '${args.providerId}' added with ${stored} model(s) from catalog site '${args.site}'.`,
          ]
          if (built.missing.length > 0) lines.push(`Unknown ids skipped: ${built.missing.join(", ")}.`)
          if (built.resolved.length > 0) {
            lines.push(`Example: ${describeProbed(built.resolved[0])}`)
          }
          return lines.join("\n")
        },
      }),
    },
  }
}

export default { id, server, setup: setupV2 }
