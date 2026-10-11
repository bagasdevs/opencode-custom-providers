import { describe, expect, it } from "vitest"
import { normalizeBaseUrl } from "../src/endpoint.js"
import { isValidUrl, sanitizeDialogText } from "../src/security.js"
import { parseTokenEdit, resolveTokenEdit } from "../src/model-fields.js"

describe("normalizeBaseUrl (totality)", () => {
  const hostileInputs = [
    "",
    "   ",
    "notaurl",
    ":::",
    "http://",
    "a",
    "https://example.com/v1#fragment",
  ]
  // Nonsense inputs: if normalization ever "repaired" these into parseable
  // http/https URLs, validation would accept garbage endpoints.
  const nonsense = new Set(["", "   ", "notaurl", ":::", "http://", "a"])

  it("never throws on hostile input", () => {
    for (const raw of hostileInputs) {
      expect(() => normalizeBaseUrl(raw)).not.toThrow()
    }
  })

  it("never turns nonsense into a URL that isValidUrl accepts", () => {
    for (const raw of hostileInputs) {
      if (!nonsense.has(raw)) continue
      expect(isValidUrl(normalizeBaseUrl(raw))).toBe(false)
    }
  })
})

describe("sanitizeDialogText", () => {
  it("strips every control character including escape and delete", () => {
    const mixed = `hello\u001bworld\u007f\nsecond\tline\r`
    expect(sanitizeDialogText(mixed)).toBe("helloworldsecondline")
  })

  it("leaves ordinary text untouched", () => {
    const plain = "plain text with no control characters: 123 !?"
    expect(sanitizeDialogText(plain)).toBe(plain)
  })
})

describe("parseTokenEdit and resolveTokenEdit", () => {
  it("treats a number as a set", () => {
    const edit = parseTokenEdit("200000")
    expect(edit).toEqual({ action: "set", value: 200000 })
    expect(resolveTokenEdit(undefined, edit!)).toBe(200000)
  })

  it("treats 0 as a clear even when a value already exists", () => {
    const edit = parseTokenEdit("0")
    expect(edit).toEqual({ action: "clear" })
    expect(resolveTokenEdit(200000, edit!)).toBe(0)
  })

  it("treats blank as a keep, not a clear", () => {
    const edit = parseTokenEdit("   ")
    expect(edit).toEqual({ action: "keep" })
    expect(resolveTokenEdit(200000, edit!)).toBe(200000)
    expect(resolveTokenEdit(undefined, edit!)).toBeUndefined()
  })

  it("rejects garbage instead of silently keeping the old value", () => {
    expect(parseTokenEdit("abc")).toBeNull()
    expect(parseTokenEdit("12x3")).toBeNull()
    // A rejected edit never reaches resolveTokenEdit as a keep, so the caller
    // can warn instead of silently discarding the user's input.
    expect(resolveTokenEdit(200000, parseTokenEdit("abc")!)).toBe(200000)
  })
})
