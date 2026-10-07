// Typechecks every js block in README.md against the built package types, as a strict browser project
// with no @types/node would. Each block is its own module, and the names it leaves to the application,
// such as `file` and `sink`, are declared here. Run it after `npm run build`.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const dir = here("./dist/examples/")
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const app = `type Client = typeof import("@tesera/client")
declare const file: File
declare const sink: WritableStream<Uint8Array>
declare const offer: import("@tesera/client").TransferOffer
declare const secret: string
declare function onProgress(progress: import("@tesera/client").Progress): void
declare function render(bytes: number, total: number | undefined, done: boolean): void
declare function showLink(link: string): void
declare function share(offer: import("@tesera/client").TransferOffer, secret: string): void
declare function answerFromReceiver(): Promise<import("@tesera/client").TransferAnswer>
declare function sendBack(answer: import("@tesera/client").TransferAnswer): void
`
const blocks = [...readFileSync(here("./README.md"), "utf8").matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1])
if (blocks.length === 0) throw new Error("README.md has no js blocks")
blocks.forEach((code, i) => writeFileSync(`${dir}example-${i + 1}.ts`, `${code}\nexport {}\n`))
writeFileSync(`${dir}app.d.ts`, app)
writeFileSync(
  `${dir}tsconfig.json`,
  JSON.stringify({
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
      types: [],
      paths: { "@tesera/client": ["../types/index.d.ts"] },
    },
    include: ["*.ts"],
  }),
)
execFileSync(process.execPath, [here("./node_modules/typescript/bin/tsc"), "-p", dir], { stdio: "inherit" })
console.log(`README.md: ${blocks.length} examples typecheck`)
