import { FLAVORS, collisionSuggestion } from "./flavors.js"
import { parseTokenEdit, REASONING_LEVELS, reasoningLabel, resolveTokenEdit, type TokenEdit } from "./model-fields.js"
import { isValidUrl, sanitizeDialogText } from "./security.js"
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
  return provider.pending > 0 ? ` (${provider.pending} new model(s) found: run /reload-models to add them)` : ""
}

function cancelled(ctx: V2TuiContext): void {
  ctx.ui.toast.show({ title: "Custom providers", message: "Cancelled. Nothing was changed.", variant: "info" })
}

interface ModelRow {
  id: string
  name: string
  reasoning: string
  reasoningLabel: string
  image: boolean
  context?: number
  output?: number
}

/** Prompts for a token count until it parses, or the user backs out. Returns the
 * edit rather than a number, because a kept value and a cancellation are both
 * undefined once resolved, and the caller has to tell those apart. */
async function askToken(ctx: V2TuiContext, title: string, current: number | undefined): Promise<TokenEdit | undefined> {
  const placeholder = current === undefined ? "e.g. 128000 (blank = leave unset)" : `current: ${current} (blank = keep, 0 = clear)`
  for (;;) {
    const raw = await ctx.ui.dialog.prompt({ title, placeholder })
    if (raw === undefined) return undefined
    const edit = parseTokenEdit(raw)
    if (edit === null) {
      ctx.ui.toast.show({ message: "Enter a whole number of tokens, or 0 to clear it.", variant: "warning" })
      continue
    }
    return edit
  }
}

async function editOneModel(ctx: V2TuiContext, providerId: string, model: ModelRow): Promise<void> {
  const reasoning = await ctx.ui.dialog.select({
    title: `Thinking level for ${model.id}`,
    options: REASONING_LEVELS.map(level => ({
      title: reasoningLabel(level),
      value: level,
      description: level === model.reasoning ? "Currently set" : undefined,
    })),
  })
  if (reasoning === undefined) {
    cancelled(ctx)
    return
  }
  const image = await ctx.ui.dialog.select({
    title: `Can ${model.id} read images?`,
    options: [
      { title: "Yes", value: "yes", description: "Sends text and images" },
      { title: "No", value: "no", description: "Sends text only" },
    ],
  })
  if (image === undefined) {
    cancelled(ctx)
    return
  }
  const contextEdit = await askToken(ctx, `Context window for ${model.id}`, model.context)
  if (contextEdit === undefined) {
    cancelled(ctx)
    return
  }
  const outputEdit = await askToken(ctx, `Longest reply for ${model.id}`, model.output)
  if (outputEdit === undefined) {
    cancelled(ctx)
    return
  }
  const context = resolveTokenEdit(model.context, contextEdit)
  const output = resolveTokenEdit(model.output, outputEdit)
  const { message } = await call<{ message: string }>(ctx, "editModel", {
    providerId,
    modelId: model.id,
    reasoning,
    image: image === "yes",
    context,
    output,
  })
  await ctx.ui.dialog.alert({ title: `Edit ${model.id}`, message })
}

async function wizardEditModels(ctx: V2TuiContext, providerId: string): Promise<void> {
  const { models, status, message } = await call<{ models: ModelRow[]; status: string; message: string }>(ctx, "listModels", { providerId })
  if (status !== "ok") {
    fail(ctx, message)
    return
  }
  if (models.length === 0) {
    ctx.ui.toast.show({
      message: `'${providerId}' has no models yet. Fix its address and key with /edit-provider, then run /reload-models.`,
      variant: "warning",
    })
    return
  }
  for (;;) {
    const picked = await ctx.ui.dialog.select({
      title: `Which model of ${providerId}?`,
      options: [
        ...models.map(model => ({
          title: model.name === model.id ? model.id : `${model.name} (${model.id})`,
          value: model.id,
          description: `${model.reasoningLabel}; images ${model.image ? "yes" : "no"}; context ${model.context ?? "unset"}; longest reply ${model.output ?? "unset"}`,
        })),
        { title: "Done", value: "", description: "Go back" },
      ],
    })
    if (!picked) {
      cancelled(ctx)
      return
    }
    if (picked === "") return
    const model = models.find(item => item.id === picked)
    if (model) await editOneModel(ctx, providerId, model)
    const again = await call<{ models?: ModelRow[] }>(ctx, "listModels", { providerId })
    models.splice(0, models.length, ...(again?.models ?? []))
  }
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
      description: `${provider.baseURL}: ${provider.models} model(s)${statusSuffix(provider)}`,
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
      "Leave empty only for local servers like Ollama. Press Esc to cancel: nothing is saved until the last step.",
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
    // A name clash is not a bad model id, so it must not be reported as one: the old
    // wording sent the user back to retype ids that were never the problem.
    if (manual.status === "confirm_replace") {
      const confirmed = await ctx.ui.dialog.confirm({
        title: `${providerId} already exists`,
        message: manual.message + "\n\nReplace it?",
        label: { confirm: "Replace it", cancel: "Keep what I have" },
      })
      if (!confirmed) {
        cancelled(ctx)
        return
      }
      const replaced = await call<ManualAddResult>(ctx, "manualAdd", { ...input, modelIds, confirmReplace: true })
      await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: replaced.message })
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
    title: "Step 1 of 5: Name for this provider",
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
      `'${providerId}' cannot be used as a name. Use only letters, numbers, hyphens and underscores: for example my-proxy. Run /add-provider to start again.`,
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
      title: "Step 2 of 5: Base URL",
      description:
        "Paste your provider's API address: it is on their setup page, labelled \"Base URL\" or \"API endpoint\". " +
        "It looks like https://api.example.com/v1. A local server like Ollama uses http://localhost:11434/v1.",
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
        "It must start with https:// (or http:// for a local server) and look like https://api.example.com/v1.\n\nNothing was saved: please try again.",
    })
  }

  const flavor = await ctx.ui.dialog.select({
    title: "Step 3 of 5: API type",
    placeholder: "Pick the first one if you are unsure",
    options: FLAVOR_OPTIONS,
  })
  if (!flavor) {
    cancelled(ctx)
    return
  }

  const apiKey = await askApiKey(ctx, "Step 4 of 5: API key")
  if (apiKey === undefined) {
    cancelled(ctx)
    return
  }
  const displayStyle = await ctx.ui.dialog.select({
    title: "Step 5 of 5: How should models appear in the model list?",
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
    if (result.status === "confirm_replace") {
      const confirmed = await ctx.ui.dialog.confirm({
        title: `${providerId} already exists`,
        message:
          `You already have a provider named '${providerId}'. Adding this one would replace its settings and its model list.\n\n` +
          "Replace it?",
        label: { confirm: "Replace it", cancel: "Keep what I have" },
      })
      if (confirmed) {
        result = await call<ExtendedAddResult>(ctx, "add", { ...input, confirmReplace: true })
        continue
      }
      cancelled(ctx)
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
      "Leave empty to add every model this provider offers: that is the safe choice.",
  })
  if (models === undefined) {
    cancelled(ctx)
    return
  }
  const apiKey = await askApiKey(ctx, "API key for this provider (paste it if you have one)")
  if (apiKey === undefined) {
    cancelled(ctx)
    return
  }
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
  // `changes` is the structured per-model diff; it is only present when the probe
  // succeeded, so its absence (or emptiness) means there is nothing to review.
  const probe = await call<{ message: string; changes?: { id: string; kind: string; detail: string }[] }>(ctx, "reprobe", {
    providerId: provider.id,
  })
  const { message } = probe
  const changes = probe.changes ?? []
  // Show what was found first: the select dialog cannot be trusted to display a long placeholder.
  await ctx.ui.dialog.alert({ title: `What was found for ${provider.id}`, message })
  // Review first, then the all-or-nothing pair, and keep before apply. The plan in
  // docs/ux-analysis/final-plan.md asks for exactly this: the safest option should be the
  // one under the cursor, not the one that rewrites everything.
  const options = [
    {
      title: "Review one by one",
      value: "review",
      description: "Decide each change on its own instead of taking all or none.",
    },
  ]
  if (changes.length === 0) options.pop()
  options.push({ title: "Keep what I have", value: "keep", description: "Change nothing" })
  options.push({
    title: "Apply everything",
    value: "apply",
    description: "Add the new models. Models that disappeared stay in your list.",
  })
  const choice = await ctx.ui.dialog.select({ title: "Apply these changes?", options })
  if (!choice) {
    cancelled(ctx)
    return
  }
  if (choice === "review") {
    // The comment this replaces claimed an Esc keeps the unrecorded models via absent-key
    // semantics. That reasoning is unreachable: the guard below returns before any apply
    // call, so no partial decision set is ever sent. Stated plainly so nobody later treats
    // it as a safety proof when changing the loop to send partial decisions.
    const decisions: Record<string, "apply" | "keep"> = {}
    for (const change of changes) {
      // A vanished model is deleted when the decision is anything but "keep", so the row
      // has to say that. Labelling it "Take the new values" invited the user to delete a
      // model while believing they were accepting an update.
      const vanishing = change.kind === "removed"
      const decision = await ctx.ui.dialog.select({
        title: sanitizeDialogText(`${change.id} (${change.kind})`),
        options: vanishing
          ? [
              { title: "Keep this model", value: "keep", description: "Leave it in your list as it is now." },
              { title: "Remove this model", value: "apply", description: sanitizeDialogText(`Delete it: ${change.detail}`) },
            ]
          : [
              { title: "Apply this change", value: "apply", description: sanitizeDialogText(`Take the new values: ${change.detail}`) },
              { title: "Keep what I have", value: "keep", description: "Leave this model exactly as it is now." },
            ],
      })
      if (decision !== "apply" && decision !== "keep") {
        cancelled(ctx)
        return
      }
      decisions[change.id] = decision
    }
    const applied = await call<{ message: string }>(ctx, "apply", {
      providerId: provider.id,
      decisions: JSON.stringify(decisions),
    })
    await ctx.ui.dialog.alert({ title: `Update ${provider.id}`, message: applied.message })
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
      { title: "A model's settings", value: "model", description: "Change thinking, image input, or token limits" },
    ],
  })
  if (!field) {
    cancelled(ctx)
    return
  }
  if (field === "model") {
    await wizardEditModels(ctx, provider.id)
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
      description: "Must start with https:// (or http:// for a local server) and usually ends in /v1",
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
  // remove reports a failure in its message rather than by throwing, so a missing
  // provider would otherwise be announced with a success toast. The provider list was
  // just read, so this only happens when it changed underneath us.
  if (/^There is no provider named/.test(message)) fail(ctx, message)
  else done(ctx, message)
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
            ? `${provider.id}: NOT READY (no models yet)\n  ${provider.baseURL}\n  Fix it with /edit-provider (check the URL and API key), then /reload-models`
            : `${provider.id}: ${provider.models} model(s) ready${statusSuffix(provider)}\n  ${provider.baseURL}`,
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
