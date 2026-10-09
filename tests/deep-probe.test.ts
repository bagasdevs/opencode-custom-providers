import { afterEach, describe, expect, it, vi } from "vitest"

// Hermetic: keep HOME-dependent reads off the real HOME.
vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>()
  const home = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/opencode-occp-deep-probe-${process.pid}`
  return { ...os, homedir: () => home }
})

import {
  applyPatch,
  deepenEndpointItems,
  deepenItem,
  fetchLitellmInfo,
  fetchModelDetail,
  fetchOllamaShow,
  fetchPublicCatalog,
  mapPool,
  patchFromRecord,
  probeDeveloperRole,
  type DeepenContext,
} from "../src/deep-probe.js"
import type { EndpointModelResponse } from "../src/endpoint.js"

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    ((url: unknown, init?: unknown) => handler(String(url), init as RequestInit)) as typeof fetch,
  )
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const CTX: DeepenContext = {
  modelsUrl: "https://api.example.com/v1/models",
  origin: "https://api.example.com",
  apiKey: "sk-test",
  flavor: "openai-chat",
}

describe("patchFromRecord", () => {
  it("normalizes detail-shaped records", () => {
    const patch = patchFromRecord({
      context_window: 9_000,
      max_output_tokens: 1_000,
      capabilities: { vision: true, reasoning: { effort_options: ["low", "high"] } },
    })
    expect(patch).toMatchObject({
      context_length: 9_000,
      max_output_tokens: 1_000,
      vision: true,
      effort_options: ["low", "high"],
    })
  })

  it("converts OpenRouter-style per-token pricing to per-1M", () => {
    const patch = patchFromRecord({ pricing: { prompt: "0.000002", completion: "0.000008" } })
    expect(patch.input_cost).toBe(2)
    expect(patch.output_cost).toBe(8)
  })
})

describe("fetchModelDetail", () => {
  it("retrieves and normalizes one model", async () => {
    stubFetch(url => {
      expect(url).toContain("/v1/models/m1")
      return json({ context_window: 5_000 })
    })
    const patch = await fetchModelDetail("https://api.example.com/v1/models", "m1", "k")
    expect(patch.context_length).toBe(5_000)
  })
})

describe("fetchLitellmInfo", () => {
  it("converts per-token prices and reads limits (data-wrapped)", async () => {
    stubFetch(url => {
      expect(url).toContain("/model/info")
      return json({ data: { input_cost_per_token: 0.0000015, output_cost_per_token: 0.000006, max_input_tokens: 200_000 } })
    })
    const patch = await fetchLitellmInfo("https://api.example.com", "m1")
    expect(patch.input_cost).toBe(1.5)
    expect(patch.output_cost).toBe(6)
    expect(patch.context_length).toBe(200_000)
  })
})

describe("fetchPublicCatalog", () => {
  it("accepts bare arrays and {data} envelopes", async () => {
    stubFetch(() => json([{ id: "a", context_length: 10 }]))
    const bare = await fetchPublicCatalog("https://x.example")
    expect(bare.get("a")?.context_length).toBe(10)
    stubFetch(() => json({ data: [{ id: "b", max_output_tokens: 20 }] }))
    const wrapped = await fetchPublicCatalog("https://x.example")
    expect(wrapped.get("b")?.max_output_tokens).toBe(20)
  })
})

describe("fetchOllamaShow", () => {
  it("detects vision capability", async () => {
    stubFetch(() => json({ capabilities: ["completion", "vision"] }))
    const patch = await fetchOllamaShow("http://localhost:11434", "llava")
    expect(patch.vision).toBe(true)
  })
})

describe("deepenItem", () => {
  it("skips the network when nothing is missing", async () => {
    let calls = 0
    stubFetch(() => {
      calls++
      return json({})
    })
    const item: EndpointModelResponse = {
      id: "m1",
      context_length: 1_000,
      max_output_tokens: 100,
      input_cost: 1,
      output_cost: 2,
      capabilities: { reasoning: true },
    }
    const out = await deepenItem(item, CTX)
    expect(out).toEqual(item)
    expect(calls).toBe(0)
  })

  it("fills gaps from the detail endpoint", async () => {
    stubFetch(url => {
      if (url.endsWith("/api/models/public")) return json([])
      return json({ context_window: 7_000, max_output_tokens: 700 })
    })
    const out = await deepenItem({ id: "m2" }, CTX)
    expect(out.context_length).toBe(7_000)
    expect(out.max_output_tokens).toBe(700)
  })

  it("posts ollama detail probes to <origin>/api/show, not the /api/tags list URL", async () => {
    const urls: string[] = []
    stubFetch(url => {
      urls.push(url)
      if (url.endsWith("/api/show")) return json({ capabilities: ["completion", "vision"] })
      return json({})
    })
    const ctx: DeepenContext = {
      modelsUrl: "http://localhost:11434/api/tags",
      origin: "http://localhost:11434",
      flavor: "ollama",
    }
    const out = await deepenItem({ id: "llava" }, ctx)
    expect(out.capabilities?.vision).toBe(true)
    expect(urls).toContain("http://localhost:11434/api/show")
    expect(urls.some(u => u.includes("/api/tags/api/show"))).toBe(false)
  })
})

describe("applyPatch", () => {
  it("keeps existing sane values and fills gaps", () => {
    const out = applyPatch(
      { id: "m", context_length: 1_000 },
      { context_length: 9_000, max_output_tokens: 500, vision: true },
    )
    expect(out.context_length).toBe(1_000)
    expect(out.max_output_tokens).toBe(500)
    expect(out.capabilities?.vision).toBe(true)
  })
})

describe("probeDeveloperRole", () => {
  it("returns false on explicit developer rejection", async () => {
    stubFetch(() => new Response('{"error": "developer role not supported"}', { status: 400 }))
    await expect(probeDeveloperRole("https://api.example.com/v1", "k")).resolves.toBe(false)
  })

  it("is inconclusive without a key, on auth failures, or on success", async () => {
    await expect(probeDeveloperRole("https://api.example.com/v1")).resolves.toBeUndefined()
    stubFetch(() => new Response("nope", { status: 401 }))
    await expect(probeDeveloperRole("https://api.example.com/v1", "k")).resolves.toBeUndefined()
    stubFetch(() => json({ id: "ok" }))
    await expect(probeDeveloperRole("https://api.example.com/v1", "k")).resolves.toBeUndefined()
  })
})

describe("mapPool", () => {
  it("preserves order with varying delays", async () => {
    const delays = [30, 5, 20, 10, 0]
    const out = await mapPool(delays, 2, async (ms, i) => {
      await new Promise(r => setTimeout(r, ms))
      return i
    })
    expect(out).toEqual([0, 1, 2, 3, 4])
  })

  it("never exceeds the pool size", async () => {
    let active = 0
    let max = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    const out = await mapPool(items, 3, async v => {
      active++
      max = Math.max(max, active)
      await new Promise(r => setTimeout(r, 5))
      active--
      return v * 2
    })
    expect(out).toEqual(items.map(v => v * 2))
    expect(max).toBeLessThanOrEqual(3)
  })

  it("surfaces a per-index rejection", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async v => {
        if (v === 2) throw new Error("boom-1")
        return v
      }),
    ).rejects.toThrow("boom-1")
  })
})

describe("deepenEndpointItems", () => {
  it("performs zero fetches when every item is complete", async () => {
    let calls = 0
    stubFetch(() => {
      calls++
      return json([])
    })
    const items: EndpointModelResponse[] = [
      {
        id: "m1",
        context_length: 1_000,
        max_output_tokens: 100,
        input_cost: 1,
        output_cost: 2,
        capabilities: {},
      },
      {
        id: "m2",
        context_length: 2_000,
        max_output_tokens: 200,
        input_cost: 3,
        output_cost: 4,
        capabilities: {},
      },
    ]
    const out = await deepenEndpointItems(items, CTX)
    expect(calls).toBe(0)
    expect(out).toBe(items)
  })
})
