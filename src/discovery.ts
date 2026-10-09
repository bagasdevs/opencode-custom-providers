import { sanitizeModelId } from "./security.js"
import { probeEndpoint, probedToEnriched } from "./probe.js"
import { DEFAULT_FLAVOR, type ProviderFlavor } from "./flavors.js"
import type { DisplayStyle, EnrichedModel } from "./enrich.js"

// Barrel: preserve the historical "./discovery.js" import surface so existing
// importers (commands.ts, server.ts, tui.ts, types.ts, tests) keep working.
export { normalizeModelId, fetchEndpointModels } from "./endpoint.js"
export { clearModelsDevCache } from "./catalog.js"
export { buildEnrichedModel } from "./enrich.js"
export type { DisplayStyle, EnrichedModel } from "./enrich.js"

/**
 * Discover models through the tiered probe pipeline (models.dev > local rules >
 * API fallback > defaults) for the given endpoint flavor. Throws on invalid
 * URLs / unreachable endpoints — every caller wraps this in a try/catch.
 */
export async function discoverAndEnrich(
  baseURL: string,
  apiKey?: string,
  displayStyle: DisplayStyle = "slug",
  flavor: ProviderFlavor = DEFAULT_FLAVOR,
): Promise<Record<string, EnrichedModel>> {
  const probed = await probeEndpoint(baseURL, apiKey, flavor)
  const result: Record<string, EnrichedModel> = {}

  for (const p of probed) {
    const id = sanitizeModelId(p.id)
    result[id] = probedToEnriched(p, displayStyle)
  }

  return result
}
