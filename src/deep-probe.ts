import type { EndpointModelResponse } from "./endpoint.js"
import type { ProviderFlavor } from "./flavors.js"

// Deep detection sources, best-effort: failures fall through to the next tier.

export interface DetailPatch {
  context_length?: number
  max_output_tokens?: number
  input_cost?: number
  output_cost?: number
  effort_options?: string[]
  vision?: boolean
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) {
    const err: Error & { status?: number; body?: string } = new Error(`HTTP ${res.status}` as string)
    err.status = res.status
    try {
      err.body = await res.text()
    } catch {
      err.body = ""
    }
    throw err
  }
  return res.json() as Promise<unknown>
}

function authHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
  return headers
}

/** OpenAI Retrieve Model: GET <modelsUrl>/<id>. */
export async function fetchModelDetail(
  modelsUrl: string,
  id: string,
  apiKey?: string,
): Promise<DetailPatch> {
  const raw = (await getJson(
    `${modelsUrl.replace(/\/+$/, "")}/${encodeURIComponent(id)}`,
    authHeaders(apiKey),
    8_000,
  )) as Record<string, unknown>
  return patchFromRecord(raw)
}

/** Normalize a model-detail-shaped record into a patch. Exported for tests. */
export function patchFromRecord(raw: Record<string, unknown>): DetailPatch {
  const patch: DetailPatch = {}
  const rec = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined
  const firstNum = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = num(raw[k])
      if (v !== undefined) return v
    }
    return undefined
  }

  const ctx = firstNum(["context_window", "max_model_len", "context_length", "inputTokenLimit"])
  if (ctx !== undefined) patch.context_length = ctx
  const out = firstNum(["max_output_tokens", "max_completion_tokens", "outputTokenLimit"])
  if (out !== undefined) patch.max_output_tokens = out

  const cost = num(raw["input_cost"]) !== undefined || num(raw["output_cost"]) !== undefined
    ? { input: num(raw["input_cost"]) ?? 0, output: num(raw["output_cost"]) ?? 0 }
    : undefined
  if (cost) {
    patch.input_cost = cost.input
    patch.output_cost = cost.output
  }
  const pricing = rec(raw["pricing"])
  if (pricing) {
    const per = (v: unknown): number | undefined => {
      const n = typeof v === "string" ? Number(v) : num(v) !== undefined ? (v as number) : undefined
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n * 1_000_000 : undefined
    }
    const pi = per(pricing["prompt"])
    const po = per(pricing["completion"])
    if (pi !== undefined || po !== undefined) {
      patch.input_cost = pi ?? 0
      patch.output_cost = po ?? 0
    }
  }

  const caps = rec(raw["capabilities"])
  if (caps) {
    if (caps["vision"] === true) patch.vision = true
    const reasoning = rec(caps["reasoning"])
    const opts = reasoning?.["effort_options"]
    if (Array.isArray(opts)) {
      const levels = opts.filter((e): e is string => typeof e === "string" && e.length > 0)
      if (levels.length > 0) patch.effort_options = levels
    }
  }
  return patch
}

/** LiteLLM: GET <origin>/model/info?model=<id> (per-token prices → per-1M). */
export async function fetchLitellmInfo(
  origin: string,
  id: string,
  apiKey?: string,
): Promise<DetailPatch> {
  const raw = (await getJson(
    `${origin}/model/info?model=${encodeURIComponent(id)}`,
    authHeaders(apiKey),
    8_000,
  )) as Record<string, unknown>
  const data = (typeof raw["data"] === "object" && raw["data"] !== null
    ? (raw["data"] as Record<string, unknown>)
    : raw)
  const patch: DetailPatch = {}
  const perToken = (v: unknown): number | undefined => {
    const n = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
    return n === undefined ? undefined : n * 1_000_000
  }
  const pi = perToken(data["input_cost_per_token"])
  const po = perToken(data["output_cost_per_token"] ?? data["output_cost"])
  if (pi !== undefined || po !== undefined) {
    patch.input_cost = pi ?? 0
    patch.output_cost = po ?? 0
  }
  const ctx = num(data["max_input_tokens"])
  if (ctx !== undefined) patch.context_length = ctx
  const out = num(data["max_output_tokens"])
  if (out !== undefined) patch.max_output_tokens = out
  if (Object.keys(patch).length === 0) throw new Error("Empty LiteLLM info")
  return patch
}

/** New API-style public catalog: GET <origin>/api/models/public (no auth). */
export async function fetchPublicCatalog(origin: string): Promise<Map<string, DetailPatch>> {
  const raw = await getJson(`${origin}/api/models/public`, authHeaders(), 8_000)
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)["data"])
      ? ((raw as Record<string, unknown>)["data"] as unknown[])
      : []
  const map = new Map<string, DetailPatch>()
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue
    const rec = entry as Record<string, unknown>
    if (typeof rec["id"] !== "string") continue
    try {
      map.set(rec["id"] as string, patchFromRecord(rec))
    } catch {
    }
  }
  return map
}

/** Ollama native: POST <base>/api/show {name} → capabilities. */
export async function fetchOllamaShow(base: string, name: string): Promise<DetailPatch> {
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const raw = (await res.json()) as Record<string, unknown>
  const patch: DetailPatch = {}
  const caps = raw["capabilities"]
  if (Array.isArray(caps) && caps.includes("vision")) patch.vision = true
  if (Object.keys(patch).length === 0) throw new Error("Empty Ollama show")
  return patch
}

export function applyPatch(
  item: EndpointModelResponse,
  patch: DetailPatch,
): EndpointModelResponse {
  const merged: EndpointModelResponse = {
    ...item,
    capabilities: { ...item.capabilities },
  }
  if (patch.context_length !== undefined && merged.context_length === undefined) {
    merged.context_length = patch.context_length
  }
  if (patch.max_output_tokens !== undefined && merged.max_output_tokens === undefined) {
    merged.max_output_tokens = patch.max_output_tokens
  }
  if (patch.input_cost !== undefined || patch.output_cost !== undefined) {
    merged.input_cost = patch.input_cost ?? merged.input_cost
    merged.output_cost = patch.output_cost ?? merged.output_cost
  }
  if (patch.vision === true && merged.capabilities) {
    merged.capabilities.vision = true
  }
  if (patch.effort_options && merged.capabilities) {
    const existing = merged.capabilities.reasoning
    if (existing === undefined || existing === false) {
      merged.capabilities.reasoning = { effort_options: patch.effort_options } as unknown as boolean
    }
  }
  return merged
}

export interface DeepenContext {
  /** The /models URL that answered the list probe. */
  modelsUrl: string
  origin: string
  apiKey?: string
  flavor: ProviderFlavor
}

function needsDeep(item: EndpointModelResponse): boolean {
  const hasCtx = (item.context_window ?? item.max_model_len ?? item.context_length) !== undefined
  const hasOut = (item.max_completion_tokens ?? item.max_output_tokens) !== undefined
  const hasCost = item.input_cost !== undefined || item.output_cost !== undefined
  return !hasCtx || !hasOut || !hasCost
}

/** Never throws: returns the item unchanged on failure. */
export async function deepenItem(
  item: EndpointModelResponse,
  ctx: DeepenContext,
  publicCatalog?: Map<string, DetailPatch>,
): Promise<EndpointModelResponse> {
  let merged = item
  try {
    const inline = patchFromRecord(item as unknown as Record<string, unknown>)
    if (inline.input_cost !== undefined || inline.output_cost !== undefined) {
      merged = applyPatch(merged, inline)
    }
  } catch {
  }
  if (!needsDeep(merged)) return merged

  const pub = publicCatalog?.get(item.id)
  if (pub && (pub.input_cost !== undefined || pub.output_cost !== undefined || pub.context_length !== undefined)) {
    merged = applyPatch(merged, pub)
    if (!needsDeep(merged)) return merged
  }

  if (ctx.flavor === "openai-chat" || ctx.flavor === "openai-responses") {
    try {
      merged = applyPatch(merged, await fetchModelDetail(ctx.modelsUrl, item.id, ctx.apiKey))
      if (!needsDeep(merged)) return merged
    } catch {
    }
    try {
      merged = applyPatch(merged, await fetchLitellmInfo(ctx.origin, item.id, ctx.apiKey))
    } catch {
    }
    return merged
  }

  if (ctx.flavor === "ollama") {
    try {
      merged = applyPatch(merged, await fetchOllamaShow(ctx.origin, item.id))
    } catch {
    }
  }
  return merged
}

/** Runs fn over items with at most `size` in flight, order-preserving. */
export async function mapPool<T, R>(
  items: T[],
  size: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  if (items.length === 0) return out
  const limit = Math.max(1, Math.floor(size) || 1)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return out
}

export async function deepenEndpointItems(
  items: EndpointModelResponse[],
  ctx: DeepenContext,
): Promise<EndpointModelResponse[]> {
  if (items.length === 0) return items
  if (!items.some(needsDeep)) return items
  let pub: Map<string, DetailPatch> | undefined
  try {
    pub = await fetchPublicCatalog(ctx.origin)
    if (pub.size === 0) pub = undefined
  } catch {
    pub = undefined
  }
  return mapPool(items, 8, async item => {
    try {
      return await deepenItem(item, ctx, pub)
    } catch {
      return item
    }
  })
}

/** POST a 1-token chat with role "developer": false = rejected, undefined = inconclusive. */
export async function probeDeveloperRole(
  baseURL: string,
  apiKey?: string,
): Promise<boolean | undefined> {
  if (!apiKey) return undefined
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return undefined
  }
  const clean = url.pathname.replace(/\/+$/, "")
  const target = clean.endsWith("/chat/completions")
    ? url.toString()
    : new URL(`${clean}/chat/completions`, url.origin).toString()
  let res: Response
  try {
    res = await fetch(target, {
      method: "POST",
      headers: { ...authHeaders(apiKey) },
      body: JSON.stringify({ model: "probe", messages: [{ role: "developer", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return undefined
  }
  if (res.status === 401 || res.status === 403) return undefined
  if (res.status === 400) {
    try {
      const body = await res.text()
      if (/developer/i.test(body)) return false
    } catch {
      return undefined
    }
  }
  return undefined
}

