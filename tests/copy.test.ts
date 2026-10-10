import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const SOURCES = ["src/tui-v2.ts", "src/tui.ts", "src/flavors.ts", "src/server-v2.ts", "src/server.ts"]

const LOCAL_TERM = "local server"
const RETIRED_PHRASES = [/on this computer/i, /Something running/i, /or localhost http/i]

function joinedDescriptionValues(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/description:\s*([\s\S]*?)(?=,\s*\n\s*\w+:|\n\s*\}\)|$)/g)) {
    const literals = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1])
    if (literals.length > 0) out.push(literals.join(""))
  }
  return out
}

describe("user-facing wording", () => {
  it("names a machine-local server the same way everywhere", () => {
    for (const file of SOURCES) {
      const text = read(file)
      for (const retired of RETIRED_PHRASES) {
        expect(
          text,
          `${file} still says "${String(retired)}". Use "${LOCAL_TERM}" instead — the earlier ` +
            `phrasings described the same thing in three different ways and readers could not tell ` +
            `whether they meant the same setup step.`,
        ).not.toMatch(retired)
      }
    }
  })

  it("keeps one term for it across the shipped strings", () => {
    const combined = SOURCES.map(read).join("\n")
    const mentions = combined.match(/local server/gi) ?? []
    expect(mentions.length).toBeGreaterThan(0)
  })

  it("reads every description, including concatenated ones", () => {
    const values = joinedDescriptionValues(read("src/tui-v2.ts"))
    const longest = Math.max(...values.map(v => v.length))
    expect(longest, "concatenated descriptions must be joined before checking").toBeGreaterThan(120)
  })

  it("does not put a newline in a dialog description", () => {
    for (const file of ["src/tui-v2.ts", "src/tui.ts"]) {
      const text = read(file)
      for (const description of joinedDescriptionValues(text)) {
        expect(
          description,
          `${file} has a newline in a description: "${description.slice(0, 60)}". The host renders ` +
            `description on a single line, so the newline does not break the text — it only joins ` +
            `two sentences into a run-on. Use a shorter sentence, or move the paragraph to message.`,
        ).not.toContain("\\n")
      }
    }
  })
})
