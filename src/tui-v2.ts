import { FLAVORS, collisionSuggestion } from "./flavors.js"
import { isValidUrl } from "./security.js"
import { id as pluginId } from "./ids.js"
import type { AddProviderResult, ManualAddResult, ProviderRow, SiteRow } from "./server-v2.js"

export const id = `${pluginId}.tui`

const RPC_ID = pluginId

interface RpcResult {
  output?: unknown
}

interface DialogSelectOption {
  title: string
  value: string
  description?: string
  category?: string
}

export interface DialogApi {
  alert(options: { title: string; message: string }): Promise<void>
  confirm(options: { title: string; message: string; label?: { confirm?: string; cancel?: string } }): Promise<boolean | undefined>
  prompt(options: { title: string; description?: string; placeholder?: string; value?: string }): Promise<string | undefined>
  select(options: {
    title: string
    placeholder?: string
    options: readonly DialogSelectOption[]
  }): Promise<string | undefined>
}

export interface ToastApi {
  show(options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error" }): void
}

export interface KeymapLayer {
  mode?: string
  enabled?: boolean | (() => boolean)
  priority?: number
  commands?: readonly {
    id?: string
    title?: string
    description?: string
    group?: string
    palette?: true
    slash?: { name: string; aliases?: string[]; arguments?: true }
    run: (input?: string) => void | Promise<void>
  }[]
}

export interface V2TuiContext {
  options: Readonly<Record<string, unknown>>
  client: {
    rpc: { call(input: { rpcID: string; method: string; input?: unknown }): Promise<RpcResult> }
  }
  ui: {
    dialog: DialogApi
    toast: ToastApi
    panel: { open(name: string, options?: { presentation?: "panel" | "fullscreen" }): boolean }
  }
  keymap: { layer(factory: () => KeymapLayer): void }
}

const FLAVOR_OPTIONS: readonly DialogSelectOption[] = Object.values(FLAVORS).map(spec => ({
  title: spec.label,
  value: spec.flavor,
  description: spec.description,
}))

const SIMPLE_OPTIONS: readonly DialogSelectOption[] = [
  {
    title: "Model id",
    value: "slug",
    description: "Short name, for example gpt-4o. Works everywhere. Safe choice.",
  },
  {
    title: "Friendly name",
    value: "name",
    description: "The provider's own label, when it offers one.",
  },
]

async function call<T>(ctx: V2TuiContext, method: string, input?: unknown): Promise<T> {
  // The RPC endpoint rejects a missing `input` with 400 "Expected object", so an
  // empty object must be sent explicitly for methods that take no arguments.
  const result = await ctx.client.rpc.call({ rpcID: RPC_ID, method, input: input ?? {} })
  return result.output as T
}

function fail(ctx: V2TuiContext, message: string): void {
  ctx.ui.toast.show({ title: "Custom providers", message, variant: "error" })
}

function done(ctx: V2TuiContext, message: string): void {
  ctx.ui.toast.show({ title: "Custom providers", message, variant: "success" })
}

function statusSuffix(provider: ProviderRow): string {
  return provider.pending > 0 ? ` (${provider.pending} new model(s) found — run /reload-models to add them)` : ""
}

function cancelled(ctx: V2TuiContext): void {
  ctx.ui.toast.show({ title: "Custom providers", message: "Cancelled. Nothing was changed.", variant: "info" })
}

async function pickProvider(ctx: V2TuiContext): Promise<ProviderRow | undefined> {
  const { providers } = await call<{ providers: ProviderRow[] }>(ctx, "list")
  if (providers.length === 0) {
    ctx.ui.toast.show({
      message: "You have no custom providers yet. Run /add-provider to add your first one.",
      variant: "warning",
    })
    return undefined
  }
  const selected = await ctx.ui.dialog.select({
    title: "Which provider?",
    options: providers.map(provider => ({
      title: provider.id,
      value: provider.id,
      description: `${provider.baseURL} — ${provider.models} model(s)${statusSuffix(provider)}`,
    })),
  })
  if (!selected) cancelled(ctx)
  return providers.find(provider => provider.id === selected)
}

async function askApiKey(ctx: V2TuiContext, title: string): Promise<string | undefined> {
  return ctx.ui.dialog.prompt({
    title,
    description:
      "Paste the key you got from your provider (it often starts with sk-). Most providers need one. " +
      "It is saved in opencode's secure key store, never shown again, and you can replace it any time with /edit-provider. " +
      "Leave empty only for local servers like Ollama.",
  })
}
async function promptManualAdd(
  ctx: V2TuiContext,
  input: { providerId: string; baseURL: string; flavor: string; apiKey?: string; displayStyle: string },
  providerId: string,
): Promise<void> {
  for (;;) {
    const modelIds = await ctx.ui.dialog.prompt({
      title: "Add models manually",
      description: "Enter one or more model ids separated by commas. Find these ids on your provider's setup page.",
      placeholder: "model-a, model-b",
    })
    if (modelIds === undefined) {
      cancelled(ctx)
      return
    }
    const manual = await call<ManualAddResult>(ctx, "manualAdd", { ...input, modelIds })
    if (manual.status === "ok") {
      await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: manual.message })
      return
    }
    await ctx.ui.dialog.alert({ title: "Check the model ids", message: manual.message })
  }
}

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/

// Repair the URL mistakes beginners actually make, so a near-miss is offered back instead of rejected.
function repairBaseURL(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed || isValidUrl(trimmed)) return undefined
  if (/^https?:\/\//i.test(trimmed)) return undefined
  if (/^localhost([:/]|$)/i.test(trimmed) || /^127\.0\.0\.1([:/]|$)/i.test(trimmed) || /^\d+\.\d+\.\d+\.\d+([:/]|$)/.test(trimmed)) {
    return `http://${trimmed}`
  }
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/|:|$)/i.test(trimmed)) return `https://${trimmed}`
  return undefined
}

async function wizardAdd(ctx: V2TuiContext): Promise<void> {
  let providerId = await ctx.ui.dialog.prompt({
    title: "Step 1 of 5 — Name for this provider",
    description:
      "Any short name you will recognise later. Letters, numbers, hyphens and underscores only. Example: my-proxy",
    placeholder: "my-proxy",
  })
  if (!providerId) {
    cancelled(ctx)
    return
  }
  providerId = providerId.trim()
  if (!ID_PATTERN.test(providerId)) {
    fail(
      ctx,
      `'${providerId}' cannot be used as a name. Use only letters, numbers, hyphens and underscores — for example my-proxy. Run /add-provider to start again.`,
    )
    return
  }
  // Reusing a built-in provider name would rewrite that provider's settings, so offer a safe name instead.
  const clash = collisionSuggestion(providerId)
  if (clash) {
    const use = await ctx.ui.dialog.confirm({
      title: "That name is already used by a built-in provider",
      message: `'${providerId}' belongs to an opencode built-in provider. Using it may change your existing ${providerId} setup.\n\nUse '${clash}' instead?`,
      label: { confirm: `Use ${clash}`, cancel: "Go back" },
    })
    if (!use) {
      cancelled(ctx)
      return
    }
    providerId = clash
  }
  // Replacing an existing provider of ours would silently drop its models, so confirm first.
  const existing = await call<{ providers: Array<{ id: string }> }>(ctx, "list").catch(() => undefined)
  if (existing?.providers?.some(entry => entry.id === providerId)) {
    const replace = await ctx.ui.dialog.confirm({
      title: "You already have a provider with this name",
      message: `Adding '${providerId}' again replaces the one you have now, including its model list.\n\nReplace it?`,
      label: { confirm: "Replace it", cancel: "Go back" },
    })
    if (!replace) {
      cancelled(ctx)
      return
    }
  }

  let baseURL: string | undefined
  for (;;) {
    baseURL = await ctx.ui.dialog.prompt({
      title: "Step 2 of 5 — Base URL",
      description:
        "Paste the address your provider gives you for API access. It is usually on their setup page, labelled \"Base URL\" or \"API endpoint\", and looks like https://api.example.com/v1. " +
        "Something running on this computer can use http://localhost:11434/v1.",
      placeholder: "https://api.example.com/v1",
    })
    if (!baseURL) {
      cancelled(ctx)
      return
    }
    const repaired = repairBaseURL(baseURL)
    if (repaired) {
      const use = await ctx.ui.dialog.confirm({
        title: "Did you mean this address?",
        message: `'${baseURL}' is missing the start of the address.\n\nUse '${repaired}' instead?`,
        label: { confirm: "Use this address", cancel: "Type it again" },
      })
      if (use) {
        baseURL = repaired
        break
      }
      continue
    }
    if (isValidUrl(baseURL)) break
    await ctx.ui.dialog.alert({
      title: "That address could not be read",
      message:
        "It must start with https:// (or http:// for something on this computer) and look like https://api.example.com/v1.\n\nNothing was saved — please try again.",
    })
  }

  const flavor = await ctx.ui.dialog.select({
    title: "Step 3 of 5 — API type",
    placeholder: "Pick the first one if you are unsure",
    options: FLAVOR_OPTIONS,
  })
  if (!flavor) {
    cancelled(ctx)
    return
  }

  const apiKey = await askApiKey(ctx, "Step 4 of 5 — API key")
  if (apiKey === undefined) {
    cancelled(ctx)
    return
  }
  const displayStyle = await ctx.ui.dialog.select({
    title: "Step 5 of 5 — How should models appear in the model list?",
    options: SIMPLE_OPTIONS,
  })
  if (!displayStyle) {
    cancelled(ctx)
    return
  }
  const input = {
    providerId,
    baseURL,
    flavor,
    apiKey: apiKey || undefined,
    displayStyle,
  }

  if (flavor === "anthropic") {
    await ctx.ui.dialog.alert({
      title: "Anthropic needs model names",
      message:
        "Anthropic APIs cannot list their models here. Type the model names you use and they will be added with metadata from the public model database.",
    })
    await promptManualAdd(ctx, input, providerId)
    return
  }

  type ExtendedAddResult = AddProviderResult | { status: "confirm_endpoint_reuse"; usedBy: string[]; message: string; detail?: string }
  let result = await call<ExtendedAddResult>(ctx, "add", input)
  while (result.status !== "ok") {
    if (result.status === "invalid") {
      await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: result.message })
      return
    }
    if (result.status === "confirm_endpoint_reuse") {
      const confirmed = await ctx.ui.dialog.confirm({
        title: "That address is already in use",
        message: `This address is already used by: ${result.usedBy.join(", ")}.

Add another provider on the same address?`,
        label: { confirm: "Add it anyway", cancel: "Cancel" },
      })
      if (confirmed) {
        result = await call<ExtendedAddResult>(ctx, "add", { ...input, confirmReuse: true })
        continue
      }
      cancelled(ctx)
      return
    }
    const action = await ctx.ui.dialog.select({
      title: "Could not get the provider's model list",
      placeholder: result.message,
      options: [
        { title: "Try again", value: "retry", description: "Check the address and key, then try the model list again." },
        { title: "Add models manually", value: "manual", description: "Type the model ids from your provider's setup page." },
        { title: "Cancel", value: "cancel", description: "Nothing will be saved." },
      ],
    })
    if (!action || action === "cancel") {
      cancelled(ctx)
      return
    }
    if (action === "retry") {
      result = await call<ExtendedAddResult>(ctx, "add", input)
      continue
    }
    await promptManualAdd(ctx, input, providerId)
    return
  }
  await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: result.message })
}

async function wizardCatalogAdd(ctx: V2TuiContext): Promise<void> {
  const { sites } = await call<{ sites: SiteRow[] }>(ctx, "catalog.list")
  if (sites.length === 0) {
    fail(ctx, "The built-in catalog is empty, so there is nothing to pick. Use /add-provider instead.")
    return
  }
  const site = await ctx.ui.dialog.select({
    title: "Pick a provider from the catalog",
    placeholder: "You still need that provider's API key",
    options: sites.map(entry => ({
      title: entry.name,
      value: entry.id,
      description: `${entry.modelCount} model(s) available`,
    })),
  })
  if (!site) {
    cancelled(ctx)
    return
  }
  const providerId = await ctx.ui.dialog.prompt({
    title: "Name for this provider",
    description: "Any short name you will recognise later. Letters, numbers, hyphens and underscores only.",
    placeholder: site,
    value: site,
  })
  if (!providerId) {
    cancelled(ctx)
    return
  }
  const models = await ctx.ui.dialog.prompt({
    title: "Which models? (optional)",
    description:
      "Type model names separated by commas, for example claude-sonnet-4-5, gpt-4o. " +
      "Leave empty to add every model this provider offers — that is the safe choice.",
  })
  const apiKey = await askApiKey(ctx, "API key for this provider (paste it if you have one)")
  const { message } = await call<{ message: string }>(ctx, "catalog.add", {
    site,
    providerId,
    models: models || undefined,
    apiKey: apiKey || undefined,
  })
  await ctx.ui.dialog.alert({ title: `Add from catalog: ${providerId}`, message })
}

async function wizardReprobe(ctx: V2TuiContext): Promise<void> {
  const provider = await pickProvider(ctx)
  if (!provider) return
  const { message } = await call<{ message: string }>(ctx, "reprobe", { providerId: provider.id })
  await ctx.ui.dialog.alert({ title: `Check for new models: ${provider.id}`, message })
}

async function wizardApplyReconcile(ctx: V2TuiContext): Promise<void> {
  const provider = await pickProvider(ctx)
  if (!provider) return
  const { message } = await call<{ message: string }>(ctx, "reprobe", { providerId: provider.id })
  // Show what was found first: the select dialog cannot be trusted to display a long placeholder.
  await ctx.ui.dialog.alert({ title: `What was found for ${provider.id}`, message })
  const choice = await ctx.ui.dialog.select({
    title: "Apply these changes?",
    options: [
      {
        title: "Apply everything",
        value: "apply",
        description: "Add the new models. Models that disappeared stay in your list.",
      },
      { title: "Keep what I have", value: "keep", description: "Change nothing" },
    ],
  })
  if (!choice) {
    cancelled(ctx)
    return
  }
  const applied = await call<{ message: string }>(ctx, "apply", { providerId: provider.id, mode: choice })
  await ctx.ui.dialog.alert({ title: `Update ${provider.id}`, message: applied.message })
}

async function wizardEdit(ctx: V2TuiContext): Promise<void> {
  const provider = await pickProvider(ctx)
  if (!provider) return
  const flavorLabel = FLAVORS[provider.flavor as keyof typeof FLAVORS]?.label ?? provider.flavor
  const styleLabel = provider.displayStyle === "name" ? "Friendly name" : "Model id"
  const field = await ctx.ui.dialog.select({
    title: `What do you want to change for ${provider.id}?`,
    options: [
      { title: "Base URL", value: "baseURL", description: `Currently: ${provider.baseURL}` },
      { title: "API type", value: "flavor", description: `Currently: ${flavorLabel}` },
      { title: "How models are listed", value: "displayStyle", description: `Currently: ${styleLabel}` },
      { title: "API key", value: "apiKey", description: "Replace the saved key" },
    ],
  })
  if (!field) {
    cancelled(ctx)
    return
  }
  let value: string | undefined
  if (field === "flavor") {
    value = await ctx.ui.dialog.select({ title: "API type", options: FLAVOR_OPTIONS })
  } else if (field === "displayStyle") {
    value = await ctx.ui.dialog.select({ title: "How should models appear in the model list?", options: SIMPLE_OPTIONS })
  } else if (field === "apiKey") {
    value = await ctx.ui.dialog.prompt({
      title: "New API key",
      description: "Paste the new key. Press Esc to keep the current one. It is saved securely and can be replaced again later.",
    })
  } else {
    value = await ctx.ui.dialog.prompt({
      title: "New Base URL",
      description: "Must start with https:// (or http:// for something on this computer) and usually ends in /v1",
      value: provider.baseURL,
    })
  }
  if (value === undefined || value === "") {
    cancelled(ctx)
    return
  }
  const { message } = await call<{ message: string }>(ctx, "edit", {
    providerId: provider.id,
    [field]: value,
  })
  await ctx.ui.dialog.alert({ title: `Edit ${provider.id}`, message })
}

async function wizardDelete(ctx: V2TuiContext): Promise<void> {
  const provider = await pickProvider(ctx)
  if (!provider) return
  const confirmed = await ctx.ui.dialog.confirm({
    title: "Remove this provider?",
    message: `Remove '${provider.id}' and its ${provider.models} model(s)?\n\nThis cannot be undone. Your other opencode settings are not touched. You can add it again later with /add-provider.`,
    label: { confirm: "Remove it", cancel: "Keep it" },
  })
  if (!confirmed) {
    cancelled(ctx)
    return
  }
  const { message } = await call<{ message: string }>(ctx, "remove", { providerId: provider.id })
  done(ctx, message)
}

async function wizardRefresh(ctx: V2TuiContext): Promise<void> {
  const { message } = await call<{ message: string }>(ctx, "refresh")
  done(ctx, message)
}

async function wizardList(ctx: V2TuiContext): Promise<void> {
  const { providers } = await call<{ providers: ProviderRow[] }>(ctx, "list")
  const message = providers.length
    ? providers
        .map(provider =>
          provider.models === 0
            ? `${provider.id} — NOT READY (no models yet)\n  ${provider.baseURL}\n  Fix it with /edit-provider (check the URL and API key), then /reload-models`
            : `${provider.id} — ${provider.models} model(s) ready${statusSuffix(provider)}\n  ${provider.baseURL}`,
        )
        .join("\n\n")
    : "You have no custom providers yet. Run /add-provider to add your first one."
  await ctx.ui.dialog.alert({ title: "Your custom providers", message })
}

const COMMANDS = [
  { name: "add-provider", title: "Add a provider", description: "Set up a new API provider step by step", run: wizardAdd },
  { name: "list-custom-providers", title: "List my providers", description: "Show every custom provider and its models", run: wizardList },
  {
    name: "check-for-new-models",
    aliases: ["reprobe-models"],
    title: "Check for new models",
    description: "Ask your provider whether it has new models",
    run: wizardReprobe,
  },
  { name: "reload-models", title: "Reload all models", description: "Refresh every provider from its own address", run: wizardRefresh },
  { name: "add-known-provider", title: "Add a known provider", description: "Pick a provider from the built-in list", run: wizardCatalogAdd },
  { name: "review-model-changes", aliases: ["apply-reconcile"], title: "Review model changes", description: "See what changed and choose what to keep", run: wizardApplyReconcile },
  { name: "edit-provider", title: "Edit a provider", description: "Change its address, API type, key, or how models are named", run: wizardEdit },
  { name: "delete-provider", title: "Delete a provider", description: "Remove a provider and its models", run: wizardDelete },
] as const

export const setup = (ctx: V2TuiContext): void => {
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: COMMANDS.map(command => ({
      id: `${pluginId}.${command.name}`,
      title: command.title,
      description: command.description,
      group: "Custom providers",
      palette: true as const,
      slash: {
        name: command.name,
        aliases: "aliases" in command ? [...command.aliases] : undefined,
      },
      run: async () => {
        try {
          await command.run(ctx)
        } catch (error) {
          // Errors must name the next action; raw messages leave a beginner stuck.
          await ctx.ui.dialog.alert({
            title: "Something went wrong",
            message:
              "The action did not finish and nothing was changed.\n" +
              "Run /list-custom-providers to see the current state, then try again.\n\n" +
              `Technical detail (for bug reports): ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      },
    })),
  }))
}
