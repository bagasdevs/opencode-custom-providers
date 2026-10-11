// src/flavors.ts
var FLAVORS = {
  "openai-chat": {
    flavor: "openai-chat",
    label: "OpenAI-compatible (most common)",
    description: "Choose this for OpenAI, OpenRouter, DeepSeek, Groq, Together, LM Studio, vLLM and most other services. If unsure, choose this one",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128e3, output: 4096 }
  },
  "openai-responses": {
    flavor: "openai-responses",
    label: "OpenAI Responses API",
    description: "Only for services that explicitly ask for the 'Responses' API. If unsure, choose the first option",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128e3, output: 4096 }
  },
  anthropic: {
    flavor: "anthropic",
    label: "Anthropic (Claude)",
    description: "Claude models; the endpoint cannot list models, so add them from the catalog",
    listPaths: [],
    listShape: "none",
    fallbackLimits: { context: 2e5, output: 32e3 }
  },
  gemini: {
    flavor: "gemini",
    label: "Google Gemini",
    description: "Google's Gemini API (get a key at aistudio.google.com)",
    listPaths: ["/v1beta/models", "/models"],
    listShape: "gemini-list",
    fallbackLimits: { context: 1e6, output: 64e3 }
  },
  ollama: {
    flavor: "ollama",
    label: "Ollama (local server)",
    description: "A local Ollama install, usually http://localhost:11434",
    listPaths: ["/api/tags", "/models"],
    listShape: "ollama-tags",
    fallbackLimits: { context: 128e3, output: 4096 }
  }
};
var DEFAULT_FLAVOR = "openai-chat";
function parseFlavor(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase().replaceAll("_", "-");
  const found = Object.keys(FLAVORS).find((f) => f === v);
  return found ?? null;
}
var BUILT_IN_IDS = /* @__PURE__ */ new Set([
  "opencode",
  "openai",
  "anthropic",
  "google",
  "gemini",
  "deepseek",
  "xai",
  "grok",
  "groq",
  "ollama",
  "openrouter",
  "azure",
  "bedrock",
  "vertex",
  "mistral",
  "together",
  "fireworks",
  "cerebras",
  "perplexity",
  "cohere",
  "moonshot",
  "zhipu",
  "lmstudio",
  "lm-studio",
  "vllm",
  "llamacpp",
  "llama-cpp",
  "github-copilot",
  "copilot"
]);
function collisionSuggestion(providerId) {
  if (BUILT_IN_IDS.has(providerId.toLowerCase())) {
    return `${providerId}-custom`;
  }
  return null;
}

// src/model-fields.ts
var REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function reasoningLabel(level) {
  if (level === "off") return "Off - no reasoning";
  if (level === "xhigh") return "xhigh - maximum (only if the model supports it)";
  if (level === "max") return "max - maximum (only if the model supports it)";
  return `${level} - cap reasoning at ${level}`;
}
var TOKEN_DIGITS = /^\d+$/;
function parseTokenEdit(raw) {
  const cleaned = raw.trim().replace(/[_,]/g, "");
  if (!cleaned) return { action: "keep" };
  if (!TOKEN_DIGITS.test(cleaned)) return null;
  const parsed = Number.parseInt(cleaned, 10);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed === 0 ? { action: "clear" } : { action: "set", value: parsed };
}
function resolveTokenEdit(current, edit) {
  if (edit === null) return current;
  if (edit.action === "keep") return current;
  if (edit.action === "clear") return 0;
  return edit.value;
}

// src/security.ts
var VALID_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return VALID_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}
function sanitizeModelId(id3) {
  return id3.trim().replaceAll(/[^a-zA-Z0-9/_\-:.]/g, "_");
}
function sanitizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return raw.split(/[?#]/)[0];
  }
}
function sanitizeDialogText(text) {
  return text.replaceAll(/[\u0000-\u001f\u007f]/g, "");
}
function sanitizeErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replaceAll(
    /https?:\/\/[^\s"'`<>]+/gi,
    (match) => sanitizeUrl(match)
  );
  const redacted = message.replaceAll(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]").replaceAll(/api[_-]?key[=:]\s*[^\s&]+/gi, "api_key=[REDACTED]").replaceAll(/sk-[a-zA-Z0-9_-]+/g, "sk-[REDACTED]").replaceAll(/\b(key|token|access_token|password)=[^\s&]+/gi, "$1=[REDACTED]");
  const printable = sanitizeDialogText(redacted);
  return printable.length > 400 ? `${printable.slice(0, 400)}\u2026` : printable;
}

// src/ids.ts
var id = "opencode-custom-providers";

// src/tui-v2.ts
var id2 = `${id}.tui`;
var RPC_ID = id;
var FLAVOR_OPTIONS = Object.values(FLAVORS).map((spec) => ({
  title: spec.label,
  value: spec.flavor,
  description: spec.description
}));
var SIMPLE_OPTIONS = [
  {
    title: "Model id",
    value: "slug",
    description: "Short name, for example gpt-4o. Works everywhere. Safe choice."
  },
  {
    title: "Friendly name",
    value: "name",
    description: "The provider's own label, when it offers one."
  }
];
async function call(ctx, method, input) {
  const result = await ctx.client.rpc.call({ rpcID: RPC_ID, method, input: input ?? {} });
  return result.output;
}
function fail(ctx, message) {
  ctx.ui.toast.show({ title: "Custom providers", message, variant: "error" });
}
function done(ctx, message) {
  ctx.ui.toast.show({ title: "Custom providers", message, variant: "success" });
}
function statusSuffix(provider) {
  return provider.pending > 0 ? ` (${provider.pending} new model(s) found: run /reload-models to add them)` : "";
}
function cancelled(ctx) {
  ctx.ui.toast.show({ title: "Custom providers", message: "Cancelled. Nothing was changed.", variant: "info" });
}
async function askToken(ctx, title, current) {
  const placeholder = current === void 0 ? "e.g. 128000 (blank = leave unset)" : `current: ${current} (blank = keep, 0 = clear)`;
  for (; ; ) {
    const raw = await ctx.ui.dialog.prompt({ title, placeholder });
    if (raw === void 0) return void 0;
    const edit = parseTokenEdit(raw);
    if (edit === null) {
      ctx.ui.toast.show({ message: "Enter a whole number of tokens, or 0 to clear it.", variant: "warning" });
      continue;
    }
    return edit;
  }
}
async function editOneModel(ctx, providerId, model) {
  let reasoning = "";
  let image = "";
  let contextEdit;
  let outputEdit;
  for (let step = 1; step <= 4; ) {
    if (step === 1) {
      const answer2 = await ctx.ui.dialog.select({
        title: `Thinking level for ${model.id}`,
        options: REASONING_LEVELS.map((level) => ({
          title: reasoningLabel(level),
          value: level,
          description: level === model.reasoning ? "Currently set" : void 0
        }))
      });
      if (answer2 === void 0) {
        cancelled(ctx);
        return;
      }
      reasoning = answer2;
      step = 2;
      continue;
    }
    if (step === 2) {
      const answer2 = await ctx.ui.dialog.select({
        title: `Can ${model.id} read images?`,
        options: [
          { title: "Yes", value: "yes", description: "Sends text and images" },
          { title: "No", value: "no", description: "Sends text only" }
        ]
      });
      if (answer2 === void 0) {
        step = 1;
        continue;
      }
      image = answer2;
      step = 3;
      continue;
    }
    if (step === 3) {
      const answer2 = await askToken(ctx, `Context window for ${model.id}`, model.context);
      if (answer2 === void 0) {
        step = 2;
        continue;
      }
      contextEdit = answer2;
      step = 4;
      continue;
    }
    const answer = await askToken(ctx, `Longest reply for ${model.id}`, model.output);
    if (answer === void 0) {
      step = 3;
      continue;
    }
    outputEdit = answer;
    break;
  }
  if (contextEdit === void 0 || outputEdit === void 0) {
    cancelled(ctx);
    return;
  }
  const context = resolveTokenEdit(model.context, contextEdit);
  const output = resolveTokenEdit(model.output, outputEdit);
  const { message } = await call(ctx, "editModel", {
    providerId,
    modelId: model.id,
    reasoning,
    image: image === "yes",
    context,
    output
  });
  await ctx.ui.dialog.alert({ title: `Edit ${model.id}`, message });
}
async function wizardEditModels(ctx, providerId) {
  const { models, status, message } = await call(ctx, "listModels", { providerId });
  if (status !== "ok") {
    fail(ctx, message);
    return;
  }
  if (models.length === 0) {
    ctx.ui.toast.show({
      message: `'${providerId}' has no models yet. Fix its address and key with /edit-provider, then run /reload-models.`,
      variant: "warning"
    });
    return;
  }
  for (; ; ) {
    const picked = await ctx.ui.dialog.select({
      title: `Which model of ${providerId}?`,
      options: [
        ...models.map((model2) => ({
          title: model2.name === model2.id ? model2.id : `${model2.name} (${model2.id})`,
          value: model2.id,
          description: `${model2.reasoningLabel}; images ${model2.image ? "yes" : "no"}; context ${model2.context ?? "unset"}; longest reply ${model2.output ?? "unset"}`
        })),
        { title: "Done", value: "", description: "Go back" }
      ]
    });
    if (picked === "") return;
    if (picked === void 0) {
      cancelled(ctx);
      return;
    }
    const model = models.find((item) => item.id === picked);
    if (model) await editOneModel(ctx, providerId, model);
    const again = await call(ctx, "listModels", { providerId });
    models.splice(0, models.length, ...again?.models ?? []);
  }
}
async function pickProvider(ctx) {
  const { providers } = await call(ctx, "list");
  if (providers.length === 0) {
    ctx.ui.toast.show({
      message: "You have no custom providers yet. Run /add-provider to add your first one.",
      variant: "warning"
    });
    return void 0;
  }
  const selected = await ctx.ui.dialog.select({
    title: "Which provider?",
    options: providers.map((provider) => ({
      title: provider.id,
      value: provider.id,
      description: `${provider.baseURL}: ${provider.models} model(s)${statusSuffix(provider)}`
    }))
  });
  if (!selected) cancelled(ctx);
  return providers.find((provider) => provider.id === selected);
}
async function askApiKey(ctx, title) {
  return ctx.ui.dialog.prompt({
    title,
    description: "Paste the key you got from your provider (it often starts with sk-). Most providers need one. It is saved in opencode's secure key store, never shown again, and you can replace it any time with /edit-provider. Leave empty only for local servers like Ollama. Press Esc to cancel: nothing is saved until the last step."
  });
}
async function promptManualAdd(ctx, input, providerId) {
  for (; ; ) {
    const modelIds = await ctx.ui.dialog.prompt({
      title: "Add models manually",
      description: "Enter one or more model ids separated by commas. Find these ids on your provider's setup page.",
      placeholder: "model-a, model-b"
    });
    if (modelIds === void 0) {
      cancelled(ctx);
      return;
    }
    const manual = await call(ctx, "manualAdd", { ...input, modelIds });
    if (manual.status === "ok") {
      await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: manual.message });
      return;
    }
    if (manual.status === "confirm_replace") {
      const confirmed = await ctx.ui.dialog.confirm({
        title: `${providerId} already exists`,
        message: manual.message + "\n\nReplace it?",
        label: { confirm: "Replace it", cancel: "Keep what I have" }
      });
      if (!confirmed) {
        cancelled(ctx);
        return;
      }
      const replaced = await call(ctx, "manualAdd", { ...input, modelIds, confirmReplace: true });
      await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: replaced.message });
      return;
    }
    await ctx.ui.dialog.alert({ title: "Check the model ids", message: manual.message });
  }
}
var ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
function repairBaseURL(raw) {
  const trimmed = raw.trim();
  if (!trimmed || isValidUrl(trimmed)) return void 0;
  if (/^https?:\/\//i.test(trimmed)) return void 0;
  if (/^localhost([:/]|$)/i.test(trimmed) || /^127\.0\.0\.1([:/]|$)/i.test(trimmed) || /^\d+\.\d+\.\d+\.\d+([:/]|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/|:|$)/i.test(trimmed)) return `https://${trimmed}`;
  return void 0;
}
async function wizardAdd(ctx) {
  let providerId = "";
  let baseURL = "";
  let flavor = "";
  let apiKey;
  let displayStyle = "";
  for (let step = 1; step <= 5; ) {
    if (step === 1) {
      const answer2 = await ctx.ui.dialog.prompt({
        title: "Step 1 of 5: Name for this provider",
        description: "Any short name you will recognise later. Letters, numbers, hyphens and underscores only. Example: my-proxy",
        placeholder: "my-proxy",
        value: providerId || void 0
      });
      if (!answer2) {
        cancelled(ctx);
        return;
      }
      const trimmed = answer2.trim();
      if (!ID_PATTERN.test(trimmed)) {
        fail(
          ctx,
          `'${trimmed}' cannot be used as a name. Use only letters, numbers, hyphens and underscores: for example my-proxy. Run /add-provider to start again.`
        );
        continue;
      }
      const clash = collisionSuggestion(trimmed);
      if (clash) {
        const use = await ctx.ui.dialog.confirm({
          title: "That name is already used by a built-in provider",
          message: `'${trimmed}' belongs to an opencode built-in provider. Using it may change your existing ${trimmed} setup.

Use '${clash}' instead?`,
          label: { confirm: `Use ${clash}`, cancel: "Go back" }
        });
        if (!use) continue;
        providerId = clash;
      } else {
        providerId = trimmed;
      }
      const existing = await call(ctx, "list").catch(() => void 0);
      if (existing?.providers?.some((entry) => entry.id === providerId)) {
        const replace = await ctx.ui.dialog.confirm({
          title: "You already have a provider with this name",
          message: `Adding '${providerId}' again replaces the one you have now, including its model list.

Replace it?`,
          label: { confirm: "Replace it", cancel: "Go back" }
        });
        if (!replace) continue;
      }
      step = 2;
      continue;
    }
    if (step === 2) {
      const answer2 = await ctx.ui.dialog.prompt({
        title: "Step 2 of 5: Base URL",
        description: `Paste your provider's API address: it is on their setup page, labelled "Base URL" or "API endpoint". It looks like https://api.example.com/v1. A local server like Ollama uses http://localhost:11434/v1.`,
        placeholder: "https://api.example.com/v1",
        value: baseURL || void 0
      });
      if (!answer2) {
        step = 1;
        continue;
      }
      let candidate = answer2;
      const repaired = repairBaseURL(candidate);
      if (repaired) {
        const use = await ctx.ui.dialog.confirm({
          title: "Did you mean this address?",
          message: `'${candidate}' is missing the start of the address.

Use '${repaired}' instead?`,
          label: { confirm: "Use this address", cancel: "Type it again" }
        });
        if (!use) continue;
        candidate = repaired;
      }
      if (!isValidUrl(candidate)) {
        await ctx.ui.dialog.alert({
          title: "That address could not be read",
          message: "It must start with https:// (or http:// for a local server) and look like https://api.example.com/v1.\n\nNothing was saved: please try again."
        });
        continue;
      }
      baseURL = candidate;
      step = 3;
      continue;
    }
    if (step === 3) {
      const answer2 = await ctx.ui.dialog.select({
        title: "Step 3 of 5: API type",
        placeholder: "Pick the first one if you are unsure",
        options: FLAVOR_OPTIONS
      });
      if (!answer2) {
        step = 2;
        continue;
      }
      flavor = answer2;
      step = 4;
      continue;
    }
    if (step === 4) {
      const answer2 = await askApiKey(ctx, "Step 4 of 5: API key");
      if (answer2 === void 0) {
        step = 3;
        continue;
      }
      apiKey = answer2;
      step = 5;
      continue;
    }
    const answer = await ctx.ui.dialog.select({
      title: "Step 5 of 5: How should models appear in the model list?",
      options: SIMPLE_OPTIONS
    });
    if (!answer) {
      step = 4;
      continue;
    }
    displayStyle = answer;
    break;
  }
  const input = {
    providerId,
    baseURL,
    flavor,
    apiKey: apiKey || void 0,
    displayStyle
  };
  if (flavor === "anthropic") {
    await ctx.ui.dialog.alert({
      title: "Anthropic needs model names",
      message: "Anthropic APIs cannot list their models here. Type the model names you use and they will be added with metadata from the public model database."
    });
    await promptManualAdd(ctx, input, providerId);
    return;
  }
  let result = await call(ctx, "add", input);
  while (result.status !== "ok") {
    if (result.status === "invalid") {
      await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: result.message });
      return;
    }
    if (result.status === "confirm_replace") {
      const confirmed = await ctx.ui.dialog.confirm({
        title: `${providerId} already exists`,
        message: `You already have a provider named '${providerId}'. Adding this one would replace its settings and its model list.

Replace it?`,
        label: { confirm: "Replace it", cancel: "Keep what I have" }
      });
      if (confirmed) {
        result = await call(ctx, "add", { ...input, confirmReplace: true });
        continue;
      }
      cancelled(ctx);
      return;
    }
    if (result.status === "confirm_endpoint_reuse") {
      const confirmed = await ctx.ui.dialog.confirm({
        title: "That address is already in use",
        message: `This address is already used by: ${result.usedBy.join(", ")}.

Add another provider on the same address?`,
        label: { confirm: "Add it anyway", cancel: "Cancel" }
      });
      if (confirmed) {
        result = await call(ctx, "add", { ...input, confirmReuse: true });
        continue;
      }
      cancelled(ctx);
      return;
    }
    const action = await ctx.ui.dialog.select({
      title: "Could not get the provider's model list",
      placeholder: result.message,
      options: [
        { title: "Try again", value: "retry", description: "Check the address and key, then try the model list again." },
        { title: "Add models manually", value: "manual", description: "Type the model ids from your provider's setup page." },
        { title: "Cancel", value: "cancel", description: "Nothing will be saved." }
      ]
    });
    if (!action || action === "cancel") {
      cancelled(ctx);
      return;
    }
    if (action === "retry") {
      result = await call(ctx, "add", input);
      continue;
    }
    await promptManualAdd(ctx, input, providerId);
    return;
  }
  await ctx.ui.dialog.alert({ title: `Add provider: ${providerId}`, message: result.message });
}
async function wizardCatalogAdd(ctx) {
  const { sites } = await call(ctx, "catalog.list");
  if (sites.length === 0) {
    fail(ctx, "The built-in catalog is empty, so there is nothing to pick. Use /add-provider instead.");
    return;
  }
  let site = "";
  let providerId = "";
  let models;
  let apiKey;
  for (let step = 1; step <= 4; ) {
    if (step === 1) {
      const answer2 = await ctx.ui.dialog.select({
        title: "Pick a provider from the catalog",
        placeholder: "You still need that provider's API key",
        options: sites.map((entry) => ({
          title: entry.name,
          value: entry.id,
          description: `${entry.modelCount} model(s) available`
        }))
      });
      if (!answer2) {
        cancelled(ctx);
        return;
      }
      site = answer2;
      step = 2;
      continue;
    }
    if (step === 2) {
      const answer2 = await ctx.ui.dialog.prompt({
        title: "Name for this provider",
        description: "Any short name you will recognise later. Letters, numbers, hyphens and underscores only.",
        placeholder: site,
        value: providerId || site
      });
      if (!answer2) {
        step = 1;
        continue;
      }
      providerId = answer2;
      step = 3;
      continue;
    }
    if (step === 3) {
      const answer2 = await ctx.ui.dialog.prompt({
        title: "Which models? (optional)",
        description: "Type model names separated by commas, for example claude-sonnet-4-5, gpt-4o. Leave empty to add every model this provider offers: that is the safe choice.",
        value: models
      });
      if (answer2 === void 0) {
        step = 2;
        continue;
      }
      models = answer2;
      step = 4;
      continue;
    }
    const answer = await askApiKey(ctx, "API key for this provider (paste it if you have one)");
    if (answer === void 0) {
      step = 3;
      continue;
    }
    apiKey = answer;
    break;
  }
  const { message } = await call(ctx, "catalog.add", {
    site,
    providerId,
    models: models || void 0,
    apiKey: apiKey || void 0
  });
  await ctx.ui.dialog.alert({ title: `Add from catalog: ${providerId}`, message });
}
async function wizardReprobe(ctx) {
  const provider = await pickProvider(ctx);
  if (!provider) return;
  const { message } = await call(ctx, "reprobe", { providerId: provider.id });
  await ctx.ui.dialog.alert({ title: `Check for new models: ${provider.id}`, message });
}
async function wizardApplyReconcile(ctx) {
  const provider = await pickProvider(ctx);
  if (!provider) return;
  const probe = await call(ctx, "reprobe", { providerId: provider.id });
  const { message } = probe;
  const changes = Array.isArray(probe.changes) ? probe.changes : [];
  await ctx.ui.dialog.alert({ title: `What was found for ${provider.id}`, message });
  const options = [
    {
      title: "Review one by one",
      value: "review",
      description: "Decide each change on its own instead of taking all or none."
    }
  ];
  if (changes.length === 0) options.pop();
  options.push({ title: "Keep what I have", value: "keep", description: "Change nothing" });
  options.push({
    title: "Apply everything",
    value: "apply",
    description: "Add the new models. Models that disappeared stay in your list."
  });
  const choice = await ctx.ui.dialog.select({ title: "Apply these changes?", options });
  if (!choice) {
    cancelled(ctx);
    return;
  }
  if (choice === "review") {
    const decisions = {};
    for (const change of changes) {
      const vanishing = change.kind === "removed";
      const decision = await ctx.ui.dialog.select({
        title: sanitizeDialogText(`${change.id} (${change.kind})`),
        options: vanishing ? [
          { title: "Keep this model", value: "keep", description: "Leave it in your list as it is now." },
          { title: "Remove this model", value: "apply", description: sanitizeDialogText(`Delete it: ${change.detail}`) }
        ] : [
          { title: "Apply this change", value: "apply", description: sanitizeDialogText(`Take the new values: ${change.detail}`) },
          { title: "Keep what I have", value: "keep", description: "Leave this model exactly as it is now." }
        ]
      });
      if (decision !== "apply" && decision !== "keep") {
        cancelled(ctx);
        return;
      }
      decisions[change.id] = decision;
    }
    const applied2 = await call(ctx, "apply", {
      providerId: provider.id,
      decisions: JSON.stringify(decisions)
    });
    await ctx.ui.dialog.alert({ title: `Update ${provider.id}`, message: applied2.message });
    return;
  }
  const applied = await call(ctx, "apply", { providerId: provider.id, mode: choice });
  await ctx.ui.dialog.alert({ title: `Update ${provider.id}`, message: applied.message });
}
async function wizardEdit(ctx) {
  const provider = await pickProvider(ctx);
  if (!provider) return;
  for (; ; ) {
    const flavorLabel = FLAVORS[provider.flavor]?.label ?? provider.flavor;
    const styleLabel = provider.displayStyle === "name" ? "Friendly name" : "Model id";
    const field = await ctx.ui.dialog.select({
      title: `What do you want to change for ${provider.id}?`,
      options: [
        { title: "Base URL", value: "baseURL", description: `Currently: ${provider.baseURL}` },
        { title: "API type", value: "flavor", description: `Currently: ${flavorLabel}` },
        { title: "How models are listed", value: "displayStyle", description: `Currently: ${styleLabel}` },
        { title: "API key", value: "apiKey", description: "Replace the saved key" },
        { title: "A model's settings", value: "model", description: "Change thinking, image input, or token limits" },
        { title: "Delete models", value: "deleteModels", description: "Remove several models from this provider at once" },
        { title: "Rename provider", value: "rename", description: `Currently: ${provider.id}` }
      ]
    });
    if (!field) {
      cancelled(ctx);
      return;
    }
    if (field === "model") {
      await wizardEditModels(ctx, provider.id);
      continue;
    }
    if (field === "deleteModels") {
      await wizardDeleteModels(ctx, provider.id);
      continue;
    }
    if (field === "rename") {
      await wizardRename(ctx, provider);
      continue;
    }
    let value;
    if (field === "flavor") {
      value = await ctx.ui.dialog.select({ title: "API type", options: FLAVOR_OPTIONS });
    } else if (field === "displayStyle") {
      value = await ctx.ui.dialog.select({ title: "How should models appear in the model list?", options: SIMPLE_OPTIONS });
    } else if (field === "apiKey") {
      value = await ctx.ui.dialog.prompt({
        title: "New API key",
        description: "Paste the new key. Press Esc to keep the current one. Leave it empty and the current key is kept. It is saved securely and can be replaced again later."
      });
    } else {
      value = await ctx.ui.dialog.prompt({
        title: "New Base URL",
        description: "Must start with https:// (or http:// for a local server) and usually ends in /v1",
        value: provider.baseURL
      });
    }
    if (value === void 0 || value === "") continue;
    const { message } = await call(ctx, "edit", {
      providerId: provider.id,
      [field]: value
    });
    await ctx.ui.dialog.alert({ title: `Edit ${provider.id}`, message });
  }
}
async function wizardDeleteModels(ctx, providerId) {
  for (; ; ) {
    const raw = await ctx.ui.dialog.prompt({
      title: `Delete models from ${providerId}`,
      description: "Type one or more model ids separated by commas. Every id has to exist or nothing is deleted. Run /list-models to see the ids.",
      placeholder: "model-a, model-b"
    });
    if (raw === void 0 || raw.trim() === "") return;
    const ids = raw.split(",").map((modelId) => modelId.trim()).filter((modelId) => modelId.length > 0);
    if (ids.length === 0) {
      ctx.ui.toast.show({ message: "Type at least one model id, separated by commas.", variant: "warning" });
      continue;
    }
    const confirmed = await ctx.ui.dialog.confirm({
      title: "Delete these models?",
      message: `Delete ${ids.length} model${ids.length === 1 ? "" : "s"} from '${providerId}'?

${ids.join(", ")}

This cannot be undone. The provider keeps its other models, its address and its key.`,
      label: { confirm: "Delete them", cancel: "Keep them" }
    });
    if (!confirmed) return;
    const { status, message } = await call(ctx, "deleteModels", { providerId, modelIds: raw });
    if (status === "ok") {
      done(ctx, message);
      return;
    }
    if (status === "unknown_provider") {
      fail(ctx, message);
      return;
    }
    await ctx.ui.dialog.alert({ title: `Delete models from ${providerId}`, message });
  }
}
async function wizardRename(ctx, provider) {
  const raw = await ctx.ui.dialog.prompt({
    title: `Rename ${provider.id}`,
    description: "A new short name for this provider. Letters, numbers, hyphens and underscores only. Its models, address and key stay as they are.",
    placeholder: "my-proxy"
  });
  if (raw === void 0 || raw.trim() === "") return;
  const newId = raw.trim();
  if (!ID_PATTERN.test(newId)) {
    fail(ctx, `'${newId}' cannot be used as a name. Use only letters, numbers, hyphens and underscores: for example my-proxy.`);
    return;
  }
  if (newId === provider.id) {
    fail(ctx, `'${newId}' is already the name of this provider. Pick a different name.`);
    return;
  }
  const confirmed = await ctx.ui.dialog.confirm({
    title: "Rename this provider?",
    message: `Rename '${provider.id}' to '${newId}'?

Its models, address and key are kept. An API key saved under '${provider.id}' stays stored under that name.`,
    label: { confirm: "Rename it", cancel: "Keep the current name" }
  });
  if (!confirmed) return;
  const { status, message } = await call(ctx, "renameProvider", { providerId: provider.id, newId });
  if (status === "ok") {
    provider.id = newId;
    done(ctx, message);
    return;
  }
  fail(ctx, message);
}
async function wizardDelete(ctx) {
  const provider = await pickProvider(ctx);
  if (!provider) return;
  const confirmed = await ctx.ui.dialog.confirm({
    title: "Remove this provider?",
    message: `Remove '${provider.id}' and its ${provider.models} model(s)?

This cannot be undone. Your other opencode settings are not touched. You can add it again later with /add-provider.`,
    label: { confirm: "Remove it", cancel: "Keep it" }
  });
  if (!confirmed) {
    cancelled(ctx);
    return;
  }
  const { message } = await call(ctx, "remove", { providerId: provider.id });
  if (/^There is no provider named/.test(message)) fail(ctx, message);
  else done(ctx, message);
}
async function wizardRefresh(ctx) {
  const { message } = await call(ctx, "refresh");
  done(ctx, message);
}
async function wizardList(ctx) {
  const { providers } = await call(ctx, "list");
  const message = providers.length ? providers.map(
    (provider) => provider.models === 0 ? `${provider.id}: NOT READY (no models yet)
  ${provider.baseURL}
  Fix it with /edit-provider (check the URL and API key), then /reload-models` : `${provider.id}: ${provider.models} model(s) ready${statusSuffix(provider)}
  ${provider.baseURL}`
  ).join("\n\n") : "You have no custom providers yet. Run /add-provider to add your first one.";
  await ctx.ui.dialog.alert({ title: "Your custom providers", message });
}
var COMMANDS = [
  { name: "add-provider", title: "Add a provider", description: "Set up a new API provider step by step", run: wizardAdd },
  { name: "list-custom-providers", title: "List my providers", description: "Show every custom provider and its models", run: wizardList },
  {
    name: "check-for-new-models",
    aliases: ["reprobe-models"],
    title: "Check for new models",
    description: "Ask your provider whether it has new models",
    run: wizardReprobe
  },
  { name: "reload-models", title: "Reload all models", description: "Refresh every provider from its own address", run: wizardRefresh },
  { name: "add-known-provider", title: "Add a known provider", description: "Pick a provider from the built-in list", run: wizardCatalogAdd },
  { name: "review-model-changes", aliases: ["apply-reconcile"], title: "Review model changes", description: "See what changed and choose what to keep", run: wizardApplyReconcile },
  { name: "edit-provider", title: "Edit a provider", description: "Change its address, API type, key, or how models are named", run: wizardEdit },
  { name: "delete-provider", title: "Delete a provider", description: "Remove a provider and its models", run: wizardDelete }
];
var setup = (ctx) => {
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: COMMANDS.map((command) => ({
      id: `${id}.${command.name}`,
      title: command.title,
      description: command.description,
      group: "Custom providers",
      palette: true,
      slash: {
        name: command.name,
        aliases: "aliases" in command ? [...command.aliases] : void 0
      },
      run: async () => {
        try {
          await command.run(ctx);
        } catch (error) {
          await ctx.ui.dialog.alert({
            title: "Something went wrong",
            message: `The action did not finish and nothing was changed.
Run /list-custom-providers to see the current state, then try again.

Technical detail (for bug reports): ${error instanceof Error ? error.message : String(error)}`
          });
        }
      }
    }))
  }));
};

// src/endpoint.ts
function normalizeModelId(id3) {
  let normalized = id3.toLowerCase();
  if (normalized.startsWith("models/")) {
    normalized = normalized.slice(7);
  }
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex !== -1) {
    normalized = normalized.slice(slashIndex + 1);
  }
  return normalized.replaceAll(":", "-");
}
var ENDPOINT_PATH_SUFFIXES = ["/chat/completions", "/messages", "/responses", "/models"];
function schemelessHostIsLocal(raw) {
  const host = raw.split(/[/?#]/, 1)[0];
  if (host.startsWith("[")) return true;
  if (/^::1($|:)/.test(host)) return true;
  const name = host.split(":", 1)[0];
  if (/^localhost$/i.test(name) || /\.local$/i.test(name)) return true;
  if (name === "0.0.0.0") return true;
  const octets = /^(\d{1,3})(?:\.(\d{1,3}))?(?:\.\d{1,3}){0,2}$/.exec(name);
  if (!octets) return false;
  const first = Number(octets[1]);
  const second = octets[2] === void 0 ? void 0 : Number(octets[2]);
  return first === 127 || first === 10 || first === 192 && second === 168 || first === 172 && second !== void 0 && second >= 16 && second <= 31;
}
function schemelessHostIsPlausible(raw) {
  if (schemelessHostIsLocal(raw)) return true;
  const host = raw.split(/[/?#]/, 1)[0];
  const name = host.split(":", 1)[0];
  return /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(name);
}
function normalizeBaseUrl(raw) {
  let candidate = raw.trim();
  if (candidate === "") return candidate;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    if (!schemelessHostIsPlausible(candidate)) return candidate;
    candidate = `${schemelessHostIsLocal(candidate) ? "http" : "https"}://${candidate}`;
  }
  candidate = candidate.replace(/\/+$/, "");
  const schemeEnd = candidate.indexOf("://");
  if (candidate.indexOf("/", schemeEnd + 3) === -1) return candidate;
  let changed = true;
  while (changed) {
    changed = false;
    const lower = candidate.toLowerCase();
    for (const suffix of ENDPOINT_PATH_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        candidate = candidate.slice(0, candidate.length - suffix.length).replace(/\/+$/, "");
        changed = true;
        break;
      }
    }
  }
  return candidate;
}
async function fetchEndpointModels(baseURL, apiKey) {
  if (!isValidUrl(baseURL)) return [];
  const url = new URL(baseURL);
  const cleanPath = url.pathname.replace(/\/+$/, "");
  const modelsPath = cleanPath.endsWith("/models") ? cleanPath : `${cleanPath}/models`;
  const modelsUrl = new URL(modelsPath, url.origin);
  modelsUrl.search = url.search;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  const res = await fetch(modelsUrl.toString(), {
    headers,
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.text();
      if (body) detail = sanitizeErrorMessage(body.slice(0, 500));
    } catch {
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const rawData = await res.json();
  const data = Array.isArray(rawData) ? rawData : Array.isArray(rawData?.data) ? rawData.data : null;
  if (!data) {
    throw new Error("Unexpected response format from /v1/models");
  }
  return data.filter((item) => typeof item?.id === "string");
}

// src/catalog.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
var PKG_VERSION = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
var MODELS_DEV_URL = "https://models.dev/api.json";
var CACHE_TTL = 6 * 60 * 60 * 1e3;
function cacheDir() {
  return path.join(os.homedir() || "/tmp", ".cache", "opencode-custom-providers");
}
function cacheFile() {
  return path.join(cacheDir(), "models-dev.json");
}
var lookupMap = null;
var lookupPromise = null;
var catalogPromise = null;
function readCacheEntry() {
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}
function writeCache(data) {
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 448, recursive: true });
    }
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ timestamp: Date.now(), data }, null, 2),
      { mode: 384 }
    );
  } catch {
  }
}
async function fetchModelsDevCatalog() {
  const entry = readCacheEntry();
  const isFresh = entry && Date.now() - entry.timestamp <= CACHE_TTL;
  if (isFresh && entry) return entry.data;
  try {
    const res = await fetch(MODELS_DEV_URL, {
      headers: { "User-Agent": `opencode-custom-providers/${PKG_VERSION}` },
      signal: AbortSignal.timeout(1e4)
    });
    if (res.ok) {
      const data = await res.json();
      writeCache(data);
      return data;
    }
  } catch {
  }
  if (entry) {
    return entry.data;
  }
  return {};
}
function buildLookupMap(catalog) {
  const map = /* @__PURE__ */ new Map();
  for (const provider of Object.values(catalog)) {
    if (!provider.models) continue;
    for (const model of Object.values(provider.models)) {
      const key = normalizeModelId(model.id);
      if (!map.has(key)) {
        map.set(key, model);
      }
    }
  }
  return map;
}
async function getLookupMap() {
  if (lookupMap) return lookupMap;
  if (!lookupPromise) {
    lookupPromise = fetchModelsDevCatalog().then((catalog) => {
      lookupMap = buildLookupMap(catalog);
      return lookupMap;
    });
  }
  return lookupPromise;
}
function clearModelsDevCache() {
  lookupMap = null;
  lookupPromise = null;
  catalogPromise = null;
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return;
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (Date.now() - mtimeMs > CACHE_TTL) fs.unlinkSync(file);
  } catch {
  }
}
async function getCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetchModelsDevCatalog();
  }
  return catalogPromise;
}
function summarizeCatalog(catalog) {
  return Object.values(catalog).filter((p) => p && typeof p.id === "string" && p.api && isValidUrl(p.api) && p.models && Object.keys(p.models).length > 0).map((p) => ({
    id: p.id,
    name: p.name || p.id,
    api: p.api,
    modelCount: Object.keys(p.models).length
  })).sort((a, b) => a.name.localeCompare(b.name));
}
async function listCatalogSites() {
  return summarizeCatalog(await getCatalog());
}

// src/rules.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";
import * as os2 from "node:os";
var EXACT = {
  "gpt-4o": { context: 128e3, output: 16384, reasoning: false, image: true },
  "gpt-4o-mini": { context: 128e3, output: 16384, reasoning: false, image: true },
  "gpt-4.1": { context: 1e6, output: 32768, reasoning: false, image: true },
  "gpt-4.1-mini": { context: 1e6, output: 32768, reasoning: false, image: true },
  "gpt-5": { context: 4e5, output: 128e3, reasoning: true, image: true },
  "gpt-5-mini": { context: 4e5, output: 128e3, reasoning: true, image: true },
  "o1": { context: 2e5, output: 1e5, reasoning: true, image: true },
  "o3": { context: 2e5, output: 1e5, reasoning: true, image: true },
  "o4-mini": { context: 2e5, output: 1e5, reasoning: true, image: true },
  "claude-sonnet-4-6": { context: 1e6, output: 128e3, reasoning: true, image: true },
  "claude-opus-4-6": { context: 1e6, output: 128e3, reasoning: true, image: true },
  "claude-haiku-4-5": { context: 2e5, output: 64e3, reasoning: true, image: true },
  "deepseek-chat": { context: 128e3, output: 8192, reasoning: false, image: false },
  "deepseek-reasoner": { context: 128e3, output: 32768, reasoning: true, image: false },
  "deepseek-r1": { context: 128e3, output: 32768, reasoning: true, image: false },
  "deepseek-v3": { context: 128e3, output: 8192, reasoning: false, image: false },
  "deepseek-v4-pro": { context: 256e3, output: 32768, reasoning: false, image: false },
  "qwen-max": { context: 256e3, output: 8192, reasoning: false, image: false },
  "qwen-plus": { context: 256e3, output: 8192, reasoning: false, image: false },
  "qwen-turbo": { context: 1e6, output: 8192, reasoning: false, image: false },
  "qwq-32b": { context: 128e3, output: 32768, reasoning: true, image: false },
  "kimi-k2": { context: 256e3, output: 16384, reasoning: false, image: false },
  "kimi-k2-thinking": { context: 256e3, output: 32768, reasoning: true, image: false },
  "moonshot-v1-128k": { context: 128e3, output: 4096, reasoning: false, image: false },
  "glm-4.6": { context: 2e5, output: 32768, reasoning: true, image: true },
  "glm-4.5": { context: 128e3, output: 16384, reasoning: true, image: false },
  "gemini-2.5-pro": { context: 1e6, output: 65536, reasoning: true, image: true },
  "gemini-2.5-flash": { context: 1e6, output: 65536, reasoning: true, image: true },
  "gemini-3.1-pro": { context: 1e6, output: 64e3, reasoning: true, image: true },
  "grok-4": { context: 256e3, output: 16384, reasoning: true, image: true },
  "grok-3": { context: 131072, output: 16384, reasoning: false, image: false }
};
var PREFIX = [
  ["gpt-5", { context: 4e5, output: 128e3, reasoning: true, image: true }],
  ["gpt-4", { context: 128e3, output: 16384, reasoning: false, image: true }],
  ["o1", { context: 2e5, output: 1e5, reasoning: true, image: true }],
  ["o3", { context: 2e5, output: 1e5, reasoning: true, image: true }],
  ["claude-opus", { context: 1e6, output: 128e3, reasoning: true, image: true }],
  ["claude-sonnet", { context: 5e5, output: 64e3, reasoning: true, image: true }],
  ["claude-haiku", { context: 2e5, output: 64e3, reasoning: true, image: true }],
  ["claude", { context: 2e5, output: 32e3, reasoning: false, image: true }],
  ["deepseek-r", { context: 128e3, output: 32768, reasoning: true, image: false }],
  ["deepseek", { context: 128e3, output: 8192, reasoning: false, image: false }],
  ["qwen", { context: 128e3, output: 8192, reasoning: false, image: false }],
  ["qwq", { context: 128e3, output: 32768, reasoning: true, image: false }],
  ["kimi", { context: 256e3, output: 16384, reasoning: false, image: false }],
  ["moonshot", { context: 128e3, output: 4096, reasoning: false, image: false }],
  ["glm", { context: 128e3, output: 16384, reasoning: true, image: false }],
  ["gemini", { context: 1e6, output: 64e3, reasoning: true, image: true }],
  ["grok", { context: 131072, output: 16384, reasoning: false, image: false }],
  ["llama", { context: 128e3, output: 8192, reasoning: false, image: false }],
  ["mistral", { context: 128e3, output: 8192, reasoning: false, image: false }],
  ["mixtral", { context: 64e3, output: 8192, reasoning: false, image: false }]
];
function matchLocalRule(id3) {
  const key = normalizeModelId(id3).split("@")[0].replace(/\[.*\]$/, "");
  const exact = EXACT[key];
  if (exact) return { meta: exact, pattern: key };
  let best = null;
  for (const [prefix, meta] of PREFIX) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.pattern.length)) {
      best = { meta, pattern: prefix };
    }
  }
  return best;
}
function isValidRule(v) {
  if (typeof v !== "object" || v === null) return false;
  const r = v;
  return typeof r.context === "number" && Number.isFinite(r.context) && r.context > 0 && typeof r.output === "number" && Number.isFinite(r.output) && r.output > 0 && typeof r.reasoning === "boolean" && typeof r.image === "boolean";
}
var rulesCache = null;
function loadCustomRules() {
  const file = path2.join(os2.homedir(), ".opencode-custom-providers-rules.json");
  let mtimeMs;
  try {
    mtimeMs = fs2.statSync(file).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (rulesCache && rulesCache.file === file && rulesCache.mtimeMs === mtimeMs) {
    return rulesCache.rules;
  }
  if (mtimeMs === -1) {
    const empty = {};
    rulesCache = { file, mtimeMs, rules: empty };
    return empty;
  }
  try {
    const raw = JSON.parse(fs2.readFileSync(file, "utf-8"));
    const exact = raw?.exact;
    if (typeof exact !== "object" || exact === null) {
      const empty = {};
      rulesCache = { file, mtimeMs, rules: empty };
      return empty;
    }
    const valid = {};
    for (const [id3, rule] of Object.entries(exact)) {
      if (isValidRule(rule)) valid[id3] = rule;
    }
    rulesCache = { file, mtimeMs, rules: valid };
    return valid;
  } catch {
    const empty = {};
    rulesCache = { file, mtimeMs, rules: empty };
    return empty;
  }
}

// src/deep-probe.ts
var num = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : void 0;
async function getJson(url, headers, timeoutMs) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try {
      err.body = await res.text();
    } catch {
      err.body = "";
    }
    throw err;
  }
  return res.json();
}
function authHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}
async function fetchModelDetail(modelsUrl, id3, apiKey) {
  const raw = await getJson(
    `${modelsUrl.replace(/\/+$/, "")}/${encodeURIComponent(id3)}`,
    authHeaders(apiKey),
    8e3
  );
  return patchFromRecord(raw);
}
function patchFromRecord(raw) {
  const patch = {};
  const rec = (v) => typeof v === "object" && v !== null ? v : void 0;
  const firstNum = (keys) => {
    for (const k of keys) {
      const v = num(raw[k]);
      if (v !== void 0) return v;
    }
    return void 0;
  };
  const ctx = firstNum(["context_window", "max_model_len", "context_length", "inputTokenLimit"]);
  if (ctx !== void 0) patch.context_length = ctx;
  const out = firstNum(["max_output_tokens", "max_completion_tokens", "outputTokenLimit"]);
  if (out !== void 0) patch.max_output_tokens = out;
  const cost = num(raw["input_cost"]) !== void 0 || num(raw["output_cost"]) !== void 0 ? { input: num(raw["input_cost"]) ?? 0, output: num(raw["output_cost"]) ?? 0 } : void 0;
  if (cost) {
    patch.input_cost = cost.input;
    patch.output_cost = cost.output;
  }
  const pricing = rec(raw["pricing"]);
  if (pricing) {
    const per = (v) => {
      const n = typeof v === "string" ? Number(v) : num(v) !== void 0 ? v : void 0;
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n * 1e6 : void 0;
    };
    const pi = per(pricing["prompt"]);
    const po = per(pricing["completion"]);
    if (pi !== void 0 || po !== void 0) {
      patch.input_cost = pi ?? 0;
      patch.output_cost = po ?? 0;
    }
  }
  const caps = rec(raw["capabilities"]);
  if (caps) {
    if (caps["vision"] === true) patch.vision = true;
    const reasoning = rec(caps["reasoning"]);
    const opts = reasoning?.["effort_options"];
    if (Array.isArray(opts)) {
      const levels = opts.filter((e) => typeof e === "string" && e.length > 0);
      if (levels.length > 0) patch.effort_options = levels;
    }
  }
  return patch;
}
async function fetchLitellmInfo(origin, id3, apiKey) {
  const raw = await getJson(
    `${origin}/model/info?model=${encodeURIComponent(id3)}`,
    authHeaders(apiKey),
    8e3
  );
  const data = typeof raw["data"] === "object" && raw["data"] !== null ? raw["data"] : raw;
  const patch = {};
  const perToken = (v) => {
    const n = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : void 0;
    return n === void 0 ? void 0 : n * 1e6;
  };
  const pi = perToken(data["input_cost_per_token"]);
  const po = perToken(data["output_cost_per_token"] ?? data["output_cost"]);
  if (pi !== void 0 || po !== void 0) {
    patch.input_cost = pi ?? 0;
    patch.output_cost = po ?? 0;
  }
  const ctx = num(data["max_input_tokens"]);
  if (ctx !== void 0) patch.context_length = ctx;
  const out = num(data["max_output_tokens"]);
  if (out !== void 0) patch.max_output_tokens = out;
  if (Object.keys(patch).length === 0) throw new Error("Empty LiteLLM info");
  return patch;
}
async function fetchPublicCatalog(origin) {
  const raw = await getJson(`${origin}/api/models/public`, authHeaders(), 8e3);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw["data"]) ? raw["data"] : [];
  const map = /* @__PURE__ */ new Map();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry;
    if (typeof rec["id"] !== "string") continue;
    try {
      map.set(rec["id"], patchFromRecord(rec));
    } catch {
    }
  }
  return map;
}
async function fetchOllamaShow(base, name) {
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(8e3)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  const patch = {};
  const caps = raw["capabilities"];
  if (Array.isArray(caps) && caps.includes("vision")) patch.vision = true;
  if (Object.keys(patch).length === 0) throw new Error("Empty Ollama show");
  return patch;
}
function applyPatch(item, patch) {
  const merged = {
    ...item,
    capabilities: { ...item.capabilities }
  };
  if (patch.context_length !== void 0 && merged.context_length === void 0) {
    merged.context_length = patch.context_length;
  }
  if (patch.max_output_tokens !== void 0 && merged.max_output_tokens === void 0) {
    merged.max_output_tokens = patch.max_output_tokens;
  }
  if (patch.input_cost !== void 0 || patch.output_cost !== void 0) {
    merged.input_cost = patch.input_cost ?? merged.input_cost;
    merged.output_cost = patch.output_cost ?? merged.output_cost;
  }
  if (patch.vision === true && merged.capabilities) {
    merged.capabilities.vision = true;
  }
  if (patch.effort_options && merged.capabilities) {
    const existing = merged.capabilities.reasoning;
    if (existing === void 0 || existing === false) {
      merged.capabilities.reasoning = { effort_options: patch.effort_options };
    }
  }
  return merged;
}
function needsDeep(item) {
  const hasCtx = (item.context_window ?? item.max_model_len ?? item.context_length) !== void 0;
  const hasOut = (item.max_completion_tokens ?? item.max_output_tokens) !== void 0;
  const hasCost = item.input_cost !== void 0 || item.output_cost !== void 0;
  return !hasCtx || !hasOut || !hasCost;
}
async function deepenItem(item, ctx, publicCatalog) {
  let merged = item;
  try {
    const inline = patchFromRecord(item);
    if (inline.input_cost !== void 0 || inline.output_cost !== void 0) {
      merged = applyPatch(merged, inline);
    }
  } catch {
  }
  if (!needsDeep(merged)) return merged;
  const pub = publicCatalog?.get(item.id);
  if (pub && (pub.input_cost !== void 0 || pub.output_cost !== void 0 || pub.context_length !== void 0)) {
    merged = applyPatch(merged, pub);
    if (!needsDeep(merged)) return merged;
  }
  if (ctx.flavor === "openai-chat" || ctx.flavor === "openai-responses") {
    try {
      merged = applyPatch(merged, await fetchModelDetail(ctx.modelsUrl, item.id, ctx.apiKey));
      if (!needsDeep(merged)) return merged;
    } catch {
    }
    try {
      merged = applyPatch(merged, await fetchLitellmInfo(ctx.origin, item.id, ctx.apiKey));
    } catch {
    }
    return merged;
  }
  if (ctx.flavor === "ollama") {
    try {
      merged = applyPatch(merged, await fetchOllamaShow(ctx.origin, item.id));
    } catch {
    }
  }
  return merged;
}
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  if (items.length === 0) return out;
  const limit = Math.max(1, Math.floor(size) || 1);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}
async function deepenEndpointItems(items, ctx) {
  if (items.length === 0) return items;
  if (!items.some(needsDeep)) return items;
  let pub;
  try {
    pub = await fetchPublicCatalog(ctx.origin);
    if (pub.size === 0) pub = void 0;
  } catch {
    pub = void 0;
  }
  return mapPool(items, 8, async (item) => {
    try {
      return await deepenItem(item, ctx, pub);
    } catch {
      return item;
    }
  });
}
async function probeDeveloperRole(baseURL, apiKey) {
  if (!apiKey) return void 0;
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    return void 0;
  }
  const clean = url.pathname.replace(/\/+$/, "");
  const target = clean.endsWith("/chat/completions") ? url.toString() : new URL(`${clean}/chat/completions`, url.origin).toString();
  let res;
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { ...authHeaders(apiKey) },
      body: JSON.stringify({ model: "probe", messages: [{ role: "developer", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(1e4)
    });
  } catch {
    return void 0;
  }
  if (res.status === 401 || res.status === 403) return void 0;
  if (res.status === 400) {
    try {
      const body = await res.text();
      if (/developer/i.test(body)) return false;
    } catch {
      return void 0;
    }
  }
  return void 0;
}

// src/probe.ts
function isLocalHost(host) {
  if (host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0") return true;
  if (host.endsWith(".local")) return true;
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const second = /^172\.(\d+)\./.exec(host);
  return second !== null && Number(second[1]) >= 16 && Number(second[1]) <= 31;
}
function buildCandidateUrls(baseURL) {
  const out = [];
  const push = (u) => {
    const clean = u.replace(/\/+$/, "");
    if (clean && !out.includes(clean)) out.push(clean);
  };
  push(baseURL);
  try {
    const url = new URL(baseURL);
    const cleanPath = url.pathname.replace(/\/+$/, "");
    if (!cleanPath.endsWith("/v1")) {
      push(new URL(`${cleanPath}/v1`, url.origin).toString());
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol === "http:" && !isLocalHost(host)) {
      const https = new URL(url.toString());
      https.protocol = "https:";
      push(https.toString());
    }
  } catch {
  }
  return out;
}
function parseCapabilities(item) {
  let toolCall = false;
  let reasoning = false;
  let temperature = false;
  if (item.capabilities) {
    if (item.capabilities.function_calling || item.capabilities.tool_choice) toolCall = true;
    if (item.capabilities.reasoning) reasoning = true;
    if (item.capabilities.temperature) temperature = true;
  }
  if (item.supported_parameters) {
    if (item.supported_parameters.includes("tools") || item.supported_parameters.includes("tool_choice")) {
      toolCall = true;
    }
    if (item.supported_parameters.includes("temperature")) temperature = true;
  }
  return { toolCall, reasoning, temperature };
}
function parseEffortOptions(item) {
  const raw = item.capabilities?.reasoning;
  if (typeof raw !== "object" || raw === null) return void 0;
  const opts = raw.effort_options;
  if (!Array.isArray(opts)) return void 0;
  const levels = opts.filter((e) => typeof e === "string" && e.length > 0);
  return levels.length > 0 ? levels : void 0;
}
async function fetchFlavorModels(base, apiKey, flavor) {
  const spec = FLAVORS[flavor];
  if (spec.listShape === "none" || spec.listPaths.length === 0) return [];
  if (spec.listShape === "openai-list") {
    const errors = [];
    for (const p of spec.listPaths) {
      try {
        const url = new URL(base);
        const clean = url.pathname.replace(/\/+$/, "");
        const target = clean.endsWith(p) ? base : new URL(`${clean}${p}`, url.origin).toString();
        const models = await fetchEndpointModels(target, apiKey);
        if (models.length > 0) return models;
      } catch (error) {
        errors.push(sanitizeErrorMessage(error));
      }
    }
    if (errors.length > 0) throw new Error(errors[errors.length - 1]);
    return [];
  }
  for (const p of spec.listPaths) {
    try {
      const url = new URL(base);
      const clean = url.pathname.replace(/\/+$/, "");
      const target = clean.endsWith(p) ? base : new URL(`${clean}${p}`, url.origin).toString();
      const listUrl = geminiListUrl(target, spec.listShape, apiKey);
      const res = await fetch(listUrl, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15e3)
      });
      if (!res.ok) continue;
      const raw = await res.json();
      const items = normalizeListShape(raw, spec.listShape);
      if (items.length > 0) return items;
    } catch {
    }
  }
  return [];
}
function geminiListUrl(target, shape, apiKey) {
  if (shape !== "gemini-list" || !apiKey) return target;
  try {
    const url = new URL(target);
    url.searchParams.set("key", apiKey);
    return url.toString();
  } catch {
    return `${target}${target.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`;
  }
}
function normalizeListShape(raw, shape) {
  if (shape === "ollama-tags") {
    const models = raw["models"];
    if (!Array.isArray(models)) return [];
    return models.filter((m) => typeof m === "object" && m !== null && typeof m["name"] === "string").map((m) => ({ id: m["name"].split(":")[0].trim() || m["name"] })).filter((m) => m.id.length > 0);
  }
  if (shape === "gemini-list") {
    const models = raw["models"];
    if (!Array.isArray(models)) return [];
    const out = [];
    for (const m of models) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m;
      const name = rec["name"];
      if (typeof name !== "string" || name.length === 0) continue;
      const id3 = name.startsWith("models/") ? name.slice(7) : name;
      const item = { id: id3 };
      if (typeof rec["displayName"] === "string") item.name = rec["displayName"];
      if (typeof rec["inputTokenLimit"] === "number") item.context_length = rec["inputTokenLimit"];
      if (typeof rec["outputTokenLimit"] === "number") item.max_output_tokens = rec["outputTokenLimit"];
      out.push(item);
    }
    return out;
  }
  return [];
}
function resolveModel(item, lookup, flavor, customs) {
  const spec = FLAVORS[flavor];
  const id3 = sanitizeModelId(item.id);
  const key = normalizeModelId(id3);
  const meta = lookup.get(key);
  const custom = customs[key];
  const rule = custom ? { meta: custom, pattern: `custom:${key}` } : matchLocalRule(id3);
  const caps = parseCapabilities(item);
  const levels = parseEffortOptions(item);
  const probed = { id: id3 };
  if (item.name && item.name !== item.id) probed.name = item.name;
  else if (meta) probed.name = meta.name;
  const epContext = [item.context_window, item.max_model_len, item.context_length].find((v) => typeof v === "number");
  if (epContext !== void 0) {
    probed.context = epContext;
    probed.contextSource = "detected";
  } else if (meta) {
    probed.context = meta.limit.context;
    probed.contextSource = "models.dev";
  } else if (rule) {
    probed.context = rule.meta.context;
    probed.contextSource = "local-rules";
  } else {
    probed.context = spec.fallbackLimits.context;
    probed.contextSource = "api-fallback";
  }
  const epOutput = [item.max_completion_tokens, item.max_output_tokens].find((v) => typeof v === "number");
  if (epOutput !== void 0) {
    probed.maxOutput = epOutput;
    probed.maxOutputSource = "detected";
  } else if (meta) {
    probed.maxOutput = meta.limit.output;
    probed.maxOutputSource = "models.dev";
  } else if (rule) {
    probed.maxOutput = rule.meta.output;
    probed.maxOutputSource = "local-rules";
  } else {
    probed.maxOutput = spec.fallbackLimits.output;
    probed.maxOutputSource = "api-fallback";
  }
  if (probed.maxOutput !== void 0 && probed.context !== void 0 && probed.maxOutput >= probed.context) {
    probed.maxOutput = Math.max(1, Math.floor(probed.context / 2));
  }
  if (caps.reasoning || meta?.reasoning) {
    probed.reasoning = true;
    probed.reasoningSource = caps.reasoning ? "detected" : "models.dev";
  } else if (levels && levels.length > 0) {
    probed.reasoning = true;
    probed.reasoningSource = "detected";
  } else if (rule) {
    probed.reasoning = rule.meta.reasoning;
    probed.reasoningSource = "local-rules";
  }
  if (levels && levels.length > 0) probed.reasoningLevels = levels;
  const vision = item.capabilities?.vision === true;
  const metaImage = meta?.modalities?.input.includes("image") ?? false;
  if (vision || metaImage) {
    probed.image = true;
    probed.imageSource = vision ? "detected" : "models.dev";
  } else if (rule) {
    probed.image = rule.meta.image;
    probed.imageSource = "local-rules";
  } else {
    probed.image = false;
    probed.imageSource = "default";
  }
  const hasEndpointCost = typeof item.input_cost === "number" || typeof item.output_cost === "number";
  if (hasEndpointCost) {
    probed.cost = {
      input: typeof item.input_cost === "number" ? item.input_cost : 0,
      output: typeof item.output_cost === "number" ? item.output_cost : 0
    };
    probed.costSource = "detected";
  } else if (meta?.cost) {
    probed.cost = {
      input: meta.cost.input ?? 0,
      output: meta.cost.output ?? 0,
      cache_read: meta.cost.cache_read,
      cache_write: meta.cost.cache_write
    };
    probed.costSource = "models.dev";
  }
  return probed;
}
function modelsUrlFor(candidate, flavor) {
  const first = FLAVORS[flavor].listPaths[0] ?? "/models";
  try {
    const url = new URL(candidate);
    const clean = url.pathname.replace(/\/+$/, "");
    if (clean.endsWith(first)) return candidate;
    return new URL(`${clean}${first}`, url.origin).toString();
  } catch {
    return candidate;
  }
}
async function probeEndpointOutcome(baseURL, apiKey, flavor = DEFAULT_FLAVOR) {
  if (!isValidUrl(baseURL)) {
    throw new Error("Invalid Base URL. Please enter a full URL (including https://).");
  }
  if (FLAVORS[flavor].listShape === "none") {
    return { models: [], baseURL, listUnsupported: true };
  }
  const lookup = await getLookupMap();
  const customs = loadCustomRules();
  const candidates = buildCandidateUrls(baseURL);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const items = await fetchFlavorModels(candidate, apiKey, flavor);
      if (items.length > 0) {
        let origin = "";
        try {
          origin = new URL(candidate).origin;
        } catch {
          origin = candidate;
        }
        const deep = await deepenEndpointItems(items, {
          modelsUrl: modelsUrlFor(candidate, flavor),
          origin,
          apiKey,
          flavor
        });
        return {
          models: deep.map((item) => resolveModel(item, lookup, flavor, customs)),
          baseURL: candidate,
          listUnsupported: false
        };
      }
    } catch (error) {
      lastError = sanitizeErrorMessage(error);
    }
  }
  throw new Error(
    `Probe failed for ${baseURL}` + (lastError ? `: ${lastError}` : ". No models found: retry or add models manually.")
  );
}
async function probeEndpoint(baseURL, apiKey, flavor = DEFAULT_FLAVOR) {
  return (await probeEndpointOutcome(baseURL, apiKey, flavor)).models;
}
function probedToEnriched(probed, displayStyle) {
  const limit = {};
  if (hasEvidence(probed.contextSource)) limit.context = probed.context;
  if (hasEvidence(probed.maxOutputSource)) limit.output = probed.maxOutput;
  const model = {
    name: displayStyle === "slug" ? probed.id : probed.name ?? probed.id,
    limit
  };
  if (hasEvidence(probed.imageSource)) {
    model.modalities = probed.image ? { input: ["text", "image"], output: ["text"] } : { input: ["text"], output: ["text"] };
  }
  if (probed.reasoning) model.reasoning = true;
  if (probed.reasoningLevels?.length) model.reasoningLevels = [...probed.reasoningLevels];
  if (probed.cost) {
    model.cost = {
      input: probed.cost.input,
      output: probed.cost.output,
      cache_read: probed.cost.cache_read,
      cache_write: probed.cost.cache_write
    };
  }
  return model;
}
function hasEvidence(source) {
  return source !== void 0 && source !== "default" && source !== "api-fallback";
}
function isAuthoritative(source) {
  return source === "detected" || source === "models.dev";
}
function describeProbed(probed) {
  const lines = [`Model: ${probed.id}`];
  if (hasEvidence(probed.contextSource)) {
    lines.push(`  Context window: ${probed.context?.toLocaleString("en-US") ?? "unknown"} tokens${tag(probed.contextSource)}`);
  }
  if (hasEvidence(probed.maxOutputSource)) {
    lines.push(`  Longest reply: ${probed.maxOutput?.toLocaleString("en-US") ?? "unknown"} tokens${tag(probed.maxOutputSource)}`);
  }
  if (probed.reasoning !== void 0) {
    const levels = probed.reasoningLevels?.length ? ` (${probed.reasoningLevels.join("/")})` : "";
    lines.push(`  Thinking: ${probed.reasoning ? "supported" : "not supported"}${levels}${tag(probed.reasoningSource)}`);
  }
  if (hasEvidence(probed.imageSource)) {
    lines.push(`  Image input: ${probed.image ? "supported" : "not supported"}${tag(probed.imageSource)}`);
  }
  if (probed.cost) {
    lines.push(
      `  Price: $${probed.cost.input} per million input tokens, $${probed.cost.output} per million output tokens${tag(probed.costSource)}`
    );
  }
  return lines.join("\n");
}
function tag(source) {
  return source === "detected" || source === void 0 ? "" : ` [${source}]`;
}
function catalogToProbed(model) {
  const probed = { id: model.id, name: model.name };
  probed.context = model.limit.context;
  probed.contextSource = "models.dev";
  probed.maxOutput = model.limit.output;
  probed.maxOutputSource = "models.dev";
  probed.reasoning = model.reasoning;
  probed.reasoningSource = "models.dev";
  const image = model.modalities?.input.includes("image") ?? false;
  probed.image = image;
  probed.imageSource = "models.dev";
  if (model.cost) {
    probed.cost = {
      input: model.cost.input ?? 0,
      output: model.cost.output ?? 0,
      cache_read: model.cost.cache_read,
      cache_write: model.cost.cache_write
    };
    probed.costSource = "models.dev";
  }
  return probed;
}
function parseModelIds(raw) {
  if (raw === void 0) return void 0;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
async function buildCatalogModels(siteId, modelIds, displayStyle) {
  const catalog = await getCatalog();
  const site = catalog[siteId];
  if (!site) throw new Error(`Unknown catalog site '${siteId}'.`);
  if (!site.api || !isValidUrl(site.api)) {
    throw new Error(`Catalog site '${siteId}' has no usable API endpoint.`);
  }
  const wanted = modelIds && modelIds.length > 0 ? new Set(modelIds.map((m) => m.trim()).filter((m) => m.length > 0)) : null;
  const models = {};
  const resolved = [];
  const matched = /* @__PURE__ */ new Set();
  for (const model of Object.values(site.models ?? {})) {
    const id3 = sanitizeModelId(model.id);
    if (wanted) {
      const hit = wanted.has(id3) || wanted.has(model.id);
      if (!hit) continue;
      if (wanted.has(id3)) matched.add(id3);
      if (wanted.has(model.id)) matched.add(model.id);
    }
    const probed = catalogToProbed({ ...model, id: id3 });
    resolved.push(probed);
    models[id3] = probedToEnriched(probed, displayStyle);
  }
  const missing = wanted ? [...wanted].filter((raw) => !matched.has(raw)) : [];
  return { baseURL: site.api, models, resolved, missing };
}
async function previewManualModels(ids, flavor, displayStyle) {
  const lookup = await getLookupMap();
  const customs = loadCustomRules();
  const resolvedFlavor = flavor ?? DEFAULT_FLAVOR;
  const style = displayStyle ?? "slug";
  const out = [];
  for (const raw of ids) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const probed = resolveModel({ id: trimmed }, lookup, resolvedFlavor, customs);
    out.push({ id: probed.id, probed, model: probedToEnriched(probed, style) });
  }
  return out;
}

// src/discovery.ts
async function discoverAndEnrich(baseURL, apiKey, displayStyle = "slug", flavor = DEFAULT_FLAVOR) {
  const probed = await probeEndpoint(baseURL, apiKey, flavor);
  const result = {};
  for (const p of probed) {
    const id3 = sanitizeModelId(p.id);
    result[id3] = probedToEnriched(p, displayStyle);
  }
  return result;
}

// src/types.ts
function getApiKey(provider, providerId) {
  if (provider.options?.apiKey) return provider.options.apiKey;
  const envKey = `OPENCODE_LOCAL_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return process.env[envKey];
}
function shouldDiscover(provider) {
  const baseURL = provider.options?.baseURL;
  if (!baseURL || !isValidUrl(baseURL)) return false;
  if (provider.dynamic === true) return true;
  const models = provider.models;
  return !models || Object.keys(models).length === 0;
}

// src/reconcile.ts
function hasImage(model) {
  return model.modalities?.input.includes("image") ?? false;
}
function sourcesOf(probed) {
  return {
    contextSource: probed.contextSource,
    maxOutputSource: probed.maxOutputSource,
    costSource: probed.costSource,
    imageSource: probed.imageSource
  };
}
function freshWins(sources, source) {
  return sources === void 0 || isAuthoritative(source);
}
function describeUpdate(id3, current, fresh, sources) {
  const parts = [];
  if (fresh.limit.context !== void 0 && (current.limit.context === void 0 || freshWins(sources, sources?.contextSource)) && current.limit.context !== fresh.limit.context) {
    parts.push(`context ${current.limit.context} -> ${fresh.limit.context}`);
  }
  if (fresh.limit.output !== void 0 && (current.limit.output === void 0 || freshWins(sources, sources?.maxOutputSource)) && current.limit.output !== fresh.limit.output) {
    parts.push(`max-out ${current.limit.output} -> ${fresh.limit.output}`);
  }
  if (current.name !== fresh.name) {
    parts.push(`name "${current.name}" -> "${fresh.name}"`);
  }
  if (!!current.reasoning !== !!fresh.reasoning) {
    parts.push(fresh.reasoning ? "reasoning [+]" : "reasoning [-]");
  }
  if (fresh.modalities !== void 0 && (current.modalities === void 0 || freshWins(sources, sources?.imageSource)) && hasImage(current) !== hasImage(fresh)) {
    parts.push(hasImage(fresh) ? "image [+]" : "image [-]");
  }
  if (parts.length === 0) return null;
  return `${id3}: ${parts.join(", ")}`;
}
function mergeAppliedModel(stored, fresh, sources) {
  const limit = { ...stored.limit };
  if (fresh.limit.context !== void 0 && (stored.limit.context === void 0 || freshWins(sources, sources?.contextSource))) {
    limit.context = fresh.limit.context;
  }
  if (fresh.limit.input !== void 0) limit.input = fresh.limit.input;
  if (fresh.limit.output !== void 0 && (stored.limit.output === void 0 || freshWins(sources, sources?.maxOutputSource))) {
    limit.output = fresh.limit.output;
  }
  const modalities = fresh.modalities !== void 0 && (stored.modalities === void 0 || freshWins(sources, sources?.imageSource)) ? fresh.modalities : stored.modalities;
  const merged = {
    name: fresh.name,
    limit,
    modalities
  };
  if (stored.family !== void 0) merged.family = stored.family;
  if (stored.release_date !== void 0) merged.release_date = stored.release_date;
  if (stored.status !== void 0) merged.status = stored.status;
  if (stored.attachment !== void 0) merged.attachment = stored.attachment;
  if (stored.temperature !== void 0) merged.temperature = stored.temperature;
  if (stored.tool_call !== void 0) merged.tool_call = stored.tool_call;
  if (fresh.reasoning) merged.reasoning = true;
  if (fresh.cost && (stored.cost === void 0 || freshWins(sources, sources?.costSource))) {
    merged.cost = { ...fresh.cost };
  } else if (stored.cost) {
    merged.cost = { ...stored.cost };
  }
  if (fresh.reasoningLevels?.length) {
    merged.reasoningLevels = [...fresh.reasoningLevels];
  } else if (merged.reasoning && stored.reasoningLevels?.length) {
    merged.reasoningLevels = [...stored.reasoningLevels];
  }
  return merged;
}
function diffModels(current, fresh, displayStyle) {
  const changes = [];
  const seen = /* @__PURE__ */ new Set();
  for (const p of fresh) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const stored = current[p.id];
    if (!stored) {
      changes.push({ id: p.id, kind: "added", detail: `${p.id}: new model`, searchText: `${p.id} added` });
      continue;
    }
    const detail = describeUpdate(p.id, stored, probedToEnriched(p, displayStyle), sourcesOf(p));
    if (detail) changes.push({ id: p.id, kind: "updated", detail, searchText: `${p.id} updated` });
  }
  for (const id3 of Object.keys(current)) {
    if (!seen.has(id3)) {
      changes.push({ id: id3, kind: "removed", detail: `${id3}: vanished upstream (unsupported)`, searchText: `${id3} removed` });
    }
  }
  return changes;
}
function applyDecisions(current, fresh, decisions, displayStyle) {
  const next = { ...current };
  const freshById = new Map(fresh.map((p) => [p.id, p]));
  for (const p of fresh) {
    const decision = decisions[p.id] ?? "apply";
    if (!current[p.id]) {
      if (decision === "apply") next[p.id] = probedToEnriched(p, displayStyle);
    } else if (decision === "apply") {
      next[p.id] = mergeAppliedModel(current[p.id], probedToEnriched(p, displayStyle), sourcesOf(p));
    } else if (decision === "remove") {
      delete next[p.id];
    }
  }
  for (const id3 of Object.keys(current)) {
    if (!freshById.has(id3)) {
      const decision = decisions[id3] ?? "keep";
      if (decision !== "keep") delete next[id3];
    }
  }
  return next;
}

// src/commands.ts
async function reloadOneProvider(providerId, providerConfig) {
  const baseURL = providerConfig.options.baseURL;
  const apiKey = getApiKey(providerConfig, providerId);
  const displayStyle = providerConfig.displayStyle ?? "slug";
  try {
    const models = await discoverAndEnrich(baseURL, apiKey, displayStyle, getProviderFlavor(providerConfig));
    const count = Object.keys(models).length;
    if (count > 0) {
      return { providerId, models };
    }
    if (providerConfig.models && Object.keys(providerConfig.models).length > 0) {
      return {
        providerId,
        models: null,
        warning: `${providerId} returned 0 models (keeping previous models). Check endpoint status.`
      };
    }
    return { providerId, models: null };
  } catch (error) {
    return {
      providerId,
      models: null,
      error: `Failed to reload ${providerId}: ${sanitizeErrorMessage(error)}`
    };
  }
}
async function chunkedAllSettled(tasks, size = 4) {
  const outcomes = [];
  for (let i = 0; i < tasks.length; i += size) {
    const settled = await Promise.allSettled(tasks.slice(i, i + size).map((fn) => fn()));
    outcomes.push(...settled);
  }
  return outcomes;
}
async function reloadAllProviders(providers) {
  const dynamicProviders = Object.entries(providers).filter(
    ([, p]) => shouldDiscover(p)
  );
  const result = {
    totalModels: 0,
    failures: 0,
    providerCount: dynamicProviders.length,
    warnings: [],
    errors: []
  };
  if (dynamicProviders.length === 0) return result;
  clearModelsDevCache();
  const outcomes = await chunkedAllSettled(
    dynamicProviders.map(([id3, cfg]) => () => reloadOneProvider(id3, cfg)),
    4
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      result.failures++;
      result.errors.push(`Unexpected error: ${sanitizeErrorMessage(outcome.reason)}`);
      continue;
    }
    const { providerId, models, warning, error } = outcome.value;
    if (error) {
      result.failures++;
      result.errors.push(error);
    } else if (warning) {
      result.warnings.push(warning);
    }
    if (models) {
      const providerConfig = providers[providerId];
      providerConfig.models = models;
      result.totalModels += Object.keys(models).length;
    }
  }
  return result;
}
function validateProviderId(providerId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(providerId)) {
    return "Invalid Provider ID. Use alphanumeric, hyphens, or underscores only.";
  }
  return null;
}
function validateAddProviderParams(params, existingProviders) {
  const idError = validateProviderId(params.providerId);
  if (idError) return idError;
  if (!isValidUrl(normalizeBaseUrl(params.baseURL))) {
    return "Invalid Base URL. Please enter a full URL (including https://).";
  }
  if (existingProviders[params.providerId] && !params.overwrite) {
    return `A provider with ID '${params.providerId}' already exists. Set overwrite to true to replace it.`;
  }
  return null;
}
async function addProvider(params) {
  const displayStyle = params.displayStyle ?? "slug";
  const baseURL = normalizeBaseUrl(params.baseURL).replace(/\/+$/, "");
  try {
    const models = await discoverAndEnrich(baseURL, params.apiKey, displayStyle, params.flavor ?? DEFAULT_FLAVOR);
    const modelCount = Object.keys(models).length;
    if (modelCount === 0) {
      return {
        success: false,
        modelCount: 0,
        message: "No models found at the given endpoint. Provider not added."
      };
    }
    const providerEntry = {
      name: params.providerId,
      npm: "@ai-sdk/openai-compatible",
      api: baseURL,
      options: { baseURL },
      dynamic: true,
      displayStyle,
      models
    };
    if (params.flavor) providerEntry.flavor = params.flavor;
    if (params.apiKey) {
      const role = await probeDeveloperRole(baseURL, params.apiKey);
      if (role === false) {
        providerEntry.compat = { supportsDeveloperRole: false };
      }
    }
    return {
      success: true,
      modelCount,
      message: `Provider '${params.providerId}' added with ${modelCount} model(s).`,
      providerEntry
    };
  } catch (error) {
    return {
      success: false,
      modelCount: 0,
      message: `Failed to discover models: ${sanitizeErrorMessage(error)}`
    };
  }
}
async function persistProviderApiKey(providerEntry, providerId, apiKey, storeApiKey) {
  if (!apiKey) return;
  let storedInAuthStore = false;
  try {
    storedInAuthStore = await storeApiKey(providerId, apiKey);
  } catch {
    storedInAuthStore = false;
  }
  if (!storedInAuthStore) {
    throw new Error(
      `Failed to persist API key for provider '${providerId}' in auth store`
    );
  }
}
function getProviderFlavor(provider) {
  const raw = provider.flavor;
  return (typeof raw === "string" ? parseFlavor(raw) : null) ?? DEFAULT_FLAVOR;
}
async function reprobeProvider(providerId, provider) {
  const baseURL = provider.options?.baseURL;
  if (!baseURL || !isValidUrl(baseURL)) {
    throw new Error(`Provider '${providerId}' has no valid baseURL to probe.`);
  }
  const apiKey = getApiKey(provider, providerId);
  const displayStyle = provider.displayStyle ?? "slug";
  const flavor = getProviderFlavor(provider);
  if (FLAVORS[flavor].listShape === "none") {
    return { changes: [], fresh: [] };
  }
  const fresh = await probeEndpoint(baseURL, apiKey, flavor);
  const current = provider.models ?? {};
  return { changes: diffModels(current, fresh, displayStyle), fresh };
}
function applyReconcile(provider, fresh, decisions) {
  const displayStyle = provider.displayStyle ?? "slug";
  const current = provider.models ?? {};
  return applyDecisions(current, fresh, decisions, displayStyle);
}
function renameProviderEntry(providers, oldId, newId) {
  const clean = newId.trim();
  const idError = validateProviderId(clean);
  if (idError) return { error: idError };
  const entry = providers[oldId];
  if (!entry) return { error: `Unknown provider '${oldId}'.` };
  if (clean !== oldId && providers[clean]) {
    return { error: `A provider with ID '${clean}' already exists.` };
  }
  entry.name = clean;
  const originalKeys = Object.keys(providers);
  const rebuilt = {};
  for (const key of originalKeys) {
    const value = key === oldId ? entry : providers[key];
    const target = key === oldId ? clean : key;
    Object.defineProperty(rebuilt, target, { value, enumerable: true, writable: true, configurable: true });
  }
  for (const key of originalKeys) {
    delete providers[key];
  }
  for (const key of Object.keys(rebuilt)) {
    Object.defineProperty(providers, key, {
      value: rebuilt[key],
      enumerable: true,
      writable: true,
      configurable: true
    });
  }
  const suggestion = collisionSuggestion(clean);
  if (suggestion && suggestion !== clean) {
    return {
      warning: `'${clean}' matches a well-known built-in id and will merge with it. Consider '${suggestion}' for a fully separate provider.`
    };
  }
  return {};
}
function deleteProviderEntry(providers, providerId) {
  if (!providers[providerId]) return `Unknown provider '${providerId}'.`;
  delete providers[providerId];
  return null;
}
function parseToggle(value) {
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return null;
}
function editModelField(models, modelId, field, value) {
  const model = models[modelId];
  if (!model) return `Unknown model '${modelId}'.`;
  switch (field) {
    case "name": {
      const name = value.trim();
      if (!name) return "Name must not be empty.";
      model.name = name;
      return null;
    }
    case "context":
    case "output": {
      model.limit ??= {};
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return `'${field}' must be a positive integer (got '${value}').`;
      }
      if (field === "context") model.limit.context = n;
      else model.limit.output = n;
      return null;
    }
    case "reasoning": {
      const b = parseToggle(value);
      if (b === null) return `Use true/false for 'reasoning' (got '${value}').`;
      if (b) model.reasoning = true;
      else delete model.reasoning;
      return null;
    }
    case "image": {
      const b = parseToggle(value);
      if (b === null) return `Use true/false for 'image' (got '${value}').`;
      model.modalities = b ? { input: ["text", "image"], output: ["text"] } : { input: ["text"], output: ["text"] };
      return null;
    }
  }
}
function getStoredModels(provider) {
  return provider.models ?? {};
}
function deleteModels(models, ids) {
  const deleted = [];
  const missing = [];
  for (const raw of ids) {
    const id3 = raw.trim();
    if (!id3) continue;
    if (models[id3]) {
      delete models[id3];
      deleted.push(id3);
    } else {
      missing.push(id3);
    }
  }
  return { deleted, missing };
}
async function migrateInlineKey(provider, providerId, storeApiKey) {
  const inline = provider.options?.apiKey;
  if (!inline) return { migrated: false, note: "" };
  try {
    const ok = await storeApiKey(providerId, inline);
    if (!ok) {
      return { migrated: false, note: `Kept inline API key for '${providerId}' (auth store declined).` };
    }
  } catch {
    return { migrated: false, note: `Kept inline API key for '${providerId}' (auth store unavailable).` };
  }
  if (provider.options) delete provider.options.apiKey;
  return { migrated: true, note: `Migrated inline API key for '${providerId}' to the auth store.` };
}

// src/opencode-client.ts
function createTuiBridge(apiClient) {
  return {
    async setApiKey(id3, key) {
      await apiClient.auth.set({ providerID: id3, auth: { type: "api", key } });
    },
    async removeApiKey(id3) {
      await apiClient.auth.remove({ providerID: id3 });
    },
    async updateProviders(providers) {
      const body = { provider: providers };
      await apiClient.config.update({ config: body });
    },
    async getProviders() {
      const { data: config } = await apiClient.config.get();
      return config?.provider ?? {};
    }
  };
}

// src/tui.ts
function showPrompt(api, title, placeholder) {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () => api.ui.DialogPrompt({
        title,
        placeholder,
        onConfirm: (value) => resolve(value),
        onCancel: () => resolve(null)
      }),
      () => resolve(null)
    );
  });
}
function showConfirm(api, title, message) {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () => api.ui.DialogConfirm({
        title,
        message,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false)
      }),
      () => resolve(false)
    );
  });
}
function showSelect(api, title, options) {
  return new Promise((resolve) => {
    api.ui.dialog.replace(
      () => api.ui.DialogSelect({
        title,
        options: options.map((o) => ({
          ...o,
          onSelect: () => resolve(o.value)
        }))
      }),
      () => resolve(null)
    );
  });
}
var tui = async (api) => {
  const bridge = createTuiBridge(api.client);
  api.command.register(() => [
    {
      title: "Reload Models",
      value: "reload-models",
      description: "Re-discover models from all dynamic providers without restarting",
      slash: {
        name: "reload-models",
        aliases: ["refresh-models"]
      },
      onSelect: async () => {
        const providers = await bridge.getProviders();
        const result = await reloadAllProviders(providers);
        if (result.providerCount === 0) {
          api.ui.toast({ message: "No dynamic providers configured.", variant: "warning" });
          return;
        }
        api.ui.toast({
          message: `Reloading models from ${result.providerCount} provider(s)...`,
          variant: "info"
        });
        for (const w of result.warnings) {
          api.ui.toast({ message: w, variant: "warning" });
        }
        for (const e of result.errors) {
          api.ui.toast({ message: e, variant: "error" });
        }
        if (result.totalModels > 0) {
          await bridge.updateProviders(providers);
        }
        if (result.failures === 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) from ${result.providerCount} provider(s).`,
            variant: "success"
          });
        } else if (result.totalModels > 0) {
          api.ui.toast({
            message: `Reloaded ${result.totalModels} model(s) with ${result.failures} failure(s). Check provider URLs/keys.`,
            variant: "warning"
          });
        }
      }
    },
    {
      title: "Add Provider",
      value: "add-provider",
      description: "Add a new OpenAI-compatible custom provider with dynamic model discovery",
      slash: {
        name: "add-provider"
      },
      onSelect: async () => {
        const source = await showSelect(api, "Add provider", [
          { title: "Custom endpoint", value: "endpoint", description: "Probe /models and metadata sources" },
          { title: "models.dev catalog", value: "catalog", description: "Known site, metadata from catalog, no probing" }
        ]);
        if (!source) return;
        if (source === "catalog") {
          let sites;
          try {
            api.ui.toast({ message: "Loading models.dev catalog...", variant: "info" });
            sites = await listCatalogSites();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Catalog failed: ${message}`, variant: "error" });
            return;
          }
          if (sites.length === 0) {
            api.ui.toast({ message: "Catalog is empty.", variant: "warning" });
            return;
          }
          const siteId = await showSelect(api, "Catalog site", sites.map((s) => ({
            title: s.name,
            value: s.id,
            description: `${s.modelCount} model(s)`
          })));
          if (!siteId) return;
          const site = sites.find((s) => s.id === siteId);
          if (!site) return;
          const rawProviderId2 = await showPrompt(api, "Provider ID", siteId);
          if (!rawProviderId2) return;
          const providerId2 = rawProviderId2.trim();
          const idError2 = validateProviderId(providerId2);
          if (idError2) {
            api.ui.toast({ message: idError2, variant: "error" });
            return;
          }
          const suggestion = collisionSuggestion(providerId2);
          if (suggestion && suggestion !== providerId2) {
            api.ui.toast({ message: `'${providerId2}' merges with a built-in id; '${suggestion}' stays separate.`, variant: "warning" });
          }
          const catProviders = await bridge.getProviders();
          if (catProviders[providerId2]) {
            const overwrite2 = await showConfirm(api, "Provider already exists", `Overwrite '${providerId2}'?`);
            if (!overwrite2) return;
          }
          const rawApiKey2 = await showPrompt(api, "API Key (Optional)", "sk-...");
          const apiKey2 = rawApiKey2?.trim() || void 0;
          const displayStyle2 = await showSelect(api, "Model Display Names", [
            { title: "Full Slug", value: "slug", description: "vertex/gemini-3.1-pro (best for proxies)" },
            { title: "Friendly Name", value: "name", description: "Gemini 3.1 Pro (may be ambiguous)" }
          ]);
          if (!displayStyle2) return;
          const scope = await showSelect(api, `${site.modelCount} model(s) available`, [
            { title: "Add all", value: "all", description: `${site.modelCount} model(s)` },
            { title: "Pick ids", value: "pick", description: "Comma-separated" },
            { title: "Cancel", value: "cancel", description: "Add nothing" }
          ]);
          if (!scope || scope === "cancel") return;
          let modelIds;
          if (scope === "pick") {
            const rawIds = await showPrompt(api, "Model ids (comma-separated)");
            if (!rawIds) return;
            modelIds = parseModelIds(rawIds);
            if (!modelIds || modelIds.length === 0) {
              api.ui.toast({ message: "No model ids provided. Enter at least one id (comma-separated).", variant: "error" });
              return;
            }
          }
          api.ui.toast({ message: `Adding ${providerId2} from catalog...`, variant: "info" });
          let built;
          try {
            built = await buildCatalogModels(siteId, modelIds, displayStyle2);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Catalog add failed: ${message}`, variant: "error" });
            return;
          }
          const entry2 = {
            name: providerId2,
            npm: "@ai-sdk/openai-compatible",
            api: built.baseURL,
            options: { baseURL: built.baseURL },
            dynamic: true,
            displayStyle: displayStyle2,
            models: built.models
          };
          try {
            await persistProviderApiKey(entry2, providerId2, apiKey2, async (id3, key) => {
              await bridge.setApiKey(id3, key);
              return true;
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" });
            return;
          }
          catProviders[providerId2] = entry2;
          await bridge.updateProviders(catProviders);
          const stored2 = Object.keys(built.models).length;
          api.ui.toast({
            message: `Added ${stored2} model(s)${built.missing.length > 0 ? `, unknown: ${built.missing.join(", ")}` : ""}.`,
            variant: "success"
          });
          return;
        }
        const rawProviderId = await showPrompt(api, "Provider ID", "e.g., my-proxy (alphanumeric only)");
        if (!rawProviderId) return;
        const providerId = rawProviderId.trim();
        const idError = validateProviderId(providerId);
        if (idError) {
          api.ui.toast({ message: idError, variant: "error" });
          return;
        }
        const providers = await bridge.getProviders();
        let overwrite = false;
        if (providers[providerId]) {
          overwrite = await showConfirm(
            api,
            "Provider already exists",
            `A provider with ID '${providerId}' already exists. Overwrite it?`
          );
          if (!overwrite) return;
        }
        const rawBaseURL = await showPrompt(api, "Base URL", "https://api.example.com/v1");
        if (!rawBaseURL) return;
        const baseURL = rawBaseURL.trim();
        const rawApiKey = await showPrompt(api, "API Key (Optional)", "sk-...");
        const apiKey = rawApiKey?.trim() || void 0;
        const displayStyle = await showSelect(api, "Model Display Names", [
          {
            title: "Full Slug",
            value: "slug",
            description: "vertex/gemini-3.1-pro (best for proxies)"
          },
          {
            title: "Friendly Name",
            value: "name",
            description: "Gemini 3.1 Pro (may be ambiguous)"
          }
        ]);
        if (!displayStyle) return;
        const params = { providerId, baseURL, apiKey, displayStyle, overwrite };
        const validationError = validateAddProviderParams(params, providers);
        if (validationError) {
          api.ui.toast({ message: validationError, variant: "error" });
          return;
        }
        api.ui.toast({ message: `Discovering models from ${baseURL}...`, variant: "info" });
        const result = await addProvider(params);
        if (!result.success || !result.providerEntry) {
          api.ui.toast({ message: result.message, variant: "warning" });
          return;
        }
        try {
          await persistProviderApiKey(
            result.providerEntry,
            providerId,
            apiKey,
            async (id3, key) => {
              await bridge.setApiKey(id3, key);
              return true;
            }
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" });
          return;
        }
        providers[providerId] = result.providerEntry;
        await bridge.updateProviders(providers);
        const entry = result.providerEntry;
        const stored = Object.keys(entry.models ?? {}).length;
        const learned = [];
        for (const model of Object.values(entry.models ?? {})) {
          const limits = model.limit;
          if (limits?.context) learned.push("context");
          if (limits?.output) learned.push("max output");
          break;
        }
        const detail = learned.length ? ` Learned: ${[...new Set(learned)].join(", ")}.` : " No extra details were measured for it.";
        api.ui.toast({
          message: `${result.message}${detail} Run /model to pick one of its ${stored} model${stored === 1 ? "" : "s"}.`,
          variant: "success"
        });
      }
    },
    {
      title: "Re-probe Models",
      value: "reprobe-models",
      description: "Re-probe a provider and reconcile model changes",
      slash: {
        name: "reprobe-models"
      },
      onSelect: async () => {
        const providers = await bridge.getProviders();
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" });
          return;
        }
        const providerId = await showSelect(api, "Provider to re-probe", ids.map((id3) => ({ title: id3, value: id3 })));
        if (!providerId) return;
        const provider = providers[providerId];
        api.ui.toast({ message: `Probing ${providerId}...`, variant: "info" });
        let rep;
        try {
          rep = await reprobeProvider(providerId, provider);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.ui.toast({ message: `Re-probe failed: ${message}`, variant: "error" });
          return;
        }
        if (rep.changes.length === 0) {
          api.ui.toast({ message: `Already in sync (${rep.fresh.length} model(s)).`, variant: "success" });
          return;
        }
        const mode = await showSelect(api, `${rep.changes.length} change(s) found`, [
          { title: "Review each", value: "each", description: "Decide per model" },
          { title: "Keep what I have (safest)", value: "keep", description: "Leave every model as it is" },
          { title: "Cancel", value: "cancel", description: "Change nothing" }
        ]);
        if (!mode || mode === "cancel") return;
        if (mode === "keep") {
          api.ui.toast({ message: "Kept what you have. Nothing was changed.", variant: "info" });
          return;
        }
        const decisions = {};
        if (mode === "each") {
          const freshById = new Map(rep.fresh.map((p) => [p.id, p]));
          for (const change of rep.changes) {
            const fresh = freshById.get(change.id);
            const source = fresh ? `
${describeProbed(fresh)}` : "";
            const choice = await showSelect(api, `[${change.kind}] ${change.id}`, [
              { title: "Keep stored", value: "keep", description: "Leave the current entry unchanged" },
              { title: "Apply update", value: "apply", description: `${change.detail}${source}` },
              { title: "Remove", value: "remove", description: "Delete the stored entry" }
            ]);
            if (!choice) return;
            decisions[change.id] = choice;
          }
        }
        const next = applyReconcile(provider, rep.fresh, decisions);
        provider.models = next;
        await bridge.updateProviders(providers);
        api.ui.toast({ message: `Reconciled: ${Object.keys(next).length} model(s) stored.`, variant: "success" });
      }
    },
    {
      title: "Edit Provider",
      value: "edit-provider",
      description: "Rename, re-point, or tweak a provider and its models",
      slash: {
        name: "edit-provider"
      },
      onSelect: async () => {
        const providers = await bridge.getProviders();
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" });
          return;
        }
        const providerId = await showSelect(api, "Provider to edit", ids.map((id3) => ({ title: id3, value: id3 })));
        if (!providerId) return;
        const provider = providers[providerId];
        if (provider.options?.apiKey) {
          try {
            const migration = await migrateInlineKey(provider, providerId, async (id3, key) => {
              await bridge.setApiKey(id3, key);
              return true;
            });
            if (migration.migrated) {
              api.ui.toast({ message: migration.note, variant: "success" });
              await bridge.updateProviders(providers);
            } else if (migration.note) {
              api.ui.toast({ message: migration.note, variant: "warning" });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Key migration failed: ${message}`, variant: "error" });
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
          { title: "Delete models", value: "delete" }
        ]);
        if (!action) return;
        const save = async () => {
          await bridge.updateProviders(providers);
        };
        if (action === "rename") {
          const raw = await showPrompt(api, "New provider ID", providerId);
          if (!raw) return;
          let finalId = raw.trim();
          const suggestion = collisionSuggestion(finalId);
          if (suggestion && suggestion !== finalId) {
            const useSuggested = await showConfirm(
              api,
              "Built-in id collision",
              `'${finalId}' merges with a built-in provider. Use '${suggestion}' instead?`
            );
            if (useSuggested) finalId = suggestion;
          }
          const { error, warning } = renameProviderEntry(providers, providerId, finalId);
          if (error) {
            api.ui.toast({ message: error, variant: "error" });
            return;
          }
          await save();
          api.ui.toast({ message: `Renamed to '${finalId}'.`, variant: "success" });
          if (warning) api.ui.toast({ message: warning, variant: "warning" });
          api.ui.toast({ message: "Stored credential (if any) is still keyed by the old id: re-enter it via Edit Provider \u2192 API key.", variant: "warning" });
          return;
        }
        if (action === "endpoint") {
          const raw = await showPrompt(api, "Base URL", provider.options?.baseURL);
          if (!raw) return;
          const baseURL = normalizeBaseUrl(raw).replace(/\/+$/, "");
          if (!isValidUrl(baseURL)) {
            api.ui.toast({ message: "Invalid Base URL.", variant: "error" });
            return;
          }
          provider.options = { ...provider.options, baseURL };
          provider.api = baseURL;
          await save();
          api.ui.toast({ message: "Endpoint updated. Run Re-probe Models to refresh.", variant: "success" });
          return;
        }
        if (action === "flavor") {
          const flavor = await showSelect(api, "Endpoint flavor", Object.values(FLAVORS).map((f) => ({
            title: f.label,
            value: f.flavor,
            description: f.description
          })));
          if (!flavor) return;
          provider.flavor = flavor;
          await save();
          api.ui.toast({ message: `Flavor set to ${flavor}. Run Re-probe Models to refresh.`, variant: "success" });
          return;
        }
        if (action === "key") {
          const raw = await showPrompt(api, "API Key (blank to clear)", "sk-...");
          if (raw === null) return;
          const key = raw.trim() || void 0;
          try {
            await persistProviderApiKey(provider, providerId, key, async (id3, k) => {
              await bridge.setApiKey(id3, k);
              return true;
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            api.ui.toast({ message: `Failed to persist API key: ${message}`, variant: "error" });
            return;
          }
          if (!key) {
            try {
              await bridge.removeApiKey?.(providerId);
            } catch {
            }
          }
          if (!key && provider.options) delete provider.options.apiKey;
          await save();
          api.ui.toast({ message: key ? "API key updated." : "API key cleared.", variant: "success" });
          return;
        }
        if (action === "style") {
          const style = await showSelect(api, "Model display names", [
            { title: "Full Slug", value: "slug" },
            { title: "Friendly Name", value: "name" }
          ]);
          if (!style) return;
          provider.displayStyle = style;
          await save();
          api.ui.toast({ message: `Display style set to ${style}.`, variant: "success" });
          return;
        }
        const models = getStoredModels(provider);
        if (action === "model") {
          const modelIds = Object.keys(models);
          if (modelIds.length === 0) {
            api.ui.toast({ message: "No models stored.", variant: "warning" });
            return;
          }
          const modelId = await showSelect(api, "Model to edit", modelIds.map((id3) => ({ title: id3, value: id3 })));
          if (!modelId) return;
          const field = await showSelect(api, `Field of ${modelId}`, [
            { title: "Display name", value: "name" },
            { title: "Context window", value: "context" },
            { title: "Max output", value: "output" },
            { title: "Reasoning", value: "reasoning" },
            { title: "Image input", value: "image" }
          ]);
          if (!field) return;
          const m = models[modelId];
          m.limit ??= {};
          const current = field === "name" ? m.name : field === "context" ? String(m.limit.context) : field === "output" ? String(m.limit.output) : field === "reasoning" ? String(!!m.reasoning) : String(m.modalities?.input.includes("image") ?? false);
          const raw = await showPrompt(api, `${field} (current: ${current})`);
          if (raw === null) return;
          const error = editModelField(models, modelId, field, raw);
          if (error) {
            api.ui.toast({ message: error, variant: "error" });
            return;
          }
          provider.models = models;
          await save();
          api.ui.toast({ message: `Model '${modelId}' updated.`, variant: "success" });
          return;
        }
        if (action === "add") {
          const raw = await showPrompt(api, "Model ids (comma-separated)");
          if (!raw) return;
          const ids2 = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          if (ids2.length === 0) return;
          api.ui.toast({ message: "Resolving metadata...", variant: "info" });
          const previews = await previewManualModels(ids2, provider.flavor, provider.displayStyle);
          const lines = previews.map(({ probed }) => describeProbed(probed));
          const ok = await showConfirm(
            api,
            "Add models",
            `${previews.length} model(s):
${lines.slice(0, 10).join("\n")}${lines.length > 10 ? `
\u2026+${lines.length - 10} more` : ""}`
          );
          if (!ok) return;
          const stored = getStoredModels(provider);
          let added = 0;
          const skipped = [];
          for (const { id: id3, model } of previews) {
            if (!id3 || stored[id3]) {
              skipped.push(id3);
              continue;
            }
            stored[id3] = model;
            added++;
          }
          provider.models = stored;
          await save();
          api.ui.toast({
            message: `Added ${added}${skipped.length > 0 ? `, skipped ${skipped.length}` : ""}.`,
            variant: "success"
          });
          return;
        }
        if (action === "delete") {
          const modelIds = Object.keys(models);
          if (modelIds.length === 0) {
            api.ui.toast({ message: "No models stored.", variant: "warning" });
            return;
          }
          const raw = await showPrompt(api, "Model ids to delete (comma-separated)");
          if (!raw) return;
          const candidates = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          const unknown = candidates.filter((id3) => !models[id3]);
          if (unknown.length > 0) {
            api.ui.toast({ message: `Unknown model(s): ${unknown.join(", ")}.`, variant: "error" });
            return;
          }
          const ok = await showConfirm(
            api,
            "Delete models",
            `Remove ${candidates.length} model(s) from ${providerId}?
${candidates.join(", ")}`
          );
          if (!ok) return;
          const { deleted } = deleteModels(models, candidates);
          provider.models = models;
          await save();
          api.ui.toast({ message: `Deleted ${deleted.length} model(s).`, variant: "success" });
        }
      }
    },
    {
      title: "Delete Provider",
      value: "delete-provider",
      description: "Remove a provider and its models",
      slash: {
        name: "delete-provider"
      },
      onSelect: async () => {
        const providers = await bridge.getProviders();
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          api.ui.toast({ message: "No providers configured.", variant: "warning" });
          return;
        }
        const providerId = await showSelect(api, "Provider to delete", ids.map((id3) => ({ title: id3, value: id3 })));
        if (!providerId) return;
        const ok = await showConfirm(api, "Delete provider", `Remove '${providerId}' and all its models?`);
        if (!ok) return;
        const error = deleteProviderEntry(providers, providerId);
        if (error) {
          api.ui.toast({ message: error, variant: "error" });
          return;
        }
        await bridge.updateProviders(providers);
        api.ui.toast({ message: `Provider '${providerId}' deleted.`, variant: "success" });
      }
    }
  ]);
};
var tui_default = { id, tui, setup };
export {
  tui_default as default,
  id,
  tui
};
