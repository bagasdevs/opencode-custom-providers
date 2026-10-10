// EnrichedModel is the stored model shape shared by every write path.
// The resolver that produces it is resolveModel (src/probe.ts), which leaves
// exactly one resolver, so there is no second, unclamped copy here.


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
  // A limit that was never measured is absent, not a placeholder number.
  limit: {
    context?: number
    input?: number
    output?: number
  }
  modalities?: {
    input: string[]
    output: string[]
  }
}

export type DisplayStyle = "name" | "slug"
