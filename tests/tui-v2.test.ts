import { describe, expect, it } from "vitest"
import { setup, type DialogApi, type KeymapLayer, type V2TuiContext } from "../src/tui-v2.js"

type RpcCall = { rpcID: string; method: string; input?: unknown }

function makeContext(
  responses: unknown[],
  promptValues: Array<string | undefined>,
  selectValues: Array<string | undefined>,
) {
  const calls: RpcCall[] = []
  const alerts: Array<{ title: string; message: string }> = []
  let layerFactory: (() => KeymapLayer) | undefined
  const dialog: DialogApi = {
    alert: async options => {
      alerts.push(options)
    },
    confirm: async () => true,
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
          if (input.method === "list") return { output: { providers: [] } }
          return { output: responses.shift() }
        },
      },
    },
    ui: {
      dialog,
      toast: { show: () => undefined },
      panel: { open: () => true },
    },
    keymap: {
      layer: factory => {
        layerFactory = factory
      },
    },
  }
  return { context, calls, alerts, getLayer: () => layerFactory?.() }
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
