import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const dist = join(dirname(fileURLToPath(import.meta.url)), "..")

/** The built CLI, copied where no node_modules can be found, as on an install without optional packages. */
let bare = ""

function run(args: string[], until: RegExp | null, ms = 15_000, onOut?: (out: string) => void): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(bare, "src/cli.js"), ...args], { stdio: ["ignore", "pipe", "pipe"], cwd: bare })
    let out = ""
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`timed out: ${out}`))
    }, ms)
    const read = (data: Buffer) => {
      out += String(data)
      onOut?.(out)
      if (until && until.test(out)) child.kill("SIGTERM")
    }
    child.stdout.on("data", read)
    child.stderr.on("data", read)
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

describe("without the optional webtransport packages", () => {
  before(() => {
    bare = mkdtempSync(join(tmpdir(), "tesera-bare-"))
    cpSync(join(dist, "src"), join(bare, "src"), { recursive: true })
    writeFileSync(join(bare, "package.json"), JSON.stringify({ type: "module" }))
  })

  after(() => {
    rmSync(bare, { recursive: true, force: true })
  })

  it("runs an ordinary UDP relay", async () => {
    const { out } = await run(["relay", "--listen", "127.0.0.1:0"], /addr=127\.0\.0\.1:\d+/)
    assert.match(out, /addr=127\.0\.0\.1:\d+/)
    assert.doesNotMatch(out, /webtransport/i)
  })

  it("runs the control plane", async () => {
    const { out } = await run(["api", "--listen", "127.0.0.1:0", "--discover", "127.0.0.1:9"], /event=listen addr=127\.0\.0\.1:\d+/)
    assert.match(out, /role=api event=listen/)
  })

  it("refuses --webtransport with a clear error", async () => {
    const { code, out } = await run(["relay", "--listen", "127.0.0.1:0", "--identity", "11".repeat(32), "--webtransport", "127.0.0.1:0"], null)
    assert.notEqual(code, 0)
    assert.match(out, /@fails-components\/webtransport/)
    assert.doesNotMatch(out, /event=listen/)
  })
})

describe("with the webtransport library but not its native transport", () => {
  before(() => {
    bare = mkdtempSync(join(tmpdir(), "tesera-half-"))
    cpSync(join(dist, "src"), join(bare, "src"), { recursive: true })
    writeFileSync(join(bare, "package.json"), JSON.stringify({ type: "module" }))
    // What npm leaves on Node.js 20 before 20.17: the library and its dependencies, without the transport.
    for (const name of ["@fails-components/webtransport", "debug", "ms", "bindings", "file-uri-to-path"]) {
      cpSync(join(dist, "..", "node_modules", name), join(bare, "node_modules", name), { recursive: true })
    }
  })

  after(() => {
    rmSync(bare, { recursive: true, force: true })
  })

  it("exits with an error that names the transport, and never publishes a statement", async () => {
    const statements: unknown[] = []
    let polling = true
    const poll = async (out: () => string) => {
      while (polling) {
        const port = /event=api addr=127\.0\.0\.1:(\d+)/.exec(out())?.[1]
        if (port) {
          const body = await fetch(`http://127.0.0.1:${port}/v1/transports`).then((r) => r.json()).catch(() => null)
          if (body) statements.push(...((body as { statements?: unknown[] }).statements ?? []))
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    let seen = ""
    const running = run(
      ["relay", "--listen", "127.0.0.1:0", "--api", "127.0.0.1:0", "--identity", "11".repeat(32), "--webtransport", "127.0.0.1:0"],
      null,
      15_000,
      (out) => (seen = out),
    )
    const polled = poll(() => seen)
    const { code, out } = await running.finally(() => (polling = false))
    await polled
    assert.equal(code, 1)
    assert.match(out, /webtransport-transport-http3-quiche/)
    assert.doesNotMatch(out, /event=(listen|api|webtransport-listen)/)
    assert.deepEqual(statements, [])
  })
})
