import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hermetic: keep the models.dev cache and custom-rules reads off the real HOME.
vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>()
  const home = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/opencode-occp-probe-${process.pid}`
  return { ...os, homedir: () => home }
})

import { parseModelIds, probeEndpoint } from "../src/probe.js"
import { clearModelsDevCache } from "../src/catalog.js"

beforeEach(() => {
  clearModelsDevCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearModelsDevCache()
})

describe("parseModelIds (add-from-catalog selection)", () => {
  it("returns undefined when omitted, meaning 'every catalog model'", () => {
    expect(parseModelIds(undefined)).toBeUndefined()
  })

  it("splits on commas, trims, and drops blank segments", () => {
    expect(parseModelIds("a, b ,, c ")).toEqual(["a", "b", "c"])
  })

  it("returns an empty list for blank or comma-only input (callers must reject)", () => {
    expect(parseModelIds("")).toEqual([])
    expect(parseModelIds(" , , ")).toEqual([])
  })
})
describe("gemini list auth", () => {
  it("appends ?key= to the gemini-list URL, preserving existing params, with no Authorization header", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal(
      "fetch",
      (async (url: unknown, init?: RequestInit) => {
        const target = String(url)
        const headers = { ...(init?.headers ?? {}) } as Record<string, string>
        seen.push({ url: target, headers })
        let body: unknown = {}
        if (target.includes("models.dev")) body = {}
        else if (target.includes("/api/models/public")) body = []
        else if (target.includes("/v1beta/models")) body = { models: [{ name: "models/zzz-gemini-m" }] }
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }) as typeof fetch,
    )

    const probed = await probeEndpoint(
      "https://gem.example/v1beta/models?alt=json",
      "sk-test",
      "gemini",
    )
    expect(probed).toHaveLength(1)

    const listCall = seen.find(c => c.url.includes("/v1beta/models") && !c.url.includes("models.dev"))
    expect(listCall?.url).toContain("key=sk-test")
    expect(listCall?.url).toContain("alt=json")
    expect(listCall?.headers["Authorization"]).toBeUndefined()
    expect(listCall?.headers["Content-Type"]).toBe("application/json")
  })
})

describe("gemini list path fallback", () => {
  it("uses the live path without waiting for a hung first path", async () => {
    // No timers: the first path stays pending forever, so a serial
    // implementation hangs and the test times out instead of passing.
    let v1betaCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn((target: unknown) => {
        const url = String(target)
        if (url.includes("models.dev")) return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
        if (url.includes("/api/models/public")) return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }))
        if (url.includes("/v1beta/models")) {
          v1betaCalls++
          return new Promise<Response>(() => {})
        }
        if (url.includes("/models?key=") || url.includes("/models&key=") || url.includes("/models?alt=")) {
          return Promise.resolve(new Response(JSON.stringify({ models: [{ name: "models/live-gemini" }] }), { status: 200 }))
        }
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
      }) as unknown as typeof fetch,
    )
    const probed = await probeEndpoint("https://gem2.example", "sk-test", "gemini")
    expect(probed.map(m => m.id)).toContain("live-gemini")
    expect(v1betaCalls).toBe(1)
  })
})

