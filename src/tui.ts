import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
// The /tui/plugin subpath is the same `define` without the Solid layer a test process can't load.
import * as Plugin from "@opencode/plugin/tui/plugin"
import { id as tuiId, setup as setupV2 } from "./tui-v2.js"
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
            message: `Reloaded ${result.totalModels} model(s). ${result.failures} provider(s) failed.`,
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
        const source = await showSelect(api, "Add a provider > Where is it from?", [
          { title: "My own API", value: "endpoint", description: "You type its address and key." },
          { title: "Built-in list", value: "catalog", description: "Pick from a ready-made list." },
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
          const siteId = await showSelect(api, "Add from built-in list > Pick one", sites.map(s => ({
            title: s.name,
            value: s.id,
            description: `${s.modelCount} model(s)`,
          })))
          if (!siteId) return
          const site = sites.find(s => s.id === siteId)
          if (!site) return

          const rawProviderId = await showPrompt(api, "Add from built-in list > Name", siteId)
          if (!rawProviderId) return
          const providerId = rawProviderId.trim()
          const idError = validateProviderId(providerId)
          if (idError) {
            api.ui.toast({ message: idError, variant: "error" })
            return
          }
          const suggestion = collisionSuggestion(providerId)
          if (suggestion && suggestion !== providerId) {
            api.ui.toast({ message: `'${providerId}' is a name OpenCode already uses. Pick a different one, or use '${suggestion}'.`, variant: "warning" })
          }

          const catProviders = await bridge.getProviders()
          if (catProviders[providerId]) {
            const overwrite = await showConfirm(api, "Add from built-in list > Name taken", `'${providerId}' already exists. Replace it?`)
            if (!overwrite) return
          }

          const rawApiKey = await showPrompt(api, "Add from built-in list > API key (optional)", "sk-...")
          const apiKey = rawApiKey?.trim() || undefined

          const displayStyle = await showSelect<DisplayStyle>(api, "Add from built-in list > Model names", [
            {
              title: "Model id",
              value: "slug",
              description: "Short id, like gpt-4o. Works everywhere.",
            },
            {
              title: "Friendly name",
              value: "name",
              description: "The provider's own label, when it has one.",
            },
          ])
          if (!displayStyle) return

          const scope = await showSelect(api, `Add from built-in list > Which models? (${site.modelCount} available)`, [
            { title: "Add all", value: "all", description: `Adds all ${site.modelCount} model(s)` },
            { title: "Type the names", value: "pick", description: "Choose which ones to add" },
            { title: "Cancel", value: "cancel", description: "Add nothing" },
          ])
          if (!scope || scope === "cancel") return
          let modelIds: string[] | undefined
          if (scope === "pick") {
            const rawIds = await showPrompt(api, "Add from built-in list > Model ids", "model-a, model-b")
            if (!rawIds) return
            modelIds = parseModelIds(rawIds)
            if (!modelIds || modelIds.length === 0) {
              api.ui.toast({ message: "Type at least one model id, separated by commas.", variant: "error" })
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
            message: `Added ${stored} model(s).${built.missing.length > 0 ? ` Not found: ${built.missing.join(", ")}.` : ""}`,
            variant: "success",
          })
          return
        }

        const rawProviderId = await showPrompt(api, "Add a provider > Step 1 of 5: Name", "e.g. my-proxy (letters, numbers, - and _)")
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
            "Add a provider > Name taken",
            `You already have a provider named '${providerId}'. Replace it? Its models will be replaced too.`,
          )
          if (!overwrite) return
        }

        const rawBaseURL = await showPrompt(api, "Add a provider > Step 2 of 5: Base URL", "https://api.example.com/v1")
        if (!rawBaseURL) return

        const baseURL = rawBaseURL.trim()

        const rawApiKey = await showPrompt(api, "Add a provider > Step 4 of 5: API key (optional)", "sk-...")
        const apiKey = rawApiKey?.trim() || undefined

        const displayStyle = await showSelect<DisplayStyle>(api, "Add a provider > Step 5 of 5: Model names", [
          {
            title: "Model id",
            value: "slug",
            description: "Short id, like gpt-4o. Works everywhere.",
          },
          {
            title: "Friendly name",
            value: "name",
            description: "The provider's own label, when it has one.",
          },
        ])
        if (!displayStyle) return

        const params = { providerId, baseURL, apiKey, displayStyle, overwrite }
        const validationError = validateAddProviderParams(params, providers)
        if (validationError) {
          api.ui.toast({ message: validationError, variant: "error" })
          return
        }

        api.ui.toast({ message: `Finding models at ${baseURL}...`, variant: "info" })

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
        api.ui.toast({
          message: `${result.message} Pick one with /model.`,
          variant: "success",
        })
      },
    },
    {
      title: "Review model changes",
      value: "reprobe-models",
      description: "Check a provider for new or removed models",
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
        const providerId = await showSelect(api, "Review model changes > Pick a provider", ids.map(id => ({ title: id, value: id })))
        if (!providerId) return
        const provider = providers[providerId]

        api.ui.toast({ message: `Probing ${providerId}...`, variant: "info" })
        let rep
        try {
          rep = await reprobeProvider(providerId, provider)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          api.ui.toast({ message: `Could not check ${providerId}: ${message}`, variant: "error" })
          return
        }
        if (rep.changes.length === 0) {
          api.ui.toast({ message: `Already in sync (${rep.fresh.length} model(s)).`, variant: "success" })
          return
        }
        const mode = await showSelect(api, `Review model changes > ${rep.changes.length} change(s) found`, [
          { title: "Review one by one", value: "each", description: "Decide each change yourself." },
          { title: "Keep everything (safest)", value: "keep", description: "Change nothing." },
          { title: "Cancel", value: "cancel", description: "Change nothing" },
        ])
        if (!mode || mode === "cancel") return
        if (mode === "keep") {
          api.ui.toast({ message: "Kept everything. Nothing was changed.", variant: "info" })
          return
        }

        const decisions: Record<string, TriDecision> = {}
        if (mode === "each") {
          const freshById = new Map(rep.fresh.map(p => [p.id, p]))
          for (const change of rep.changes) {
            const fresh = freshById.get(change.id)
            const source = fresh ? `\n${describeProbed(fresh)}` : ""
            const choice = await showSelect<TriDecision>(api, `Review model changes > ${change.id} (${change.kind})`, [
              { title: "Keep it", value: "keep", description: "Leave this model as it is." },
              { title: "Apply this change", value: "apply", description: `${change.detail}${source}` },
              { title: "Delete it", value: "remove", description: "Remove this model from the list." },
            ])
            if (!choice) return
            decisions[change.id] = choice
          }
        }
        const next = applyReconcile(provider, rep.fresh, decisions)
        provider.models = next
        await bridge.updateProviders(providers)
        api.ui.toast({ message: `Updated: ${Object.keys(next).length} model(s) stored.`, variant: "success" })
      },
    },
    {
      title: "Edit a provider",
      value: "edit-provider",
      description: "Change the address, key, or models",
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
        const providerId = await showSelect(api, "Edit a provider > Pick a provider", ids.map(id => ({ title: id, value: id })))
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
            const message =
              error instanceof Error
                ? error.message
                : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
                  ? (error as { message: string }).message
                  : typeof error === "string"
                    ? error
                    : "unknown error"
            api.ui.toast({ message: `Key migration failed: ${message}`, variant: "error" })
          }
        }
        const action = await showSelect(api, `Edit ${providerId} > What to change`, [
          { title: "Rename", value: "rename" },
          { title: "Base URL", value: "endpoint" },
          { title: "API type", value: "flavor" },
          { title: "API key", value: "key" },
          { title: "Model names", value: "style" },
          { title: "Model settings", value: "model" },
          { title: "Type model ids to add", value: "add" },
          { title: "Delete models", value: "delete" },
        ])
        if (!action) return
        const save = async () => {
          await bridge.updateProviders(providers)
        }

        if (action === "rename") {
          const raw = await showPrompt(api, `Edit ${providerId} > Rename`, providerId)
          if (!raw) return
          let finalId = raw.trim()
          const suggestion = collisionSuggestion(finalId)
          if (suggestion && suggestion !== finalId) {
            const useSuggested = await showConfirm(
              api,
              `Edit ${providerId} > Name taken`,
              `'${finalId}' is a name OpenCode already uses. Use '${suggestion}' instead?`,
            )
            if (!useSuggested) return
            finalId = suggestion
          }
          const { error, warning } = renameProviderEntry(providers, providerId, finalId)
          if (error) {
            api.ui.toast({ message: error, variant: "error" })
            return
          }
          await save()
          api.ui.toast({ message: `Renamed to '${finalId}'.`, variant: "success" })
          if (warning) api.ui.toast({ message: warning, variant: "warning" })
          api.ui.toast({ message: "Renamed. Enter the API key again: Edit a provider > API key.", variant: "warning" })
          return
        }
        if (action === "endpoint") {
          const raw = await showPrompt(api, `Edit ${providerId} > Base URL`, provider.options?.baseURL)
          if (!raw) return
          const baseURL = normalizeBaseUrl(raw).replace(/\/+$/, "")
          if (!isValidUrl(baseURL)) {
            api.ui.toast({ message: "That address is not valid. Nothing was changed.", variant: "error" })
            return
          }
          provider.options = { ...provider.options, baseURL }
          provider.api = baseURL
          await save()
          api.ui.toast({ message: "Base URL saved. Choose 'Review model changes' to refresh.", variant: "success" })
          return
        }
        if (action === "flavor") {
          const flavor = await showSelect(api, `Edit ${providerId} > API type`, Object.values(FLAVORS).map(f => ({
            title: f.label,
            value: f.flavor,
            description: f.description,
          })))
          if (!flavor) return
          provider.flavor = flavor
          await save()
          api.ui.toast({ message: "API type saved. Choose 'Review model changes' to refresh.", variant: "success" })
          return
        }
        if (action === "key") {
          const raw = await showPrompt(api, `Edit ${providerId} > New API key (empty clears it)`, "sk-...")
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
          api.ui.toast({ message: key ? "API key saved." : "API key cleared.", variant: "success" })
          return
        }
        if (action === "style") {
          const style = await showSelect<DisplayStyle>(api, `Edit ${providerId} > Model names`, [
            {
              title: "Model id",
              value: "slug",
              description: "Short id, like gpt-4o. Works everywhere.",
            },
            {
              title: "Friendly name",
              value: "name",
              description: "The provider's own label, when it has one.",
            },
          ])
          if (!style) return
          provider.displayStyle = style
          await save()
          api.ui.toast({ message: "Model names saved.", variant: "success" })
          return
        }

        const models = getStoredModels(provider)
        if (action === "model") {
          const modelIds = Object.keys(models)
          if (modelIds.length === 0) {
            api.ui.toast({ message: "This provider has no models yet. Run 'Reload Models' first.", variant: "warning" })
            return
          }
          const modelId = await showSelect(api, `Edit ${providerId} > Model settings: which model?`, modelIds.map(id => ({ title: id, value: id })))
          if (!modelId) return
          const field = await showSelect<ModelField>(api, `Edit ${providerId} > ${modelId}: what to change`, [
            { title: "Name", value: "name" },
            { title: "Context window", value: "context" },
            { title: "Longest reply", value: "output" },
            { title: "Thinking", value: "reasoning" },
            { title: "Reads images", value: "image" },
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
          const raw = await showPrompt(api, `Edit ${providerId} > ${modelId}: ${field} (now: ${current})`)
          if (raw === null) return
          const error = editModelField(models, modelId, field, raw)
          if (error) {
            api.ui.toast({ message: error, variant: "error" })
            return
          }
          provider.models = models
          await save()
          api.ui.toast({ message: `Saved '${modelId}'.`, variant: "success" })
          return
        }
        if (action === "add") {
          const raw = await showPrompt(api, `Edit ${providerId} > Add models: type the ids`, "model-a, model-b")
          if (!raw) return
          const ids = raw.split(",").map(s => s.trim()).filter(s => s.length > 0)
          if (ids.length === 0) return
          api.ui.toast({ message: "Looking up details...", variant: "info" })
          const previews = await previewManualModels(ids, provider.flavor, provider.displayStyle)
          const lines = previews.map(({ probed }) => describeProbed(probed))
          const ok = await showConfirm(
            api,
            `Edit ${providerId} > Add models?`,
            `${previews.length} model(s) to add:\n${lines.slice(0, 10).join("\n")}${lines.length > 10 ? `\n…+${lines.length - 10} more` : ""}`,
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
            message: `Added ${added}.${skipped.length > 0 ? ` Skipped ${skipped.length} already in the list.` : ""}`,
            variant: "success",
          })
          return
        }
        if (action === "delete") {
          const modelIds = Object.keys(models)
          if (modelIds.length === 0) {
            api.ui.toast({ message: "This provider has no models to delete.", variant: "warning" })
            return
          }
          const raw = await showPrompt(api, `Edit ${providerId} > Delete models: type the ids`, "model-a, model-b")
          if (!raw) return
          const candidates = raw.split(",").map(s => s.trim()).filter(s => s.length > 0)
          const unknown = candidates.filter(id => !models[id])
          if (unknown.length > 0) {
            api.ui.toast({ message: `Not found in this provider: ${unknown.join(", ")}. Nothing was deleted.`, variant: "error" })
            return
          }
          const ok = await showConfirm(
            api,
            `Edit ${providerId} > Delete models?`,
            `Delete ${candidates.length} model(s) from ${providerId}?\n${candidates.join(", ")}\nThis cannot be undone.`,
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
      title: "Delete a provider",
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
        const providerId = await showSelect(api, "Delete a provider > Pick a provider", ids.map(id => ({ title: id, value: id })))
        if (!providerId) return
        const ok = await showConfirm(api, `Delete a provider > Delete ${providerId}?`, `'${providerId}' and all its models are removed. This cannot be undone.`)
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

// One default export for both hosts: V1 reads `tui`, V2 reads `id` + `setup`.
// The id is the TUI one: V2 keeps both halves in one namespace, so the server id would collide.
const definition = { id: tuiId, setup: setupV2 } satisfies Plugin.Definition
const dual: Plugin.Definition & { tui: TuiPlugin } = { ...definition, tui }
export default Plugin.define(dual)
