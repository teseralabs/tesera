// Bundles @tesera/client and its tests. See esbuild-runtime.mjs for how tesera core is compiled in.
import { build } from "esbuild"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { clientRuntime, common } from "./esbuild-runtime.mjs"

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

const lib = await build({
  ...common,
  entryPoints: [here("./src/index.ts")],
  outfile: here("./dist/index.js"),
  platform: "neutral",
  target: "es2022",
  external: ["@noble/ciphers", "@noble/ciphers/*", "@noble/hashes", "@noble/hashes/*", "buffer"],
  plugins: [clientRuntime()],
})

const tests = readdirSync(here("./test")).filter((name) => name.endsWith(".test.ts"))
await build({
  ...common,
  entryPoints: tests.map((name) => here(`./test/${name}`)),
  outdir: here("./dist/test"),
  platform: "node",
  target: "node20",
  external: ["@fails-components/*"],
  plugins: [clientRuntime({ allowNode: true })],
})

const inputs = Object.keys(lib.metafile.inputs)
const coreModules = inputs.filter((path) => path.startsWith("../../src/")).sort()
const bytes = Object.values(lib.metafile.outputs).reduce((sum, out) => sum + (out.entryPoint ? out.bytes : 0), 0)
console.log(`dist/index.js: ${Math.round(bytes / 1000)} kB from ${inputs.length} modules, ${coreModules.length} of them tesera core:`)
for (const path of coreModules) console.log(`  ${path.slice("../../".length)}`)
