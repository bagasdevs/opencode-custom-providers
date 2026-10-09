import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hermetic: redirect the models.dev cache dir and custom-rules path (~/.…)
// into a temp home so tests never read or clobber the real HOME.
vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>()
  const home = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/opencode-occp-discovery-${process.pid}`
  return { ...os, homedir: () => home }
})

import { discoverAndEnrich } from "../src/discovery.js"
import { clearModelsDevCache } from "../src/catalog.js"

const TEST_MODEL = "zzz-tier-probe-abc"

function stubJson(handler: (url: string, init?: RequestInit) => unknown): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    "fetch",
    (async (url: unknown, init?: RequestInit) => {
      const target = String(url)
      urls.push(target)
      const body = handler(target, init)
      return new Response(JSON.stringify(body ?? {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as typeof fetch,
  )
  return urls
}

beforeEach(() => {
  clearModelsDevCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearModelsDevCache()
})

describe("discoverAndEnrich flavor routing", () => {
  it("defaults to the openai-chat tiered pipeline (flavor fallback limits)", async () => {
    stubJson(url => {
      if (url.includes("models.dev")) return {}
      if (url.includes("/api/models/public")) return []
      if (url.includes("/model/info")) return {}
      if (url.endsWith("/v1/models")) return { data: [{ id: TEST_MODEL }] }
      return {} // per-model detail
    })
    const out = await discoverAndEnrich("https://api.example.com/v1", "sk-test")
    const model = out[TEST_MODEL]
    expect(model).toBeDefined()
    expect(model.name).toBe(TEST_MODEL)
    expect(model.limit).toEqual({ context: 128_000, output: 4_096 })
    expect(model.reasoning).toBe(true)
  })

  it("uses the passed flavor's fallback limits (gemini ≠ openai-chat)", async () => {
    stubJson(url => {
      if (url.includes("models.dev")) return {}
      if (url.includes("/api/models/public")) return []
      if (url.includes("/v1beta/models")) return { models: [{ name: `models/${TEST_MODEL}` }] }
      return {}
    })
    const out = await discoverAndEnrich("https://g.example", undefined, "slug", "gemini")
    const model = out[TEST_MODEL]
    expect(model).toBeDefined()
    expect(model.limit).toEqual({ context: 1_000_000, output: 64_000 })
    expect(model.reasoning).toBe(true)
  })

  it("short-circuits list-less flavors (anthropic) with no endpoint traffic", async () => {
    const urls = stubJson(() => {
      throw new Error("endpoint must not be called")
    })
    const out = await discoverAndEnrich("https://api.example.com/v1", undefined, "slug", "anthropic")
    expect(out).toEqual({})
    expect(urls.filter(u => !u.includes("models.dev"))).toEqual([])
  })

  it("throws on an invalid URL (callers catch and report gracefully)", async () => {
    stubJson(() => {
      throw new Error("must not be called")
    })
    await expect(discoverAndEnrich("not-a-url")).rejects.toThrow(/Invalid Base URL/)
  })
})
