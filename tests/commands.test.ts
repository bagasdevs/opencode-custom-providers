import { afterEach, describe, expect, it, vi } from "vitest"
import {
  chunkedAllSettled,
  renameProviderEntry,
  persistProviderApiKey,
  reprobeProvider,
  rotateProviderApiKey,
  validateAddProviderParams,
  validateProviderId,
  type AddProviderParams,
} from "../src/commands.js"
import type { ProviderConfig } from "../src/types.js"
import type { EnrichedModel } from "../src/enrich.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeEntry(): ProviderConfig {
  return { options: { baseURL: "https://api.example.com/v1" } }
}

describe("validateProviderId", () => {
  it("accepts alphanumeric, hyphens, and underscores", () => {
    expect(validateProviderId("my-proxy_1")).toBeNull()
  })

  it("rejects ids with spaces or special characters", () => {
    expect(validateProviderId("bad id!")).toBeTypeOf("string")
  })

  it("rejects empty ids", () => {
    expect(validateProviderId("")).toBeTypeOf("string")
  })
})

describe("validateAddProviderParams", () => {
  const base: AddProviderParams = {
    providerId: "my-proxy",
    baseURL: "https://api.example.com/v1",
  }

  it("accepts valid params with no conflicts", () => {
    expect(validateAddProviderParams(base, {})).toBeNull()
  })

  it("rejects invalid base URLs", () => {
    expect(
      validateAddProviderParams({ ...base, baseURL: "notaurl" }, {}),
    ).toBeTypeOf("string")
  })

  it("rejects duplicates without overwrite", () => {
    expect(
      validateAddProviderParams(base, { "my-proxy": makeEntry() }),
    ).toBeTypeOf("string")
  })

  it("accepts duplicates with overwrite", () => {
    expect(
      validateAddProviderParams(
        { ...base, overwrite: true },
        { "my-proxy": makeEntry() },
      ),
    ).toBeNull()
  })

  it("rejects invalid provider ids", () => {
    expect(
      validateAddProviderParams({ ...base, providerId: "bad id" }, {}),
    ).toBeTypeOf("string")
  })
})

describe("persistProviderApiKey", () => {
  it("is a no-op without an api key", async () => {
    const entry = makeEntry()
    await persistProviderApiKey(entry, "p1", undefined, async () => true)
    expect(entry.options).not.toHaveProperty("apiKey")
  })

  it("stores via the auth store without touching the entry", async () => {
    const entry = makeEntry()
    await persistProviderApiKey(entry, "p1", "sk-test", async () => true)
    expect(entry.options).not.toHaveProperty("apiKey")
  })

  it("throws instead of writing plain text when the store returns false", async () => {
    const entry = makeEntry()
    await expect(
      persistProviderApiKey(entry, "p1", "sk-test", async () => false),
    ).rejects.toThrow(/Failed to persist API key/)
    expect(entry.options).not.toHaveProperty("apiKey")
  })

  it("throws instead of writing plain text when the store throws", async () => {
    const entry = makeEntry()
    await expect(
      persistProviderApiKey(entry, "p1", "sk-test", async () => {
        throw new Error("store down")
      }),
    ).rejects.toThrow(/Failed to persist API key/)
    expect(entry.options).not.toHaveProperty("apiKey")
  })
})

describe("rotateProviderApiKey (server edit-provider key rotation)", () => {
  it("persists the new key and deletes the legacy inline copy", async () => {
    const entry: ProviderConfig = { options: { baseURL: "https://api.example.com/v1", apiKey: "sk-old" } }
    const seen: Array<[string, string]> = []
    await rotateProviderApiKey(entry, "p1", "sk-new", async (id, key) => {
      seen.push([id, key])
      return true
    })
    expect(seen).toEqual([["p1", "sk-new"]])
    expect(entry.options).not.toHaveProperty("apiKey")
  })

  it("clears the inline key even when there is no new key (clear-key rotation)", async () => {
    const entry: ProviderConfig = { options: { baseURL: "https://api.example.com/v1", apiKey: "sk-old" } }
    await rotateProviderApiKey(entry, "p1", undefined, async () => true)
    expect(entry.options).not.toHaveProperty("apiKey")
  })

  it("keeps the inline key when the auth store rejects the write", async () => {
    const entry: ProviderConfig = { options: { baseURL: "https://api.example.com/v1", apiKey: "sk-old" } }
    await expect(
      rotateProviderApiKey(entry, "p1", "sk-new", async () => false),
    ).rejects.toThrow(/Failed to persist API key/)
    expect(entry.options?.apiKey).toBe("sk-old")
  })
})

describe("renameProviderEntry", () => {
  it("preserves the position of the renamed entry in the key order", () => {
    const providers = {
      alpha: makeEntry(),
      beta: makeEntry(),
      gamma: makeEntry(),
    }
    const res = renameProviderEntry(providers, "alpha", "alpha-renamed")
    expect(res.error).toBeUndefined()
    expect(Object.keys(providers)).toEqual(["alpha-renamed", "beta", "gamma"])
    expect(providers["alpha-renamed"]?.name).toBe("alpha-renamed")
  })

  it("keeps a __proto__ provider key instead of dropping it", () => {
    // "__proto__" passes validateProviderId and JSON.parse creates it as an own key, but a
    // plain `rebuilt[key] = value` assignment sets the object prototype instead of a key,
    // so that provider disappeared from the config on the next write.
    const providers = JSON.parse('{"__proto__":{"name":"evil"},"alpha":{"name":"alpha"}}') as Record<string, ProviderConfig>
    const res = renameProviderEntry(providers, "alpha", "alpha-renamed")
    expect(res.error).toBeUndefined()
    expect(Object.keys(providers)).toEqual(["__proto__", "alpha-renamed"])
    expect(Object.prototype.hasOwnProperty.call(providers, "__proto__")).toBe(true)
  })

  it("preserves position for the last, only, and same id cases", () => {
    const last = { alpha: makeEntry(), beta: makeEntry() }
    renameProviderEntry(last, "beta", "zed")
    expect(Object.keys(last)).toEqual(["alpha", "zed"])

    const only = { alpha: makeEntry() }
    renameProviderEntry(only, "alpha", "solo")
    expect(Object.keys(only)).toEqual(["solo"])

    const same = { alpha: makeEntry(), beta: makeEntry() }
    renameProviderEntry(same, "beta", "beta")
    expect(Object.keys(same)).toEqual(["alpha", "beta"])
  })

  it("preserves position when the renamed entry is not first", () => {
    const providers = {
      alpha: makeEntry(),
      beta: makeEntry(),
      gamma: makeEntry(),
    }
    const res = renameProviderEntry(providers, "beta", "beta-renamed")
    expect(res.error).toBeUndefined()
    expect(Object.keys(providers)).toEqual(["alpha", "beta-renamed", "gamma"])
    expect(providers["beta-renamed"]?.name).toBe("beta-renamed")
  })
})

describe("reprobeProvider", () => {
  it("short-circuits list-less flavors (anthropic) without any network call", async () => {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      (async (url: unknown) => {
        urls.push(String(url))
        throw new Error("network must not be used")
      }) as typeof fetch,
    )
    const entry: ProviderConfig = {
      name: "anth",
      flavor: "anthropic",
      options: { baseURL: "https://api.example.com/v1" },
      models: {
        "claude-x": {
          name: "claude-x",
          limit: { context: 200_000, output: 32_000 },
        } as EnrichedModel,
      },
    }
    const res = await reprobeProvider("anth", entry)
    expect(res).toEqual({ changes: [], fresh: [] })
    expect(urls).toEqual([])
  })
})

describe("chunkedAllSettled (FIX6)", () => {
  it("preserves input order with varying delays", async () => {
    const delays = [30, 5, 20, 10, 0, 8, 3, 15, 1]
    const tasks = delays.map((ms, i) => async () => {
      await new Promise(r => setTimeout(r, ms))
      return i
    })
    const outcomes = await chunkedAllSettled(tasks, 4)
    expect(outcomes.map(o => (o.status === "fulfilled" ? o.value : null))).toEqual(
      delays.map((_, i) => i),
    )
  })

  it("never exceeds the pool size", async () => {
    let active = 0
    let max = 0
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      active++
      max = Math.max(max, active)
      await new Promise(r => setTimeout(r, 5))
      active--
      return i
    })
    const outcomes = await chunkedAllSettled(tasks, 4)
    expect(outcomes).toHaveLength(10)
    expect(max).toBeLessThanOrEqual(4)
  })

  it("captures rejections as settled outcomes in order", async () => {
    const tasks = [
      async () => 1,
      async () => {
        throw new Error("boom")
      },
      async () => 3,
    ]
    const outcomes = await chunkedAllSettled(tasks, 2)
    expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: 1 })
    expect(outcomes[1].status).toBe("rejected")
    expect(outcomes[2]).toMatchObject({ status: "fulfilled", value: 3 })
  })
})
