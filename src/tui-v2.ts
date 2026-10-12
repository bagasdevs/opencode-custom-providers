import { FLAVORS, collisionSuggestion } from "./flavors.js"
import { parseTokenEdit, REASONING_LEVELS, reasoningLabel, resolveTokenEdit, type TokenEdit } from "./model-fields.js"
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
    description: "Short id, like gpt-4o. Works everywhere.",
  },
  {
    title: "Friendly name",
    value: "name",
    description: "The provider's own label, when it has one.",
  },
]

async function call<T>(ctx: V2TuiContext, method: string, input?: unknown): Promise<T> {
  // The RPC endpoint rejects a missing `input` with 400 "Expected object", so an
  // empty object must be sent explicitly for methods that take no arguments.
  const result = await ctx.client.rpc.call({ rpcID: RPC_ID, method, input: input ?? {} })
  return result.output as T
}

/** Plain text for a thrown value: the message for Errors and message-bearing objects, never "[object Object]". */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message
  }
  return "unknown error"
}

function fail(ctx: V2TuiContext, message: string): void {
  ctx.ui.toast.show({ title: "Custom providers", message, variant: "error" })
}

function done(ctx: V2TuiContext, message: string): void {
  ctx.ui.toast.show({ title: "Custom providers", message, variant: "success" })
}

function statusSuffix(provider: ProviderRow): string {
  return provider.pending > 0 ? ` (${provider.pending} new: pick "Reload all models")` : ""
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
  endpointDiffers?: boolean
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
  // Four steps, and Esc inside one goes back to the previous step instead of dropping the
  // whole edit. Only Esc at the first step leaves, and that is the one that reports it.
  let reasoning = ""
  let image = ""
  let contextEdit: TokenEdit | undefined
  let outputEdit: TokenEdit | undefined
  for (let step = 1; step <= 4; ) {
    if (step === 1) {
      const answer = await ctx.ui.dialog.select({
        title: `Thinking level for ${model.id}`,
        options: REASONING_LEVELS.map(level => ({
          title: reasoningLabel(level),
          value: level,
          description: level === model.reasoning ? "Currently set" : undefined,
        })),
      })
      if (answer === undefined) {
        cancelled(ctx)
        return
      }
      reasoning = answer
      step = 2
      continue
    }
    if (step === 2) {
      const answer = await ctx.ui.dialog.select({
        title: `Can ${model.id} read images?`,
        options: [
          { title: "Yes", value: "yes", description: "Sends text and images" },
          { title: "No", value: "no", description: "Sends text only" },
        ],
      })
      if (answer === undefined) {
        step = 1
        continue
      }
      image = answer
      step = 3
      continue
    }
    if (step === 3) {
      const answer = await askToken(ctx, `Context window for ${model.id}`, model.context)
      if (answer === undefined) {
        step = 2
        continue
      }
      contextEdit = answer
      step = 4
      continue
    }
    const answer = await askToken(ctx, `Longest reply for ${model.id}`, model.output)
    if (answer === undefined) {
      step = 3
      continue
    }
    outputEdit = answer
    break
  }
  // askToken only returns once the prompt parsed, so both edits are present here.
  if (contextEdit === undefined || outputEdit === undefined) {
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
      message: `'${providerId}' has no models yet. Choose "Reload all models" first.`,
      variant: "warning",
    })
    return
  }
  for (;;) {
    const picked = await ctx.ui.dialog.select({
      title: `Edit ${providerId} > Model settings: which model?`,
      options: [
        ...models.map(model => ({
          title: model.name,
          value: model.id,
          description: `Thinking: ${model.reasoningLabel}${model.image ? ", reads images" : ""}`,
        })),
        { title: "Done", value: "", description: "Go back to the menu" },
      ],
    })
    if (picked === "") return
    // Only Esc means "go back quietly": this picker is a submenu of the edit wizard, so a
    // cancel toast here would claim nothing changed right after an edit landed, and the
    // wizard's own Esc already reports the real cancellation. The "Done" option uses the
    // empty string, which the old falsy check swallowed before it could return.
    if (picked === undefined) {
      cancelled(ctx)
      return
    }
    const model = models.find(item => item.id === picked)
    if (model?.endpointDiffers) {
      const choice = await ctx.ui.dialog.select({
        title: `Edit ${providerId} > ${model.id}`,
        options: [
          { title: "Use the endpoint's values", value: "endpoint", description: "Take the context and reply limits the provider reports" },
          { title: "Change its settings", value: "edit", description: "Set thinking level, images and limits by hand" },
        ],
      })
      if (choice === undefined) {
        cancelled(ctx)
        return
      }
      if (choice === "endpoint") {
        const { status, message } = await call<{ status: string; message: string }>(ctx, "useEndpointValues", { providerId, modelId: model.id })
        if (status === "ok") done(ctx, `Updated ${model.id} from the endpoint`)
        else fail(ctx, message)
      } else {
        await editOneModel(ctx, providerId, model)
      }
    } else if (model) {
      await editOneModel(ctx, providerId, model)
    }
    const again = await call<{ models?: ModelRow[] }>(ctx, "listModels", { providerId })
    models.splice(0, models.length, ...(again?.models ?? []))
  }
}

async function pickProvider(ctx: V2TuiContext, where: string): Promise<ProviderRow | undefined> {
  const { providers } = await call<{ providers: ProviderRow[] }>(ctx, "list")
  if (providers.length === 0) {
    ctx.ui.toast.show({
      message: "You have no providers yet. Choose 'Add a provider' first.",
      variant: "warning",
    })
    return undefined
  }
  const selected = await ctx.ui.dialog.select({
    title: `${where} > Pick a provider`,
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
      "Paste the key from your provider's site (often starts with sk-). Saved securely. " +
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
      title: "Add a provider > Type the model ids",
      description: "Model ids, separated by commas. Example: gpt-4o, gpt-4o-mini",
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
        title: `Add a provider > ${providerId} already exists`,
        message: manual.message + "\n\nReplace it?",
        label: { confirm: "Replace it", cancel: "Keep it" },
      })
      if (!confirmed) {
        cancelled(ctx)
        return
      }
      const replaced = await call<ManualAddResult>(ctx, "manualAdd", { ...input, modelIds, confirmReplace: true })
      await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: replaced.message })
      return
    }
    await ctx.ui.dialog.alert({ title: "Add a provider > Check the model ids", message: manual.message })
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

// One entry point for adding: ask where the provider comes from, then run that wizard.
async function wizardAddSource(ctx: V2TuiContext): Promise<void> {
  const source = await ctx.ui.dialog.select({
    title: "Add a provider > Where is it from?",
    options: [
      { title: "My own API", value: "own", description: "You type its address and key." },
      { title: "Built-in list", value: "catalog", description: "Pick from a ready-made list." },
    ],
  })
  if (source === "catalog") await wizardCatalogAdd(ctx)
  else if (source === "own") await wizardAdd(ctx)
  else cancelled(ctx)
}

async function wizardAdd(ctx: V2TuiContext): Promise<void> {
  // Esc inside a step goes back one step, so a mistake at step 4 does not cost the user
  // steps 1 to 3. Only Esc at step 1 leaves the wizard and reports the cancellation.
  let providerId = ""
  let baseURL = ""
  let flavor = ""
  let apiKey: string | undefined
  let displayStyle = ""
  for (let step = 1; step <= 5; ) {
    if (step === 1) {
      const answer = await ctx.ui.dialog.prompt({
        title: "Add a provider > Step 1 of 5: Name",
        description: "A short name you will recognise later. Letters, numbers, - and _ only. Example: my-proxy",
        placeholder: "my-proxy",
        value: providerId || undefined,
      })
      if (!answer) {
        // The first step: there is nothing behind it, so this is the only real exit.
        cancelled(ctx)
        return
      }
      const trimmed = answer.trim()
      if (!ID_PATTERN.test(trimmed)) {
        fail(
          ctx,
          `'${trimmed}' cannot be used as a name. Use only letters, numbers, hyphens and underscores: for example my-proxy. Run /custom-providers to start again.`,
        )
        continue
      }
      // Reusing a built-in provider name would rewrite that provider's settings, so offer a safe name instead.
      const clash = collisionSuggestion(trimmed)
      if (clash) {
        const use = await ctx.ui.dialog.confirm({
          title: "Add a provider > Step 1 of 5: Name taken",
          message: `'${trimmed}' is already used by OpenCode. Use '${clash}' instead?`,
          label: { confirm: `Use ${clash}`, cancel: "Type another" },
        })
        // "Go back" means the name step, not the whole wizard.
        if (!use) continue
        providerId = clash
      } else {
        providerId = trimmed
      }
      // Replacing an existing provider of ours would silently drop its models, so confirm first.
      const existing = await call<{ providers: Array<{ id: string }> }>(ctx, "list").catch(() => undefined)
      if (existing?.providers?.some(entry => entry.id === providerId)) {
        const replace = await ctx.ui.dialog.confirm({
          title: "Add a provider > Step 1 of 5: Name already used",
          message: `You already have a provider named '${providerId}'. Replace it? Its models will be replaced too.`,
          label: { confirm: "Replace it", cancel: "Type another" },
        })
        if (!replace) continue
      }
      step = 2
      continue
    }

    if (step === 2) {
      const answer = await ctx.ui.dialog.prompt({
        title: "Add a provider > Step 2 of 5: Base URL",
        description:
          "Copy the Base URL from your provider's setup page. Example: https://api.example.com/v1",
        placeholder: "https://api.example.com/v1",
        value: baseURL || undefined,
      })
      if (!answer) {
        step = 1
        continue
      }
      let candidate = answer
      const repaired = repairBaseURL(candidate)
      if (repaired) {
        const use = await ctx.ui.dialog.confirm({
          title: "Add a provider > Step 2 of 5: Did you mean this?",
          message: `'${candidate}' is missing the start of the address.\n\nUse '${repaired}' instead?`,
          label: { confirm: "Use it", cancel: "Type it again" },
        })
        // "Type it again" re-asks this same step.
        if (!use) continue
        candidate = repaired
      }
      if (!isValidUrl(candidate)) {
        await ctx.ui.dialog.alert({
          title: "Add a provider > Step 2 of 5: Address not valid",
          message:
            "It must start with https:// (or http:// for a local server), like https://api.example.com/v1. Nothing was saved. Try again.",
        })
        continue
      }
      baseURL = candidate
      step = 3
      continue
    }

    if (step === 3) {
      const answer = await ctx.ui.dialog.select({
        title: "Add a provider > Step 3 of 5: API type",
        placeholder: "Not sure? Pick the first one.",
        options: FLAVOR_OPTIONS,
      })
      if (!answer) {
        step = 2
        continue
      }
      flavor = answer
      step = 4
      continue
    }

    if (step === 4) {
      const answer = await askApiKey(ctx, "Add a provider > Step 4 of 5: API key")
      if (answer === undefined) {
        step = 3
        continue
      }
      apiKey = answer
      step = 5
      continue
    }

    const answer = await ctx.ui.dialog.select({
      title: "Add a provider > Step 5 of 5: Model names",
      options: SIMPLE_OPTIONS,
    })
    if (!answer) {
      step = 4
      continue
    }
    displayStyle = answer
    break
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
      title: "Add a provider > Type the model ids",
      message:
        "Anthropic cannot list its models here. Type the model names you use, and their details are filled in automatically.",
    })
    await promptManualAdd(ctx, input, providerId)
    return
  }

  type ExtendedAddResult = AddProviderResult | { status: "confirm_endpoint_reuse"; usedBy: string[]; message: string; detail?: string }
  ctx.ui.toast.show({ title: "Custom providers", message: "Checking models, this can take a few seconds...", variant: "info" })
  let result = await call<ExtendedAddResult>(ctx, "add", input)
  while (result.status !== "ok") {
    if (result.status === "invalid") {
      await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: result.message })
      return
    }
    if (result.status === "confirm_replace") {
      const confirmed = await ctx.ui.dialog.confirm({
        title: `Add a provider > ${providerId} already exists`,
        message:
          `You already have a provider named '${providerId}'. Adding this one replaces its settings and models.\n\n` +
          "Replace it?",
        label: { confirm: "Replace it", cancel: "Keep it" },
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
        title: "Add a provider > Address already used",
        message: `This address is already used by: ${result.usedBy.join(", ")}.

Add this one anyway?`,
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
      title: "Add a provider > Could not load its models",
      placeholder: result.message,
      options: [
        { title: "Try again", value: "retry", description: "Check the address and key first." },
        { title: "Type the model ids", value: "manual", description: "Add the model names yourself." },
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
    fail(ctx, "The built-in catalog is empty, so there is nothing to pick. Use /custom-providers instead.")
    return
  }
  // Esc inside a step goes back one step; only Esc at the site picker leaves the wizard.
  let site = ""
  let providerId = ""
  let models: string | undefined
  let apiKey: string | undefined
  for (let step = 1; step <= 4; ) {
    if (step === 1) {
      const answer = await ctx.ui.dialog.select({
        title: "Add from built-in list > Step 1 of 4: Pick one",
        placeholder: "You will need that provider's API key.",
        options: sites.map(entry => ({
          title: entry.name,
          value: entry.id,
          description: `${entry.modelCount} model(s) available`,
        })),
      })
      if (!answer) {
        cancelled(ctx)
        return
      }
      site = answer
      step = 2
      continue
    }
    if (step === 2) {
      const answer = await ctx.ui.dialog.prompt({
        title: "Add from built-in list > Step 2 of 4: Name",
        description: "A short name you will recognise. Letters, numbers, - and _ only.",
        placeholder: site,
        value: providerId || site,
      })
      if (!answer) {
        step = 1
        continue
      }
      providerId = answer
      step = 3
      continue
    }
    if (step === 3) {
      const answer = await ctx.ui.dialog.prompt({
        title: "Add from built-in list > Step 3 of 4: Which models?",
        description:
          "Type names separated by commas, e.g. gpt-4o, gpt-4o-mini. Leave empty to add all of them.",
        value: models,
      })
      if (answer === undefined) {
        step = 2
        continue
      }
      models = answer
      step = 4
      continue
    }
    const answer = await askApiKey(ctx, "Add from built-in list > Step 4 of 4: API key")
    if (answer === undefined) {
      step = 3
      continue
    }
    apiKey = answer
    break
  }
  const { message } = await call<{ message: string }>(ctx, "catalog.add", {
    site,
    providerId,
    models: models || undefined,
    apiKey: apiKey || undefined,
  })
  await ctx.ui.dialog.alert({ title: `Add from built-in list > ${providerId}`, message })
}

// Esc at the menu is the only way out: an Esc or an empty value in an inner dialog
// returns to this loop, so the user can make several changes in one visit instead of
// restarting the wizard after every field.
async function wizardEdit(ctx: V2TuiContext): Promise<void> {
  const provider = await pickProvider(ctx, "Edit a provider")
  if (!provider) return
  for (;;) {
    const flavorLabel = FLAVORS[provider.flavor as keyof typeof FLAVORS]?.label ?? provider.flavor
    const styleLabel = provider.displayStyle === "name" ? "Friendly name" : "Model id"
    const field = await ctx.ui.dialog.select({
      title: `Edit ${provider.id} > What to change`,
      placeholder: "Pick one. Esc when you are done.",
      options: [
        { title: "Base URL", value: "baseURL", description: `Now: ${provider.baseURL}` },
        { title: "API key", value: "apiKey", description: "Replace the saved key" },
        { title: "API type", value: "flavor", description: `Now: ${flavorLabel}` },
        { title: "Model names", value: "displayStyle", description: `Now: ${styleLabel}` },
        { title: "Add models manually", value: "addManual", description: "Type model names yourself" },
        { title: "Delete models", value: "deleteModels", description: "Remove models from this provider" },
        { title: "Model settings", value: "model", description: "Thinking level, image support, length limits" },
        { title: "Rename", value: "rename", description: `Now: ${provider.id}` },
      ],
    })
    if (!field) {
      cancelled(ctx)
      return
    }
    if (field === "model") {
      await wizardEditModels(ctx, provider.id)
      continue
    }
    if (field === "deleteModels") {
      await wizardDeleteModels(ctx, provider.id)
      continue
    }
    if (field === "addManual") {
      await wizardAddManualModels(ctx, provider.id)
      continue
    }
    if (field === "apiKey") {
      const typed = await ctx.ui.dialog.prompt({
        title: `Edit ${provider.id} > New API key`,
        description: "Paste the new key. Leave empty to clear the saved key.",
      })
      if (typed === undefined) continue
      if (typed === "") {
        const confirmed = await ctx.ui.dialog.confirm({
          title: "Clear the API key",
          message: `Remove the saved API key for ${provider.id}? The provider will be called without a key.`,
          label: { confirm: "Clear it", cancel: "Keep it" },
        })
        if (!confirmed) continue
        const { message } = await call<{ message: string }>(ctx, "clearKey", { providerId: provider.id })
        done(ctx, message)
        continue
      }
      const { message } = await call<{ message: string }>(ctx, "edit", { providerId: provider.id, apiKey: typed })
      await ctx.ui.dialog.alert({ title: `Edit ${provider.id} > Saved`, message })
      continue
    }
    if (field === "rename") {
      await wizardRename(ctx, provider)
      continue
    }
    let value: string | undefined
    if (field === "flavor") {
      value = await ctx.ui.dialog.select({ title: `Edit ${provider.id} > API type`, options: FLAVOR_OPTIONS })
    } else if (field === "displayStyle") {
      value = await ctx.ui.dialog.select({ title: `Edit ${provider.id} > Model names`, options: SIMPLE_OPTIONS })
    } else {
      value = await ctx.ui.dialog.prompt({
        title: `Edit ${provider.id} > New Base URL`,
        description: "Starts with https://. Often ends in /v1. Leave empty to keep it.",
        value: provider.baseURL,
      })
    }
    // Esc, or an empty value, means "nothing to change here": back to the menu, and no
    // RPC call, so an accidental keypress cannot write a half-finished value.
    if (value === undefined || value === "") continue
    const { message } = await call<{ message: string }>(ctx, "edit", {
      providerId: provider.id,
      [field]: value,
    })
    await ctx.ui.dialog.alert({ title: `Edit ${provider.id} > Saved`, message })
  }
}

// One text prompt for comma-separated ids, appended to the provider. Ids already present are
// skipped by the server, so retyping an existing model is harmless. Esc leaves quietly.
async function wizardAddManualModels(ctx: V2TuiContext, providerId: string): Promise<void> {
  const modelIds = await ctx.ui.dialog.prompt({
    title: `Edit ${providerId} > Add models manually`,
    description: "Model ids, separated by commas. Example: gpt-4o, gpt-4o-mini",
    placeholder: "model-a, model-b",
  })
  if (modelIds === undefined || modelIds.trim() === "") return
  const { status, message } = await call<{ status: string; message: string }>(ctx, "addModelIds", { providerId, modelIds })
  if (status === "ok") done(ctx, message)
  else fail(ctx, message)
}

// Pick one model at a time from a list. Each pick asks to confirm, then the list comes back
// without the deleted model, so several can be removed in one visit. Esc or "Done" leaves.
async function wizardDeleteModels(ctx: V2TuiContext, providerId: string): Promise<void> {
  for (;;) {
    const { models } = await call<{ models: ModelRow[] }>(ctx, "listModels", { providerId })
    if (models.length === 0) {
      ctx.ui.toast.show({ message: `'${providerId}' has no models left.`, variant: "info" })
      return
    }
    const picked = await ctx.ui.dialog.select({
      title: `Edit ${providerId} > Delete models`,
      placeholder: "Pick one model. Choose Done when you are finished.",
      options: [
        ...models.map(model => ({ title: model.name, value: model.id, description: model.id })),
        { title: "Done", value: "", description: "Go back to the menu" },
      ],
    })
    if (!picked) return
    const confirmed = await ctx.ui.dialog.confirm({
      title: `Edit ${providerId} > Delete ${picked}?`,
      message: `'${picked}' is removed from '${providerId}'. This cannot be undone.`,
      label: { confirm: "Delete it", cancel: "Keep it" },
    })
    if (!confirmed) continue
    const { status, message } = await call<{ status: string; message: string; deleted: number }>(ctx, "deleteModels", { providerId, modelIds: picked })
    if (status === "unknown_provider") {
      fail(ctx, message)
      return
    }
    if (status === "ok") {
      done(ctx, `Deleted '${picked}'.`)
      continue
    }
    await ctx.ui.dialog.alert({ title: `Edit ${providerId} > Delete models`, message })
  }
}

// Takes the live provider row so a successful rename keeps the wizard pointed at the
// new name for the rest of the visit.
async function wizardRename(ctx: V2TuiContext, provider: ProviderRow): Promise<void> {
  const raw = await ctx.ui.dialog.prompt({
    title: `Edit ${provider.id} > Rename`,
    description: "A new short name. Letters, numbers, - and _ only. Models and address stay as they are.",
    placeholder: "my-proxy",
  })
  if (raw === undefined || raw.trim() === "") return
  const newId = raw.trim()
  if (!ID_PATTERN.test(newId)) {
    fail(ctx, `'${newId}' cannot be used as a name. Use only letters, numbers, hyphens and underscores: for example my-proxy.`)
    return
  }
  if (newId === provider.id) {
    fail(ctx, `'${newId}' is already the name of this provider. Pick a different name.`)
    return
  }
  const confirmed = await ctx.ui.dialog.confirm({
    title: `Edit ${provider.id} > Rename to ${newId}?`,
    message: `Rename '${provider.id}' to '${newId}'? You will need to enter the API key again.`,
    label: { confirm: "Rename it", cancel: "Keep the name" },
  })
  if (!confirmed) return
  const { status, message } = await call<{ status: string; message: string }>(ctx, "renameProvider", { providerId: provider.id, newId })
  if (status === "ok") {
    provider.id = newId
    done(ctx, message)
    return
  }
  fail(ctx, message)
}

async function wizardDelete(ctx: V2TuiContext): Promise<void> {
  const provider = await pickProvider(ctx, "Delete a provider")
  if (!provider) return
  const confirmed = await ctx.ui.dialog.confirm({
    title: `Delete a provider > Delete ${provider.id}?`,
    message: `'${provider.id}' and its ${provider.models} model(s) are removed. This cannot be undone.`,
    label: { confirm: "Delete it", cancel: "Keep it" },
  })
  if (!confirmed) {
    cancelled(ctx)
    return
  }
  const { status, message } = await call<{ status: string; message: string }>(ctx, "remove", { providerId: provider.id })
  // remove reports a failure in its message rather than by throwing, so check the status
  // field: a missing provider or one that comes from the opencode config is not a success.
  if (status === "ok") done(ctx, message)
  else fail(ctx, message)
}

async function wizardRefresh(ctx: V2TuiContext): Promise<void> {
  ctx.ui.toast.show({ title: "Custom providers", message: "Checking models, this can take a few seconds...", variant: "info" })
  const { message } = await call<{ message: string }>(ctx, "refresh")
  done(ctx, message)
}

async function wizardList(ctx: V2TuiContext): Promise<void> {
  const { providers } = await call<{ providers: ProviderRow[] }>(ctx, "list")
  const message = providers.length
    ? providers
        .map(provider =>
          provider.models === 0
            ? `${provider.id}: no models yet\n  ${provider.baseURL}\n  Choose "Reload all models" to fetch them.`
            : `${provider.id}: ${provider.models} model(s) ready${statusSuffix(provider)}\n  ${provider.baseURL}`,
        )
        .join("\n\n")
    : "You have no providers yet. Choose 'Add a provider' to start."
  await ctx.ui.dialog.alert({ title: "List my providers", message })
}

async function wizardHub(ctx: V2TuiContext): Promise<void> {
  // One command replaces eight, so the menu has to come back after an action: that is what
  // makes a single visit enough to list, add, edit and delete.
  //
  // The hub owns the exit message. A sub-wizard reports its own cancellation, which is
  // accurate: that flow really was abandoned. But once an action has run, leaving the hub
  // must stay quiet, because "Nothing was changed" would be false.
  let ran = false
  for (;;) {
    const action = await ctx.ui.dialog.select({
      title: "Custom providers",
      placeholder: "Pick one. Esc to close.",
      options: [
        { title: "List my providers", value: "list", description: "See what you have set up" },
        { title: "Add a provider", value: "add", description: "Your own API, or a ready-made one" },
        { title: "Edit a provider", value: "edit", description: "Change the address, key, or models" },
        { title: "Delete a provider", value: "delete", description: "Remove a provider and its models" },
        { title: "Reload all models", value: "reload", description: "Fetch the latest model list for every provider" },
      ],
    })
    if (!action) {
      if (!ran) cancelled(ctx)
      return
    }
    ran = true
    if (action === "list") await wizardList(ctx)
    else if (action === "add") await wizardAddSource(ctx)
    else if (action === "edit") await wizardEdit(ctx)
    else if (action === "delete") await wizardDelete(ctx)
    else await wizardRefresh(ctx)
  }
}

const COMMANDS = [
  {
    name: "custom-providers",
    title: "Custom providers",
    description: "Add, edit, check or remove your custom providers",
    run: wizardHub,
  },
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
      slash: { name: command.name },
      run: async () => {
        try {
          await command.run(ctx)
        } catch (error) {
          // Errors must name the next action; raw messages leave a beginner stuck.
          await ctx.ui.dialog.alert({
            title: "Something went wrong",
            message:
              "Nothing was changed. Try again, or choose 'List my providers' to check.\n\n" +
              `Details: ${errorText(error)}`,
          })
        }
      },
    })),
  }))
}
