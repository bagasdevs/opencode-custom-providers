// Bundle-time stand-in for @opencode/plugin.
//
// Bundles install to a plugins directory with no node_modules, so importing the real package
// would break a V1 host. The only runtime use is `define`, which is identity in the original.
// Both export styles are provided: the root entry exposes `Plugin.define`, the /tui/plugin
// subpath exposes `define` directly.
export function define(plugin) {
  return plugin
}

export const Plugin = { define }

export default { Plugin, define }
