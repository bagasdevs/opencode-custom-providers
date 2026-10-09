import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createRequire } from "node:module"
import { normalizeModelId } from "./endpoint.js"

const require = createRequire(import.meta.url)
const { version: PKG_VERSION } = require("../package.json")

const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_TTL = 6 * 60 * 60 * 1000 // 6 hours

// Resolved per call so mocked homedir values apply in tests.
function cacheDir(): string {
  return path.join(os.homedir() || "/tmp", ".cache", "opencode-custom-providers")
}
function cacheFile(): string {
  return path.join(cacheDir(), "models-dev.json")
}


// ── models.dev types (subset matching OpenCode's schema) ──

export interface ModelsDevModel {
  id: string
  name: string
  family?: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
  limit: {
    context: number
    input?: number
    output: number
  }
  modalities?: {
    input: string[]
    output: string[]
  }
  status?: string
}

export interface ModelsDevProvider {
  id: string
  name: string
  npm?: string
  api?: string
  models: Record<string, ModelsDevModel>
}

// ── models.dev cache + lookup ──

// Module-level singleton: shared across providers per process. Cleared by
// clearModelsDevCache() so the next call rebuilds it with fresh data.
let lookupMap: Map<string, ModelsDevModel> | null = null
let lookupPromise: Promise<Map<string, ModelsDevModel>> | null = null
let catalogPromise: Promise<Record<string, ModelsDevProvider>> | null = null

interface CacheEntry {
  timestamp: number
  data: Record<string, ModelsDevProvider>
}

function readCacheEntry(): CacheEntry | null {
  try {
    const file = cacheFile()
    if (!fs.existsSync(file)) return null
    const content = fs.readFileSync(file, "utf-8")
    return JSON.parse(content) as CacheEntry
  } catch {
    return null
  }
}

function writeCache(data: Record<string, ModelsDevProvider>): void {
  try {
    const dir = cacheDir()
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { mode: 0o700, recursive: true })
    }
    fs.writeFileSync(
      cacheFile(),
      JSON.stringify({ timestamp: Date.now(), data }, null, 2),
      { mode: 0o600 },
    )
  } catch {
    // ignore write errors
  }
}

async function fetchModelsDevCatalog(): Promise<Record<string, ModelsDevProvider>> {
  const entry = readCacheEntry()
  const isFresh = entry && (Date.now() - entry.timestamp <= CACHE_TTL)
  if (isFresh && entry) return entry.data

  try {
    const res = await fetch(MODELS_DEV_URL, {
      headers: { "User-Agent": `opencode-custom-providers/${PKG_VERSION}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) {
      const data = await res.json() as Record<string, ModelsDevProvider>
      writeCache(data)
      return data
    }
  } catch {
    // Ignore fetch error, fall back to stale cache if available
  }

  if (entry) {
    return entry.data
  }

  return {}
}

function buildLookupMap(catalog: Record<string, ModelsDevProvider>): Map<string, ModelsDevModel> {
  const map = new Map<string, ModelsDevModel>()
  for (const provider of Object.values(catalog)) {
    if (!provider.models) continue
    for (const model of Object.values(provider.models)) {
      const key = normalizeModelId(model.id)
      if (!map.has(key)) {
        map.set(key, model)
      }
    }
  }
  return map
}

export async function getLookupMap(): Promise<Map<string, ModelsDevModel>> {
  if (lookupMap) return lookupMap
  if (!lookupPromise) {
    lookupPromise = fetchModelsDevCatalog().then(catalog => {
      lookupMap = buildLookupMap(catalog)
      return lookupMap
    })
  }
  return lookupPromise
}

export function clearModelsDevCache(): void {
  lookupMap = null
  lookupPromise = null
  catalogPromise = null
  try {
    const file = cacheFile()
    if (!fs.existsSync(file)) return
    const mtimeMs = fs.statSync(file).mtimeMs
    if (Date.now() - mtimeMs > CACHE_TTL) fs.unlinkSync(file)
  } catch {
    // ignore
  }
}

// ── catalog picking (add-from-catalog flow) ──

export interface CatalogSite {
  id: string
  name: string
  api?: string
  modelCount: number
}

/** Raw catalog access for flows that need more than the lookup map. */
export async function getCatalog(): Promise<Record<string, ModelsDevProvider>> {
  if (!catalogPromise) {
    catalogPromise = fetchModelsDevCatalog()
  }
  return catalogPromise
}

/** Pure summary of a catalog for pickers. Exported for tests. */
export function summarizeCatalog(
  catalog: Record<string, ModelsDevProvider>,
): CatalogSite[] {
  return Object.values(catalog)
    .filter(p => p && typeof p.id === "string" && p.models && Object.keys(p.models).length > 0)
    .map(p => ({
      id: p.id,
      name: p.name || p.id,
      api: p.api,
      modelCount: Object.keys(p.models).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function listCatalogSites(): Promise<CatalogSite[]> {
  return summarizeCatalog(await getCatalog())
}
