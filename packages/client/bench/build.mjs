// Builds and runs the per-block microbenchmark three ways:
//
//   native   tesera core with node:crypto, in Node
//   client   the client runtime (@noble, Buffer polyfill), in Node
//   chrome   the client runtime in headless Chrome
//
//   node bench/build.mjs [--chrome PATH]
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { launch } from "../e2e/cdp.mjs"
import { clientRuntime, common } from "../esbuild-runtime.mjs"

const { values: args } = parseArgs({
  options: { chrome: { type: "string", default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
})
const here = (path) => fileURLToPath(new URL(path, import.meta.url))
mkdirSync(here("./out"), { recursive: true })
const entry = here("./micro.ts")
const base = { bundle: true, format: "esm", logLevel: "warning", entryPoints: [entry], target: "es2022" }
await build({ ...base, outfile: here("./out/micro-native.mjs"), platform: "node" })
await build({ ...common, ...base, sourcemap: false, metafile: false, outfile: here("./out/micro-client.mjs"), platform: "node", plugins: [clientRuntime()] })
await build({ ...common, ...base, sourcemap: false, metafile: false, outfile: here("./out/micro-browser.js"), platform: "browser", plugins: [clientRuntime()] })

const results = {}
for (const kind of ["native", "client"]) {
  const { run } = await import(here(`./out/micro-${kind}.mjs`))
  results[kind] = run()
}

const script = readFileSync(here("./out/micro-browser.js"), "utf8")
const page = `<!doctype html><script type="module">${script.replace(/export\s*\{[^}]*\};?\s*$/, "")}
window.micro = run()</script>`
const server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page))
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const browser = launch(args.chrome, here("./out/chrome-profile"))
const tab = await browser.page(`http://127.0.0.1:${server.address().port}/`)
results.chrome = await tab.waitFor("window.micro", { timeoutMs: 600_000, everyMs: 500 })
await browser.close()
server.close()

writeFileSync(here("./out/micro.json"), JSON.stringify(results, null, 2))
const names = results.native.results.map((r) => r.name)
console.log(`block body ${results.native.body} bytes; microseconds per operation (MB/s of block body where it applies)`)
const cell = (r) => (r ? `${r.perOpUs} us${r.mbPerSec ? ` (${Math.round(r.mbPerSec)} MB/s)` : ""}` : "-")
for (const name of names) {
  const pick = (kind) => results[kind]?.results.find((r) => r.name === name)
  console.log(`${name.padEnd(68)} native ${cell(pick("native")).padEnd(22)} client ${cell(pick("client")).padEnd(22)} chrome ${cell(pick("chrome"))}`)
}
