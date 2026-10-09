// Endpoint flavors: how to list models + protocol-level fallback limits.
// Tier-4 ("API fallback") numbers follow better-custom conventions.

export type ProviderFlavor =
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "ollama"

export type ListShape = "openai-list" | "ollama-tags" | "gemini-list" | "none"

export interface FlavorSpec {
  flavor: ProviderFlavor
  label: string
  description: string
  /** Ordered candidate paths (appended when the base lacks them). */
  listPaths: string[]
  listShape: ListShape
  /** Protocol-level fallback limits used when nothing else knows the model. */
  fallbackLimits: { context: number; output: number }
}

export const FLAVORS: Record<ProviderFlavor, FlavorSpec> = {
  "openai-chat": {
    flavor: "openai-chat",
    label: "OpenAI Chat Completions",
    description: "OpenAI-compatible /models endpoint (default)",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128_000, output: 4_096 },
  },
  "openai-responses": {
    flavor: "openai-responses",
    label: "OpenAI Responses",
    description: "Responses-style gateways with an OpenAI /models list",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128_000, output: 4_096 },
  },
  anthropic: {
    flavor: "anthropic",
    label: "Anthropic Messages",
    description: "No list API — add from catalog or by hand",
    listPaths: [],
    listShape: "none",
    fallbackLimits: { context: 200_000, output: 32_000 },
  },
  gemini: {
    flavor: "gemini",
    label: "Gemini",
    description: "Google Generative Language list API",
    listPaths: ["/v1beta/models", "/models"],
    listShape: "gemini-list",
    fallbackLimits: { context: 1_000_000, output: 64_000 },
  },
  ollama: {
    flavor: "ollama",
    label: "Ollama",
    description: "Local Ollama daemon (/api/tags)",
    listPaths: ["/api/tags", "/models"],
    listShape: "ollama-tags",
    fallbackLimits: { context: 128_000, output: 4_096 },
  },
}

export const DEFAULT_FLAVOR: ProviderFlavor = "openai-chat"

export function parseFlavor(value: string | undefined): ProviderFlavor | null {
  if (!value) return null
  const v = value.trim().toLowerCase().replaceAll("_", "-")
  const found = (Object.keys(FLAVORS) as ProviderFlavor[]).find(f => f === v)
  return found ?? null
}

const BUILT_IN_IDS = new Set([
  "openai", "anthropic", "google", "gemini", "deepseek", "xai",
  "groq", "ollama", "openrouter", "azure", "bedrock", "vertex",
])

/** Suggest `<id>-custom` when a provider id collides with a well-known built-in. */
export function collisionSuggestion(providerId: string): string | null {
  if (BUILT_IN_IDS.has(providerId.toLowerCase())) {
    return `${providerId}-custom`
  }
  return null
}
