import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>()
  const home = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/opencode-occp-persistence-${process.pid}`
  return { ...os, homedir: () => home }
})

import { clearModelsDevCache } from "../src/catalog.js"
import { setup, type V2Context } from "../src/server-v2.js"

type Draft = Record<string, unknown>

interface HostProvider {
  id: string
  name: string
  activation: "auto" | "enabled" | "disabled"
  package?: string
  integrationID?: string
  settings?: Record<string, unknown>
}

// A host that actually keeps what the plugin writes: models land in a nested map the test can read
// back, and storage is a real key/value store that survives between two plugin processes.
// The editor shape below mirrors what the host hands the transform callback.
function createHost(storage: Map<string, unknown>) {
  const providers = new Map<string, HostProvider>()
  const models = new Map<string, Map<string, Draft>>()
  const transforms: Array<(editor: ReturnType<typeof createEditor>) => void> = []
  const rpc: Record<string, (input: unknown) => Promise<unknown>> = {}

  function createEditor() {
    return {
      list: () =>
        [...providers.entries()].map(([id, provider]) => ({
          provider,
          models: models.get(id) ?? new Map<string, Draft>(),
        })),
      get: (providerID: string) => {
        const provider = providers.get(providerID)
        if (!provider) return undefined
        return { provider, models: models.get(providerID) ?? new Map<string, Draft>() }
      },
      update: (providerID: string, update: (provider: HostProvider) => void) => {
        // The host creates providers with an empty package, which is why the plugin has to fill it in.
        const provider = providers.get(providerID) ?? {
          id: providerID,
          name: providerID,
          activation: "enabled" as const,
          package: "",
        }
        update(provider)
        providers.set(providerID, provider)
      },
      models: {
        update: (providerID: string, modelID: string, update: (model: Draft) => void) => {
          const forProvider = models.get(providerID) ?? new Map<string, Draft>()
          const model = forProvider.get(modelID) ?? {}
          update(model)
          forProvider.set(modelID, model)
          models.set(providerID, forProvider)
        },
        remove: (providerID: string, modelID: string) => {
          models.get(providerID)?.delete(modelID)
        },
      },
    }
  }

  const editor = createEditor()
  const context: V2Context = {
    provider: {
      transform: async callback => {
        transforms.push(callback as unknown as (editor: ReturnType<typeof createEditor>) => void)
        await callback(editor as never)
        return undefined
      },
      // A real reload replays every registered transform, which is what a restart does too.
      reload: async () => {
        for (const transform of transforms) transform(createEditor())
      },
    },
    integration: {
      transform: async callback => callback({
        update: (integrationID: string, update: (integration: { id: string; name: string }) => void) =>
          update({ id: integrationID, name: integrationID }),
        method: { update: () => undefined },
      } as never),
      reload: async () => undefined,
      connect: { key: async () => undefined },
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
    },
    tool: {
      transform: async callback => callback({
        namespace: () => undefined,
        add: () => undefined,
      } as never),
    },
    storage: {
      get: async key => storage.get(key),
      // Round-trip through JSON so the test sees exactly what a real storage backend would return.
      set: async (key, value) => {
        storage.set(key, JSON.parse(JSON.stringify(value)) as unknown)
      },
    },
    rpc: {
      register: async (_definition, handlers) => {
        for (const [name, handler] of Object.entries(handlers)) {
          rpc[name] = input => handler(input)
        }
      },
    },
  }

  const modelIds = (providerID: string): string[] => [...(models.get(providerID)?.keys() ?? [])]

  return { context, rpc, modelIds, providers }
}

const MODEL_IDS = ["gpt-4o", "gpt-4o-mini"]

beforeEach(() => {
  clearModelsDevCache()
  // The provider endpoint stays unreachable, so a restart cannot repopulate the picker by
  // re-probing: only persisted data can restore the models.
  vi.stubGlobal("fetch", async (input: unknown) => {
    if (String(input).includes("provider.example")) throw new Error("network unreachable")
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearModelsDevCache()
})

async function call(host: ReturnType<typeof createHost>, method: string, input: unknown) {
  const handler = host.rpc[method]
  if (!handler) throw new Error(`${method} RPC was not registered`)
  return handler(input)
}

describe("discovered models survive a restart", () => {
  it("restores the host model list on a fresh process from persisted storage only", async () => {
    const storage = new Map<string, unknown>()

    const first = createHost(storage)
    await setup(first.context)
    const added = await call(first, "manualAdd", {
      providerId: "persisted-proxy",
      baseURL: "https://provider.example/v1",
      modelIds: MODEL_IDS.join(","),
      apiKey: "test-key",
    })
    expect(added).toMatchObject({ status: "ok" })
    // Sanity: the models do reach the host in the process that discovered them.
    expect(first.modelIds("persisted-proxy")).toEqual(MODEL_IDS)
    expect(storage.size).toBeGreaterThan(0)

    const second = createHost(storage)
    await setup(second.context)

    expect(second.modelIds("persisted-proxy")).toEqual(MODEL_IDS)
    expect(second.providers.get("persisted-proxy")?.activation).toBe("enabled")
    const reported = await call(second, "list", {})
    expect(reported).toMatchObject({
      providers: [{ id: "persisted-proxy", models: MODEL_IDS.length }],
    })
  })

  it("keeps a removed provider's models out of a fresh process", async () => {
    const storage = new Map<string, unknown>()

    const first = createHost(storage)
    await setup(first.context)
    await call(first, "manualAdd", {
      providerId: "persisted-proxy",
      baseURL: "https://provider.example/v1",
      modelIds: MODEL_IDS.join(","),
      apiKey: "test-key",
    })
    const removed = await call(first, "remove", { providerId: "persisted-proxy" })
    expect(removed).toMatchObject({ message: expect.stringContaining("persisted-proxy") })

    const second = createHost(storage)
    await setup(second.context)

    expect(second.modelIds("persisted-proxy")).toEqual([])
    expect(second.providers.get("persisted-proxy")?.activation).toBe("disabled")
  })
})

describe("storage shape", () => {
  it("stores the model drafts beside the provider it belongs to", async () => {
    const storage = new Map<string, unknown>()
    const host = createHost(storage)
    await setup(host.context)
    await call(host, "manualAdd", {
      providerId: "persisted-proxy",
      baseURL: "https://provider.example/v1",
      modelIds: MODEL_IDS.join(","),
      apiKey: "test-key",
    })

    expect(storage.get("providers")).toMatchObject({
      "persisted-proxy": {
        baseURL: "https://provider.example/v1",
        models: { "gpt-4o": expect.any(Object), "gpt-4o-mini": expect.any(Object) },
      },
    })
  })

  it("still loads a provider entry written before models were stored", async () => {
    // The old shape has no models field: the provider must come back enabled, just without models.
    const storage = new Map<string, unknown>([
      ["providers", { "persisted-proxy": { baseURL: "https://provider.example/v1", flavor: "openai-chat", displayStyle: "slug" } }],
    ])
    const host = createHost(storage)
    await setup(host.context)

    expect(host.providers.get("persisted-proxy")?.activation).toBe("enabled")
    expect(host.modelIds("persisted-proxy")).toEqual([])
    const reported = await call(host, "list", {})
    expect(reported).toMatchObject({
      providers: [{ id: "persisted-proxy", models: 0 }],
    })
  })
})