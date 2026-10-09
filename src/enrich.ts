import type { ModelsDevModel } from "./catalog.js"
import type { EndpointModelResponse } from "./endpoint.js"

// ── enrichment: merge endpoint data with models.dev ──

export interface EnrichedModel {
  name: string
  family?: string
  release_date?: string
  status?: string
  attachment?: boolean
  reasoning?: boolean
  reasoningLevels?: string[]
  temperature?: boolean
  tool_call?: boolean
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
}

function parseEndpointCapabilities(item: EndpointModelResponse) {
  let toolCall = false
  let reasoning = false
  let temperature = false

  if (item.capabilities) {
    if (item.capabilities.function_calling || item.capabilities.tool_choice) toolCall = true
    if (item.capabilities.reasoning) reasoning = true
    if (item.capabilities.temperature) temperature = true
  }

  if (item.supported_parameters) {
    if (item.supported_parameters.includes("tools") || item.supported_parameters.includes("tool_choice")) {
      toolCall = true
    }
    if (item.supported_parameters.includes("temperature")) {
      temperature = true
    }
  }

  return { toolCall, reasoning, temperature }
}

function endpointContextWindow(item: EndpointModelResponse): number | undefined {
  const v = item.context_window ?? item.max_model_len ?? item.context_length
  return typeof v === "number" ? v : undefined
}

function endpointMaxOutput(item: EndpointModelResponse): number | undefined {
  const v = item.max_completion_tokens ?? item.max_output_tokens
  return typeof v === "number" ? v : undefined
}

export type DisplayStyle = "name" | "slug"

export function buildEnrichedModel(
  item: EndpointModelResponse,
  id: string,
  meta: ModelsDevModel | undefined,
  displayStyle: DisplayStyle,
): EnrichedModel {
  const caps = parseEndpointCapabilities(item)

  const epContext = endpointContextWindow(item)
  const epOutput = endpointMaxOutput(item)

  const displayName = displayStyle === "slug"
    ? id
    : (item.name && item.name !== item.id ? item.name : undefined) ?? meta?.name ?? id

  const model: EnrichedModel = {
    name: displayName,
    limit: {
      context: epContext ?? meta?.limit.context ?? 128_000,
      input: meta?.limit.input,
      output: epOutput ?? meta?.limit.output ?? 4096,
    },
    modalities: meta?.modalities ?? { input: ["text"], output: ["text"] },
  }

  // Capabilities: prefer models.dev when available, fall back to endpoint-detected
  if (meta) {
    model.reasoning = caps.reasoning || meta.reasoning
    model.temperature = caps.temperature || meta.temperature
    model.tool_call = caps.toolCall || meta.tool_call
    model.attachment = meta.attachment
    model.family = meta.family
    model.release_date = meta.release_date
    model.status = meta.status
    model.cost = {
      input: meta.cost?.input ?? 0,
      output: meta.cost?.output ?? 0,
      cache_read: meta.cost?.cache_read,
      cache_write: meta.cost?.cache_write,
    }
  } else {
    // No models.dev match — use whatever the endpoint told us, with safe defaults.
    // tool_call defaults to false for unknown models to avoid sending tool calls
    // to endpoints that don't support them.
    if (caps.reasoning) model.reasoning = true
    if (caps.temperature) model.temperature = true
    if (caps.toolCall) model.tool_call = true

    if (typeof item.input_cost === "number" || typeof item.output_cost === "number") {
      model.cost = {
        input: typeof item.input_cost === "number" ? item.input_cost : 0,
        output: typeof item.output_cost === "number" ? item.output_cost : 0,
      }
    }
  }

  // Strip false/undefined booleans so OpenCode's fallback chain works cleanly
  if (!model.reasoning) delete model.reasoning
  if (!model.temperature) delete model.temperature
  if (!model.attachment) delete model.attachment
  if (model.family === undefined) delete model.family
  if (model.release_date === undefined) delete model.release_date
  if (model.status === undefined) delete model.status

  return model
}
