import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { setup as setupV2 } from "./tui-v2.js"
import type { DisplayStyle } from "./discovery.js"
import type { ProviderConfig } from "./types.js"
import {
  reloadAllProviders,
  addProvider,
  validateAddProviderParams,
  validateProviderId,
  persistProviderApiKey,
  reprobeProvider,
  applyReconcile,
  renameProviderEntry,
  deleteProviderEntry,
  editModelField,
  deleteModels,
  getStoredModels,
  migrateInlineKey,
  type ModelField,
} from "./commands.js"
import { isValidUrl } from "./security.js"
import { normalizeBaseUrl } from "./endpoint.js"
import { FLAVORS, collisionSuggestion } from "./flavors.js"
import type { TriDecision } from "./reconcile.js"
import { describeProbed, buildCatalogModels, parseModelIds, previewManualModels } from "./probe.js"
import { listCatalogSites } from "./catalog.js"
import { createTuiBridge } from "./opencode-client.js"

import { id } from "./ids.js"
export { id }

function showPrompt(api: TuiPluginApi, title: string, placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogPrompt({
          title,
          placeholder,
          onConfirm: (value: string) => resolve(value),
          onCancel: () => resolve(null),
        }),
      () => resolve(null),
    )
  })
}

function showConfirm(api: TuiPluginApi, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogConfirm({
          title,
          message,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      () => resolve(false),
    )
  })
}

function showSelect<V>(
  api: TuiPluginApi,
  title: string,
  options: Array<{ title: string; value: V; description?: string }>,
): Promise<V | null> {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () =>
        api.ui.DialogSelect({
          title,
          options: options.map((o) => ({
            ...o,
            onSelect: () => resolve(o.value),
          })),
        }),
      () => resolve(null),
    )
  })
}

export const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const bridge = createTuiBridge(api.client)
  api.command.register(() => [
    {
      title: "Reload Models",
      value: "reload-models",
      description: "Re-discover models from all dynamic providers without restarting",
      slash: {
        name: "reload-models",
        aliases: ["refresh-models"],
      },
      onSelect: async () => {
        const providers = await bridge.getProviders()

        const result = await reloadAllProviders(providers)

        if (result.providerCount === 0) {
          api.ui.toast({ message: "No dynamic providers configured.", variant: "warning" })
          return
        }

        api.ui.toast({
          message: `Reloading models from ${result.providerCount} provider(s)...`,
          variant: "info",
        })

        for (const w of result.warnings) {
          api.ui.toast({ message: w, variant: "warning" })
        }
        for (const e of result.errors) {
          api.ui.toast({ message: e, variant: "error" })
        }

        if (result.totalModels > 0) {
          await bridge.updateProviders(providers)
        }

        if (result.failures === 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`,
            variant: "success",
          })
        } else if (result.totalModels > 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s). Check provider URLs/keys.`,
            variant: "warning",
          })
        }
      },
    },
    {
      title: "Add Provider",
      value: "add-provider",
      description: "Add a new OpenAI-compatible custom provider with dynamic model discovery",
      slash: {
        name: "add-provider",
      },
      onSelect: async () => {
        const source = await showSelect(api, "Add provider", [
          { title: "Custom endpoint", value: "endpoint", description: "Probe /models and metadata sources" },
          { title: "models.dev catalog", value: "catalog", description: "Known site, metadata from catalog, no probing" },
        ])
        if (!source) return

        if (source === "catalog") {
          let sites
          try {
            api.ui.toast({ message: "Loading models.dev catalog...", variant: "info" })
            sites = await listCatalogSites()
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            api.ui.toast({ message: `Catalog failed: ${message}`, variant: "error" })
            return
          }
          if (sites.length === 0) {
            api.ui.toast({ message: "Catalog is empty.", variant: "warning" })
            return
          }
          const siteId = await showSelect(api, "Catalog site", sites.map(s => ({
            title: s.name,
            value: s.id,
            description: `${s.modelCount} model(s)`,
          })))
          if (!siteId) return
          const site = sites.find(s => s.id === siteId)
          if (!site) return

          const rawProviderId = await showPrompt(api, "Provider ID", siteId)
          if (!rawProviderId) return
          const providerId = rawProviderId.trim()
          const idError = validateProviderId(providerId)
          if (idError) {
            api.ui.toast({ message: idError, variant: "error" })
            return
          }
          const suggestion = collisionSuggestion(providerId)
          if (suggestion && suggestion !== providerId) {
            api.ui.toast({ message: `'${providerId}' merges with a built-in id; '${suggestion}' stays separate.`, variant: "warning" })
          }

          const catProviders = await bridge.getProviders()
          if (catProviders[providerId]) {
            const overwrite = await showConfirm(api, "Provider already exists", `Overwrite '${providerId}'?`)
            if (!overwrite) return
          }

          const rawApiKey = await showPrompt(api, "API Key (Optional)", "sk-...")
          const apiKey = rawApiKey?.trim() || undefined

          const displayStyle = await showSelect<DisplayStyle>(api, "Model Display Names", [
            { title: "Full Slug", value: "slug", description: "vertex/gemini-3.1-pro (best for proxies)" },
            { title: "Friendly Name", value: "name", description: "Gemini 3.1 Pro (may be ambiguous)" },
          ])
          if (!displayStyle) return

          const scope = await showSelect(api, `${site.modelCount} model(s) available`, [
            { title: "Add all", value: "all", description: `${site.modelCount} model(s)` },
            { title: "Pick ids", value: "pick", description: "Comma-separated" },
            { title: "Cancel", value: "cancel", description: "Add nothing" },
          ])
          if (!scope || scope === "cancel") return
          let modelIds: string[] | undefined
          if (scope === "pick") {
            const rawIds = await showPrompt(api, "Model ids (comma-separated)")
            if (!rawIds) return
            modelIds = parseModelIds(rawIds)
            if (!modelIds || modelIds.length === 0) {
              api.ui.toast({ message: "No model ids provided. Enter at least one id (comma-separated).", variant: "error" })
              return
            }
          }

          api.ui.toast({ message: `Adding ${providerId} from catalog...`, variant: "info" })
          let built
          try {
            built = await buildCatalogModels(siteId, modelIds, displayStyle)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            api.ui.toast({ message: `Catalog add failed: ${message}`, variant: "error" })
            return
          }
          const entry: ProviderConfig = {
            name: providerId,
            npm: "@ai-sdk/openai-compatible",
            api: built.baseURL,
            options: { baseURL: built.baseURL },
            dynamic: true,
            displayStyle,
            models: built.models,
          }
          try {
            await persistProviderApiKey(entry, providerId, apiKey, async (id, key) => {
              await bridge.setApiKey(id, key)
              return true
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" })
            return
          }
          catProviders[providerId] = entry
          await bridge.updateProviders(catProviders)
          const stored = Object.keys(built.models).length
          api.ui.toast({
            message: `Added ${stored} model(s)${built.missing.length > 0 ? `, unknown: ${built.missing.join(", ")}` : ""}.`,
            variant: "success",
          })
          return
        }

        const rawProviderId = await showPrompt(api, "Provider ID", "e.g., my-proxy (alphanumeric only)")
        if (!rawProviderId) return

        const providerId = rawProviderId.trim()
        const idError = validateProviderId(providerId)
        if (idError) {
          api.ui.toast({ message: idError, variant: "error" })
          return
        }

        const providers = await bridge.getProviders()

        let overwrite = false
        if (providers[providerId]) {
          overwrite = await showConfirm(
            api,
            "Provider already exists",
            `A provider with ID '${providerId}' already exists. Overwrite it?`,
          )
          if (!overwrite) return
        }

        const rawBaseURL = await showPrompt(api, "Base URL", "https://api.example.com/v1")
        if (!rawBaseURL) return

        const baseURL = rawBaseURL.trim()

        const rawApiKey = await showPrompt(api, "API Key (Optional)", "sk-...")
        const apiKey = rawApiKey?.trim() || undefined

        const displayStyle = await showSelect<DisplayStyle>(api, "Model Display Names", [
          {
            title: "Full Slug",
            value: "slug",
            description: "vertex/gemini-3.1-pro (best for proxies)",
          },
          {
            title: "Friendly Name",
            value: "name",
            description: "Gemini 3.1 Pro (may be ambiguous)",
          },
        ])
        if (!displayStyle) return

        const params = { providerId, baseURL, apiKey, displayStyle, overwrite }
        const validationError = validateAddProviderParams(params, providers)
        if (validationError) {
          api.ui.toast({ message: validationError, variant: "error" })
          return
        }

        api.ui.toast({ message: `Discovering models from ${baseURL}...`, variant: "info" })

        const result = await addProvider(params)

        if (!result.success || !result.providerEntry) {
          api.ui.toast({ message: result.message, variant: "warning" })
          return
        }

        try {
          await persistProviderApiKey(
            result.providerEntry,
            providerId,
            apiKey,
            async (id, key) => {
              await bridge.setApiKey(id, key)
              return true
            },
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" })
          return
        }

        providers[providerId] = result.providerEntry
        await bridge.updateProviders(providers)

        // Say what was learned and what to do next, not just "done".
        const entry = result.providerEntry
        const stored = Object.keys(entry.models ?? {}).length
        const learned: string[] = []
        for (const model of Object.values(entry.models ?? {})) {
          const limits = (model as { limit?: { context?: number; output?: number } }).limit
          if (limits?.context) learned.push("context")
          if (limits?.output) learned.push("max output")
          break
        }
        const detail = learned.length ? ` Learned: ${[...new Set(learned)].join(", ")}.` : " No extra details were measured for it."
        api.ui.toast({
          message: `${result.message}${detail} Run /model to pick one of its ${stored} model${stored === 1 ? "" : "s"}.`,
          variant: "success",
        })
      },
    },
    {
      title: "Re-probe Models",
      value: "reprobe-models",
      description: "Re-probe a provider and reconcile model changes",
      slash: {
        name: "reprobe-models",
      },
      onSelect: async () => {
        const providers = await bridge.getProviders()
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const providerId = await showSelect(api, "Provider to re-probe", ids.map(id => ({ title: id, value: id })))
        if (!providerId) return
        const provider = providers[providerId]

        api.ui.toast({ message: `Probing ${providerId}...`, variant: "info" })
        let rep
        try {
          rep = await reprobeProvider(providerId, provider)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          api.ui.toast({ message: `Re-probe failed: ${message}`, variant: "error" })
          return
        }
        if (rep.changes.length === 0) {
          api.ui.toast({ message: `Already in sync (${rep.fresh.length} model(s)).`, variant: "success" })
          return
        }
        const mode = await showSelect(api, `${rep.changes.length} change(s) found`, [
          { title: "Review each", value: "each", description: "Decide per model" },
          { title: "Keep what I have (safest)", value: "keep", description: "Leave every model as it is" },
          { title: "Cancel", value: "cancel", description: "Change nothing" },
        ])
        if (!mode || mode === "cancel") return
        if (mode === "keep") {
          api.ui.toast({ message: "Kept what you have. Nothing was changed.", variant: "info" })
          return
        }

        const decisions: Record<string, TriDecision> = {}
        if (mode === "each") {
          const freshById = new Map(rep.fresh.map(p => [p.id, p]))
          for (const change of rep.changes) {
            const fresh = freshById.get(change.id)
            const source = fresh ? `\n${describeProbed(fresh)}` : ""
            const choice = await showSelect<TriDecision>(api, `[${change.kind}] ${change.id}`, [
              { title: "Keep stored", value: "keep", description: "Leave the current entry unchanged" },
              { title: "Apply update", value: "apply", description: `${change.detail}${source}` },
              { title: "Remove", value: "remove", description: "Delete the stored entry" },
            ])
            if (!choice) return
            decisions[change.id] = choice
          }
        }
        const next = applyReconcile(provider, rep.fresh, decisions)
        provider.models = next
        await bridge.updateProviders(providers)
        api.ui.toast({ message: `Reconciled: ${Object.keys(next).length} model(s) stored.`, variant: "success" })
      },
    },
    {
      title: "Edit Provider",
      value: "edit-provider",
      description: "Rename, re-point, or tweak a provider and its models",
      slash: {
        name: "edit-provider",
      },
      onSelect: async () => {
        const providers = await bridge.getProviders()
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const providerId = await showSelect(api, "Provider to edit", ids.map(id => ({ title: id, value: id })))
        if (!providerId) return
        const provider = providers[providerId]
        if (provider.options?.apiKey) {
          try {
            const migration = await migrateInlineKey(provider, providerId, async (id, key) => {
              await bridge.setApiKey(id, key)
              return true
            })
            if (migration.migrated) {
              api.ui.toast({ message: migration.note, variant: "success" })
              await bridge.updateProviders(providers)
            } else if (migration.note) {
              api.ui.toast({ message: migration.note, variant: "warning" })
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            api.ui.toast({ message: `Key migration failed: ${message}`, variant: "error" })
          }
        }
        const action = await showSelect(api, `Edit ${providerId}`, [
          { title: "Rename", value: "rename" },
          { title: "Endpoint", value: "endpoint" },
          { title: "Flavor", value: "flavor" },
          { title: "API key", value: "key" },
          { title: "Display style", value: "style" },
          { title: "Edit model", value: "model" },
          { title: "Add models manually", value: "add" },
          { title: "Delete models", value: "delete" },
        ])
        if (!action) return
        const save = async () => {
          await bridge.updateProviders(providers)
        }

        if (action === "rename") {
          const raw = await showPrompt(api, "New provider ID", providerId)
          if (!raw) return
          let finalId = raw.trim()
          const suggestion = collisionSuggestion(finalId)
          if (suggestion && suggestion !== finalId) {
            const useSuggested = await showConfirm(
              api,
              "Built-in id collision",
              `'${finalId}' merges with a built-in provider. Use '${suggestion}' instead?`,
            )
            if (useSuggested) finalId = suggestion
          }
          const { error, warning } = renameProviderEntry(providers, providerId, finalId)
          if (error) {
            api.ui.toast({ message: error, variant: "error" })
            return
          }
          await save()
          api.ui.toast({ message: `Renamed to '${finalId}'.`, variant: "success" })
          if (warning) api.ui.toast({ message: warning, variant: "warning" })
          api.ui.toast({ message: "Stored credential (if any) is still keyed by the old id: re-enter it via Edit Provider → API key.", variant: "warning" })
          return
        }
        if (action === "endpoint") {
          const raw = await showPrompt(api, "Base URL", provider.options?.baseURL)
          if (!raw) return
          const baseURL = normalizeBaseUrl(raw).replace(/\/+$/, "")
          if (!isValidUrl(baseURL)) {
            api.ui.toast({ message: "Invalid Base URL.", variant: "error" })
            return
          }
          provider.options = { ...provider.options, baseURL }
          provider.api = baseURL
          await save()
          api.ui.toast({ message: "Endpoint updated. Run Re-probe Models to refresh.", variant: "success" })
          return
        }
        if (action === "flavor") {
          const flavor = await showSelect(api, "Endpoint flavor", Object.values(FLAVORS).map(f => ({
            title: f.label,
            value: f.flavor,
            description: f.description,
          })))
          if (!flavor) return
          provider.flavor = flavor
          await save()
          api.ui.toast({ message: `Flavor set to ${flavor}. Run Re-probe Models to refresh.`, variant: "success" })
          return
        }
        if (action === "key") {
          const raw = await showPrompt(api, "API Key (blank to clear)", "sk-...")
          if (raw === null) return
          const key = raw.trim() || undefined
          try {
            await persistProviderApiKey(provider, providerId, key, async (id, k) => {
              await bridge.setApiKey(id, k)
              return true
            })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" })
            return
          }
          if (!key) {
            try {
              await bridge.removeApiKey?.(providerId)
            } catch {
            }
          }
          if (!key && provider.options) delete provider.options.apiKey
          await save()
          api.ui.toast({ message: key ? "API key updated." : "API key cleared.", variant: "success" })
          return
        }
        if (action === "style") {
          const style = await showSelect<DisplayStyle>(api, "Model display names", [
            { title: "Full Slug", value: "slug" },
            { title: "Friendly Name", value: "name" },
          ])
          if (!style) return
          provider.displayStyle = style
          await save()
          api.ui.toast({ message: `Display style set to ${style}.`, variant: "success" })
          return
        }

        const models = getStoredModels(provider)
        if (action === "model") {
          const modelIds = Object.keys(models)
          if (modelIds.length === 0) {
            api.ui.toast({ message: "No models stored.", variant: "warning" })
            return
          }
          const modelId = await showSelect(api, "Model to edit", modelIds.map(id => ({ title: id, value: id })))
          if (!modelId) return
          const field = await showSelect<ModelField>(api, `Field of ${modelId}`, [
            { title: "Display name", value: "name" },
            { title: "Context window", value: "context" },
            { title: "Max output", value: "output" },
            { title: "Reasoning", value: "reasoning" },
            { title: "Image input", value: "image" },
          ])
          if (!field) return
          const m = models[modelId]
          // An unmeasured limit is absent, not a refusal to edit.
          m.limit ??= {}
          const current = field === "name"
            ? m.name
            : field === "context"
              ? String(m.limit.context)
              : field === "output"
                ? String(m.limit.output)
                : field === "reasoning"
                  ? String(!!m.reasoning)
                  : String(m.modalities?.input.includes("image") ?? false)
          const raw = await showPrompt(api, `${field} (current: ${current})`)
          if (raw === null) return
          const error = editModelField(models, modelId, field, raw)
          if (error) {
            api.ui.toast({ message: error, variant: "error" })
            return
          }
          provider.models = models
          await save()
          api.ui.toast({ message: `Model '${modelId}' updated.`, variant: "success" })
          return
        }
        if (action === "add") {
          const raw = await showPrompt(api, "Model ids (comma-separated)")
          if (!raw) return
          const ids = raw.split(",").map(s => s.trim()).filter(s => s.length > 0)
          if (ids.length === 0) return
          api.ui.toast({ message: "Resolving metadata...", variant: "info" })
          const previews = await previewManualModels(ids, provider.flavor, provider.displayStyle)
          const lines = previews.map(({ probed }) => describeProbed(probed))
          const ok = await showConfirm(
            api,
            "Add models",
            `${previews.length} model(s):\n${lines.slice(0, 10).join("\n")}${lines.length > 10 ? `\n…+${lines.length - 10} more` : ""}`,
          )
          if (!ok) return
          const stored = getStoredModels(provider)
          let added = 0
          const skipped: string[] = []
          for (const { id, model } of previews) {
            if (!id || stored[id]) {
              skipped.push(id)
              continue
            }
            stored[id] = model
            added++
          }
          provider.models = stored
          await save()
          api.ui.toast({
            message: `Added ${added}${skipped.length > 0 ? `, skipped ${skipped.length}` : ""}.`,
            variant: "success",
          })
          return
        }
        if (action === "delete") {
          const modelIds = Object.keys(models)
          if (modelIds.length === 0) {
            api.ui.toast({ message: "No models stored.", variant: "warning" })
            return
          }
          const raw = await showPrompt(api, "Model ids to delete (comma-separated)")
          if (!raw) return
          const candidates = raw.split(",").map(s => s.trim()).filter(s => s.length > 0)
          const unknown = candidates.filter(id => !models[id])
          if (unknown.length > 0) {
            api.ui.toast({ message: `Unknown model(s): ${unknown.join(", ")}.`, variant: "error" })
            return
          }
          const ok = await showConfirm(
            api,
            "Delete models",
            `Remove ${candidates.length} model(s) from ${providerId}?\n${candidates.join(", ")}`,
          )
          if (!ok) return
          const { deleted } = deleteModels(models, candidates)
          provider.models = models
          await save()
          api.ui.toast({ message: `Deleted ${deleted.length} model(s).`, variant: "success" })
        }
      },
    },
    {
      title: "Delete Provider",
      value: "delete-provider",
      description: "Remove a provider and its models",
      slash: {
        name: "delete-provider",
      },
      onSelect: async () => {
        const providers = await bridge.getProviders()
        const ids = Object.keys(providers)
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" })
          return
        }
        const providerId = await showSelect(api, "Provider to delete", ids.map(id => ({ title: id, value: id })))
        if (!providerId) return
        const ok = await showConfirm(api, "Delete provider", `Remove '${providerId}' and all its models?`)
        if (!ok) return
        const error = deleteProviderEntry(providers, providerId)
        if (error) {
          api.ui.toast({ message: error, variant: "error" })
          return
        }
        await bridge.updateProviders(providers)
        api.ui.toast({ message: `Provider '${providerId}' deleted.`, variant: "success" })
      },
    },
  ])
}

export default { id, tui, setup: setupV2 }
