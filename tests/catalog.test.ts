import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  clearModelsDevCache,
  getCatalog,
  listCatalogSites,
  summarizeCatalog,
} from "../src/catalog.js"
import { buildCatalogModels, catalogToProbed, previewManualModels } from "../src/probe.js"
import { fetchLitellmInfo } from "../src/deep-probe.js"

vi.mock("node:os", { spy: true })

const CATALOG = {
  "site-b": {
    id: "site-b",
    name: "Beta",
    api: "https://b.example/v1",
    models: {
      m1: {
        id: "m1",
        name: "M One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 10_000, output: 1_000 },
        modalities: { input: ["text"], output: ["text"] },
      },
      m2: {
        id: "org/m2",
        name: "M Two",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: true,
        tool_call: true,
        cost: { input: 2, output: 8 },
        limit: { context: 20_000, output: 2_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
  "site-a": {
    id: "site-a",
    name: "Alpha",
    api: "https://a.example/v1",
    models: {
      x: {
        id: "x",
        name: "X",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: false,
        limit: { context: 5_000, output: 500 },
      },
    },
  },
  "empty-site": { id: "empty-site", name: "Empty", models: {} },
  "no-api": {
    id: "no-api",
    name: "NoApi",
    models: {
      y: {
        id: "y",
        name: "Y",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: false,
        limit: { context: 5_000, output: 500 },
      },
    },
  },
}

beforeEach(() => {
  clearModelsDevCache()
  vi.mocked(os.homedir).mockReturnValue(path.join(os.tmpdir(), "opencode-tests-no-home"))
  vi.stubGlobal(
    "fetch",
    (() => Promise.resolve(new Response(JSON.stringify(CATALOG)))) as typeof fetch,
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearModelsDevCache()
})

describe("summarizeCatalog", () => {
  it("sorts by name and skips sites without a usable address or models", () => {
    const sites = summarizeCatalog(CATALOG as never)
    // A site the catalog cannot add (no api URL) must never be offered.
    expect(sites.map(s => s.id)).toEqual(["site-a", "site-b"])
    expect(sites[0]).toMatchObject({ name: "Alpha", modelCount: 1 })
  })
})

describe("listCatalogSites", () => {
  it("fetches and summarizes without probing", async () => {
    const sites = await listCatalogSites()
    expect(sites.map(s => s.id)).toEqual(["site-a", "site-b"])
  })
})

describe("catalogToProbed", () => {
  it("tags everything models.dev and never guesses cost", () => {
    const p = catalogToProbed(CATALOG["site-b"].models.m2 as never)
    expect(p.contextSource).toBe("models.dev")
    expect(p.reasoning).toBe(true)
    expect(p.image).toBe(true)
    expect(p.cost).toEqual({ input: 2, output: 8, cache_read: undefined, cache_write: undefined })
    const plain = catalogToProbed(CATALOG["site-b"].models.m1 as never)
    expect(plain.cost).toBeUndefined()
    expect(plain.image).toBe(false)
  })
})

describe("buildCatalogModels", () => {
  it("builds all models with display names", async () => {
    const built = await buildCatalogModels("site-b", undefined, "name")
    expect(built.baseURL).toBe("https://b.example/v1")
    expect(Object.keys(built.models).sort()).toEqual(["m1", "org/m2"])
    expect(built.models["org/m2"].name).toBe("M Two")
    expect(built.missing).toEqual([])
  })

  it("selects subsets and reports missing ids", async () => {
    const built = await buildCatalogModels("site-b", ["m1", "zzz"], "slug")
    expect(Object.keys(built.models)).toEqual(["m1"])
    expect(built.missing).toEqual(["zzz"])
  })

  it("rejects unknown sites and api-less sites", async () => {
    await expect(buildCatalogModels("nope", undefined, "slug")).rejects.toThrow(/Unknown catalog site/)
    await expect(buildCatalogModels("no-api", undefined, "slug")).rejects.toThrow(/no usable API endpoint/)
  })
})

describe("previewManualModels", () => {
  it("resolves hand-typed ids without endpoint traffic", async () => {
    const previews = await previewManualModels(["gpt-4o", "zzz-unknown-xyz"], "openai-chat", "slug")
    expect(previews.map(p => p.id)).toEqual(["gpt-4o", "zzz-unknown-xyz"])
    expect(previews[0].probed.contextSource).toBe("local-rules")
    expect(previews[0].model.limit.context).toBe(128_000)
    expect(previews[1].probed.contextSource).toBe("api-fallback")
  })
})

describe("fetchLitellmInfo", () => {
  it("converts input_cost_per_token and falls back to bare output_cost", async () => {
    vi.stubGlobal(
      "fetch",
      (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: { input_cost_per_token: 0.000001, output_cost: 0.000003, max_output_tokens: 1_000 },
            }),
          ),
        )) as typeof fetch,
    )
    const patch = await fetchLitellmInfo("https://api.example.com", "m1")
    expect(patch.input_cost).toBe(1)
    expect(patch.output_cost).toBe(3)
    expect(patch.max_output_tokens).toBe(1_000)
  })
})

describe("catalog memo (FIX4)", () => {
  it("shares one fetch across consecutive getCatalog/listCatalogSites calls", async () => {
    const home = os.homedir()
    fs.rmSync(path.join(home, ".cache"), { recursive: true, force: true })
    clearModelsDevCache()
    let calls = 0
    vi.stubGlobal(
      "fetch",
      (async () => {
        calls++
        return new Response(JSON.stringify(CATALOG))
      }) as typeof fetch,
    )
    const first = await getCatalog()
    const second = await getCatalog()
    expect(second).toBe(first)
    const sites = await listCatalogSites()
    expect(calls).toBe(1)
    expect(sites.map(s => s.id)).toEqual(["site-a", "site-b"])
    // Memo never leaks across clears: fresh network fetch after clear.
    fs.rmSync(path.join(home, ".cache"), { recursive: true, force: true })
    clearModelsDevCache()
    let calls2 = 0
    vi.stubGlobal(
      "fetch",
      (async () => {
        calls2++
        return new Response(JSON.stringify(CATALOG))
      }) as typeof fetch,
    )
    await getCatalog()
    await getCatalog()
    expect(calls2).toBe(1)
  })
})

describe("clearModelsDevCache TTL (FIX5)", () => {
  const TTL = 6 * 60 * 60 * 1000

  function cacheFileFor(home: string): string {
    return path.join(home, ".cache", "opencode-custom-providers", "models-dev.json")
  }

  it("keeps a fresh cache file and resets memory maps", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-ttl-fresh-"))
    try {
      vi.mocked(os.homedir).mockReturnValue(home)
      const file = cacheFileFor(home)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now(), data: {} }))
      clearModelsDevCache()
      expect(fs.existsSync(file)).toBe(true)
      // Memory reset: drop the file so the next fetch must hit network.
      fs.rmSync(file, { force: true })
      let calls = 0
      vi.stubGlobal(
        "fetch",
        (async () => {
          calls++
          return new Response(JSON.stringify(CATALOG))
        }) as typeof fetch,
      )
      await getCatalog()
      await getCatalog()
      expect(calls).toBe(1)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("unlinks a stale cache file and resets memory maps", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-ttl-stale-"))
    try {
      vi.mocked(os.homedir).mockReturnValue(home)
      const file = cacheFileFor(home)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now() - TTL - 60_000, data: {} }))
      const past = new Date(Date.now() - TTL - 60_000)
      fs.utimesSync(file, past, past)
      clearModelsDevCache()
      expect(fs.existsSync(file)).toBe(false)
      let calls = 0
      vi.stubGlobal(
        "fetch",
        (async () => {
          calls++
          return new Response(JSON.stringify(CATALOG))
        }) as typeof fetch,
      )
      await getCatalog()
      await getCatalog()
      expect(calls).toBe(1)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
