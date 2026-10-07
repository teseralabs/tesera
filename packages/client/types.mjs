// Keeps the package's own declarations from the tsc output in dist/decl, as dist/types. tesera core's
// declarations stay out, so the public types can't name Node.js types such as Buffer.
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const from = here("./dist/decl/packages/client/src")
const to = here("./dist/types")

rmSync(to, { recursive: true, force: true })
cpSync(from, to, { recursive: true, filter: (path) => !path.endsWith("/core.d.ts") })
rmSync(here("./dist/decl"), { recursive: true, force: true })

const files = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]))
const problems = []
for (const file of files(to)) {
  const text = readFileSync(file, "utf8")
  if (/\.\.\/src\/|["']\.\.?\/(\.\.\/)*core\.js["']/.test(text)) problems.push(`${file} imports tesera core`)
  if (/\bBuffer\b|NodeJS\./.test(text)) problems.push(`${file} names a Node.js type`)
}
if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}
