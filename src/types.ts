import { isValidUrl } from "./security.js"

import type { DisplayStyle } from "./discovery.js"
import type { ProviderFlavor } from "./flavors.js"

export interface ProviderConfig {
  name?: string
  npm?: string
  api?: string
  dynamic?: boolean
  displayStyle?: DisplayStyle
  flavor?: ProviderFlavor
  compat?: {
    supportsDeveloperRole?: boolean
  }
  options?: {
    baseURL?: string
    apiKey?: string
    [key: string]: unknown
  }
  models?: Record<string, unknown>
  [key: string]: unknown
}

// Non-goals, kept out on purpose. Per-model HTTP headers and per-model
// baseURL overrides, $ENV / !command auth serialization, models.yml runtime
// selection and video-input display are all deliberately absent from this
// shape. Reading them here is a scope error, not a missing feature.

export interface OpenCodeConfig {
  provider?: Record<string, ProviderConfig>
  [key: string]: unknown
}

export function getApiKey(provider: ProviderConfig, providerId: string): string | undefined {
  if (provider.options?.apiKey) return provider.options.apiKey
  const envKey = `OPENCODE_LOCAL_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}_API_KEY`
  return process.env[envKey]
}

export function shouldDiscover(provider: ProviderConfig): boolean {
  const baseURL = provider.options?.baseURL
  if (!baseURL || !isValidUrl(baseURL)) return false
  if (provider.dynamic === true) return true
  const models = provider.models
  return !models || Object.keys(models).length === 0
}
