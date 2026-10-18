// Bundle-time stand-in for @opencode/plugin: bundles install where no node_modules
// exists, so the real package would break a V1 host. `define` is identity; both
// export styles are provided (root `Plugin.define`, /tui/plugin `define`).
export function define(plugin) {
  return plugin
}

export const Plugin = { define }

export default { Plugin, define }
