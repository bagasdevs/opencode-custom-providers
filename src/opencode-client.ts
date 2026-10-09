import type { PluginInput } from "@opencode-ai/plugin"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Config as SdkV1Config } from "@opencode-ai/sdk"
import type { Config as SdkV2Config } from "@opencode-ai/sdk/v2"
import type { ProviderConfig } from "./types.js"

// Static per-entrypoint bridges for the opencode v1 (server) vs v2 (TUI)
// client split. The host guarantees the shape per entrypoint, so callers pick
// a bridge by typed import — never by runtime probing. Each bridge owns one
// cast to the real SDK Config type, so SDK renames fail at compile time.
//
// The cast exists because local ProviderConfig is a superset of the SDK's
// (`dynamic`, `displayStyle`, `flavor`, `compat`, index signature).

export interface ClientBridge {
  setApiKey(id: string, key: string): Promise<void>
  /** Optional: v1 server Auth is MCP-OAuth-only and has no provider-key remove. */
  removeApiKey?(id: string): Promise<void>
  updateProviders(providers: Record<string, ProviderConfig>): Promise<void>
  getProviders(): Promise<Record<string, ProviderConfig>>
}

export type ServerClient = PluginInput["client"]
export type TuiClient = TuiPluginApi["client"]

export function createServerBridge(client: ServerClient): ClientBridge {
  return {
    async setApiKey(id, key) {
      await client.auth.set({ path: { id }, body: { type: "api", key } })
    },
    async updateProviders(providers) {
      const body = { provider: providers } as unknown as SdkV1Config
      await client.config.update({ body })
    },
    async getProviders() {
      const { data: config } = await client.config.get()
      return (config?.provider as Record<string, ProviderConfig>) ?? {}
    },
  }
}

export function createTuiBridge(apiClient: TuiClient): ClientBridge {
  return {
    async setApiKey(id, key) {
      await apiClient.auth.set({ providerID: id, auth: { type: "api", key } })
    },
    async removeApiKey(id) {
      await apiClient.auth.remove({ providerID: id })
    },
    async updateProviders(providers) {
      const body = { provider: providers } as unknown as SdkV2Config
      await apiClient.config.update({ config: body })
    },
    async getProviders() {
      const { data: config } = await apiClient.config.get()
      return (config?.provider as Record<string, ProviderConfig>) ?? {}
    },
  }
}
