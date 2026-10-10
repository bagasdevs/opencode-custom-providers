import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hermetic: keep the models.dev cache and custom-rules reads off the real HOME.
vi.mock("node:os", async importOriginal => {
  const os = await importOriginal<typeof import("node:os")>()
  const home = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/opencode-occp-metadata-${process.pid}`
  return { ...os, homedir: () => home }
})

import { describeProbed, previewManualModels, probeEndpointOutcome, resolveModel } from "../src/probe.js"
import { probedToDraft } from "../src/v2-models.js"
import { buildCandidateUrls } from "../src/probe.js"
import { clearModelsDevCache } from "../src/catalog.js"

beforeEach(() => {
  clearModelsDevCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  clearModelsDevCache()
})

describe("M2 - no placeholder number is written when the value is unknown", () => {
  const noEvidence = resolveModel({ id: "zzz-unknown-xyz" }, new Map(), "openai-chat", {})

  it("still resolves a fallback value on the probe, tagged as a fallback", () => {
    expect(noEvidence.context).toBe(128_000)
    expect(noEvidence.contextSource).toBe("api-fallback")
  })

  it("writes an empty limit rather than the fallback number", () => {
    expect(probedToDraft(noEvidence).limit).toEqual({})
  })

  it("keeps a measured limit", () => {
    const measured = resolveModel({ id: "m1", context_length: 9_000, max_output_tokens: 1_000 }, new Map(), "openai-chat", {})
    expect(probedToDraft(measured).limit).toEqual({ context: 9_000, output: 1_000 })
  })
})

describe("m8 - `default` means no measurement", () => {
  it("leaves reasoning undefined when no tier produced evidence", () => {
    const probed = resolveModel({ id: "zzz-unknown-xyz" }, new Map(), "openai-chat", {})
    expect(probed.reasoning).toBeUndefined()
    expect(probed.reasoningSource).toBeUndefined()
  })

  it("never renders a capability the probe did not measure", () => {
    const probed = resolveModel({ id: "zzz-unknown-xyz" }, new Map(), "openai-chat", {})
    expect(describeProbed(probed)).toBe("Model: zzz-unknown-xyz")
  })

  it("still records a rule-sourced reasoning claim (local rules are evidence)", () => {
    expect(resolveModel({ id: "gpt-4o" }, new Map(), "openai-chat", {}).reasoningSource).toBe("local-rules")
  })
})

describe("M3 - one resolver owns the clamp", () => {
  it("clamps a degenerate output onto context at the single write boundary", () => {
    const probed = resolveModel({ id: "m", context_length: 8_000, max_output_tokens: 8_000 }, new Map(), "openai-chat", {})
    expect(probed.maxOutput).toBe(4_000)
  })

  it("exposes no second resolver from discovery", async () => {
    const barrel = await import("../src/discovery.js")
    expect(Object.keys(barrel)).not.toContain("buildEnrichedModel")
  })
})

describe("M9 - reasoning effort levels survive into the stored draft", () => {
  it("writes the advertised levels as variants", () => {
    const probed = resolveModel(
      { id: "m", capabilities: { reasoning: { effort_options: ["low", "high"] } as unknown as boolean } },
      new Map(),
      "openai-chat",
      {},
    )
    expect(probedToDraft(probed).variants).toEqual([
      { id: "low", label: "low", thinkingLevel: "low" },
      { id: "high", label: "high", thinkingLevel: "high" },
    ])
  })

  it("falls back to the full set when the gateway advertised none", () => {
    const probed = resolveModel(
      { id: "m", capabilities: { reasoning: true } },
      new Map(),
      "openai-chat",
      {},
    )
    expect(probedToDraft(probed).variants).toEqual([
      { id: "low", label: "low", thinkingLevel: "low" },
      { id: "medium", label: "medium", thinkingLevel: "medium" },
      { id: "high", label: "high", thinkingLevel: "high" },
    ])
  })

  it("writes no variants for a non-reasoning model", () => {
    expect(probedToDraft(resolveModel({ id: "gpt-4o" }, new Map(), "openai-chat", {})).variants).toBeUndefined()
  })
})

describe("M10 - endpoint normalisation writes back the variant that answered", () => {
  const stubModels = (answers: Record<string, unknown>) => {
    vi.stubGlobal(
      "fetch",
      (async (url: unknown) => {
        const target = String(url)
        if (target.includes("models.dev")) return new Response("{}", { status: 200 })
        if (target.includes("/api/models/public")) return new Response("[]", { status: 200 })
        if (target.includes("/model/info")) return new Response("{}", { status: 200 })
        for (const [fragment, body] of Object.entries(answers)) {
          if (target.includes(fragment)) return new Response(JSON.stringify(body), { status: 200 })
        }
        return new Response("{}", { status: 200 })
      }) as typeof fetch,
    )
  }

  it("returns the /v1 candidate that actually answered, not the URL as typed", async () => {
    stubModels({ "/v1/models": { data: [{ id: "zzz-m10-model" }] } })
    const outcome = await probeEndpointOutcome("http://127.0.0.1:60285", undefined, "openai-chat")
    expect(outcome.models.map(m => m.id)).toEqual(["zzz-m10-model"])
    expect(outcome.baseURL).toBe("http://127.0.0.1:60285/v1")
    expect(outcome.listUnsupported).toBe(false)
  })

  it("reports the list-less flavor as its own outcome, not as an empty answer", async () => {
    stubModels({})
    const outcome = await probeEndpointOutcome("https://api.example.com/v1", undefined, "anthropic")
    expect(outcome).toEqual({ models: [], baseURL: "https://api.example.com/v1", listUnsupported: true })
  })

  it("never offers an https upgrade for a LAN host", () => {
    for (const host of ["192.168.1.5:8000", "10.0.0.7:8000", "172.20.1.4:8000", "box.local:8000"]) {
      expect(buildCandidateUrls(`http://${host}/v1`).some(u => u.startsWith("https:"))).toBe(false)
    }
    // A public host must still get the upgrade.
    expect(buildCandidateUrls("http://api.example.com/v1")).toContain("https://api.example.com/v1")
  })
})

describe("B2 - previewManualModels stays network-free and rejects an empty list", () => {
  it("resolves hand-typed ids with no endpoint traffic", async () => {
    vi.stubGlobal(
      "fetch",
      (() => {
        throw new Error("previewManualModels must not touch the network")
      }) as unknown as typeof fetch,
    )
    const previews = await previewManualModels(["gpt-4o"], "openai-chat", "slug")
    expect(previews).toHaveLength(1)
    expect(previews[0].probed.contextSource).toBe("local-rules")
  })

  it("returns an empty list for an empty selection, so the caller can reject it", async () => {
    vi.stubGlobal(
      "fetch",
      (() => {
        throw new Error("previewManualModels must not touch the network")
      }) as unknown as typeof fetch,
    )
    await expect(previewManualModels([], "openai-chat", "slug")).resolves.toEqual([])
  })
})

describe("m7 - documented non-goals stay out", () => {
  it("emits no per-model headers, baseURL override, env-command auth or video input", async () => {
    const probed = resolveModel({ id: "zzz-unknown-xyz" }, new Map(), "openai-chat", {})
    const draft = probedToDraft(probed)
    for (const forbidden of ["headers", "baseUrl", "baseURL", "apiKey", "video", "modelsYml"]) {
      expect(Object.keys(draft)).not.toContain(forbidden)
    }
    expect(draft.capabilities?.input).not.toContain("video")
  })
})
