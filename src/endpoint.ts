import { isValidUrl, sanitizeErrorMessage } from "./security.js"

export function normalizeModelId(id: string): string {
  let normalized = id.toLowerCase()
  if (normalized.startsWith("models/")) {
    normalized = normalized.slice(7)
  }
  const slashIndex = normalized.lastIndexOf("/")
  if (slashIndex !== -1) {
    normalized = normalized.slice(slashIndex + 1)
  }
  return normalized.replaceAll(":", "-")
}

// Repair the two common near-miss inputs (a bare host and a copy-pasted
// full endpoint path) instead of rejecting them.
const ENDPOINT_PATH_SUFFIXES = ["/chat/completions", "/messages", "/responses", "/models"]

function schemelessHostIsLocal(raw: string): boolean {
  const host = raw.split(/[/?#]/, 1)[0]
  if (host.startsWith("[")) return true
  if (/^::1($|:)/.test(host)) return true
  const name = host.split(":", 1)[0]
  if (/^localhost$/i.test(name) || /\.local$/i.test(name)) return true
  if (name === "0.0.0.0") return true
  const octets = /^(\d{1,3})(?:\.(\d{1,3}))?(?:\.\d{1,3}){0,2}$/.exec(name)
  if (!octets) return false
  const first = Number(octets[1])
  const second = octets[2] === undefined ? undefined : Number(octets[2])
  return (
    first === 127 ||
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31)
  )
}

/** A schemeless input is only worth repairing when it plausibly names a host: either a
 * local one, or a name with a dot. Without this, a nonsense string such as "notaurl"
 * would be turned into "https://notaurl" and then pass validation. */
function schemelessHostIsPlausible(raw: string): boolean {
  if (schemelessHostIsLocal(raw)) return true
  const host = raw.split(/[/?#]/, 1)[0]
  const name = host.split(":", 1)[0]
  return /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(name)
}

/** Infer the scheme for a bare host, strip a trailing "/" and a pasted
 * endpoint path, and leave an already-valid base URL untouched. */
export function normalizeBaseUrl(raw: string): string {
  let candidate = raw.trim()
  if (candidate === "") return candidate
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // Leave an implausible input alone so validation can reject it, rather than
    // inventing a scheme for something that is not a host at all.
    if (!schemelessHostIsPlausible(candidate)) return candidate
    candidate = `${schemelessHostIsLocal(candidate) ? "http" : "https"}://${candidate}`
  }
  candidate = candidate.replace(/\/+$/, "")
  const schemeEnd = candidate.indexOf("://")
  if (candidate.indexOf("/", schemeEnd + 3) === -1) return candidate
  let changed = true
  while (changed) {
    changed = false
    const lower = candidate.toLowerCase()
    for (const suffix of ENDPOINT_PATH_SUFFIXES) {
      if (lower.endsWith(suffix)) {
        candidate = candidate.slice(0, candidate.length - suffix.length).replace(/\/+$/, "")
        changed = true
        break
      }
    }
  }
  return candidate
}


export interface EndpointModelResponse {
  id: string
  name?: string
  context_length?: number
  max_completion_tokens?: number
  max_output_tokens?: number
  max_model_len?: number
  context_window?: number
  input_cost?: number
  output_cost?: number
  capabilities?: {
    tool_choice?: boolean
    function_calling?: boolean
    reasoning?: boolean
    vision?: boolean
    temperature?: boolean
    structured_output?: boolean
  }
  supported_parameters?: string[]
}


export async function fetchEndpointModels(
  baseURL: string,
  apiKey?: string,
): Promise<EndpointModelResponse[]> {
  if (!isValidUrl(baseURL)) return []

  const url = new URL(baseURL)
  const cleanPath = url.pathname.replace(/\/+$/, "")
  const modelsPath = cleanPath.endsWith("/models")
    ? cleanPath
    : `${cleanPath}/models`
  const modelsUrl = new URL(modelsPath, url.origin)
  modelsUrl.search = url.search

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  const res = await fetch(modelsUrl.toString(), {
    headers,
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.text()
      if (body) detail = sanitizeErrorMessage(body.slice(0, 500))
    } catch { /* ignore read errors */ }
    throw new Error(`HTTP ${res.status}: ${detail}`)
  }

  const rawData = await res.json()
  const data = Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData?.data)
      ? rawData.data
      : null

  if (!data) {
    throw new Error("Unexpected response format from /v1/models")
  }

  return data.filter((item: Record<string, unknown>) => typeof item?.id === "string")
}
