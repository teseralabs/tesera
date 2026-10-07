import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src")

/** Modules a static import reaches from `entry`, and the Node built-ins each one names. */
function staticGraph(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    const builtins: string[] = []
    seen.set(file, builtins)
    const code = readFileSync(file, "utf8")
    for (const match of code.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
      const spec = match[1]!
      if (spec.startsWith("node:")) builtins.push(spec)
      else if (spec.startsWith(".")) visit(join(dirname(file), spec))
    }
  }
  visit(join(src, entry))
  return seen
}

describe("sender and receiver imports", () => {
  for (const entry of ["transport/sender.js", "transport/receiver.js"]) {
    it(`${entry} reaches Node only through crypto/primitives.js`, () => {
      const graph = staticGraph(entry)
      assert.ok(graph.size > 3)
      const users = [...graph].filter(([, builtins]) => builtins.length > 0)
      assert.deepEqual(
        users.map(([file, builtins]) => [relative(src, file), builtins]),
        [["crypto/primitives.js", ["node:crypto"]]],
      )
      assert.ok(!graph.has(join(src, "carrier/udp.js")))
    })
  }
})
