import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { normalizeModelId } from "./endpoint.js"

// Built-in known-model table. Ids are normalized before matching so relay
// decorations ("gpt-5@20250807") still hit.

export interface RuleMeta {
  context: number
  output: number
  reasoning: boolean
  image: boolean
}

export interface MatchedRule {
  meta: RuleMeta
  pattern: string
}

const EXACT: Record<string, RuleMeta> = {
  "gpt-4o": { context: 128_000, output: 16_384, reasoning: false, image: true },
  "gpt-4o-mini": { context: 128_000, output: 16_384, reasoning: false, image: true },
  "gpt-4.1": { context: 1_000_000, output: 32_768, reasoning: false, image: true },
  "gpt-4.1-mini": { context: 1_000_000, output: 32_768, reasoning: false, image: true },
  "gpt-5": { context: 400_000, output: 128_000, reasoning: true, image: true },
  "gpt-5-mini": { context: 400_000, output: 128_000, reasoning: true, image: true },
  "o1": { context: 200_000, output: 100_000, reasoning: true, image: true },
  "o3": { context: 200_000, output: 100_000, reasoning: true, image: true },
  "o4-mini": { context: 200_000, output: 100_000, reasoning: true, image: true },
  "claude-sonnet-4-6": { context: 1_000_000, output: 128_000, reasoning: true, image: true },
  "claude-opus-4-6": { context: 1_000_000, output: 128_000, reasoning: true, image: true },
  "claude-haiku-4-5": { context: 200_000, output: 64_000, reasoning: true, image: true },
  "deepseek-chat": { context: 128_000, output: 8_192, reasoning: false, image: false },
  "deepseek-reasoner": { context: 128_000, output: 32_768, reasoning: true, image: false },
  "deepseek-r1": { context: 128_000, output: 32_768, reasoning: true, image: false },
  "deepseek-v3": { context: 128_000, output: 8_192, reasoning: false, image: false },
  "deepseek-v4-pro": { context: 256_000, output: 32_768, reasoning: false, image: false },
  "qwen-max": { context: 256_000, output: 8_192, reasoning: false, image: false },
  "qwen-plus": { context: 256_000, output: 8_192, reasoning: false, image: false },
  "qwen-turbo": { context: 1_000_000, output: 8_192, reasoning: false, image: false },
  "qwq-32b": { context: 128_000, output: 32_768, reasoning: true, image: false },
  "kimi-k2": { context: 256_000, output: 16_384, reasoning: false, image: false },
  "kimi-k2-thinking": { context: 256_000, output: 32_768, reasoning: true, image: false },
  "moonshot-v1-128k": { context: 128_000, output: 4_096, reasoning: false, image: false },
  "glm-4.6": { context: 200_000, output: 32_768, reasoning: true, image: true },
  "glm-4.5": { context: 128_000, output: 16_384, reasoning: true, image: false },
  "gemini-2.5-pro": { context: 1_000_000, output: 65_536, reasoning: true, image: true },
  "gemini-2.5-flash": { context: 1_000_000, output: 65_536, reasoning: true, image: true },
  "gemini-3.1-pro": { context: 1_000_000, output: 64_000, reasoning: true, image: true },
  "grok-4": { context: 256_000, output: 16_384, reasoning: true, image: true },
  "grok-3": { context: 131_072, output: 16_384, reasoning: false, image: false },
}

const PREFIX: Array<[string, RuleMeta]> = [
  ["gpt-5", { context: 400_000, output: 128_000, reasoning: true, image: true }],
  ["gpt-4", { context: 128_000, output: 16_384, reasoning: false, image: true }],
  ["o1", { context: 200_000, output: 100_000, reasoning: true, image: true }],
  ["o3", { context: 200_000, output: 100_000, reasoning: true, image: true }],
  ["claude-opus", { context: 1_000_000, output: 128_000, reasoning: true, image: true }],
  ["claude-sonnet", { context: 500_000, output: 64_000, reasoning: true, image: true }],
  ["claude-haiku", { context: 200_000, output: 64_000, reasoning: true, image: true }],
  ["claude", { context: 200_000, output: 32_000, reasoning: false, image: true }],
  ["deepseek-r", { context: 128_000, output: 32_768, reasoning: true, image: false }],
  ["deepseek", { context: 128_000, output: 8_192, reasoning: false, image: false }],
  ["qwen", { context: 128_000, output: 8_192, reasoning: false, image: false }],
  ["qwq", { context: 128_000, output: 32_768, reasoning: true, image: false }],
  ["kimi", { context: 256_000, output: 16_384, reasoning: false, image: false }],
  ["moonshot", { context: 128_000, output: 4_096, reasoning: false, image: false }],
  ["glm", { context: 128_000, output: 16_384, reasoning: true, image: false }],
  ["gemini", { context: 1_000_000, output: 64_000, reasoning: true, image: true }],
  ["grok", { context: 131_072, output: 16_384, reasoning: false, image: false }],
  ["llama", { context: 128_000, output: 8_192, reasoning: false, image: false }],
  ["mistral", { context: 128_000, output: 8_192, reasoning: false, image: false }],
  ["mixtral", { context: 64_000, output: 8_192, reasoning: false, image: false }],
]

export function matchLocalRule(id: string): MatchedRule | null {
  // Strip relay decorations (org prefixes, @versions, [1m] tags) via normalize.
  const key = normalizeModelId(id).split("@")[0].replace(/\[.*\]$/, "")
  const exact = EXACT[key]
  if (exact) return { meta: exact, pattern: key }
  // Longest-prefix wins.
  let best: MatchedRule | null = null
  for (const [prefix, meta] of PREFIX) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.pattern.length)) {
      best = { meta, pattern: prefix }
    }
  }
  return best
}

// Custom rules: ~/.opencode-custom-providers-rules.json
// { "exact": { "<id>": { context, output, reasoning, image } } }
function isValidRule(v: unknown): v is RuleMeta {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.context === "number" && Number.isFinite(r.context) && r.context > 0 &&
    typeof r.output === "number" && Number.isFinite(r.output) && r.output > 0 &&
    typeof r.reasoning === "boolean" && typeof r.image === "boolean"
  )
}

// Per-process memo guarded by file mtime (one cheap stat per call).
let rulesCache: { file: string; mtimeMs: number; rules: Record<string, RuleMeta> } | null = null

export function loadCustomRules(): Record<string, RuleMeta> {
  const file = path.join(os.homedir(), ".opencode-custom-providers-rules.json")
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    mtimeMs = -1
  }
  if (rulesCache && rulesCache.file === file && rulesCache.mtimeMs === mtimeMs) {
    return rulesCache.rules
  }
  if (mtimeMs === -1) {
    const empty: Record<string, RuleMeta> = {}
    rulesCache = { file, mtimeMs, rules: empty }
    return empty
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      exact?: Record<string, unknown>
    }
    const exact = raw?.exact
    if (typeof exact !== "object" || exact === null) {
      const empty: Record<string, RuleMeta> = {}
      rulesCache = { file, mtimeMs, rules: empty }
      return empty
    }
    const valid: Record<string, RuleMeta> = {}
    for (const [id, rule] of Object.entries(exact)) {
      if (isValidRule(rule)) valid[id] = rule
    }
    rulesCache = { file, mtimeMs, rules: valid }
    return valid
  } catch {
    const empty: Record<string, RuleMeta> = {}
    rulesCache = { file, mtimeMs, rules: empty }
    return empty
  }
}
