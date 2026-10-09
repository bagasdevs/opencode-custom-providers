import { describe, expect, it } from "vitest"
import {
  deleteModels,
  deleteProviderEntry,
  editModelField,
  getProviderFlavor,
  getStoredModels,
  migrateInlineKey,
  renameProviderEntry,
} from "../src/commands.js"
import type { ProviderFlavor } from "../src/flavors.js"
import type { ProviderConfig } from "../src/types.js"
import type { EnrichedModel } from "../src/enrich.js"

function providers(): Record<string, ProviderConfig> {
  return {
    p1: { name: "p1", options: { baseURL: "https://api.example.com/v1" } },
  }
}

function models(): Record<string, EnrichedModel> {
  return {
    m1: {
      name: "m1",
      limit: { context: 1_000, output: 100 },
      modalities: { input: ["text"], output: ["text"] },
    },
  }
}

describe("getProviderFlavor", () => {
  it("defaults to openai-chat", () => {
    expect(getProviderFlavor({})).toBe("openai-chat")
    expect(getProviderFlavor({ flavor: "nope" as unknown as ProviderFlavor })).toBe("openai-chat")
  })

  it("parses configured flavors", () => {
    expect(getProviderFlavor({ flavor: "ollama" })).toBe("ollama")
  })
})

describe("renameProviderEntry", () => {
  it("renames and updates the entry name", () => {
    const p = providers()
    expect(renameProviderEntry(p, "p1", "p2")).toEqual({})
    expect(p).not.toHaveProperty("p1")
    expect(p["p2"].name).toBe("p2")
  })

  it("rejects invalid, duplicate, and unknown ids", () => {
    const p = providers()
    expect(renameProviderEntry(p, "p1", "bad id")?.error).toBeTypeOf("string")
    expect(renameProviderEntry(p, "p1", "p1")).toEqual({})
    expect(renameProviderEntry({ ...p, other: {} }, "p1", "other")?.error).toContain("already exists")
    expect(renameProviderEntry(p, "missing", "x")?.error).toContain("Unknown")
  })

  it("warns on built-in id collisions", () => {
    const warning = renameProviderEntry(providers(), "p1", "deepseek")?.warning
    expect(warning).toContain("deepseek-custom")
  })
})

describe("deleteProviderEntry", () => {
  it("deletes existing entries and rejects unknown ones", () => {
    const p = providers()
    expect(deleteProviderEntry(p, "p1")).toBeNull()
    expect(p).not.toHaveProperty("p1")
    expect(deleteProviderEntry(p, "p1")).toContain("Unknown")
  })
})

describe("editModelField", () => {
  it("edits name, limits, and toggles", () => {
    const m = models()
    expect(editModelField(m, "m1", "name", "Pretty")).toBeNull()
    expect(m["m1"].name).toBe("Pretty")
    expect(editModelField(m, "m1", "context", "2000")).toBeNull()
    expect(m["m1"].limit.context).toBe(2_000)
    expect(editModelField(m, "m1", "output", "500")).toBeNull()
    expect(m["m1"].limit.output).toBe(500)
    expect(editModelField(m, "m1", "reasoning", "true")).toBeNull()
    expect(m["m1"].reasoning).toBe(true)
    expect(editModelField(m, "m1", "reasoning", "false")).toBeNull()
    expect(m["m1"]).not.toHaveProperty("reasoning")
    expect(editModelField(m, "m1", "image", "true")).toBeNull()
    expect(m["m1"].modalities?.input).toContain("image")
  })

  it("rejects bad values and unknown models", () => {
    const m = models()
    expect(editModelField(m, "m1", "name", "  ")).toBeTypeOf("string")
    expect(editModelField(m, "m1", "context", "abc")).toBeTypeOf("string")
    expect(editModelField(m, "m1", "output", "-5")).toBeTypeOf("string")
    expect(editModelField(m, "m1", "reasoning", "maybe")).toBeTypeOf("string")
    expect(editModelField(m, "nope", "name", "x")).toContain("Unknown")
  })
})

describe("getStoredModels + deleteModels", () => {
  it("returns the stored map and bulk-deletes by id", () => {
    const entry: ProviderConfig = { options: { baseURL: "https://api.example.com/v1" } }
    expect(getStoredModels(entry)).toEqual({})
    entry.models = { a: models()["m1"], b: models()["m1"] } as Record<string, unknown>
    const stored = getStoredModels(entry)
    const { deleted, missing } = deleteModels(stored, ["a", "nope", "  "])
    expect(deleted).toEqual(["a"])
    expect(missing).toEqual(["nope"])
    expect(stored).not.toHaveProperty("a")
    expect(stored).toHaveProperty("b")
  })
})

describe("migrateInlineKey", () => {
  it("moves inline keys into the store", async () => {
    const entry: ProviderConfig = { options: { baseURL: "https://x.example", apiKey: "sk-old" } }
    const seen: Array<[string, string]> = []
    const res = await migrateInlineKey(entry, "p1", async (id, key) => {
      seen.push([id, key])
      return true
    })
    expect(res.migrated).toBe(true)
    expect(res.note).toContain("Migrated")
    expect(entry.options).not.toHaveProperty("apiKey")
    expect(seen).toEqual([["p1", "sk-old"]])
  })

  it("keeps the key when the store declines or fails", async () => {
    const a: ProviderConfig = { options: { apiKey: "sk-a" } }
    expect((await migrateInlineKey(a, "p", async () => false)).migrated).toBe(false)
    expect(a.options?.apiKey).toBe("sk-a")
    const b: ProviderConfig = { options: { apiKey: "sk-b" } }
    const res = await migrateInlineKey(b, "p", async () => {
      throw new Error("down")
    })
    expect(res.migrated).toBe(false)
    expect(b.options?.apiKey).toBe("sk-b")
  })

  it("is a no-op without an inline key", async () => {
    const res = await migrateInlineKey({ options: {} }, "p", async () => true)
    expect(res).toEqual({ migrated: false, note: "" })
  })
})
