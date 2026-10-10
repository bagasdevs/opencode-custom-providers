// Endpoint flavors: model listing and protocol fallback limits.

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
    label: "OpenAI-compatible (most common)",
    description: "Choose this for OpenAI, OpenRouter, DeepSeek, Groq, Together, LM Studio, vLLM and most other services. If unsure, choose this one",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128_000, output: 4_096 },
  },
  "openai-responses": {
    flavor: "openai-responses",
    label: "OpenAI Responses API",
    description: "Only for services that explicitly ask for the 'Responses' API. If unsure, choose the first option",
    listPaths: ["/models"],
    listShape: "openai-list",
    fallbackLimits: { context: 128_000, output: 4_096 },
  },
  anthropic: {
    flavor: "anthropic",
    label: "Anthropic (Claude)",
    description: "Claude models; the endpoint cannot list models, so add them from the catalog",
    listPaths: [],
    listShape: "none",
    fallbackLimits: { context: 200_000, output: 32_000 },
  },
  gemini: {
    flavor: "gemini",
    label: "Google Gemini",
    description: "Google's Gemini API (get a key at aistudio.google.com)",
    listPaths: ["/v1beta/models", "/models"],
    listShape: "gemini-list",
    fallbackLimits: { context: 1_000_000, output: 64_000 },
  },
  ollama: {
    flavor: "ollama",
    label: "Ollama (on this computer)",
    description: "A local Ollama install, usually http://localhost:11434",
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

// Names opencode ships itself. Adding a custom provider under one of these would rewrite
// that provider's settings, so the wizard offers a suffixed name instead.
const BUILT_IN_IDS = new Set([
  "opencode", "openai", "anthropic", "google", "gemini", "deepseek", "xai", "grok",
  "groq", "ollama", "openrouter", "azure", "bedrock", "vertex", "mistral",
  "together", "fireworks", "cerebras", "perplexity", "cohere", "moonshot", "zhipu",
  "lmstudio", "lm-studio", "vllm", "llamacpp", "llama-cpp", "github-copilot", "copilot",
])

export function collisionSuggestion(providerId: string): string | null {
  if (BUILT_IN_IDS.has(providerId.toLowerCase())) {
    return `${providerId}-custom`
  }
  return null
}
