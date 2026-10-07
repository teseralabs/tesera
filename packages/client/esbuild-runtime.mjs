// The client runtime for esbuild: tesera's own protocol modules under ../../src are compiled in from
// source, so there is one implementation of the protocol. Two core files are swapped for the client:
// crypto/primitives (node:crypto) and carrier/udp (node:dgram). Anything else reaching node: fails.
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const core = resolve(here("../../src"))

const swaps = {
  [resolve(core, "crypto/primitives.js")]: here("./src/runtime/primitives.ts"),
  [resolve(core, "carrier/udp.js")]: here("./src/runtime/udp.ts"),
}

/** `allowNode` lets tests use Node built-ins. The package and the browser page never may. */
export function clientRuntime({ allowNode = false } = {}) {
  return {
    name: "tesera-client-runtime",
    setup(b) {
      b.onResolve({ filter: /(primitives|udp)\.js$/ }, (args) => {
        const swap = swaps[resolve(args.resolveDir, args.path)]
        return swap ? { path: swap } : undefined
      })
      b.onResolve({ filter: /^node:/ }, (args) => {
        if (allowNode && !args.importer.includes("/src/")) return { path: args.path, external: true }
        throw new Error(`${args.importer} imports ${args.path}, which @tesera/client must not reach`)
      })
    },
  }
}

export const common = {
  bundle: true,
  format: "esm",
  inject: [here("./src/runtime/buffer.ts")],
  sourcemap: true,
  logLevel: "warning",
  metafile: true,
}
