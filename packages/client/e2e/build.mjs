// Bundles the e2e page for Chrome. It imports the built package, so run `npm run build` first.
import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { clientRuntime, common } from "../esbuild-runtime.mjs"

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

const page = await build({
  ...common,
  entryPoints: [here("./page.js")],
  outfile: here("./out/page.js"),
  platform: "browser",
  target: "chrome120",
  plugins: [clientRuntime()],
})
const bytes = Object.values(page.metafile.outputs).reduce((sum, out) => sum + (out.entryPoint ? out.bytes : 0), 0)
console.log(`e2e/out/page.js: ${Math.round(bytes / 1000)} kB`)

await build({
  ...common,
  entryPoints: [here("./control-page.js")],
  outfile: here("./out/control-page.js"),
  platform: "browser",
  target: "chrome120",
  plugins: [clientRuntime()],
})

// the same checks for the harness, which runs them against the native build
await build({
  ...common,
  entryPoints: [here("../test/crypto-checks.ts")],
  outfile: here("./out/crypto-checks.mjs"),
  platform: "node",
  target: "node22",
  plugins: [clientRuntime({ allowNode: true })],
})
