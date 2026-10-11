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

describe("v2 rpc wiring", () => {
  // A method declared in the schema but missing from the handler map is invisible to the host:
  // the call fails with rpc.method_not_found even though the method type-checks and is tested
  // through its ops function. This locks the two halves together.
  it("exposes a handler for every declared method", async () => {
    const state = await registeredHandlers()
    const expected = [
      "list",
      "add",
      "manualAdd",
      "edit",
      "listModels",
      "editModel",
      "remove",
      "reprobe",
      "apply",
      "refresh",
      "catalog.list",
      "catalog.add",
    ]
    for (const method of expected) {
      expect(typeof state.handlers[method], `no handler registered for '${method}'`).toBe("function")
    }
  })

  it("routes listModels and editModel through to the ops layer", async () => {
    const { handlers } = await registeredHandlers()
    const missing = await handlers["listModels"]?.({ providerId: "nope" })
    expect(missing).toMatchObject({ status: "unknown_provider" })
    const noModel = await handlers["editModel"]?.({ providerId: "nope", modelId: "x" })
    expect(noModel).toMatchObject({ status: "unknown_provider" })
  })
})

describe("catalog add guards built-in ids", () => {
  // The catalog wizard defaults the provider id to the site id, and a site id such as
  // "openrouter" matches a built-in provider. Without the guard the write took that
  // provider over and cleared its integration, which add and manualAdd already refused.
  it("refuses a provider id that matches a built-in provider", async () => {
    const { handlers } = await registeredHandlers()
    const result = await handlers["catalog.add"]?.({ site: "openrouter", providerId: "openrouter" })
    expect(result).toMatchObject({ message: expect.stringContaining("built-in provider") })
  })

  it("still refuses an unknown catalog site", async () => {
    const { handlers } = await registeredHandlers()
    const result = await handlers["catalog.add"]?.({ site: "no-such-site", providerId: "my-proxy" })
    expect(result).toMatchObject({ message: expect.stringContaining("not in the catalog list") })
  })
})

describe("a failed storage read is not an empty store", () => {
  // If the two are conflated, a transient read error empties the managed set and the
  // next persist writes an empty object, deleting every provider the user had.
  it("writes nothing when the initial read failed", async () => {
    const writes: Array<{ key: string; value: unknown }> = []
    const state = makeContext()
    state.context.storage = {
      get: async () => {
        throw new Error("storage unavailable")
      },
      set: async (key, value) => {
        writes.push({ key, value })
      },
    }
    await setup(state.context)
    const add = state.handlers["add"]
    if (!add) throw new Error("add RPC was not registered")
    await add({ providerId: "x", baseURL: "https://provider.example/v1" }).catch(() => undefined)
    expect(writes.filter(w => w.key === "providers")).toEqual([])
  })
})
