import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { loadCustomRules } from "../src/rules.js"

vi.mock("node:os", { spy: true })

const FILENAME = ".opencode-custom-providers-rules.json"

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "rules-test-"))
  vi.mocked(os.homedir).mockReturnValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

describe("loadCustomRules", () => {
  it("returns {} when the file is missing", () => {
    expect(loadCustomRules()).toEqual({})
  })

  it("returns {} for an unparseable file", () => {
    fs.writeFileSync(path.join(home, FILENAME), "{not json")
    expect(loadCustomRules()).toEqual({})
  })

  it("keeps valid entries and drops invalid ones", () => {
    fs.writeFileSync(
      path.join(home, FILENAME),
      JSON.stringify({
        exact: {
          good: { context: 128_000, output: 4_096, reasoning: true, image: false },
          "zero-context": { context: 0, output: 4_096, reasoning: true, image: false },
          "string-output": { context: 128_000, output: "4k", reasoning: true, image: false },
          "bad-toggles": { context: 128_000, output: 4_096, reasoning: "yes", image: false },
          "missing-image": { context: 128_000, output: 4_096, reasoning: true },
          junk: "not-an-object",
        },
      }),
    )
    expect(loadCustomRules()).toEqual({
      good: { context: 128_000, output: 4_096, reasoning: true, image: false },
    })
  })

  it("parses once across calls with the same mtime", () => {
    const file = path.join(home, FILENAME)
    fs.writeFileSync(
      file,
      JSON.stringify({
        exact: { a: { context: 1_000, output: 100, reasoning: true, image: false } },
      }),
    )
    const first = loadCustomRules()
    const second = loadCustomRules()
    expect(second).toBe(first)
    expect(first).toEqual({
      a: { context: 1_000, output: 100, reasoning: true, image: false },
    })
  })

  it("returns new content after rewrite with bumped mtime", () => {
    const file = path.join(home, FILENAME)
    fs.writeFileSync(
      file,
      JSON.stringify({
        exact: { a: { context: 1_000, output: 100, reasoning: true, image: false } },
      }),
    )
    const first = loadCustomRules()
    expect(first).toEqual({
      a: { context: 1_000, output: 100, reasoning: true, image: false },
    })
    fs.writeFileSync(
      file,
      JSON.stringify({
        exact: { b: { context: 2_000, output: 200, reasoning: false, image: true } },
      }),
    )
    const bumped = new Date(Date.now() + 5_000)
    fs.utimesSync(file, bumped, bumped)
    const second = loadCustomRules()
    expect(second).toEqual({
      b: { context: 2_000, output: 200, reasoning: false, image: true },
    })
    expect(second).not.toBe(first)
    expect(loadCustomRules()).toBe(second)
  })
})
