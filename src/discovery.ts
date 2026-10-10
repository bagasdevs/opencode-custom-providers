import { sanitizeModelId } from "./security.js"
import { probeEndpoint, probedToEnriched } from "./probe.js"
import { DEFAULT_FLAVOR, type ProviderFlavor } from "./flavors.js"
import type { DisplayStyle, EnrichedModel } from "./enrich.js"

export { normalizeModelId, fetchEndpointModels } from "./endpoint.js"
export { clearModelsDevCache } from "./catalog.js"
// M3: buildEnrichedModel was the second, unclamped resolver. resolveModel
// (src/probe.ts) is now the only one, so the clamp cannot be bypassed.
export type { DisplayStyle, EnrichedModel } from "./enrich.js"

/** Throws on invalid URLs or unreachable endpoints. */
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
