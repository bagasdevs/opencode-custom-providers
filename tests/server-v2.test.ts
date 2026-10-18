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
  const definitions: Record<string, { input?: unknown; output?: unknown }> = {}
  // Partial double: only the members setup() reads.
  const context = {
    provider: {
      // The host replays transforms on every reload, and reprobe resolves candidates
      // that only exist after one replays, so reload must actually re-run it.
      transform: async (callback: (editor: typeof providerEditor) => void) => {
        lastTransform = callback as unknown as typeof lastTransform
        await callback(providerEditor)
      },
      reload: async () => {
        if (lastTransform) await lastTransform(providerEditor as never)
      },
    },
    integration: {
      transform: async (callback: (editor: typeof integrationEditor) => unknown) => callback(integrationEditor),
      reload: async () => undefined,
      connect: {
        key: async (input: { integrationID: string; key: string }) => {
          keys.push(input)
        },
      },
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    tool: {
      transform: async (callback: (editor: { namespace: () => void; add: () => void }) => unknown) =>
        callback({
          namespace: () => undefined,
          add: () => undefined,
        }),
    },
    storage: {
      get: async () => undefined,
      set: async (_key: string, value: unknown) => {
        stored.push(value)
      },
    },
    rpc: {
      register: async (definition: unknown, registered: Record<string, (input: never) => Promise<unknown>>) => {
        Object.assign(handlers, registered)
        // Keep the schemas: the live host validates every result against the output
        // schema, so a status the schema omits fails at runtime with HTTP 500 even
        // though the handler returns it. Dropping the definition here is why that
        // class of bug reached the host once already. The definition is
        // { id, methods: { <method>: { input, output } } }.
        Object.assign(definitions, (definition as { methods?: Record<string, unknown> })?.methods ?? {})
      },
    },
  } as unknown as V2Context
  return { context, handlers, keys, stored, records, definitions }
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

  it("asks before replacing an existing provider instead of failing", async () => {
    // Found by an end-to-end run against the live host: the RPC output schema listed only
    // "ok" and "invalid", so the confirm_replace branch failed output validation and
    // answered HTTP 500. Adding a model to a provider that already exists is the one case
    // a caller must handle, so the schema has to allow it.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    const { handlers, stored } = await registeredHandlers()
    const manualAdd = handlers["manualAdd"]
    if (!manualAdd) throw new Error("manualAdd RPC was not registered")

    const first = await manualAdd({
      providerId: "manual-provider",
      baseURL: "https://provider.example/v1",
      modelIds: "gpt-4o",
    })
    expect(first).toMatchObject({ status: "ok" })

    const again = await manualAdd({
      providerId: "manual-provider",
      baseURL: "https://provider.example/v1",
      modelIds: "gpt-4o-mini",
    })
    expect(again).toMatchObject({ status: "confirm_replace" })
    expect(stored).toHaveLength(1)

    const confirmed = await manualAdd({
      providerId: "manual-provider",
      baseURL: "https://provider.example/v1",
      modelIds: "gpt-4o-mini",
      confirmReplace: true,
    })
    expect(confirmed).toMatchObject({ status: "ok" })
  })

  it("declares every status the handler can return in its output schema", async () => {
    // The live host validates each result against the registered output schema and
    // answers HTTP 500 when a status is missing from it. The handler returning the
    // status is not enough: the schema has to allow it.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    const { handlers, definitions } = await registeredHandlers()
    const manualAdd = handlers["manualAdd"]
    if (!manualAdd) throw new Error("manualAdd RPC was not registered")

    const schema = definitions["manualAdd"]?.output as
      | { properties?: { status?: { enum?: string[] } } }
      | undefined
    const allowed = schema?.properties?.status?.enum ?? []
    expect(allowed).toContain("ok")
    expect(allowed).toContain("invalid")
    expect(allowed).toContain("confirm_replace")

    // Every status the handler actually produces must be allowed by the schema.
    const first = await manualAdd({ providerId: "p", baseURL: "https://provider.example/v1", modelIds: "m" })
    const clash = await manualAdd({ providerId: "p", baseURL: "https://provider.example/v1", modelIds: "m2" })
    const bad = await manualAdd({ providerId: "p", baseURL: "https://provider.example/v1", modelIds: " " })
    for (const result of [first, clash, bad]) {
      expect(allowed, `schema must allow status '${String((result as { status?: string }).status)}'`).toContain(
        (result as { status?: string }).status,
      )
    }
  })

  it("adds models to an existing provider without being given its address", async () => {
    // An agent that only knows the provider id could not call this at all: baseURL was
    // required, and the handler normalised it before any lookup, so the address-less call
    // was refused by the schema and would have thrown on undefined. The address is
    // already stored, so it is not the caller's problem.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    const { handlers, definitions } = await registeredHandlers()
    const manualAdd = handlers["manualAdd"]
    if (!manualAdd) throw new Error("manualAdd RPC was not registered")

    const input = definitions["manualAdd"]?.input as { required?: string[] } | undefined
    expect(input?.required ?? []).not.toContain("baseURL")

    const created = await manualAdd({ providerId: "addr", baseURL: "https://provider.example/v1", modelIds: "m-one" })
    expect(created).toMatchObject({ status: "ok" })

    // No baseURL, and the provider exists: the stored address is reused.
    const added = await manualAdd({ providerId: "addr", modelIds: "m-two", confirmReplace: true })
    expect(added).toMatchObject({ status: "ok" })
    expect(String((added as { message?: string }).message)).toMatch(/Added 1 model/)

    // A provider that does not exist yet still needs an address, and says so.
    const orphan = await manualAdd({ providerId: "nowhere", modelIds: "m-three" })
    expect(orphan).toMatchObject({ status: "invalid" })
    expect(String((orphan as { message?: string }).message)).toMatch(/Enter the address/)
  })

  it("keeps an existing provider's flavor and name style when they are not given", async () => {
    // With the address now optional, flavor and displayStyle are the next silent rewrites:
    // defaulting them would reset a provider that speaks anthropic back to openai-chat and
    // its friendly names back to ids, just because the caller only sent model ids. Both are
    // stored in the plugin's own record, so read the last storage payload.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    const { handlers, stored } = await registeredHandlers()
    const manualAdd = handlers["manualAdd"]
    if (!manualAdd) throw new Error("manualAdd RPC was not registered")
    const lastRecord = () => {
      const payload = stored.at(-1) as Record<string, { flavor?: string; displayStyle?: string }> | undefined
      return payload?.["styled"]
    }

    const created = await manualAdd({
      providerId: "styled",
      baseURL: "https://provider.example/v1",
      modelIds: "m-one",
      flavor: "anthropic",
      displayStyle: "name",
    })
    expect(created).toMatchObject({ status: "ok" })
    expect(lastRecord()?.flavor).toBe("anthropic")
    expect(lastRecord()?.displayStyle).toBe("name")

    const added = await manualAdd({ providerId: "styled", modelIds: "m-two", confirmReplace: true })
    expect(added).toMatchObject({ status: "ok" })
    expect(lastRecord()?.flavor).toBe("anthropic")
    expect(lastRecord()?.displayStyle).toBe("name")
  })

  it("declares the api address the catalog returns", async () => {
    // catalog.list returns rows that carry the provider's API address, but the output
    // schema did not declare it, so the host silently stripped it from the wire.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    const { definitions } = await registeredHandlers()
    const items = definitions["catalog.list"]?.output as
      | { properties?: { sites?: { items?: { properties?: Record<string, unknown> } } } }
      | undefined
    expect(items?.properties?.sites?.items?.properties).toHaveProperty("api")
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

describe("v2: a provider is usable before the transform replay lands", () => {
  // The real host returns from provider.reload() before it replays the transform, so the
  // provider a caller just added is missing from the plugin's candidate map until that replay
  // happens. Against the real host that made the next reprobe answer "there is no provider
  // named X" for a provider that add had just reported as saved.
  function deferredReplayContext() {
    const records = new Map<string, { provider: Record<string, unknown>; models: Map<string, Record<string, unknown>> }>()
    const handlers: Record<string, (input: unknown) => Promise<unknown>> = {}
    const editor = {
      list: () => [...records.values()],
      get: (providerId: string) => records.get(providerId),
      update: (providerId: string, update: (provider: Record<string, unknown>) => void) => {
        const existing = records.get(providerId)
        const provider = existing?.provider ?? { id: providerId, name: providerId, activation: "enabled" }
        update(provider)
        records.set(providerId, { provider, models: existing?.models ?? new Map() })
      },
      models: {
        update: (providerId: string, modelId: string, update: (model: Record<string, unknown>) => void) => {
          const record = records.get(providerId)
          if (!record) return
          const draft = record.models.get(modelId) ?? {}
          update(draft)
          record.models.set(modelId, draft)
        },
        remove: (providerId: string, modelID: string) => {
          records.get(providerId)?.models.delete(modelID)
        },
      },
    }
    const stored = new Map<string, unknown>()
    const context = {
      provider: {
        // Replay is deferred: it runs only when the test asks for it, like the real host.
        transform: async () => undefined,
        reload: async () => undefined,
      },
      integration: {
        transform: async (callback: (editor: unknown) => unknown) => callback({
          update: (id: string, update: (integration: { id: string; name: string }) => void) => update({ id, name: id }),
          method: { update: () => undefined },
        }),
        reload: async () => undefined,
        connect: { key: async () => undefined },
        connection: { active: async () => undefined, resolve: async () => undefined },
      },
      tool: { transform: async () => undefined },
      storage: {
        get: async (key: string) => stored.get(key),
        set: async (key: string, value: unknown) => {
          stored.set(key, JSON.parse(JSON.stringify(value)))
        },
      },
      rpc: {
        register: async (_definition: unknown, registered: Record<string, (input: unknown) => Promise<unknown>>) => {
          Object.assign(handlers, registered)
        },
      },
    }
    return { context: context as unknown as V2Context, handlers, replay: () => editor }
  }

  it("reprobes a provider that was just added, before any replay", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), { status: 200 })
    })
    const host = deferredReplayContext()
    await setup(host.context)

    const added = (await host.handlers["add"]({ providerId: "deferred", baseURL: "https://deferred.example/v1" })) as { status: string }
    expect(added.status).toBe("ok")

    // No replay has run, yet both calls must already see the provider.
    const listed = (await host.handlers["list"]({})) as { providers: Array<{ id: string; models: number }> }
    expect(listed.providers.find(provider => provider.id === "deferred")?.models).toBe(2)

    const reprobed = (await host.handlers["reprobe"]({ providerId: "deferred" })) as ReprobeResult
    expect(reprobed.message).not.toContain("no provider named")
    // A baseline must exist, or the diff is refused as unreadable.
    expect(reprobed.message).not.toContain("could not be read")
    expect(reprobed.message).toContain("Up to date")
  })
})

describe("v2 use the endpoint's values for one model", () => {
  // A hand-edited model is protected from refresh, so the user needs a deliberate way to take
  // the endpoint's current limit. This pins that the action writes only the measured limits.
  it("overwrites a hand-edited context limit and keeps limit.input", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a", context_window: 200000 }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    // Hand-edit: sets draft.edited = true and a stored context, and carries an extra limit.input.
    const record = state.records.get("my-proxy")
    const draft = record?.models.get("model-a") as { limit?: Record<string, number>; edited?: boolean } | undefined
    expect(draft).toBeDefined()
    if (draft) {
      draft.edited = true
      draft.limit = { context: 50000, input: 900000 }
    }
    // The endpoint now reports 1000000 for the same model.
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a", context_window: 1000000 }] }), { status: 200 })
    })
    await state.handlers["reprobe"]?.({ providerId: "my-proxy" })
    const listed = (await state.handlers["listModels"]?.({ providerId: "my-proxy" })) as {
      models: Array<{ id: string; endpointDiffers?: boolean }>
    }
    expect(listed.models.find(model => model.id === "model-a")?.endpointDiffers).toBe(true)

    const result = (await state.handlers["useEndpointValues"]?.({ providerId: "my-proxy", modelId: "model-a" })) as {
      status: string
      message: string
    }
    expect(result.status).toBe("ok")
    expect(result.message).toBe("Updated model-a from the endpoint.")
    const after = state.records.get("my-proxy")?.models.get("model-a") as { limit?: { context?: number; input?: number } }
    expect(after.limit?.context).toBe(1000000)
    expect(after.limit?.input).toBe(900000)
  })

  it("reports an unknown model without writing", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    const result = (await state.handlers["useEndpointValues"]?.({ providerId: "my-proxy", modelId: "missing" })) as { status: string }
    expect(result.status).toBe("unknown_model")
  })
})

describe("v2 addModelIds", () => {
  it("appends new ids and skips ids already stored", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    const result = (await state.handlers["addModelIds"]?.({ providerId: "my-proxy", modelIds: "model-a, model-x" })) as {
      status: string
      added: number
      skipped: number
    }
    expect(result).toMatchObject({ status: "ok", added: 1, skipped: 1 })
    const models = state.records.get("my-proxy")?.models
    expect(models?.has("model-x")).toBe(true)
  })

  it("reports an unknown provider without writing", async () => {
    const state = await registeredHandlers()
    const result = (await state.handlers["addModelIds"]?.({ providerId: "nope", modelIds: "x" })) as { status: string }
    expect(result.status).toBe("unknown_provider")
  })
})

describe("v2 remove status", () => {
  // The TUI shows success only on status "ok", so each outcome needs its own status.
  it("returns unknown_provider for an id that was never added", async () => {
    const state = await registeredHandlers()
    const result = (await state.handlers["remove"]?.({ providerId: "nope" })) as { status: string }
    expect(result.status).toBe("unknown_provider")
  })

  it("returns from_config and claims nothing for a host-config provider", async () => {
    const state = await registeredHandlers()
    // A host record the plugin did not create: candidateFrom accepts it, managed never has it.
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
    const result = (await state.handlers["remove"]?.({ providerId: "legacy-proxy" })) as { status: string; message: string }
    expect(result.status).toBe("from_config")
    expect(result.message).toContain("left alone")
    expect(result.message).not.toContain("Removed")
  })

  it("returns ok for a managed provider", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    const result = (await state.handlers["remove"]?.({ providerId: "my-proxy" })) as { status: string; message: string }
    expect(result.status).toBe("ok")
    expect(result.message).toContain("Removed 'my-proxy'")
  })
})

describe("v2 refresh keeps edits and says so", () => {
  // A hand-edited model keeps its stored limit on refresh. The reply must say so, and name
  // the model, so the user knows the endpoint disagrees and why nothing changed.
  // The live map drives refresh, so the seed goes through the real RPCs: editModel sets
  // edited and the stored limit, and a second endpoint reading is what refresh compares to.
  function stubEndpoint(context: number) {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a", context_window: context }] }), { status: 200 })
    })
  }

  it("keeps a hand-edited limit and names the model in the refresh reply", async () => {
    stubEndpoint(1000000)
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    const edit = (await state.handlers["editModel"]?.({
      providerId: "my-proxy",
      modelId: "model-a",
      reasoning: "off",
      image: true,
      context: 50000,
    })) as { status: string }
    expect(edit.status).toBe("ok")
    const result = (await state.handlers["refresh"]?.({})) as { message: string }
    expect(result.message).toContain("Kept your edits")
    expect(result.message).toContain("my-proxy/model-a")
    const stored = state.records.get("my-proxy")?.models.get("model-a") as { limit?: { context?: number } }
    expect(stored.limit?.context).toBe(50000)
  })

  it("removes a vanished model on refresh and names it in the reply", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 })
    })
    const result = (await state.handlers["refresh"]?.({})) as { message: string }
    expect(result.message).toContain("Removed no longer offered: my-proxy/model-b.")
    const models = state.records.get("my-proxy")?.models
    expect(models?.has("model-a")).toBe(true)
    expect(models?.has("model-b")).toBe(false)
  })

  it("keeps stored models when the probe fails", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    vi.stubGlobal("fetch", async () => new Response("connection refused", { status: 503 }))
    const result = (await state.handlers["refresh"]?.({})) as { message: string }
    expect(result.message).not.toContain("Removed no longer offered")
    const models = state.records.get("my-proxy")?.models
    expect(models?.has("model-a")).toBe(true)
    expect(models?.has("model-b")).toBe(true)
  })

  it("keeps stored models when the endpoint answers with an empty list", async () => {
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), { status: 200 })
    })
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    vi.stubGlobal("fetch", async (input: unknown) => {
      if (String(input).includes("models.dev")) return new Response("{}", { status: 200 })
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    })
    const result = (await state.handlers["refresh"]?.({})) as { message: string }
    expect(result.message).not.toContain("Removed no longer offered")
    const models = state.records.get("my-proxy")?.models
    expect(models?.has("model-a")).toBe(true)
    expect(models?.has("model-b")).toBe(true)
  })

  it("does not claim kept edits for an unedited model with differing limits", async () => {
    // Stored 50000 from the first probe, unedited; refresh then reads 1000000 and updates it.
    stubEndpoint(50000)
    const state = await registeredHandlers()
    await state.handlers["add"]?.({ providerId: "my-proxy", baseURL: "https://provider.example/v1", apiKey: "test-key" })
    stubEndpoint(1000000)
    const result = (await state.handlers["refresh"]?.({})) as { message: string }
    expect(result.message).not.toContain("Kept your edits")
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
    Object.assign(state.context, {
      storage: {
        get: async () => {
          throw new Error("storage unavailable")
        },
        set: async (key: string, value: unknown) => {
          writes.push({ key, value })
        },
      },
    })
    await setup(state.context)
    const add = state.handlers["add"]
    if (!add) throw new Error("add RPC was not registered")
    await add({ providerId: "x", baseURL: "https://provider.example/v1" }).catch(() => undefined)
    expect(writes.filter(w => w.key === "providers")).toEqual([])
  })
})
