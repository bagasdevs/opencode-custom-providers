import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>()
  const home = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/opencode-occp-server-v2-${process.pid}`
  return { ...os, homedir: () => home }
})

import { clearModelsDevCache } from "../src/catalog.js"
import { setup, type V2Context, type ReprobeResult } from "../src/server-v2.js"

type Handler = (input: unknown, context?: unknown) => Promise<unknown>

function makeContext() {
  const handlers: Record<string, Handler> = {}
  const stored: unknown[] = []
  const keys: Array<{ integrationID: string; key: string }> = []
  // The real editor keeps records across reloads, and the diff in reprobe is built from
  // what a replayed transform sees, so the fake must remember providers and models too.
  const records = new Map<
    string,
    {
      provider: {
        id: string
        name: string
        activation: "auto" | "enabled" | "disabled"
        package?: string
        integrationID?: string
        settings?: Record<string, unknown>
      }
      models: Map<string, Record<string, unknown>>
    }
  >()
  const providerEditor = {
    list: () => [...records.values()].map(record => ({ provider: record.provider, models: record.models })),
    get: (providerID: string) => {
      const record = records.get(providerID)
      return record ? { provider: record.provider, models: record.models } : undefined
    },
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
    ) => {
      let record = records.get(providerID)
      if (!record) {
        record = { provider: { id: providerID, name: providerID, activation: "enabled" as const }, models: new Map() }
        records.set(providerID, record)
      }
      update(record.provider)
    },
    models: {
      update: (_providerID: string, modelID: string, update: (model: Record<string, unknown>) => void) => {
        const record = records.get(_providerID)
        if (!record) return
        const draft = record.models.get(modelID) ?? {}
        update(draft)
        record.models.set(modelID, draft)
      },
      remove: (providerID: string, modelID: string) => {
        records.get(providerID)?.models.delete(modelID)
      },
    },
  }
  const integrationEditor = {
    update: (integrationID: string, update: (integration: { id: string; name: string }) => void) =>
      update({ id: integrationID, name: integrationID }),
    method: { update: () => undefined },
  }
  const context: V2Context = {
    provider: {
      // The host replays transforms on every reload, and reprobe resolves candidates
      // that only exist after one replays, so reload must actually re-run it.
      transform: async callback => {
        lastTransform = callback
        await callback(providerEditor)
      },
      reload: async () => {
        if (lastTransform) await lastTransform(providerEditor)
      },
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
  return { context, handlers, keys, stored, records }
}

async function registeredHandlers() {
  const state = makeContext()
  await setup(state.context)
  return state
}

let lastTransform: Parameters<Parameters<typeof setup>[0]["provider"]["transform"]>[0] | undefined

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

describe("v2 reprobe", () => {
  // The per-model change picker is built on this array, not on the prose (whose preview
  // caps at five lines), so the structured payload must survive alongside the message.
  async function seedProvider() {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    const add = state.handlers["add"]
    if (!add) throw new Error("add RPC was not registered")
    const added = await add({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    if ((added as { status: string }).status !== "ok") throw new Error("seed provider was not added")
    return state
  }

  it("reports an added model in the structured changes list", async () => {
    const { handlers } = await seedProvider()
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-c" }] }), { status: 200 })
    })
    const result = (await handlers["reprobe"]?.({ providerId: "my-proxy" })) as {
      message: string
      changes?: Array<{ id: string; kind: string; detail: string }>
    }
    expect(result.message).toContain("Found 3 model")
    const added = result.changes?.find(change => change.id === "model-c")
    expect(added).toBeDefined()
    expect(added).toMatchObject({ id: "model-c", kind: "added" })
    expect(typeof added?.detail).toBe("string")
  })

  it("reports a vanished model as removed and leaves changes off a failed probe", async () => {
    const { handlers } = await seedProvider()
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 })
    })
    const shrunk = (await handlers["reprobe"]?.({ providerId: "my-proxy" })) as {
      changes?: Array<{ id: string; kind: string }>
    }
    expect(shrunk.changes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "model-b", kind: "removed" })]))

    // An endpoint that stops answering must not produce a change list at all.
    vi.stubGlobal("fetch", async () => new Response("connection refused", { status: 503 }))
    const failed = (await handlers["reprobe"]?.({ providerId: "my-proxy" })) as { changes?: unknown }
    expect(failed.changes).toBeUndefined()
  })

  it("omits changes when the provider is unknown", async () => {
    const { handlers } = await registeredHandlers()
    const result = (await handlers["reprobe"]?.({ providerId: "nope" })) as ReprobeResult
    expect(result.message).toContain("no provider")
    expect(result.changes).toBeUndefined()
  })
})

describe("adding over an existing provider", () => {
  // add and manualAdd used to replace a tuned provider unconditionally. A second TUI
  // window or an agent tool call could therefore wipe a model list with no confirmation,
  // which is the one thing the built-in and duplicate-address guards do not cover.
  async function seed() {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    const add = state.handlers["add"]
    if (!add) throw new Error("add RPC was not registered")
    const first = await add({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    if ((first as { status: string }).status !== "ok") throw new Error("seed provider was not added")
    return { state, add }
  }

  it("refuses to replace an existing provider unless confirmReplace is set", async () => {
    const { add } = await seed()
    const again = (await add({ providerId: "my-proxy", baseURL: "https://other.example/v1", apiKey: "test-key" })) as {
      status: string
      message: string
    }
    expect(again.status).toBe("confirm_replace")
    expect(again.message).toContain("already one of your providers")
  })

  it("replaces it once confirmReplace is set", async () => {
    const { add } = await seed()
    const again = (await add({
      providerId: "my-proxy",
      baseURL: "https://other.example/v1",
      apiKey: "test-key",
      confirmReplace: true,
    })) as { status: string }
    expect(again.status).toBe("ok")
  })

  it("overwrite does not stand in for confirmReplace", async () => {
    // overwrite gates the built-in clash only. If it also opened this door, a caller
    // that merely wanted to extend a built-in could clobber its own provider instead.
    const { add } = await seed()
    const again = (await add({
      providerId: "my-proxy",
      baseURL: "https://other.example/v1",
      apiKey: "test-key",
      overwrite: true,
    })) as { status: string }
    expect(again.status).toBe("confirm_replace")
  })

  it("refuses when the provider exists only as a host record", async () => {
    // A provider this plugin did not create (an old-format entry, or one written by hand)
    // lives in `candidates` but never in `managed`. Guarding on `managed` alone left that
    // one silently replaceable, which is the very thing the guard exists to stop.
    const state = await registeredHandlers()
    // A host record with dynamic: true is what candidateFrom accepts as a provider this
    // plugin did not create. Seeded directly so the plugin's own transform stays intact:
    // calling transform() here would replace it and candidates would never be filled.
    state.records.set("legacy-proxy", {
      provider: {
        id: "legacy-proxy",
        name: "legacy-proxy",
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://legacy.example/v1", dynamic: true },
      },
      models: new Map(),
    })
    await state.context.provider.reload()
    const add = state.handlers["add"]
    if (!add) throw new Error("add RPC was not registered")
    const again = (await add({ providerId: "legacy-proxy", baseURL: "https://other.example/v1", apiKey: "k" })) as {
      status: string
    }
    expect(again.status).toBe("confirm_replace")
  })
  it("refuses through catalog.add too", async () => {
    // The third write path. It had no guard while add and manualAdd did, so it was the
    // one way left to replace a tuned provider without being asked.
    const { state } = await seed()
    const catalogAdd = state.handlers["catalog.add"]
    if (!catalogAdd) throw new Error("catalog.add RPC was not registered")
    const again = (await catalogAdd({ site: "openrouter", providerId: "my-proxy" })) as { message: string }
    expect(again.message).toContain("already one of your providers")
  })
  it("refuses through manualAdd too", async () => {
    const { state } = await seed()
    const manualAdd = state.handlers["manualAdd"]
    if (!manualAdd) throw new Error("manualAdd RPC was not registered")
    const again = (await manualAdd({ providerId: "my-proxy", baseURL: "https://other.example/v1", modelIds: "model-a" })) as {
      status: string
    }
    expect(again.status).toBe("confirm_replace")
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
