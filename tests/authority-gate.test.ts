import { describe, expect, it } from "vitest"
import { isAuthoritative, probedToEnriched, type ProbedModel } from "../src/probe.js"
import { probedToDraftKeepingEdits, type V2ModelDraft } from "../src/v2-models.js"
import { applyDecisions, diffModels, mergeAppliedModel, type FreshSources } from "../src/reconcile.js"
import type { EnrichedModel } from "../src/enrich.js"

/** A probe that measured nothing: every field is a guess or the image default. */
function guessedProbe(overrides: Partial<ProbedModel> = {}): ProbedModel {
  return {
    id: "m1",
    context: 128_000,
    contextSource: "local-rules",
    maxOutput: 8_192,
    maxOutputSource: "local-rules",
    image: false,
    imageSource: "default",
    cost: { input: 2, output: 5 },
    costSource: "local-rules",
    ...overrides,
  }
}

/** A stored draft nobody hand-edited: it came from an earlier probe or catalog. */
function storedDraft(overrides: Partial<V2ModelDraft> = {}): V2ModelDraft {
  return {
    name: "m1",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, input: 512, output: 32_000 },
    cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }],
    variants: [{ id: "low", label: "low", thinkingLevel: "low" }],
    enabled: true,
    ...overrides,
  }
}

function storedEnriched(overrides: Partial<EnrichedModel> = {}): EnrichedModel {
  return {
    name: "m1",
    limit: { context: 1_000_000, input: 512, output: 32_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 1, output: 2 },
    ...overrides,
  }
}

describe("isAuthoritative", () => {
  it("accepts only measurements and catalog values", () => {
    expect(isAuthoritative("detected")).toBe(true)
    expect(isAuthoritative("models.dev")).toBe(true)
    expect(isAuthoritative("local-rules")).toBe(false)
    expect(isAuthoritative("api-fallback")).toBe(false)
    expect(isAuthoritative("default")).toBe(false)
    expect(isAuthoritative(undefined)).toBe(false)
  })
})

describe("probedToEnriched modalities gate", () => {
  it("omits modalities when the image source is the default", () => {
    const model = probedToEnriched(guessedProbe(), "slug")
    expect(model).not.toHaveProperty("modalities")
  })

  it("emits modalities when a tier measured image input", () => {
    const off = probedToEnriched({ ...guessedProbe(), image: false, imageSource: "local-rules" }, "slug")
    expect(off.modalities).toEqual({ input: ["text"], output: ["text"] })
    const on = probedToEnriched({ ...guessedProbe(), image: true, imageSource: "models.dev" }, "slug")
    expect(on.modalities?.input).toContain("image")
  })
})

describe("probedToDraftKeepingEdits authority gate (unedited drafts)", () => {
  it("keeps stored image input when the probe only has the image default", () => {
    const next = probedToDraftKeepingEdits(storedDraft(), guessedProbe())
    expect(next.capabilities?.input).toEqual(["text", "image"])
  })

  it("keeps stored limits when the probe resolved a local rule", () => {
    const next = probedToDraftKeepingEdits(storedDraft(), guessedProbe())
    expect(next.limit?.context).toBe(1_000_000)
    expect(next.limit?.input).toBe(512)
    expect(next.limit?.output).toBe(32_000)
    expect(next.variants).toEqual([{ id: "low", label: "low", thinkingLevel: "low" }])
    expect(next.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 } }])
  })

  it("lets a detected measurement overwrite context and output, keeping limit.input", () => {
    const measured = guessedProbe({
      context: 262_144,
      contextSource: "detected",
      maxOutput: 16_384,
      maxOutputSource: "detected",
    })
    const next = probedToDraftKeepingEdits(storedDraft(), measured)
    expect(next.limit?.context).toBe(262_144)
    expect(next.limit?.output).toBe(16_384)
    expect(next.limit?.input).toBe(512)
  })

  it("keeps stored cost against a local rule but takes a models.dev price", () => {
    const ruled = probedToDraftKeepingEdits(storedDraft(), guessedProbe())
    expect(ruled.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 } }])
    const priced = probedToDraftKeepingEdits(
      storedDraft(),
      guessedProbe({ costSource: "models.dev", cost: { input: 3, output: 7 } }),
    )
    expect(priced.cost).toEqual([{ input: 3, output: 7, cache: { read: 0, write: 0 } }])
  })

  it("keeps stored variants when the gateway advertised no effort levels", () => {
    const measured = guessedProbe({
      contextSource: "detected",
      reasoning: true,
      reasoningSource: "detected",
    })
    const next = probedToDraftKeepingEdits(storedDraft(), measured)
    expect(next.variants).toEqual([{ id: "low", label: "low", thinkingLevel: "low" }])
  })

  it("writes the fresh draft when nothing is stored", () => {
    const next = probedToDraftKeepingEdits(undefined, guessedProbe())
    expect(next.limit).toEqual({ context: 128_000, output: 8_192 })
    expect(next.capabilities?.input).toEqual(["text"])
  })
})

describe("probedToDraftKeepingEdits edited path is unchanged", () => {
  it("the editor wins even against an authoritative fresh probe", () => {
    const tuned = storedDraft({ edited: true, limit: { context: 200_000, output: 64_000 } })
    const measured = guessedProbe({
      context: 262_144,
      contextSource: "detected",
      maxOutput: 16_384,
      maxOutputSource: "detected",
      image: true,
      imageSource: "detected",
      costSource: "models.dev",
      cost: { input: 3, output: 7 },
    })
    const next = probedToDraftKeepingEdits(tuned, measured)
    expect(next.limit).toEqual({ context: 200_000, output: 64_000 })
    expect(next.capabilities?.input).toEqual(["text", "image"])
    expect(next.variants).toEqual([{ id: "low", label: "low", thinkingLevel: "low" }])
    // Cost is not editor-owned, so the authoritative fresh price still updates.
    expect(next.cost).toEqual([{ input: 3, output: 7, cache: { read: 0, write: 0 } }])
    expect(next.edited).toBe(true)
  })
})

describe("mergeAppliedModel with sources", () => {
  const fresh: EnrichedModel = {
    name: "m1-fresh",
    limit: { context: 128_000, output: 8_192 },
    modalities: { input: ["text"], output: ["text"] },
    cost: { input: 2, output: 5 },
  }
  const guessed: FreshSources = {
    contextSource: "local-rules",
    maxOutputSource: "local-rules",
    costSource: "local-rules",
    imageSource: "default",
  }

  it("a local-rules guess never replaces a stored value", () => {
    const merged = mergeAppliedModel(storedEnriched(), fresh, guessed)
    expect(merged.limit).toEqual({ context: 1_000_000, input: 512, output: 32_000 })
    expect(merged.modalities?.input).toContain("image")
    expect(merged.cost).toEqual({ input: 1, output: 2 })
    expect(merged.name).toBe("m1-fresh")
  })

  it("an authoritative fresh value overwrites, and stored extras survive", () => {
    const measured: FreshSources = {
      contextSource: "detected",
      maxOutputSource: "detected",
      costSource: "models.dev",
      imageSource: "detected",
    }
    const merged = mergeAppliedModel(storedEnriched(), fresh, measured)
    expect(merged.limit).toEqual({ context: 128_000, input: 512, output: 8_192 })
    expect(merged.modalities?.input).toEqual(["text"])
    expect(merged.cost).toEqual({ input: 2, output: 5 })
  })

  it("without sources the legacy overwrite behaviour is kept", () => {
    const merged = mergeAppliedModel(storedEnriched(), fresh)
    expect(merged.limit).toEqual({ context: 128_000, input: 512, output: 8_192 })
    expect(merged.cost).toEqual({ input: 2, output: 5 })
  })
})

describe("diffModels reports only fields the probe may actually change", () => {
  const stored: Record<string, EnrichedModel> = {
    m1: storedEnriched(),
  }

  it("a local-rules context diff is not an update", () => {
    const changes = diffModels(stored, [guessedProbe()], "slug")
    expect(changes).toEqual([])
  })

  it("a detected context diff is an update with both numbers", () => {
    const changes = diffModels(
      stored,
      [guessedProbe({ context: 262_144, contextSource: "detected", maxOutput: 16_384, maxOutputSource: "detected" })],
      "slug",
    )
    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe("updated")
    expect(changes[0].detail).toContain("context 1000000 -> 262144")
  })
})

describe("applyDecisions threads sources through the apply path", () => {
  const stored: Record<string, EnrichedModel> = { m1: storedEnriched() }

  it("a guessed re-probe leaves the stored model intact", () => {
    const next = applyDecisions(stored, [guessedProbe()], {}, "slug")
    expect(next["m1"].limit).toEqual({ context: 1_000_000, input: 512, output: 32_000 })
    expect(next["m1"].cost).toEqual({ input: 1, output: 2 })
    expect(next["m1"].modalities?.input).toContain("image")
  })

  it("a measured re-probe updates the measured fields", () => {
    const next = applyDecisions(
      stored,
      [guessedProbe({ context: 262_144, contextSource: "detected", maxOutput: 16_384, maxOutputSource: "detected" })],
      {},
      "slug",
    )
    expect(next["m1"].limit).toEqual({ context: 262_144, input: 512, output: 16_384 })
  })
})
