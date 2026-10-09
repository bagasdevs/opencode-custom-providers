import { describe, expect, it } from "vitest"
import {
  createServerBridge,
  createTuiBridge,
  type ServerClient,
  type TuiClient,
} from "../src/opencode-client.js"
import type { ProviderConfig } from "../src/types.js"

interface Call {
  method: string
  args: unknown
}

function serverFake(state: { providers: Record<string, ProviderConfig> }) {
  const calls: Call[] = []
  const client = {
    auth: {
      set: async (args: unknown) => {
        calls.push({ method: "auth.set", args })
        return true
      },
    },
    config: {
      get: async () => ({ data: { provider: state.providers } }),
      update: async (args: unknown) => {
        calls.push({ method: "config.update", args })
        return { data: { provider: state.providers } }
      },
    },
  }
  return { calls, client: client as unknown as ServerClient }
}

function tuiFake(state: { providers: Record<string, ProviderConfig> }) {
  const calls: Call[] = []
  const client = {
    auth: {
      set: async (args: unknown) => {
        calls.push({ method: "auth.set", args })
        return true
      },
      remove: async (args: unknown) => {
        calls.push({ method: "auth.remove", args })
        return true
      },
    },
    config: {
      get: async () => ({ data: { provider: state.providers } }),
      update: async (args: unknown) => {
        calls.push({ method: "config.update", args })
        return { data: { provider: state.providers } }
      },
    },
  }
  return { calls, client: client as unknown as TuiClient }
}

describe("createServerBridge (v1 shapes)", () => {
  it("sends {path,body} for keys and {body} for config", async () => {
    const { calls, client } = serverFake({ providers: {} })
    const bridge = createServerBridge(client)

    await bridge.setApiKey("p1", "sk-x")
    expect(calls).toEqual([
      { method: "auth.set", args: { path: { id: "p1" }, body: { type: "api", key: "sk-x" } } },
    ])

    const providers = { p1: { name: "p1" } }
    await bridge.updateProviders(providers)
    expect(calls[1]).toEqual({
      method: "config.update",
      args: { body: { provider: providers } },
    })
  })

  it("reads providers through config.get", async () => {
    const { client } = serverFake({ providers: { p1: { name: "p1" } } })
    const bridge = createServerBridge(client)
    await expect(bridge.getProviders()).resolves.toEqual({ p1: { name: "p1" } })
  })

  it("returns {} when the config has no providers", async () => {
    const { client } = serverFake({ providers: undefined as unknown as Record<string, ProviderConfig> })
    const bridge = createServerBridge(client)
    await expect(bridge.getProviders()).resolves.toEqual({})
  })
})

describe("createTuiBridge (v2 shapes)", () => {
  it("sends {providerID,auth} for keys and {config} for config", async () => {
    const { calls, client } = tuiFake({ providers: {} })
    const bridge = createTuiBridge(client)

    await bridge.setApiKey("p1", "sk-x")
    expect(calls).toEqual([
      { method: "auth.set", args: { providerID: "p1", auth: { type: "api", key: "sk-x" } } },
    ])

    const providers = { p1: { name: "p1" } }
    await bridge.updateProviders(providers)
    expect(calls[1]).toEqual({
      method: "config.update",
      args: { config: { provider: providers } },
    })
  })

  it("reads providers through config.get", async () => {
    const { client } = tuiFake({ providers: { p1: { name: "p1" } } })
    const bridge = createTuiBridge(client)
    await expect(bridge.getProviders()).resolves.toEqual({ p1: { name: "p1" } })
  })

  it("removes provider credentials via auth.remove", async () => {
    const { calls, client } = tuiFake({ providers: {} })
    const bridge = createTuiBridge(client)
    await bridge.removeApiKey?.("p1")
    expect(calls).toEqual([{ method: "auth.remove", args: { providerID: "p1" } }])
  })

  it("server bridge exposes no removeApiKey", () => {
    const { client } = serverFake({ providers: {} })
    expect(createServerBridge(client).removeApiKey).toBeUndefined()
  })
})
