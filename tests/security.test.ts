import { describe, expect, it } from "vitest"
import { sanitizeErrorMessage } from "../src/security.js"

describe("sanitizeErrorMessage JSON-style secret redaction", () => {
  it("redacts apiKey JSON field, keeping the key name", () => {
    expect(sanitizeErrorMessage('body {"apiKey":"abc123"}')).toBe(
      'body {"apiKey":"[REDACTED]"}',
    )
  })

  it("redacts api_key JSON field with whitespace around the colon", () => {
    expect(sanitizeErrorMessage('{"api_key": "abc123"}')).toBe(
      '{"api_key": "[REDACTED]"}',
    )
  })

  it("redacts Authorization JSON field", () => {
    const out = sanitizeErrorMessage('{"Authorization":"Bearer xyz"}')
    expect(out).toBe('{"Authorization":"[REDACTED]"}')
    expect(out).not.toContain("xyz")
  })

  it("redacts token and password JSON fields", () => {
    expect(sanitizeErrorMessage('{"token":"x"}')).toBe('{"token":"[REDACTED]"}')
    expect(sanitizeErrorMessage('{"password":"hunter2"}')).toBe(
      '{"password":"[REDACTED]"}',
    )
  })

  it("leaves a non-secret JSON field unchanged", () => {
    expect(sanitizeErrorMessage('{"model":"x"}')).toBe('{"model":"x"}')
  })

  it("still redacts existing key=value and Bearer forms", () => {
    expect(sanitizeErrorMessage("token=abc")).toBe("token=[REDACTED]")
    expect(sanitizeErrorMessage("api_key=abc")).toBe("api_key=[REDACTED]")
    expect(sanitizeErrorMessage("Bearer abc.def")).toBe("Bearer [REDACTED]")
  })
})
