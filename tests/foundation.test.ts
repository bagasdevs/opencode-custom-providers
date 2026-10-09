import { describe, expect, it } from "vitest"
import { collisionSuggestion, parseFlavor } from "../src/flavors.js"
import { matchLocalRule } from "../src/rules.js"
import { buildCandidateUrls, describeProbed, resolveModel } from "../src/probe.js"
import { applyDecisions, diffModels, mergeAppliedModel } from "../src/reconcile.js"
import type { EnrichedModel } from "../src/enrich.js"

describe("parseFlavor", () => {
  it("parses known flavors case-insensitively", () => {
    expect(parseFlavor("Ollama")).toBe("ollama")
    expect(parseFlavor("openai_chat")).toBe("openai-chat")
  })

  it("returns null for unknown or empty values", () => {
    expect(parseFlavor("nope")).toBeNull()
    expect(parseFlavor(undefined)).toBeNull()
  })
})

describe("collisionSuggestion", () => {
  it("suggests -custom for well-known built-in ids", () => {
    expect(collisionSuggestion("deepseek")).toBe("deepseek-custom")
  })

  it("returns null for unique ids", () => {
    expect(collisionSuggestion("my-proxy")).toBeNull()
  })
})

describe("matchLocalRule", () => {
  it("matches exact normalized ids", () => {
    expect(matchLocalRule("gpt-4o")?.meta.context).toBe(128_000)
  })

  it("matches relay-decorated ids after normalization", () => {
    expect(matchLocalRule("bailian/deepseek-v4-pro")?.meta.context).toBe(256_000)
    expect(matchLocalRule("gpt-5@20250807")?.pattern).toBe("gpt-5")
    expect(matchLocalRule("claude-sonnet-4-6[1m]")?.meta.reasoning).toBe(true)
  })

  it("falls back to the longest prefix", () => {
    expect(matchLocalRule("claude-sonnet-9-zzz")?.pattern).toBe("claude-sonnet")
  })

  it("returns null for unknown ids", () => {
    expect(matchLocalRule("zzz-unknown-123")).toBeNull()
  })
})

describe("buildCandidateUrls", () => {
  it("adds a /v1 variant", () => {
    expect(buildCandidateUrls("https://api.example.com/x")).toEqual([
      "https://api.example.com/x",
      "https://api.example.com/x/v1",
    ])
  })

  it("skips the /v1 variant when already present", () => {
    expect(buildCandidateUrls("https://api.example.com/v1")).toEqual([
      "https://api.example.com/v1",
    ])
  })

  it("falls back from http to https for remote hosts, not localhost", () => {
    expect(buildCandidateUrls("http://api.example.com/x")).toContain("https://api.example.com/x")
    const local = buildCandidateUrls("http://localhost:11434")
    expect(local).toContain("http://localhost:11434")
    expect(local.some(u => u.startsWith("https:"))).toBe(false)
  })
})

describe("resolveModel tiers", () => {
  const lookup = new Map([
    ["catalog-model", {
      name: "Catalog Model",
      limit: { context: 500_000, output: 50_000 },
      reasoning: false,
      temperature: false,
      tool_call: false,
      modalities: { input: ["text"], output: ["text"] as string[] },
      cost: { input: 1, output: 2 },
    }],
  ])

  it("prefers detected endpoint values", () => {
    const p = resolveModel(
      { id: "m1", context_length: 9_000, max_output_tokens: 1_000 },
      lookup,
      "openai-chat",
      {},
    )
    expect(p.context).toBe(9_000)
    expect(p.contextSource).toBe("detected")
    expect(p.maxOutput).toBe(1_000)
  })

  it("falls back to models.dev, then local rules, then api fallback", () => {
    const fromCatalog = resolveModel({ id: "catalog-model" }, lookup, "openai-chat", {})
    expect(fromCatalog.contextSource).toBe("models.dev")
    const fromRules = resolveModel({ id: "gpt-4o" }, new Map(), "openai-chat", {})
    expect(fromRules.contextSource).toBe("local-rules")
    const fromFallback = resolveModel({ id: "zzz-unknown-123" }, new Map(), "anthropic", {})
    expect(fromFallback.context).toBe(200_000)
    expect(fromFallback.contextSource).toBe("api-fallback")
  })

  it("never guesses cost", () => {
    const p = resolveModel({ id: "gpt-4o" }, new Map(), "openai-chat", {})
    expect(p.cost).toBeUndefined()
    const priced = resolveModel(
      { id: "m2", input_cost: 0.5, output_cost: 1.5 },
      new Map(),
      "openai-chat",
      {},
    )
    expect(priced.cost).toEqual({ input: 0.5, output: 1.5 })
    expect(priced.costSource).toBe("detected")
  })

  it("captures advertised reasoning effort levels", () => {
    const p = resolveModel(
      {
        id: "m3",
        capabilities: { reasoning: { effort_options: ["low", "high"] } as unknown as boolean },
      },
      new Map(),
      "openai-chat",
      {},
    )
    expect(p.reasoning).toBe(true)
    expect(p.reasoningSource).toBe("detected")
    expect(p.reasoningLevels).toEqual(["low", "high"])
  })
})

describe("describeProbed", () => {
  it("renders a one-line summary with source tags", () => {
    expect(describeProbed({
      id: "gpt-4o",
      context: 128_000,
      contextSource: "detected",
      maxOutput: 16_384,
      maxOutputSource: "models.dev",
      reasoning: true,
      reasoningSource: "local-rules",
      reasoningLevels: ["low", "high"],
      image: false,
      imageSource: "default",
      cost: { input: 2.5, output: 10 },
      costSource: "models.dev",
    })).toBe(
      "gpt-4o | ctx 128000 [detected] | out 16384 [models.dev] | " +
      "reasoning (low/high) [local-rules] | image [-] [default] | cost $2.5/$10 [models.dev]",
    )
  })
})

describe("diffModels + applyDecisions", () => {
  const stored: Record<string, EnrichedModel> = {
    same: { name: "same", limit: { context: 1_000, output: 100 }, modalities: { input: ["text"], output: ["text"] } },
    changed: { name: "changed", limit: { context: 1_000, output: 100 }, modalities: { input: ["text"], output: ["text"] } },
    gone: { name: "gone", limit: { context: 1_000, output: 100 }, modalities: { input: ["text"], output: ["text"] } },
  }

  it("detects added, updated, and removed models", () => {
    const changes = diffModels(stored, [
      { id: "same", context: 1_000, maxOutput: 100 },
      { id: "changed", context: 2_000, maxOutput: 100 },
      { id: "brand-new", context: 1_000, maxOutput: 100 },
    ], "slug")
    expect(changes.map(c => `${c.kind}:${c.id}`).sort()).toEqual([
      "added:brand-new",
      "removed:gone",
      "updated:changed",
    ])
    expect(changes.find(c => c.kind === "updated")?.detail).toContain("context 1000 -> 2000")
  })

  it("applies tri-state decisions with safe defaults", () => {
    const next = applyDecisions(stored, [
      { id: "changed", context: 2_000, maxOutput: 100 },
      { id: "brand-new", context: 1_000, maxOutput: 100 },
    ], { gone: "remove" }, "slug")
    expect(next["changed"].limit.context).toBe(2_000)
    expect(next["brand-new"].limit.context).toBe(1_000)
    expect(next).not.toHaveProperty("gone")
  })
})

describe("mergeAppliedModel (apply must not drop stored-only fields)", () => {
  const stored: EnrichedModel = {
    name: "old-name",
    family: "family-x",
    release_date: "2026-01-01",
    status: "stable",
    attachment: true,
    tool_call: true,
    temperature: true,
    reasoning: true,
    reasoningLevels: ["low", "high"],
    cost: { input: 1, output: 2 },
    limit: { context: 1_000, input: 500, output: 100 },
    modalities: { input: ["text"], output: ["text"] },
  }
  const fresh: EnrichedModel = {
    name: "new-name",
    limit: { context: 2_000, output: 200 },
    modalities: { input: ["text", "image"], output: ["text"] },
    reasoning: true,
  }

  it("fresh wins for provided fields, stored-only fields carry forward", () => {
    const merged = mergeAppliedModel(stored, fresh)
    expect(merged.name).toBe("new-name")
    expect(merged.limit).toEqual({ context: 2_000, input: 500, output: 200 })
    expect(merged.modalities?.input).toContain("image")
    expect(merged.family).toBe("family-x")
    expect(merged.release_date).toBe("2026-01-01")
    expect(merged.status).toBe("stable")
    expect(merged.attachment).toBe(true)
    expect(merged.tool_call).toBe(true)
    expect(merged.temperature).toBe(true)
    expect(merged.cost).toEqual({ input: 1, output: 2 })
    expect(merged.reasoning).toBe(true)
    expect(merged.reasoningLevels).toEqual(["low", "high"])
  })

  it("takes fresh cost when the fresh probe reports one", () => {
    const merged = mergeAppliedModel(stored, { ...fresh, cost: { input: 9, output: 8 } })
    expect(merged.cost).toEqual({ input: 9, output: 8 })
  })

  it("applyDecisions merges instead of replacing an existing entry", () => {
    const next = applyDecisions(
      { m1: stored },
      [{ id: "m1", context: 2_000, maxOutput: 200, image: true }],
      {},
      "slug",
    )
    expect(next["m1"].limit).toEqual({ context: 2_000, input: 500, output: 200 })
    expect(next["m1"].family).toBe("family-x")
    expect(next["m1"].tool_call).toBe(true)
    expect(next["m1"].cost).toEqual({ input: 1, output: 2 })
    expect(next["m1"].modalities?.input).toContain("image")
  })
})
