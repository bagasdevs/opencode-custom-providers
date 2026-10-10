import { describe, expect, it } from "vitest"
import {
  applyModelFields,
  parseTokenCount,
  parseTokenEdit,
  readModelFields,
  reasoningLabel,
  REASONING_LEVELS,
  resolveTokenEdit,
  type ModelFields,
  type ReasoningLevel,
} from "../src/model-fields.js"
import type { V2ModelDraft } from "../src/v2-models.js"

function applied(reasoning: ReasoningLevel, overrides: Partial<ModelFields> = {}): V2ModelDraft {
  const draft: V2ModelDraft = {}
  applyModelFields(draft, { image: true, reasoning, ...overrides })
  return draft
}

describe("REASONING_LEVELS", () => {
  it("lists every level in ascending order", () => {
    expect([...REASONING_LEVELS]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
  })

  it("labels the opt-in levels and the capped ones", () => {
    expect(reasoningLabel("off")).toBe("Off - no reasoning")
    expect(reasoningLabel("minimal")).toBe("minimal - cap reasoning at minimal")
    expect(reasoningLabel("medium")).toBe("medium - cap reasoning at medium")
    expect(reasoningLabel("high")).toBe("high - cap reasoning at high")
    expect(reasoningLabel("xhigh")).toBe("xhigh - maximum (only if the model supports it)")
    expect(reasoningLabel("max")).toBe("max - maximum (only if the model supports it)")
  })
})

describe("applyModelFields reasoning", () => {
  it("removes both keys for off", () => {
    const draft: V2ModelDraft = { reasoning: true, thinkingLevelMap: { max: "max" } }
    applyModelFields(draft, { image: false, reasoning: "off" })
    expect(draft).toStrictEqual({ capabilities: { input: ["text"] } })
    expect("reasoning" in draft).toBe(false)
    expect("thinkingLevelMap" in draft).toBe(false)
  })

  it("caps the default levels by nulling the ones above the ceiling", () => {
    expect(applied("minimal")).toStrictEqual({
      capabilities: { input: ["text", "image"] },
      reasoning: true,
      thinkingLevelMap: { low: null, medium: null, high: null },
    })
    expect(applied("low")).toStrictEqual({
      capabilities: { input: ["text", "image"] },
      reasoning: true,
      thinkingLevelMap: { medium: null, high: null },
    })
    expect(applied("medium")).toStrictEqual({
      capabilities: { input: ["text", "image"] },
      reasoning: true,
      thinkingLevelMap: { high: null },
    })
  })

  it("writes no map for high, the default ceiling", () => {
    expect(applied("high")).toStrictEqual({ capabilities: { input: ["text", "image"] }, reasoning: true })
    expect("thinkingLevelMap" in applied("high")).toBe(false)
  })

  it("unlocks only the opt-in levels the ceiling reaches", () => {
    expect(applied("xhigh")).toStrictEqual({
      capabilities: { input: ["text", "image"] },
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
    })
    expect(applied("max")).toStrictEqual({
      capabilities: { input: ["text", "image"] },
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    })
  })

  it("clears a stale map when the new ceiling needs none", () => {
    const draft: V2ModelDraft = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
    applyModelFields(draft, { image: true, reasoning: "high" })
    expect("thinkingLevelMap" in draft).toBe(false)
  })

  it("preserves unrelated draft keys and sibling capabilities", () => {
    const draft: V2ModelDraft = {
      name: "sonnet",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [{ id: "high" }],
    }
    applyModelFields(draft, { image: true, reasoning: "medium" })
    expect(draft).toStrictEqual({
      name: "sonnet",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
      variants: [{ id: "high" }],
      reasoning: true,
      thinkingLevelMap: { high: null },
    })
  })
})

describe("applyModelFields limits", () => {
  it("writes both token counts", () => {
    const draft = applied("off", { context: 200_000, output: 8192 })
    expect(draft.limit).toStrictEqual({ context: 200_000, output: 8192 })
  })

  it("deletes the key for 0", () => {
    const draft: V2ModelDraft = { limit: { context: 128_000, output: 4096, input: 128_000 } }
    applyModelFields(draft, { image: true, reasoning: "off", context: 0, output: 0 })
    expect(draft.limit).toStrictEqual({ input: 128_000 })
  })

  it("deletes the key for undefined, and drops an emptied limit object", () => {
    const draft: V2ModelDraft = { limit: { context: 128_000, output: 4096 } }
    applyModelFields(draft, { image: true, reasoning: "off" })
    expect("limit" in draft).toBe(false)
  })

  it("creates the limit object only when a count is being set", () => {
    const draft: V2ModelDraft = {}
    applyModelFields(draft, { image: true, reasoning: "off" })
    expect("limit" in draft).toBe(false)
    applyModelFields(draft, { image: true, reasoning: "off", output: 8192 })
    expect(draft.limit).toStrictEqual({ output: 8192 })
  })
})

describe("readModelFields", () => {
  it("reads a draft that names no field permissively", () => {
    expect(readModelFields({})).toStrictEqual({
      image: true,
      reasoning: "off",
      context: undefined,
      output: undefined,
    })
  })

  it("reads image off when the input list omits image", () => {
    expect(readModelFields({ capabilities: { input: ["text"] } }).image).toBe(false)
    expect(readModelFields({ capabilities: { input: ["text", "image"] } }).image).toBe(true)
  })

  it("treats any reasoning value other than true as off", () => {
    expect(readModelFields({ reasoning: false }).reasoning).toBe("off")
    expect(readModelFields({ reasoning: "yes" }).reasoning).toBe("off")
    expect(readModelFields({ thinkingLevelMap: { max: "max" } }).reasoning).toBe("off")
  })

  it("reads a bare reasoning flag as the high ceiling", () => {
    expect(readModelFields({ reasoning: true }).reasoning).toBe("high")
    expect(readModelFields({ reasoning: true, thinkingLevelMap: {} }).reasoning).toBe("high")
  })

  it("reads the ceiling the map leaves available", () => {
    const cases: Array<[Record<string, string | null>, ReasoningLevel]> = [
      [{ max: "max", xhigh: "xhigh" }, "max"],
      [{ xhigh: "xhigh" }, "xhigh"],
      [{ xhigh: null }, "high"],
      [{ medium: null, high: null }, "low"],
      [{ high: null }, "medium"],
      // An absent key means available, so nulling minimal leaves high on top.
      [{ minimal: null }, "high"],
      // Every default level capped off leaves nothing to read, so fall back to high.
      [{ minimal: null, low: null, medium: null, high: null }, "high"],
      [{ minimal: null, low: null, medium: null, high: null }, "high"],
    ]
    for (const [map, expected] of cases) {
      expect(readModelFields({ reasoning: true, thinkingLevelMap: map }).reasoning).toBe(expected)
    }
  })

  it("reads both limits and treats a missing limit as unset", () => {
    expect(readModelFields({ limit: { context: 128_000, output: 4096, input: 128_000 } })).toStrictEqual({
      image: true,
      reasoning: "off",
      context: 128_000,
      output: 4096,
    })
    expect(readModelFields({ limit: { context: "128000" } } as unknown as V2ModelDraft)).toStrictEqual({
      image: true,
      reasoning: "off",
      context: undefined,
      output: undefined,
    })
  })
})

describe("read then apply round trip", () => {
  it("keeps a fieldless draft unchanged", () => {
    const draft: V2ModelDraft = {}
    applyModelFields(draft, readModelFields(draft))
    expect(draft).toStrictEqual({ capabilities: { input: ["text", "image"] } })
    expect(readModelFields(draft)).toStrictEqual(readModelFields({}))
  })

  it("keeps a stored draft unchanged", () => {
    const draft: V2ModelDraft = {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 128_000, output: 4096 },
      reasoning: true,
      thinkingLevelMap: { medium: null, high: null },
    }
    const before = structuredClone(draft)
    applyModelFields(draft, readModelFields(draft))
    expect(draft).toStrictEqual(before)
  })

  it("keeps every level stable when the ceiling is re-applied", () => {
    for (const level of REASONING_LEVELS) {
      const draft = applied(level)
      applyModelFields(draft, readModelFields(draft))
      expect(draft).toStrictEqual(applied(level))
    }
  })
})

describe("token prompts", () => {
  it("parses counts with separators and whitespace", () => {
    expect(parseTokenCount(" 128_000 ")).toBe(128_000)
    expect(parseTokenCount("1,234,567")).toBe(1_234_567)
    expect(parseTokenCount("4096")).toBe(4096)
  })

  it("tells blank and 0 apart", () => {
    expect(parseTokenEdit("")).toStrictEqual({ action: "keep" })
    expect(parseTokenEdit("   ")).toStrictEqual({ action: "keep" })
    expect(parseTokenEdit("0")).toStrictEqual({ action: "clear" })
    expect(parseTokenEdit("_")).toStrictEqual({ action: "keep" })
    expect(parseTokenCount("")).toBeNull()
    expect(parseTokenCount("0")).toBe(0)
  })

  it("rejects text that is not a plain count", () => {
    for (const raw of ["abc", "12abc", "12 34", "-5", "1.5", "1e6", "99999999999999999999"]) {
      expect(parseTokenCount(raw)).toBeNull()
    }
  })

  it("passes the current value through on keep and invalid input", () => {
    expect(resolveTokenEdit(4096, { action: "keep" })).toBe(4096)
    expect(resolveTokenEdit(undefined, { action: "keep" })).toBeUndefined()
    expect(resolveTokenEdit(4096, { action: "clear" })).toBe(0)
    expect(resolveTokenEdit(4096, { action: "set", value: 8192 })).toBe(8192)
    expect(resolveTokenEdit(4096, null)).toBe(4096)
  })
})
