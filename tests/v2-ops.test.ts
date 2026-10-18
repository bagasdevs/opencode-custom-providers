import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>()
  const home = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/opencode-occp-v2-ops-${process.pid}`
  return { ...os, homedir: () => home }
})

import { clearModelsDevCache } from "../src/catalog.js"
import { setup, type V2Context } from "../src/server-v2.js"
import { setup as setupTui, type KeymapLayer, type V2TuiContext } from "../src/tui-v2.js"

const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible"

interface Host {
  ctx: V2Context
  handlers: {
    [key: string]: (input: unknown) => Promise<unknown>
  }
  providers: Map<string, { provider: ProviderDraft; models: Map<string, Record<string, unknown>> }>
  storage: Map<string, unknown>
  integrations: Map<string, { id: string; name: string; methods: Array<Record<string, unknown>> }>
  tools: Array<{ name: string; description: string; input: Record<string, unknown> }>
  definition: unknown
  modelIds(providerId: string): string[]
}

// The shape server-v2's internal ProviderInfoDraft has, spelled out here because it is
// not exported: the fake host has to hand the plugin records that typecheck against it.
type ProviderDraft = {
  id: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package?: string
  integrationID?: string
  settings?: Record<string, unknown>
}

// Keeps records and models across reloads, and round-trips storage through JSON like
// the real store does: a provider id that is a plain object's prototype name only
// survives if it was written as an own property.
function createHost(): Host {
  const storage = new Map<string, unknown>()
  const providers = new Map<string, { provider: ProviderDraft; models: Map<string, Record<string, unknown>> }>()
  const integrations = new Map<string, { id: string; name: string; methods: Array<Record<string, unknown>> }>()
  const tools: Host["tools"] = []
  const transforms: Array<(providers: unknown) => void> = []
  const handlers: Host["handlers"] = {}

  const createEditor = () => ({
    list: () => [...providers.entries()].map(([, record]) => ({ provider: record.provider, models: record.models })),
    get: (providerId: string) => providers.get(providerId),
    update: (providerId: string, update: (provider: ProviderDraft) => void) => {
      const existing = providers.get(providerId)
      // The host creates a provider with an empty package, which is why the plugin has
      // to fill the rest in.
      const provider: ProviderDraft = existing?.provider ?? { id: providerId, name: providerId, activation: "enabled" }
      update(provider)
      const record = { provider, models: existing?.models ?? new Map<string, Record<string, unknown>>() }
      // A rename moves the record to its new id, models included.
      if (provider.id === providerId) providers.set(providerId, record)
      else {
        providers.delete(providerId)
        providers.set(provider.id, record)
      }
    },
    models: {
      update: (providerId: string, modelId: string, update: (model: Record<string, unknown>) => void) => {
        const record = providers.get(providerId)
        const model = record?.models.get(modelId) ?? { id: modelId, name: modelId, activation: "enabled" }
        update(model)
        if (record) record.models.set(modelId, model)
      },
      remove: (providerId: string, modelId: string) => {
        providers.get(providerId)?.models.delete(modelId)
      },
    },
  })

  let definition: unknown
  // Partial double: only the members setup() reads.
  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, JSON.parse(JSON.stringify(value)))
      },
    },
    provider: {
      reload: async () => {
        for (const transform of transforms) transform(createEditor())
      },
      transform: async (callback: (providers: unknown) => void) => {
        transforms.push(callback)
        callback(createEditor())
      },
    },
    integration: {
      transform: async (callback: (editor: unknown) => unknown) => {
        // registerIntegration names the integration and attaches its sign-in methods.
        callback({
          update: (id: string, update: (integration: { id: string; name: string; methods: unknown[] }) => void) => {
            const integration = integrations.get(id) ?? { id, name: "", methods: [] }
            update(integration)
            integrations.set(id, integration)
          },
          method: {
            update: (input: { integrationID: string; method: { type: string; [k: string]: unknown } }) => {
              const integration = integrations.get(input.integrationID) ?? { id: input.integrationID, name: "", methods: [] }
              integration.methods.push(input.method)
              integrations.set(input.integrationID, integration)
            },
          },
        })
      },
      reload: async () => undefined,
      connect: { key: async () => undefined },
      connection: { active: async () => undefined, resolve: async () => undefined },
    },
    rpc: {
      register: async (def: unknown, registered: Record<string, unknown>) => {
        definition = def
        for (const [method, handler] of Object.entries(registered)) {
          handlers[method] = handler as Host["handlers"][string]
        }
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => unknown) => {
        // namespace/add are the agent-facing surface; the fake keeps them for assertions.
        callback({
          namespace: () => undefined,
          add: (tool: { name: string; description: string; input: Record<string, unknown> }) => {
            tools.push({ name: tool.name, description: tool.description, input: tool.input })
          },
        })
      },
    },
  } as unknown as V2Context

  return {
    ctx,
    handlers,
    providers,
    storage,
    integrations,
    tools,
    get definition() {
      return definition
    },
    modelIds: providerId => [...(providers.get(providerId)?.models.keys() ?? [])],
  }
}

async function seedProvider(host: Host, providerId: string, modelIds: string[]): Promise<void> {
  const models: Record<string, Record<string, unknown>> = {}
  for (const modelId of modelIds) models[modelId] = { name: `Model ${modelId}` }
  host.storage.set("providers", {
    [providerId]: { baseURL: `https://${providerId}.example/v1`, flavor: "openai-chat", displayStyle: "slug", models },
  })
}

describe("v2 ops: delete-models", () => {
  beforeEach(() => {
    process.env.HOME = `${process.env.TEMP}/opencode-occp-v2-ops-${process.pid}`
    clearModelsDevCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    // The setup transform keeps a persistent "v" key on shared drafts between cases, so
    // every case seeds its own providers.
  })

  it("removes exactly the listed models and leaves the others", async () => {
    const host = createHost()
    await seedProvider(host, "bulk-proxy", ["model-a", "model-b", "model-c", "model-d"])
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    const result = await host.handlers.deleteModels({
      providerId: "bulk-proxy",
      modelIds: "model-a, model-c",
    }) as { status: string; message: string; deleted: number }

    expect(result.status).toBe("ok")
    expect(result.deleted).toBe(2)
    expect(result.message).toContain("model-a")
    expect(result.message).toContain("model-c")
    // Order is the stored order of the survivors, not the order of the deleted ids.
    expect(host.modelIds("bulk-proxy")).toEqual(["model-b", "model-d"])
    const stored = host.storage.get("providers") as Record<string, { models: Record<string, unknown> }>
    expect(Object.keys(stored["bulk-proxy"].models)).toEqual(["model-b", "model-d"])
  })

  it("refuses an unknown provider", async () => {
    const host = createHost()
    await seedProvider(host, "bulk-proxy", ["model-a"])
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    const result = await host.handlers.deleteModels({
      providerId: "not-mine",
      modelIds: "model-a",
    }) as { status: string; message: string; deleted: number }

    expect(result.status).toBe("unknown_provider")
    expect(result.deleted).toBe(0)
    expect(result.message).toContain("not-mine")
    expect(host.modelIds("bulk-proxy")).toEqual(["model-a"])
  })

  it("refuses the whole list when one id does not exist", async () => {
    const host = createHost()
    await seedProvider(host, "bulk-proxy", ["model-a", "model-b"])
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    const result = await host.handlers.deleteModels({
      providerId: "bulk-proxy",
      modelIds: "model-a, model-typo",
    }) as { status: string; message: string; deleted: number }

    expect(result.status).toBe("unknown_model")
    expect(result.deleted).toBe(0)
    // All-or-nothing: the good id is still there.
    expect(host.modelIds("bulk-proxy")).toEqual(["model-a", "model-b"])
  })

  it("refuses an empty id list", async () => {
    const host = createHost()
    await seedProvider(host, "bulk-proxy", ["model-a"])
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    const result = await host.handlers.deleteModels({
      providerId: "bulk-proxy",
      modelIds: "  ,  ",
    }) as { status: string; deleted: number }

    expect(result.status).toBe("invalid")
    expect(result.deleted).toBe(0)
    expect(host.modelIds("bulk-proxy")).toEqual(["model-a"])
  })
})

describe("v2 ops: rename-provider", () => {
  beforeEach(() => {
    process.env.HOME = `${process.env.TEMP}/opencode-occp-v2-ops-${process.pid}`
    clearModelsDevCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function threeProviders(): Promise<Host> {
    const host = createHost()
    host.storage.set("providers", {
      "p-alpha": {
        baseURL: "https://alpha.example/v1",
        flavor: "openai-chat",
        displayStyle: "slug",
        models: { "alpha-1": { name: "Alpha One" } },
      },
      "p-bravo": {
        baseURL: "https://bravo.example/v1",
        flavor: "openai-chat",
        displayStyle: "slug",
        models: { "bravo-1": { name: "Bravo One" }, "bravo-2": { name: "Bravo Two" } },
      },
      "p-charlie": {
        baseURL: "https://charlie.example/v1",
        flavor: "openai-chat",
        displayStyle: "slug",
        models: { "charlie-1": { name: "Charlie One" } },
      },
    })
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)
    return host
  }

  const storedKeys = (host: Host) => Object.keys(host.storage.get("providers") as Record<string, unknown>)

  it("keeps the renamed entry in its original slot", async () => {
    const host = await threeProviders()
    expect(storedKeys(host)).toEqual(["p-alpha", "p-bravo", "p-charlie"])

    const result = await host.handlers.renameProvider({ providerId: "p-bravo", newId: "p-bravo-renamed" }) as {
      status: string
      message: string
    }

    expect(result.status).toBe("ok")
    // Positional: a delete-then-append would have moved it to the end.
    expect(storedKeys(host)).toEqual(["p-alpha", "p-bravo-renamed", "p-charlie"])

    // The live host record and the models came with it.
    expect(host.modelIds("p-bravo-renamed")).toEqual(["bravo-1", "bravo-2"])

    // The new name gets its own integration record, so sign-in keeps working.
    expect(host.integrations.get("p-bravo-renamed")?.name).toBe("p-bravo-renamed")
    expect(host.integrations.get("p-bravo-renamed")?.methods.map(method => method.type)).toEqual(["key", "env"])

    const list = await host.handlers.list({}) as { providers: Array<{ id: string; models: number }> }
    expect(list.providers.map(provider => provider.id)).toEqual(["p-alpha", "p-bravo-renamed", "p-charlie"])
    expect(list.providers.find(provider => provider.id === "p-bravo-renamed")?.models).toBe(2)
  })

  it("keeps the slot of the first and the last entry too", async () => {
    const host = await threeProviders()

    const first = await host.handlers.renameProvider({ providerId: "p-alpha", newId: "p-alpha-renamed" })
    expect((first as { status: string }).status).toBe("ok")
    expect(storedKeys(host)).toEqual(["p-alpha-renamed", "p-bravo", "p-charlie"])

    const last = await host.handlers.renameProvider({ providerId: "p-charlie", newId: "p-charlie-renamed" })
    expect((last as { status: string }).status).toBe("ok")
    expect(storedKeys(host)).toEqual(["p-alpha-renamed", "p-bravo", "p-charlie-renamed"])
    expect(host.modelIds("p-charlie-renamed")).toEqual(["charlie-1"])
  })

  it("keeps a __proto__ provider id intact through a rename", async () => {
    const host = createHost()
    // JSON.parse is the only way to build an own "__proto__" key, which is exactly the
    // shape a hand-edited or legacy record can arrive in.
    host.storage.set(
      "providers",
      JSON.parse(`{
        "p-alpha": { "baseURL": "https://alpha.example/v1", "flavor": "openai-chat", "displayStyle": "slug", "models": { "alpha-1": { "name": "Alpha One" } } },
        "__proto__": { "baseURL": "https://proto.example/v1", "flavor": "openai-chat", "displayStyle": "slug", "models": { "proto-1": { "name": "Proto One" } } },
        "p-bravo": { "baseURL": "https://bravo.example/v1", "flavor": "openai-chat", "displayStyle": "slug", "models": { "bravo-1": { "name": "Bravo One" } } }
      }`),
    )
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    const result = await host.handlers.renameProvider({ providerId: "p-bravo", newId: "p-bravo-renamed" }) as { status: string }
    expect(result.status).toBe("ok")

    const stored = host.storage.get("providers") as Record<string, { baseURL: string }>
    expect(Object.keys(stored)).toEqual(["p-alpha", "__proto__", "p-bravo-renamed"])
    expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(true)
    expect(stored["__proto__"].baseURL).toBe("https://proto.example/v1")
  })

  it("can rename a provider that is itself called __proto__", async () => {
    const host = createHost()
    host.storage.set(
      "providers",
      JSON.parse(`{
        "p-alpha": { "baseURL": "https://alpha.example/v1", "flavor": "openai-chat", "displayStyle": "slug", "models": {} },
        "__proto__": { "baseURL": "https://proto.example/v1", "flavor": "openai-chat", "displayStyle": "slug", "models": { "proto-1": { "name": "Proto One" } } }
      }`),
    )
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    const result = await host.handlers.renameProvider({ providerId: "__proto__", newId: "p-proto" }) as { status: string }
    expect(result.status).toBe("ok")

    const stored = host.storage.get("providers") as Record<string, unknown>
    expect(Object.keys(stored)).toEqual(["p-alpha", "p-proto"])
    expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(false)
    expect(host.modelIds("p-proto")).toEqual(["proto-1"])
  })

  it("refuses a built-in id and says what to use instead", async () => {
    const host = await threeProviders()

    const result = await host.handlers.renameProvider({ providerId: "p-alpha", newId: "openai" }) as { status: string; message: string }

    expect(result.status).toBe("invalid")
    expect(result.message).toContain("openai-custom")
    expect(storedKeys(host)).toEqual(["p-alpha", "p-bravo", "p-charlie"])
  })

  it("refuses renaming a provider onto itself", async () => {
    const host = await threeProviders()

    const result = await host.handlers.renameProvider({ providerId: "p-bravo", newId: "p-bravo" }) as { status: string; message: string }

    expect(result.status).toBe("invalid")
    expect(result.message).toContain("p-bravo")
    expect(storedKeys(host)).toEqual(["p-alpha", "p-bravo", "p-charlie"])
  })

  it("refuses an id that is already in use", async () => {
    const host = await threeProviders()

    const result = await host.handlers.renameProvider({ providerId: "p-alpha", newId: "p-charlie" }) as { status: string; message: string }

    expect(result.status).toBe("invalid")
    expect(result.message).toContain("p-charlie")
    // Nothing moved.
    expect(storedKeys(host)).toEqual(["p-alpha", "p-bravo", "p-charlie"])
    expect(host.modelIds("p-charlie")).toEqual(["charlie-1"])
  })

  it("refuses a name that is not a valid id", async () => {
    const host = await threeProviders()

    const result = await host.handlers.renameProvider({ providerId: "p-alpha", newId: "not a name" }) as { status: string }

    expect(result.status).toBe("invalid")
    expect(storedKeys(host)).toEqual(["p-alpha", "p-bravo", "p-charlie"])
  })

  it("refuses an unknown provider", async () => {
    const host = await threeProviders()

    const result = await host.handlers.renameProvider({ providerId: "never-added", newId: "fresh-name" }) as {
      status: string
      message: string
    }

    expect(result.status).toBe("unknown_provider")
    expect(result.message).toContain("never-added")
  })

  it("refuses a provider that comes from opencode's config", async () => {
    const host = createHost()
    // The host's own config row: the plugin never wrote a storage entry for it.
    host.providers.set("config-provider", {
      provider: {
        id: "config-provider",
        name: "config-provider",
        package: OPENAI_COMPATIBLE,
        activation: "enabled",
        settings: { baseURL: "https://config.example/v1", dynamic: true },
      },
      models: new Map(),
    })
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    const result = await host.handlers.renameProvider({ providerId: "config-provider", newId: "renamed-config" }) as {
      status: string
      message: string
    }

    expect(result.status).toBe("invalid")
    expect(result.message).toContain("opencode config")
    expect(host.storage.has("providers")).toBe(false)
  })

  it("revives a name that was removed earlier", async () => {
    const host = await threeProviders()
    const removed = await host.handlers.remove({ providerId: "p-charlie" }) as { message: string }
    expect(removed.message).toContain("p-charlie")

    const result = await host.handlers.renameProvider({ providerId: "p-alpha", newId: "p-charlie" }) as { status: string }
    expect(result.status).toBe("ok")

    // The removed marker would switch the renamed provider off on every replay.
    expect(storedKeys(host)).toEqual(["p-charlie", "p-bravo"])
    const list = await host.handlers.list({}) as { providers: Array<{ id: string }> }
    expect(list.providers.map(provider => provider.id)).toContain("p-charlie")
  })

  it("keeps a config provider enabled when its id was removed earlier, and still tombstones host-only rows", async () => {
    const host = createHost()
    // "dup" is a config provider the user re-declared after removing it: it must stay enabled.
    host.providers.set("dup", {
      provider: {
        id: "dup",
        name: "dup",
        package: OPENAI_COMPATIBLE,
        activation: "enabled",
        settings: { baseURL: "https://dup.example/v1", dynamic: true },
      },
      models: new Map(),
    })
    // "gone" is a plugin-removed row (dynamic: false tombstone): it must still be disabled.
    host.providers.set("gone", {
      provider: {
        id: "gone",
        name: "gone",
        package: OPENAI_COMPATIBLE,
        activation: "enabled",
        settings: { baseURL: "https://gone.example/v1", dynamic: false },
      },
      models: new Map(),
    })
    host.storage.set("removed", ["dup", "gone"])
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    expect(host.providers.get("dup")?.provider.activation).toBe("enabled")
    expect(host.providers.get("gone")?.provider.activation).toBe("disabled")
  })
})

describe("v2 rpc wiring", () => {
  beforeEach(() => {
    process.env.HOME = `${process.env.TEMP}/opencode-occp-v2-ops-${process.pid}`
    clearModelsDevCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("exposes a handler for every declared method", async () => {
    const host = createHost()
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    expect(typeof host.handlers.deleteModels).toBe("function")
    expect(typeof host.handlers.renameProvider).toBe("function")
  })

  it("declares schemas that accept a valid payload and reject an invalid one", async () => {
    const host = createHost()
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    await setup(host.ctx)

    const definition = host.definition as {
      methods: Record<string, { input: Record<string, unknown>; output: Record<string, unknown> }>
    }
    const cases = {
      deleteModels: {
        valid: { providerId: "p", modelIds: "a, b" },
        wrongType: { providerId: 5, modelIds: "a" },
        extra: { providerId: "p", modelIds: "a", surprise: true },
        missing: { providerId: "p" },
        outputOk: { status: "ok", message: "m", deleted: 1 },
        outputBad: { status: "boom", message: "m", deleted: 1 },
      },
      renameProvider: {
        valid: { providerId: "p", newId: "q" },
        wrongType: { providerId: 5, newId: "q" },
        extra: { providerId: "p", newId: "q", confirmReplace: true },
        missing: { providerId: "p" },
        outputOk: { status: "ok", message: "m" },
        outputBad: { status: "gone", message: "m" },
      },
    }

    for (const [method, script] of Object.entries(cases)) {
      const schema = definition.methods[method]
      expect(schema, method).toBeDefined()
      expect(validate(schema.input, script.valid), `${method} valid input`).toEqual([])
      expect(validate(schema.output, script.outputOk), `${method} valid output`).toEqual([])

      for (const [label, value] of [
        ["wrong type", script.wrongType],
        ["extra key", script.extra],
        ["missing key", script.missing],
      ] as const) {
        expect(validate(schema.input, value).length, `${method} rejects ${label}`).toBeGreaterThan(0)
      }
      expect(validate(schema.output, script.outputBad).length, `${method} rejects a bad status`).toBeGreaterThan(0)
    }
  })
})

/**
 * The subset of JSON Schema the RPC schemas actually use: object shape, required keys,
 * additionalProperties: false, primitive types and a status enum. Enough to prove the
 * declared contract matches what the ops return.
 */
function validate(schema: Record<string, unknown>, value: unknown): string[] {
  const errors: string[] = []
  if (schema.type !== "object") return errors
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["expected an object"]
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  for (const key of (schema.required as string[] | undefined) ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`missing '${key}'`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`unexpected '${key}'`)
    }
  }
  for (const [key, sub] of Object.entries(properties)) {
    const candidate = (value as Record<string, unknown>)[key]
    if (candidate === undefined) continue
    if (sub.type === "string" && typeof candidate !== "string") errors.push(`'${key}' must be a string`)
    if (sub.type === "number" && typeof candidate !== "number") errors.push(`'${key}' must be a number`)
    if (Array.isArray(sub.enum) && !sub.enum.includes(candidate)) {
      errors.push(`'${key}' must be one of ${sub.enum.join(", ")}`)
    }
  }
  return errors
}

interface TuiScript {
  selects: Array<string | undefined>
  prompts: Array<string | undefined>
  confirms: Array<boolean>
  responses: Record<string, unknown>
}

/**
 * Scripted dialog answers, in call order, with an event trace. The trace is what proves
 * the wizard's shape: an Esc in a nested dialog has to show up as a second visit to the
 * menu, not as the cancelled toast.
 */
function makeTui(script: TuiScript) {
  const selects = [...script.selects]
  const prompts = [...script.prompts]
  const confirms = [...script.confirms]
  const events: string[] = []
  const toasts: Array<{ title?: string; message: string; variant?: string }> = []
  const alerts: Array<{ title: string; message: string }> = []
  const rpcCalls: Array<{ method: string; input?: unknown }> = []
  let layer: KeymapLayer | undefined

  // Partial double: only the members setup() reads.
  const context = {
    options: {},
    client: {
      rpc: {
        call: async ({ method, input }: { method: string; input?: unknown }) => {
          rpcCalls.push({ method, input })
          return { output: script.responses[method] }
        },
      },
    },
    ui: {
      dialog: {
        alert: async (options: { title: string; message: string }) => {
          alerts.push(options)
          events.push(`alert:${options.title}`)
        },
        confirm: async (options: { title: string; message: string }) => {
          events.push(`confirm:${options.title}`)
          return confirms.shift() ?? false
        },
        prompt: async (options: { title: string }) => {
          events.push(`prompt:${options.title}`)
          return prompts.shift()
        },
        select: async (options: { title: string; options?: ReadonlyArray<{ title: string; value: string }> }) => {
          events.push(`select:${options.title}`)
          return selects.shift()
        },
      },
      toast: { show: (options: { message: string; variant?: string }) => {
        toasts.push(options)
        events.push(`toast:${options.variant ?? "info"}`)
      } },
      panel: { open: () => true },
    },
    keymap: { layer: (factory: () => KeymapLayer) => { layer = factory() } },
  } as unknown as V2TuiContext

  return { context, toasts, alerts, rpcCalls, events, getLayer: () => layer }
}

async function runEditProvider(state: ReturnType<typeof makeTui>): Promise<void> {
  setupTui(state.context)
  const command = state.getLayer()?.commands?.find(item => item.slash?.name === "custom-providers")
  if (!command) throw new Error("custom-providers command was not registered")
  await command.run()
}

const PROVIDER_ROWS = () => [
  { id: "bulk-proxy", baseURL: "https://bulk.example/v1", flavor: "openai-chat", displayStyle: "slug", models: 2, pending: 0 },
]
// A fresh set per case: the wizard mutates the row it was given (a rename renames the row
// in place so the menu stays pointed at the new name), so a shared array would leak one
// test's rename into the next.
const responses = (overrides: Record<string, unknown> = {}) => ({
  list: { providers: PROVIDER_ROWS() },
  edit: { message: "Base URL updated." },
  deleteModels: { status: "ok", message: "Removed 1 model(s) from 'bulk-proxy'.", deleted: 1 },
  listModels: {
    status: "ok",
    message: "",
    models: [
      { id: "model-a", name: "Model A", reasoning: "off", reasoningLabel: "Off", image: false },
      { id: "model-b", name: "Model B", reasoning: "off", reasoningLabel: "Off", image: false },
    ],
  },
  renameProvider: { status: "ok", message: "Done. 'bulk-proxy' is now called 'bulk-proxy-2'." },
  ...overrides,
})
const MENU = "Edit bulk-proxy > What to change"

describe("edit-provider wizard layering", () => {
  // Esc at the menu is the exit; Esc in a nested dialog returns to the menu, so the
  // user can change several things in one visit instead of restarting the wizard.

  const cancelledToasts =(state: ReturnType<typeof makeTui>) =>
    state.toasts.filter(toast => toast.message === "Cancelled. Nothing was changed.")

  it("returns to the menu when the Base URL prompt is abandoned", async () => {
    const state = makeTui({
      selects: ["edit", "bulk-proxy", "baseURL", undefined],
      prompts: [undefined],
      confirms: [],
      responses: responses(),
    })

    await runEditProvider(state)

    // Two menu visits: the wizard came back after the abandoned prompt.
    expect(state.events.filter(event => event === `select:${MENU}`)).toHaveLength(2)
    expect(state.events.filter(event => event.startsWith("prompt:"))).toHaveLength(1)
    expect(state.rpcCalls.filter(call => call.method === "edit")).toEqual([])

    // The cancelled toast came from the menu Esc that ended the wizard, so it is after
    // the second menu visit: an inner Esc must not announce "nothing was changed".
    const lastMenu = state.events.lastIndexOf(`select:${MENU}`)
    expect(state.events.lastIndexOf("toast:info")).toBeGreaterThan(lastMenu)
    expect(cancelledToasts(state)).toHaveLength(1)
  })

  it("exits the wizard when the top menu is abandoned", async () => {
    const state = makeTui({
      selects: ["edit", "bulk-proxy", undefined],
      prompts: [],
      confirms: [],
      responses: responses(),
    })

    await runEditProvider(state)

    expect(state.events.filter(event => event === `select:${MENU}`)).toHaveLength(1)
    expect(state.rpcCalls.map(call => call.method)).toEqual(["list"])
    expect(cancelledToasts(state)).toHaveLength(1)
  })

  it("lets the user make one change and then leave", async () => {
    const state = makeTui({
      selects: ["edit", "bulk-proxy", "baseURL", undefined],
      prompts: ["https://new.example/v1"],
      confirms: [],
      responses: responses(),
    })

    await runEditProvider(state)

    const edits = state.rpcCalls.filter(call => call.method === "edit")
    expect(edits).toHaveLength(1)
    expect(edits[0]?.input).toEqual({ providerId: "bulk-proxy", baseURL: "https://new.example/v1" })
    expect(state.alerts).toHaveLength(1)
    // Back to the menu before the user left: the loop ran a second time.
    expect(state.events.filter(event => event === `select:${MENU}`)).toHaveLength(2)
    expect(cancelledToasts(state)).toHaveLength(1)
  })

  it("keeps the current key when the API key prompt is left empty", async () => {
    const state = makeTui({
      selects: ["edit", "bulk-proxy", "apiKey", undefined],
      prompts: [""],
      confirms: [],
      responses: responses(),
    })

    await runEditProvider(state)

    expect(state.rpcCalls.filter(call => call.method === "edit")).toEqual([])
    expect(state.events.filter(event => event === `select:${MENU}`)).toHaveLength(2)
    expect(cancelledToasts(state)).toHaveLength(1)
  })

  it("deletes the model the user picked and confirmed", async () => {
    const state = makeTui({
      // Pick model-a from the list, then "Done" to leave.
      selects: ["edit", "bulk-proxy", "deleteModels", "model-a", "", undefined],
      prompts: [],
      confirms: [true],
      responses: responses(),
    })

    await runEditProvider(state)

    const calls = state.rpcCalls.filter(call => call.method === "deleteModels")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ providerId: "bulk-proxy", modelIds: "model-a" })
    expect(state.toasts.some(toast => toast.variant === "success")).toBe(true)
  })

  it("writes nothing when the delete confirm is declined", async () => {
    const state = makeTui({
      selects: ["edit", "bulk-proxy", "deleteModels", "model-a", "", undefined],
      prompts: [],
      confirms: [false],
      responses: responses(),
    })

    await runEditProvider(state)

    expect(state.rpcCalls.filter(call => call.method === "deleteModels")).toEqual([])
  })

  it("renames the provider the user confirmed", async () => {
    const state = makeTui({
      selects: ["edit", "bulk-proxy", "rename", undefined],
      prompts: ["bulk-proxy-2"],
      confirms: [true],
      responses: responses(),
    })

    await runEditProvider(state)

    const calls = state.rpcCalls.filter(call => call.method === "renameProvider")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ providerId: "bulk-proxy", newId: "bulk-proxy-2" })
    expect(state.toasts.some(toast => toast.variant === "success")).toBe(true)
  })

  it("reports a rename the server refused", async () => {
    const state = makeTui({
      selects: ["edit", "bulk-proxy", "rename", undefined],
      prompts: ["openai"],
      confirms: [true],
      responses: responses({
        renameProvider: {
          status: "invalid",
          message: "'openai' is the name of a provider opencode already has, so renaming to it would change that provider. Use 'openai-custom' instead.",
        },
      }),
    })

    await runEditProvider(state)

    expect(state.rpcCalls.filter(call => call.method === "renameProvider")).toHaveLength(1)
    const failure = state.toasts.find(toast => toast.variant === "error")
    expect(failure?.message).toContain("openai-custom")
    // The wizard is still usable after the refusal.
    expect(state.events.filter(event => event === `select:${MENU}`)).toHaveLength(2)
  })

  it("writes nothing when the rename prompt is abandoned", async () => {
    const state = makeTui({
      selects: ["edit", "bulk-proxy", "rename", undefined],
      prompts: [undefined],
      confirms: [],
      responses: responses(),
    })

    await runEditProvider(state)

    expect(state.rpcCalls.filter(call => call.method === "renameProvider")).toEqual([])
    expect(state.events.filter(event => event === `select:${MENU}`)).toHaveLength(2)
  })
})
