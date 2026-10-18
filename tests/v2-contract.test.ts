import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import serverEntry from "../src/server.js"
import tuiEntry from "../src/tui.js"

// The catalog admits new plugins only on the V2 API: an @opencode/* dependency plus a
// `Plugin.define({ id, setup })` export. Losing either is silent locally because V1 keeps
// working, so pin both. Policy: docs/policy.md in Heretek-AI/awesome-opencode.
const root = join(import.meta.dirname, "..")

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  exports?: Record<string, unknown>
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest

// The default export carries a V1 member beside the V2 definition, which the V2 type omits.
type Dual<T> = T & { server?: unknown; tui?: unknown }

describe("OpenCode V2 plugin contract", () => {
  it("declares both host packages as peers", () => {
    expect(manifest.peerDependencies?.["@opencode/plugin"]).toBeDefined()
    expect(manifest.peerDependencies?.["@opencode-ai/plugin"]).toBeDefined()
  })

  it("ships no runtime dependencies, so an install stays small", () => {
    // Both hosts provide their plugin package when loading a plugin. Installing either one
    // would pull `effect` (~42 MB) and its chain into every consumer for no runtime gain.
    expect(manifest.dependencies ?? {}).toEqual({})
  })

  it("keeps both host packages as dev dependencies for typechecking", () => {
    expect(manifest.devDependencies?.["@opencode/plugin"]).toBeDefined()
    expect(manifest.devDependencies?.["@opencode-ai/plugin"]).toBeDefined()
  })

  it("marks both host packages optional, since each host provides only one", () => {
    expect(manifest.peerDependenciesMeta?.["@opencode/plugin"]).toEqual({ optional: true })
    expect(manifest.peerDependenciesMeta?.["@opencode-ai/plugin"]).toEqual({ optional: true })
  })

  it("exports a server entry the V2 loader can find", () => {
    // The V2 loader reads ./server from a plugin directory's package.json.
    expect(manifest.exports?.["./server"]).toBeDefined()
  })

  it("defines the server plugin with Plugin.define and a stable id", () => {
    const entry = serverEntry as Dual<typeof serverEntry>
    expect(entry.id).toBe("opencode-custom-providers")
    expect(typeof entry.setup).toBe("function")
    // The V1 hook must survive alongside the V2 definition.
    expect(typeof entry.server).toBe("function")
  })

  it("defines the TUI plugin with Plugin.define and its own id", () => {
    const entry = tuiEntry as Dual<typeof tuiEntry>
    expect(entry.id).toBe("opencode-custom-providers.tui")
    expect(typeof entry.setup).toBe("function")
    expect(typeof entry.tui).toBe("function")
  })
})
