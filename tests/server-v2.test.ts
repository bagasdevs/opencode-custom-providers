import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>()
  const home = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/opencode-occp-server-v2-${process.pid}`
  return { ...os, homedir: () => home }
})

import { clearModelsDevCache } from "../src/catalog.js"
import { setup, type V2Context } from "../src/server-v2.js"

type Handler = (input: unknown, context?: unknown) => Promise<unknown>

function makeContext() {
  const handlers: Record<string, Handler> = {}
  const stored: unknown[] = []
  const keys: Array<{ integrationID: string; key: string }> = []
  const providerEditor = {
    list: () => [],
    get: () => undefined,
    update: (
      providerID: string,
      update: (provider: {
        id: string
        name: string
        activation: "auto" | "enabled" | "disabled"
        package?: string
        integrationID?: string
        settings?: Record<string, unknown>
      }) => void,
    ) => update({ id: providerID, name: providerID, activation: "enabled" as const }),
    models: {
      update: (_providerID: string, _modelID: string, update: (model: Record<string, unknown>) => void) => update({}),
      remove: () => undefined,
    },
  }
  const integrationEditor = {
    update: (integrationID: string, update: (integration: { id: string; name: string }) => void) =>
      update({ id: integrationID, name: integrationID }),
    method: { update: () => undefined },
  }
  const context: V2Context = {
    provider: {
      transform: async callback => callback(providerEditor),
      reload: async () => undefined,
    },
    integration: {
      transform: async callback => callback(integrationEditor),
      reload: async () => undefined,
      connect: {
        key: async input => {
          keys.push(input)
        },
      },
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    tool: {
      transform: async callback =>
        callback({
          namespace: () => undefined,
          add: () => undefined,
        }),
    },
    storage: {
      get: async () => undefined,
      set: async (_key, value) => {
        stored.push(value)
      },
    },
    rpc: {
      register: async (_definition, registered) => {
        Object.assign(handlers, registered)
      },
    },
  }
  return { context, handlers, keys, stored }
}

async function registeredHandlers() {
  const state = makeContext()
  await setup(state.context)
  return state
}

beforeEach(() => {
  clearModelsDevCache()
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearModelsDevCache()
})

describe("v2 add recovery outcomes", () => {
  it("does not save a provider when the endpoint rejects discovery", async () => {
    const requests: string[] = []
    vi.stubGlobal("fetch", async (input: unknown) => {
      requests.push(String(input))
      if (String(input).includes("models.dev")) {
        return new Response("{}", { status: 200 })
      }
      return new Response("unauthorized", { status: 401 })
    })
    const { handlers, stored } = await registeredHandlers()
    const add = handlers["add"]
    if (!add) throw new Error("add RPC was not registered")

    const result = await add({
      providerId: "my-proxy",
      baseURL: "https://provider.example/v1",
      apiKey: "test-key",
    })

    expect(result).toMatchObject({ status: "unreachable" })
    expect(stored).toHaveLength(0)
    expect(requests.some(url => url.startsWith("https://provider.example"))).toBe(true)
  })

  it("requests manual entry when a non-listable API type returns no models", async () => {
    const { handlers, stored } = await registeredHandlers()
    const add = handlers["add"]
    if (!add) throw new Error("add RPC was not registered")

    const result = await add({
      providerId: "manual-provider",
      baseURL: "https://provider.example",
      flavor: "anthropic",
    })

    expect(result).toMatchObject({ status: "manual_required" })
    expect(stored).toHaveLength(0)
  })
})

describe("v2 manualAdd", () => {
  it("rejects an empty model list without persisting", async () => {
    const { handlers, stored } = await registeredHandlers()
    const manualAdd = handlers["manualAdd"]
    if (!manualAdd) throw new Error("manualAdd RPC was not registered")

    const result = await manualAdd({
      providerId: "manual-provider",
      baseURL: "https://provider.example/v1",
      modelIds: " , ",
    })

    expect(result).toMatchObject({ status: "invalid" })
    expect(stored).toHaveLength(0)
  })

  it("adds typed ids without contacting the provider endpoint", async () => {
    const requests: string[] = []
    vi.stubGlobal("fetch", async (input: unknown) => {
      requests.push(String(input))
      return new Response("{}", { status: 200 })
    })
    const { handlers, keys, stored } = await registeredHandlers()
    const manualAdd = handlers["manualAdd"]
    if (!manualAdd) throw new Error("manualAdd RPC was not registered")

    const result = await manualAdd({
      providerId: "manual-provider",
      baseURL: "https://provider.example/v1",
      modelIds: "gpt-4o",
      apiKey: "test-key",
    })

    expect(result).toMatchObject({ status: "ok" })
    expect(stored).toHaveLength(1)
    expect(keys).toEqual([{ integrationID: "manual-provider", key: "test-key" }])
    expect(requests.every(url => !url.startsWith("https://provider.example"))).toBe(true)
  })
})
