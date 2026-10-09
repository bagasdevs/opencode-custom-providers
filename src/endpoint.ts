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

// ── endpoint model response types ──

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

// ── endpoint discovery ──

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
