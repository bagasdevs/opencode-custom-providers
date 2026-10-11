import { describe, expect, it } from "vitest"
import { setup, type DialogApi, type KeymapLayer, type V2TuiContext } from "../src/tui-v2.js"

type RpcCall = { rpcID: string; method: string; input?: unknown }

function makeContext(
  responses: unknown[],
  promptValues: Array<string | undefined>,
  selectValues: Array<string | undefined>,
  listProviders: Array<{ id: string; models: number }> = [],
) {
  const calls: RpcCall[] = []
  const alerts: Array<{ title: string; message: string }> = []
  const toasts: Array<{ title?: string; message: string }> = []
  let layerFactory: (() => KeymapLayer) | undefined
  const confirmValues: Array<boolean | undefined> = []
  const dialog: DialogApi = {
    alert: async options => {
      alerts.push(options)
    },
    // Undefined keeps the historical always-confirm behaviour the existing tests rely on.
    confirm: async () => confirmValues.shift() ?? true,
    prompt: async () => promptValues.shift(),
    select: async () => selectValues.shift(),
  }
  const context: V2TuiContext = {
    options: {},
    client: {
      rpc: {
        call: async input => {
          calls.push(input)
          // `list` is a side probe (the duplicate-name guard), not part of the scripted RPC
          // sequence these tests assert on, so it must not consume a scripted response.
          if (input.method === "list") return { output: { providers: listProviders } }
          return { output: responses.shift() }
        },
      },
    },
    ui: {
      dialog,
      toast: { show: options => { toasts.push(options) } },
      panel: { open: () => true },
    },
    keymap: {
      layer: factory => {
        layerFactory = factory
      },
    },
  }
  return { context, calls, alerts, toasts, confirmValues, getLayer: () => layerFactory?.() }
}

async function runAdd(state: ReturnType<typeof makeContext>): Promise<void> {
  setup(state.context)
  const command = state.getLayer()?.commands?.find(item => item.slash?.name === "add-provider")
  if (!command) throw new Error("add-provider command was not registered")
  await command.run()
}

const initialPrompts = ["my-proxy", "https://provider.example/v1", ""]

describe("v2 add recovery", () => {
  it("retries the same add request when the user chooses retry", async () => {
    const state = makeContext(
      [
        { status: "unreachable", message: "failed", detail: "HTTP 401" },
        { status: "ok", message: "ready" },
      ],
      [...initialPrompts],
      ["openai-chat", "slug", "retry"],
    )

    await runAdd(state)

    expect(state.calls.filter(call => call.method !== "list").map(call => call.method)).toEqual(["add", "add"])
    expect(state.calls.filter(c => c.method === "add")[0]?.input).toEqual(state.calls.filter(c => c.method !== "list")[1]?.input)
    expect(state.alerts.at(-1)?.message).toBe("ready")
  })

  it("sends the original provider fields and typed ids to manualAdd", async () => {
    const state = makeContext(
      [
        { status: "manual_required", message: "empty" },
        { status: "ok", message: "added" },
      ],
      [...initialPrompts, "model-a, model-b"],
      ["openai-chat", "slug", "manual"],
    )

    await runAdd(state)

    expect(state.calls.filter(call => call.method !== "list").map(call => call.method)).toEqual(["add", "manualAdd"])
    expect(state.calls.filter(c => c.method !== "list")[1]?.input).toEqual({
      providerId: "my-proxy",
      baseURL: "https://provider.example/v1",
      flavor: "openai-chat",
      apiKey: undefined,
      displayStyle: "slug",
      modelIds: "model-a, model-b",
    })
    expect(state.alerts.at(-1)?.message).toBe("added")
  })

  it("cancels without calling a write RPC after a failed probe", async () => {
    const state = makeContext(
      [{ status: "unreachable", message: "failed" }],
      [...initialPrompts],
      ["openai-chat", "slug", "cancel"],
    )

    await runAdd(state)

    expect(state.calls.filter(call => call.method !== "list").map(call => call.method)).toEqual(["add"])
    expect(state.alerts).toHaveLength(0)
  })

  it("re-prompts when manual model ids are invalid", async () => {
    const state = makeContext(
      [
        { status: "manual_required", message: "empty" },
        { status: "invalid", message: "bad ids" },
        { status: "ok", message: "added" },
      ],
      [...initialPrompts, "", "model-a"],
      ["openai-chat", "slug", "manual"],
    )

    await runAdd(state)

    expect(state.calls.filter(call => call.method !== "list").map(call => call.method)).toEqual(["add", "manualAdd", "manualAdd"])
    expect(state.alerts.map(alert => alert.message)).toEqual(["bad ids", "added"])
  })
})

describe("v2 add guards", () => {
  it("repairs a bare host before calling add", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["my-proxy", "bagas.up.railway.app/v1", ""],
      ["openai-chat", "slug"],
    )
    await runAdd(state)
    const add = state.calls.find(c => c.method === "add")
    expect(add?.input).toMatchObject({ baseURL: "https://bagas.up.railway.app/v1" })
  })

  it("keeps a localhost address on http", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["local", "localhost:11434", ""],
      ["ollama", "slug"],
    )
    await runAdd(state)
    expect(state.calls.find(c => c.method === "add")?.input).toMatchObject({ baseURL: "http://localhost:11434" })
  })

  it("asks before replacing a provider that already exists", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["taken", "https://provider.example/v1", ""],
      ["openai-chat", "slug"],
      [{ id: "taken", models: 12 }],
    )
    await runAdd(state)
    expect(state.calls.some(c => c.method === "add")).toBe(true)
  })

  it("stops when the user declines to replace", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["taken", "https://provider.example/v1", ""],
      ["openai-chat", "slug"],
      [{ id: "taken", models: 12 }],
    )
    state.confirmValues.push(false)
    await runAdd(state)
    expect(state.calls.some(c => c.method === "add")).toBe(false)
  })

  it("confirms a reused endpoint and only then adds with confirmReuse", async () => {
    const state = makeContext(
      [{ status: "confirm_endpoint_reuse", usedBy: ["other"], message: "already used" }, { status: "ok", message: "ready" }],
      ["mine", "https://shared.example/v1", ""],
      ["openai-chat", "slug"],
    )
    state.confirmValues.push(true)
    await runAdd(state)
    const adds = state.calls.filter(c => c.method === "add")
    expect(adds).toHaveLength(2)
    expect(adds[0]?.input).not.toHaveProperty("confirmReuse")
    expect(adds[1]?.input).toMatchObject({ confirmReuse: true })
  })

  it("sends Anthropic users to the manual prompt instead of a dead end", async () => {
    const state = makeContext(
      [{ status: "ok", message: "added" }],
      ["claude", "https://api.anthropic.com/v1", "", "claude-sonnet-5"],
      ["anthropic", "slug"],
    )
    await runAdd(state)
    // This flavour cannot list models, so the wizard must never call the network add...
    expect(state.calls.some(c => c.method === "add")).toBe(false)
    // ...and must finish through the manual path with the ids the user typed.
    const manual = state.calls.find(c => c.method === "manualAdd")
    expect(manual?.input).toMatchObject({ providerId: "claude", modelIds: "claude-sonnet-5" })
  })
})

describe("v2 command surface", () => {
  // These lock the decision that /add-known-provider and the add-from-catalog AGENT TOOL are
  // different things: one is a palette command, the other is model-only. An earlier revision
  // also aliased /add-from-catalog, which duplicated the command for no user benefit.
  const commands = (() => {
    const state = makeContext([], [], [])
    setup(state.context)
    return state.getLayer()?.commands ?? []
  })()

  it("registers every command under a unique slash name", () => {
    const names = commands.map(c => c.slash?.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("does not alias /add-from-catalog onto /add-known-provider", () => {
    const known = commands.find(c => c.slash?.name === "add-known-provider")
    expect(known).toBeDefined()
    expect(known?.slash?.aliases ?? []).not.toContain("add-from-catalog")
    const flat = commands.flatMap(c => c.slash?.aliases ?? [])
    expect(flat).not.toContain("add-from-catalog")
  })

  it("keeps the two add flows separate: probe vs catalog", () => {
    const names = commands.map(c => c.slash?.name)
    expect(names).toContain("add-provider")
    expect(names).toContain("add-known-provider")
  })
})

describe("v2 add cancellation", () => {
  // Reproduces the reported bug: pressing Esc at the API-key step must save nothing.
  // A full happy-path add consumes 3 prompts (name, url, api key) and 2 selects.
  const prompts = ["my-proxy", "https://provider.example/v1", undefined]

  it("saves nothing when the user cancels at the API key step", async () => {
    const state = makeContext([{ status: "ok", message: "should not be used" }], [...prompts], ["openai-chat", "slug"])
    await runAdd(state)
    const writes = state.calls.filter(c => c.method !== "list")
    expect(writes.map(c => c.method)).not.toContain("add")
    expect(writes.map(c => c.method)).not.toContain("manualAdd")
    expect(writes).toHaveLength(0)
    expect(state.toasts.at(-1)?.message).toMatch(/Cancel/i)
  })

  it("saves nothing when the user cancels at the name step", async () => {
    const state = makeContext([{ status: "ok", message: "unused" }], [undefined], ["openai-chat", "slug"])
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list")).toHaveLength(0)
  })

  it("saves nothing when the user cancels at the base URL step", async () => {
    const state = makeContext([{ status: "ok", message: "unused" }], ["my-proxy", undefined], ["openai-chat", "slug"])
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list")).toHaveLength(0)
  })

  it("saves nothing when the user cancels at the API type step", async () => {
    const state = makeContext([{ status: "ok", message: "unused" }], ["my-proxy", "https://provider.example/v1", ""], [undefined, "slug"])
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list")).toHaveLength(0)
  })

  it("saves nothing when the user cancels at the display style step", async () => {
    const state = makeContext([{ status: "ok", message: "unused" }], ["my-proxy", "https://provider.example/v1", ""], ["openai-chat", undefined])
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list")).toHaveLength(0)
  })
})

describe("v2 add without an API key", () => {
  // The provider is stored but unusable, so the result must not read as plain success.
  it("does not report an unqualified success when the key is empty", async () => {
    const state = makeContext(
      [{ status: "ok", message: "Done. 'nokey' is ready with 2 models." }],
      ["nokey", "https://provider.example/v1", ""],
      ["openai-chat", "slug"],
    )
    await runAdd(state)
    const add = state.calls.find(c => c.method === "add")
    expect(add?.input).toMatchObject({ providerId: "nokey", apiKey: undefined })
  })

  it("still sends the key when one was typed", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ok" }],
      ["withkey", "https://provider.example/v1", "sk-test-123"],
      ["openai-chat", "slug"],
    )
    await runAdd(state)
    expect(state.calls.find(c => c.method === "add")?.input).toMatchObject({ apiKey: "sk-test-123" })
  })
})

describe("v2 model field editing", () => {
  const provider = { id: "my-proxy", models: 2 }
  const modelRows = [
    { id: "gpt-4o", name: "gpt-4o", reasoning: "high", reasoningLabel: "high - cap reasoning at high", image: true, context: 128000, output: 8192 },
    { id: "gpt-4o-mini", name: "gpt-4o-mini", reasoning: "off", reasoningLabel: "Off - no reasoning", image: false },
  ]

  const modelsResult = { models: modelRows, status: "ok", message: "" }

  async function runEditModels(state: ReturnType<typeof makeContext>): Promise<void> {
    setup(state.context)
    const command = state.getLayer()?.commands?.find(item => item.slash?.name === "edit-provider")
    if (!command) throw new Error("edit-provider command was not registered")
    await command.run()
  }

  it("sends the edited fields to editModel", async () => {
    const state = makeContext(
      [modelsResult, { message: "Saved 'gpt-4o': reasoning off." }, modelsResult],
      ["", "0"],
      ["my-proxy", "model", "gpt-4o", "off", "no", ""],
      [provider],
    )

    await runEditModels(state)

    const edit = state.calls.find(call => call.method === "editModel")
    expect(edit?.input).toEqual({
      providerId: "my-proxy",
      modelId: "gpt-4o",
      reasoning: "off",
      image: false,
      context: 128000,
      output: 0,
    })
    expect(state.alerts.at(-1)?.message).toBe("Saved 'gpt-4o': reasoning off.")
  })

  it("keeps the current token limits when both prompts are left blank", async () => {
    const state = makeContext(
      [modelsResult, { message: "saved" }, modelsResult],
      ["", ""],
      ["my-proxy", "model", "gpt-4o-mini", "max", "yes", ""],
      [provider],
    )

    await runEditModels(state)

    const edit = state.calls.find(call => call.method === "editModel")
    expect(edit?.input).toEqual({
      providerId: "my-proxy",
      modelId: "gpt-4o-mini",
      reasoning: "max",
      image: true,
      context: undefined,
      output: undefined,
    })
  })

  it("re-prompts on a bad token count instead of sending it", async () => {
    const state = makeContext(
      [modelsResult, { message: "saved" }, modelsResult],
      ["12abc", "64000", ""],
      ["my-proxy", "model", "gpt-4o", "high", "yes", ""],
      [provider],
    )

    await runEditModels(state)

    const edit = state.calls.find(call => call.method === "editModel")
    expect(edit?.input).toMatchObject({ context: 64000, output: 8192 })
    expect(state.toasts.some(toast => /whole number of tokens/.test(toast.message))).toBe(true)
  })

  it("writes nothing when the user backs out of the model list", async () => {
    const state = makeContext(
      [{ models: modelRows, status: "ok", message: "" }],
      [],
      ["my-proxy", "model", undefined],
      [provider],
    )

    await runEditModels(state)

    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })

  it("writes nothing when the user backs out of a field prompt", async () => {
    const state = makeContext(
      [{ models: modelRows, status: "ok", message: "" }],
      [],
      ["my-proxy", "model", "gpt-4o", undefined],
      [provider],
    )

    await runEditModels(state)

    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })

  it("reports a provider whose models are unknown without prompting", async () => {
    const state = makeContext(
      [{ models: [], status: "unknown_provider", message: "There is no provider named 'my-proxy'." }],
      [],
      ["my-proxy", "model"],
      [provider],
    )

    await runEditModels(state)

    expect(state.toasts.at(-1)?.message).toBe("There is no provider named 'my-proxy'.")
    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })

  it("tells the user how to fix a provider with no models yet", async () => {
    const state = makeContext(
      [{ models: [], status: "ok", message: "" }],
      [],
      ["my-proxy", "model"],
      [provider],
    )

    await runEditModels(state)

    expect(state.toasts.at(-1)?.message).toContain("has no models yet")
    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })
})

describe("v2 catalog add cancellation", () => {
  // Esc at either prompt must reach no write: an escaped model list used to become
  // "add every model", which is the opposite of what the user asked for.
  async function runCatalog(state: ReturnType<typeof makeContext>): Promise<void> {
    setup(state.context)
    const command = state.getLayer()?.commands?.find(item => item.slash?.name === "add-known-provider")
    if (!command) throw new Error("add-known-provider command was not registered")
    await command.run()
  }

  it("writes nothing when Esc is pressed at the model prompt", async () => {
    // select: site, prompt: provider name, prompt: model list (Esc), prompt: API key (answered)
    // The key is answered so the model guard is the only thing that can stop the write.
    const state = makeContext([{ sites: [{ id: "openrouter", name: "OpenRouter", modelCount: 12 }] }], ["my-proxy", undefined, ""], ["openrouter"])
    await runCatalog(state)
    expect(state.calls.some(call => call.method === "catalog.add")).toBe(false)
  })

  it("writes nothing when Esc is pressed at the API key prompt", async () => {
    // select: site, prompt: provider name, prompt: model list, prompt: API key (Esc)
    const state = makeContext([{ sites: [{ id: "openrouter", name: "OpenRouter", modelCount: 12 }] }], ["my-proxy", "", undefined], ["openrouter"])
    await runCatalog(state)
    expect(state.calls.some(call => call.method === "catalog.add")).toBe(false)
  })
})

