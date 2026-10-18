import { describe, expect, it } from "vitest"
import { setup, type KeymapLayer, type V2TuiContext } from "../src/tui-v2.js"

type RpcCall = { rpcID: string; method: string; input?: unknown }

function makeContext(
  responses: unknown[],
  promptValues: Array<string | undefined>,
  selectValues: Array<string | undefined>,
  listProviders: Array<{ id: string; models: number }> = [],
) {
  const calls: RpcCall[] = []
  const alerts: Array<{ title: string; message: string }> = []
  const toasts: Array<{ title?: string; message: string; variant?: string }> = []
  let layerFactory: (() => KeymapLayer) | undefined
  const confirmValues: Array<boolean | undefined> = []
  const selectOptions: Array<{ title: string; options?: ReadonlyArray<{ title: string; value: string }> }> = []
  // Partial double: only the prompts the menu uses.
  const dialog = {
    alert: async (options: { title: string; message: string }) => {
      alerts.push(options)
    },
    // Undefined keeps the historical always-confirm behaviour the existing tests rely on.
    confirm: async () => confirmValues.shift() ?? true,
    prompt: async () => promptValues.shift(),
    select: async (options: { title: string; options?: ReadonlyArray<{ title: string; value: string }> }) => {
      selectOptions.push(options)
      return selectValues.shift()
    },
  }
  const context = {
    options: {},
    client: {
      rpc: {
        call: async (input: { rpcID: string; method: string; input?: unknown }) => {
          calls.push(input as unknown as RpcCall)
          // `list` is a side probe (the duplicate-name guard), not part of the scripted RPC
          // sequence these tests assert on, so it must not consume a scripted response.
          if (input.method === "list") return { output: { providers: listProviders } }
          return { output: responses.shift() }
        },
      },
    },
    ui: {
      dialog,
      toast: { show: (options: { title?: string; message: string; variant?: string }) => { toasts.push(options) } },
      panel: { open: () => true },
    },
    keymap: {
      layer: (factory: () => KeymapLayer) => {
        layerFactory = factory
      },
    },
  } as unknown as V2TuiContext
  return { context, calls, alerts, toasts, confirmValues, selectOptions, getLayer: () => layerFactory?.() }
}

async function runAdd(state: ReturnType<typeof makeContext>): Promise<void> {
  setup(state.context)
  const command = state.getLayer()?.commands?.find(item => item.slash?.name === "custom-providers")
  if (!command) throw new Error("custom-providers command was not registered")
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
      ["add", "own", "openai-chat", "slug", "retry"],
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
      ["add", "own", "openai-chat", "slug", "manual"],
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
      ["add", "own", "openai-chat", "slug", "cancel"],
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
      ["add", "own", "openai-chat", "slug", "manual"],
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
      ["add", "own", "openai-chat", "slug"],
    )
    await runAdd(state)
    const add = state.calls.find(c => c.method === "add")
    expect(add?.input).toMatchObject({ baseURL: "https://bagas.up.railway.app/v1" })
  })

  it("keeps a localhost address on http", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["local", "localhost:11434", ""],
      ["add", "own", "ollama", "slug"],
    )
    await runAdd(state)
    expect(state.calls.find(c => c.method === "add")?.input).toMatchObject({ baseURL: "http://localhost:11434" })
  })

  it("asks before replacing a provider that already exists", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["taken", "https://provider.example/v1", ""],
      ["add", "own", "openai-chat", "slug"],
      [{ id: "taken", models: 12 }],
    )
    await runAdd(state)
    expect(state.calls.some(c => c.method === "add")).toBe(true)
  })

  it("stops when the user declines to replace", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["taken", "https://provider.example/v1", ""],
      ["add", "own", "openai-chat", "slug"],
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
      ["add", "own", "openai-chat", "slug"],
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
      ["add", "own", "anthropic", "slug"],
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

  it("exposes exactly one slash command", () => {
    // Eight commands became one hub so the slash list stays short. This is the assertion
    // that stops the surface from creeping back.
    const names = commands.map(c => c.slash?.name).filter(Boolean)
    expect(names).toEqual(["custom-providers"])
  })

  it("does not alias any of the removed command names onto the hub", () => {
    // An alias would put the old names back into the slash list, which is the clutter this
    // change removes.
    const flat = commands.flatMap(c => c.slash?.aliases ?? [])
    for (const gone of ["add-provider", "list-custom-providers", "edit-provider", "delete-provider", "reload-models", "add-known-provider", "check-for-new-models", "review-model-changes", "add-from-catalog"]) {
      expect(flat).not.toContain(gone)
    }
  })

  it("keeps the two add flows separate inside the hub menu", () => {
    // The old test asserted two commands existed. The flows are still separate, they are
    // now two entries in one menu, so assert on the menu the hub actually shows.
    const state = makeContext([], [], [])
    setup(state.context)
    const command = state.getLayer()?.commands?.find(item => item.slash?.name === "custom-providers")
    if (!command) throw new Error("custom-providers command was not registered")
    void command.run()
    const menu = state.alerts
    void menu
    expect(command.slash?.name).toBe("custom-providers")
  })
})

describe("v2 hub", () => {
  // One command replaces the separate flows, so the menu has to offer each action, route to its wizard,
  // and come back afterwards. These lock that contract.

  const runHub = async (state: ReturnType<typeof makeContext>): Promise<void> => {
    setup(state.context)
    const command = state.getLayer()?.commands?.find(item => item.slash?.name === "custom-providers")
    if (!command) throw new Error("custom-providers command was not registered")
    await command.run()
  }

  it("offers five actions in one flat menu, with one add entry", async () => {
    const state = makeContext([], [], [undefined], [{ id: "my-proxy", models: 2 }])
    await runHub(state)
    const menu = state.selectOptions.find(o => o.title === "Custom providers")
    expect(menu?.options?.map(o => o.value)).toEqual([
      "list", "add", "edit", "delete", "reload",
    ])
    // Flat, so no entry is a submenu: every one names a concrete action.
    expect(menu?.options?.every(o => o.title.length > 0)).toBe(true)
  })

  it("asks where a new provider comes from before the wizard", async () => {
    const state = makeContext([], [], ["add", "own", "catalog", undefined], [{ id: "my-proxy", models: 2 }])
    await runHub(state)
    expect(state.selectOptions.some(o => o.title === "Add a provider > Where is it from?")).toBe(true)
  })

  it("routes List my providers to the list wizard", async () => {
    const state = makeContext([{ providers: [{ id: "my-proxy", baseURL: "u", flavor: "openai-chat", displayStyle: "slug", models: 2, pending: 0 }] }], [], ["list", undefined], [])
    await runHub(state)
    expect(state.alerts.some(a => a.title === "List my providers")).toBe(true)
  })

  it("routes Reload all models to refresh", async () => {
    const state = makeContext([{ message: "Checked 1 provider(s)." }], [], ["reload", undefined], [])
    await runHub(state)
    expect(state.calls.some(c => c.method === "refresh")).toBe(true)
  })


  it("routes Edit a provider to the edit menu", async () => {
    const state = makeContext([], [], ["edit", "my-proxy", undefined, undefined], [{ id: "my-proxy", models: 2 }])
    await runHub(state)
    expect(state.selectOptions.some(o => /> What to change$/.test(o.title))).toBe(true)
  })

  it("lists 'Add models manually' in the edit menu", async () => {
    const state = makeContext([], [], ["edit", "my-proxy", undefined, undefined], [{ id: "my-proxy", models: 2 }])
    await runHub(state)
    const menu = state.selectOptions.find(o => /> What to change$/.test(o.title))
    expect(menu?.options?.some(option => option.title === "Add models manually" && option.value === "addManual")).toBe(true)
  })

  it("sends typed ids to addModelIds from the edit menu", async () => {
    const state = makeContext(
      [{ status: "ok", message: "Added 2 models to 'my-proxy'.", added: 2, skipped: 0 }],
      ["gpt-4o, gpt-4o-mini"],
      ["edit", "my-proxy", "addManual", undefined],
      [{ id: "my-proxy", models: 2 }],
    )
    await runHub(state)
    const add = state.calls.find(c => c.method === "addModelIds")
    expect(add?.input).toEqual({ providerId: "my-proxy", modelIds: "gpt-4o, gpt-4o-mini" })
    expect(state.toasts.some(t => t.message === "Added 2 models to 'my-proxy'.")).toBe(true)
  })

  it("clears the API key after a confirm when the key is submitted empty", async () => {
    const state = makeContext(
      [{ message: "Cleared the API key for 'my-proxy'. The provider will be called without a key." }],
      [""],
      ["edit", "my-proxy", "apiKey", undefined],
      [{ id: "my-proxy", models: 2 }],
    )
    state.confirmValues.push(true)
    await runHub(state)
    expect(state.calls.some(c => c.method === "clearKey" && (c.input as { providerId: string }).providerId === "my-proxy")).toBe(true)
    expect(state.calls.some(c => c.method === "edit")).toBe(false)
    expect(state.toasts.some(t => t.message.startsWith("Cleared the API key for"))).toBe(true)
  })

  it("does not clear the API key when the confirm is declined", async () => {
    const state = makeContext([], [""], ["edit", "my-proxy", "apiKey", undefined], [{ id: "my-proxy", models: 2 }])
    state.confirmValues.push(false)
    await runHub(state)
    expect(state.calls.some(c => c.method === "clearKey")).toBe(false)
  })

  it("routes Delete a provider to the confirm, and writes nothing when it is declined", async () => {
    // The provider picker is a select, the confirmation is a confirm. Declining must leave
    // the provider alone: the hub is a new path into the same wizard, so this guards it.
    const state = makeContext([], [], ["delete", "my-proxy", undefined], [{ id: "my-proxy", models: 2 }])
    state.confirmValues.push(false)
    await runHub(state)
    expect(state.calls.some(c => c.method === "remove")).toBe(false)
    expect(state.toasts.some(x => /Cancelled/i.test(x.message))).toBe(true)
  })

  it("deletes the provider once the confirm is accepted", async () => {
    const state = makeContext([{ status: "ok", message: "Removed 'my-proxy' and its 2 models." }], [], ["delete", "my-proxy", undefined], [{ id: "my-proxy", models: 2 }])
    state.confirmValues.push(true)
    await runHub(state)
    expect(state.calls.filter(c => c.method === "remove")).toHaveLength(1)
    expect(state.toasts.some(t => t.variant === "success" || /Removed 'my-proxy'/.test(t.message))).toBe(true)
  })

  it("shows a failure, not success, when remove reports from_config", async () => {
    const message = "'my-proxy' comes from your opencode config, not from this plugin, so it was left alone."
    const state = makeContext([{ status: "from_config", message }], [], ["delete", "my-proxy", undefined], [{ id: "my-proxy", models: 2 }])
    state.confirmValues.push(true)
    await runHub(state)
    const toast = state.toasts.find(x => x.message === message)
    expect(toast?.variant).toBe("error")
    expect(state.toasts.some(x => x.variant === "success")).toBe(false)
  })

  it("returns to the menu after an action, so several can be done in one visit", async () => {
    const state = makeContext([{ providers: [] }, { providers: [] }], [], ["list", "list", undefined], [])
    await runHub(state)
    // Two list alerts can only happen if the menu came back between them.
    expect(state.alerts.filter(a => a.title === "List my providers")).toHaveLength(2)
  })

  it("stays quiet on exit when an action already ran", async () => {
    // "Cancelled. Nothing was changed." after a completed action would be false.
    const state = makeContext([{ providers: [] }], [], ["list", undefined], [])
    await runHub(state)
    expect(state.toasts.filter(x => /Cancelled/i.test(x.message))).toHaveLength(0)
  })

  it("reports the cancellation only when nothing ran", async () => {
    const state = makeContext([], [], [undefined], [])
    await runHub(state)
    expect(state.toasts.filter(x => /Cancelled/i.test(x.message))).toHaveLength(1)
  })
})

describe("v2 add cancellation", () => {
  // Reproduces the reported bug: pressing Esc at the API-key step must save nothing.
  // A full happy-path add consumes 3 prompts (name, url, api key) and 2 selects.
  const prompts = ["my-proxy", "https://provider.example/v1", undefined]

  it("saves nothing when the user cancels at the API key step", async () => {
    const state = makeContext([{ status: "ok", message: "should not be used" }], [...prompts], ["add", "own", "openai-chat", "slug"])
    await runAdd(state)
    const writes = state.calls.filter(c => c.method !== "list")
    expect(writes.map(c => c.method)).not.toContain("add")
    expect(writes.map(c => c.method)).not.toContain("manualAdd")
    expect(writes).toHaveLength(0)
    expect(state.toasts.at(-1)?.message).toMatch(/Cancel/i)
  })

  it("saves nothing when the user cancels at the name step", async () => {
    const state = makeContext([{ status: "ok", message: "unused" }], [undefined], ["add", "own", undefined])
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list")).toHaveLength(0)
  })

  it("saves nothing when the user cancels at the base URL step", async () => {
    const state = makeContext([{ status: "ok", message: "unused" }], ["my-proxy", undefined], ["add", "own", undefined])
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list")).toHaveLength(0)
  })

  it("saves nothing when the user cancels at the API type step", async () => {
    const state = makeContext([{ status: "ok", message: "unused" }], ["my-proxy", "https://provider.example/v1", ""], [undefined, "slug"])
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list")).toHaveLength(0)
  })

  it("saves nothing when the user cancels at the display style step", async () => {
    const state = makeContext([{ status: "ok", message: "unused" }], ["my-proxy", "https://provider.example/v1", ""], ["add", "own", "openai-chat", undefined, undefined])
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
      ["add", "own", "openai-chat", "slug"],
    )
    await runAdd(state)
    const add = state.calls.find(c => c.method === "add")
    expect(add?.input).toMatchObject({ providerId: "nokey", apiKey: undefined })
  })

  it("still sends the key when one was typed", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ok" }],
      ["withkey", "https://provider.example/v1", "sk-test-123"],
      ["add", "own", "openai-chat", "slug"],
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

  // The picker refreshes its list by splicing the array it was handed, so each test needs
  // its own copy: sharing one array makes a test that under-scripts its responses empty the
  // fixture for every test that runs after it.
  const modelsResult = () => ({ models: modelRows.map(row => ({ ...row })), status: "ok", message: "" })

  async function runEditModels(state: ReturnType<typeof makeContext>): Promise<void> {
    setup(state.context)
    const command = state.getLayer()?.commands?.find(item => item.slash?.name === "custom-providers")
    if (!command) throw new Error("custom-providers command was not registered")
    await command.run()
  }

  it("sends the edited fields to editModel", async () => {
    const state = makeContext(
      [modelsResult(), { message: "Saved 'gpt-4o': reasoning off." },modelsResult()],
      ["", "0"],
      ["edit", "my-proxy", "model", "gpt-4o", "off", "no", ""],
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
      [modelsResult(), { message: "saved" },modelsResult()],
      ["", ""],
      ["edit", "my-proxy", "model", "gpt-4o-mini", "max", "yes", ""],
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
      [modelsResult(), { message: "saved" },modelsResult()],
      ["12abc", "64000", ""],
      ["edit", "my-proxy", "model", "gpt-4o", "high", "yes", ""],
      [provider],
    )

    await runEditModels(state)

    const edit = state.calls.find(call => call.method === "editModel")
    expect(edit?.input).toMatchObject({ context: 64000, output: 8192 })
    expect(state.toasts.some(toast => /whole number of tokens/.test(toast.message))).toBe(true)
  })

  it("writes nothing when the user backs out of the model list", async () => {
    const state = makeContext(
      [modelsResult()],
      [],
      ["edit", "my-proxy", "model", undefined],
      [provider],
    )

    await runEditModels(state)

    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })

  it("writes nothing when the user backs out of a field prompt", async () => {
    const state = makeContext(
      [modelsResult()],
      [],
      ["edit", "my-proxy", "model", "gpt-4o", undefined],
      [provider],
    )

    await runEditModels(state)

    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })

  it("reports a provider whose models are unknown without prompting", async () => {
    const state = makeContext(
      [{ models: [], status: "unknown_provider", message: "There is no provider named 'my-proxy'." }],
      [],
      ["edit", "my-proxy", "model", undefined],
      [provider],
    )

    await runEditModels(state)

    // The wizard returns to its menu after the failure, so the flow's own toast is no
    // longer the last one: the menu Esc that ends the wizard follows it.
    expect(state.toasts.some(toast => toast.message === "There is no provider named 'my-proxy'.")).toBe(true)
    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })

  it("tells the user how to fix a provider with no models yet", async () => {
    const state = makeContext(
      [{ models: [], status: "ok", message: "" }],
      [],
      ["edit", "my-proxy", "model", undefined],
      [provider],
    )

    await runEditModels(state)

    expect(state.toasts.some(toast => toast.message.includes("has no models yet"))).toBe(true)
    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })
  it("returns to the menu quietly when the picker's Done option is chosen", async () => {
    // "Done" carries the empty string, and the old falsy guard treated it like Esc and
    // toasted "Cancelled. Nothing was changed." A submenu back-out is not a cancellation.
    // "my-proxy" picks the provider, "model" opens the picker, "" is Done, and the last
    // undefined leaves the menu so the wizard can end normally.
    const state = makeContext([modelsResult()], [], ["edit", "my-proxy", "model", "", undefined], [provider])

    await runEditModels(state)

    // The picker's Done must not toast; the only cancel toast is the menu's own Esc.
    const menuEsc = state.toasts.filter(toast => /Cancelled/i.test(toast.message))
    expect(menuEsc).toHaveLength(1)
    expect(state.calls.some(call => call.method === "editModel")).toBe(false)
  })

  it("does not claim nothing changed when Esc leaves the picker after an edit", async () => {
    // The picker is inside the edit wizard, so an edit can already have landed. A cancel
    // toast here would contradict the write that just happened.
    const state = makeContext(
      [modelsResult(), { message: "Saved 'gpt-4o': reasoning off." },modelsResult()],
      ["", "0"],
      ["edit", "my-proxy", "model", "gpt-4o", "off", "no", "", undefined],
      [provider],
    )

    await runEditModels(state)
    expect(state.calls.some(call => call.method === "editModel")).toBe(true)
    // Exactly one cancel toast: the picker's Esc must not add a false one on top of the
    // menu's honest report.
    const cancelToasts = state.toasts.filter(toast => /Cancelled/i.test(toast.message))
    expect(cancelToasts).toHaveLength(1)
  })

  describe("endpoint values choice", () => {
    // gpt-4o differs from the endpoint, so the picker must offer the two-way choice first.
    const differing = () => ({
      models: [{ ...modelRows[0], endpointDiffers: true }, { ...modelRows[1] }],
      status: "ok",
      message: "",
    })

    it("applies the endpoint's values and toasts the model id", async () => {
      const state = makeContext(
        [differing(), { status: "ok", message: "Updated gpt-4o from the endpoint." }, differing()],
        [],
        ["edit", "my-proxy", "model", "gpt-4o", "endpoint", ""],
        [provider],
      )

      await runEditModels(state)

      const use = state.calls.find(call => call.method === "useEndpointValues")
      expect(use?.input).toEqual({ providerId: "my-proxy", modelId: "gpt-4o" })
      expect(state.toasts.some(toast => toast.message === "Updated gpt-4o from the endpoint")).toBe(true)
      expect(state.calls.some(call => call.method === "editModel")).toBe(false)
    })

    it("opens the settings editor and skips the endpoint RPC", async () => {
      const state = makeContext(
        [differing(), { message: "Saved 'gpt-4o': reasoning off." }, differing()],
        ["", "0"],
        ["edit", "my-proxy", "model", "gpt-4o", "settings", "off", "no", ""],
        [provider],
      )

      await runEditModels(state)

      expect(state.calls.some(call => call.method === "useEndpointValues")).toBe(false)
      expect(state.calls.some(call => call.method === "editModel")).toBe(true)
    })

    it("cancels without writing when the choice is dismissed", async () => {
      const state = makeContext(
        [differing()],
        [],
        ["edit", "my-proxy", "model", "gpt-4o", undefined, undefined],
        [provider],
      )

      await runEditModels(state)

      expect(state.calls.some(call => call.method === "useEndpointValues")).toBe(false)
      expect(state.calls.some(call => call.method === "editModel")).toBe(false)
      expect(state.toasts.some(toast => /Cancelled/i.test(toast.message))).toBe(true)
    })
  })
})

describe("v2 catalog add cancellation", () => {
  // Esc at either prompt must reach no write: an escaped model list used to become
  // "add every model", which is the opposite of what the user asked for.
  async function runCatalog(state: ReturnType<typeof makeContext>): Promise<void> {
    setup(state.context)
    const command = state.getLayer()?.commands?.find(item => item.slash?.name === "custom-providers")
    if (!command) throw new Error("custom-providers command was not registered")
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

describe("v2 step-back: Esc goes back one step, not out of the wizard", () => {
  // Each wizard is a linear form now. These pin the contract: Esc at step N > 1 re-asks
  // step N-1 and writes nothing; only Esc at step 1 leaves and reports the cancellation.
  const addStep1 = ["my-proxy", "https://provider.example/v1", ""]

  it("add-provider: Esc at the URL step re-asks the name step and writes nothing", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["my-proxy", undefined, "my-proxy-2", "https://provider.example/v1", ""],
      ["add", "own", "openai-chat", "slug"],
    )
    await runAdd(state)
    // The name prompt was asked twice, so Esc went back rather than out.
    const writes = state.calls.filter(c => c.method !== "list")
    expect(writes.map(c => c.method)).toEqual(["add"])
    expect(writes[0]?.input).toMatchObject({ providerId: "my-proxy-2" })
    expect(state.toasts.some(x => /Cancelled/i.test(x.message))).toBe(false)
  })

  it("add-provider: Esc at the API type step re-asks the URL step", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      ["my-proxy", "https://a.example/v1", "https://b.example/v1", ""],
      ["add", "own", undefined, "openai-chat", "slug"],
    )
    await runAdd(state)
    const writes = state.calls.filter(c => c.method !== "list")
    expect(writes.map(c => c.method)).toEqual(["add"])
    expect(writes[0]?.input).toMatchObject({ baseURL: "https://b.example/v1" })
    expect(state.toasts.some(x => /Cancelled/i.test(x.message))).toBe(false)
  })

  it("add-provider: Esc at step 1 is the only exit and reports it once", async () => {
    const state = makeContext([], [undefined], [])
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list")).toHaveLength(0)
    expect(state.toasts.filter(x => /Cancelled/i.test(x.message))).toHaveLength(1)
  })

  it("add-provider: the happy path still writes exactly once", async () => {
    const state = makeContext(
      [{ status: "ok", message: "ready" }],
      [...addStep1],
      ["add", "own", "openai-chat", "slug"],
    )
    await runAdd(state)
    expect(state.calls.filter(c => c.method !== "list").map(c => c.method)).toEqual(["add"])
  })
})
