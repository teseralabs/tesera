import { strict as assert } from "node:assert"
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { bindUdp, closeUdp, createUdpSocket } from "../src/carrier/udp.js"
import { confirmRelay } from "../src/identity/confirm.js"
import { sleep } from "../src/util.js"

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url))

type Proc = {
  child: ChildProcess
  output: () => string
  errors: () => string
}

function start(args: string[]): Proc {
  const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString()
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString()
  })
  return { child, output: () => out, errors: () => err }
}

async function waitFor(proc: Proc, text: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!proc.output().includes(text) && !proc.errors().includes(text)) {
    if (proc.child.exitCode !== null) {
      throw new Error(`exited ${proc.child.exitCode} before ${text}\n${proc.output()}\n${proc.errors()}`)
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for ${text}\n${proc.output()}\n${proc.errors()}`)
    }
    await sleep(10)
  }
}

function stopped(proc: Proc): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
      resolve(proc.child.exitCode)
      return
    }
    proc.child.once("error", reject)
    proc.child.once("exit", (code) => resolve(code))
  })
}

async function stop(proc: Proc): Promise<void> {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return
  proc.child.kill("SIGTERM")
  const timer = setTimeout(() => proc.child.kill("SIGKILL"), 500)
  await stopped(proc).catch(() => {})
  clearTimeout(timer)
}

function lanIPv4(): string | null {
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && !entry.internal) return entry.address
      }
    }
  } catch {
    return null
  }
  return null
}

async function reservePort(): Promise<number> {
  const socket = createUdpSocket()
  const bound = await bindUdp(socket, "127.0.0.1", 0)
  await closeUdp(socket)
  return bound.port
}

describe("cli", () => {
  it("transfers a file through three processes with one relay blackholed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-"))
    const input = join(dir, "in.bin")
    const output = join(dir, "out.bin")
    const payload = randomBytes(32_000)
    await writeFile(input, payload)
    const session = `session:${randomBytes(32).toString("hex")}`
    const senderPort = await reservePort()
    const receiverPort = await reservePort()
    const procs: Proc[] = []
    try {
      const relays: Proc[] = []
      for (let index = 0; index < 3; index++) {
        const args = ["relay", "--listen", "127.0.0.1:0", "--seed", String(index + 1)]
        if (index === 0) args.push("--blackhole")
        const proc = start(args)
        procs.push(proc)
        relays.push(proc)
        await waitFor(proc, "role=relay event=listen", 3000)
      }
      const relayEndpoints = relays.map((proc) => {
        const match = proc.output().match(/role=relay event=listen addr=(\S+)/)
        if (!match?.[1]) throw new Error(`no listen line: ${proc.output()}`)
        return match[1]
      })
      const receiver = start([
        "recv",
        "--listen",
        `127.0.0.1:${receiverPort}`,
        "--sender",
        `127.0.0.1:${senderPort}`,
        "--relays",
        relayEndpoints.join(","),
        "--session",
        session,
        "--output",
        output,
        "--nack-after-ms",
        "500",
      ])
      procs.push(receiver)
      await waitFor(receiver, "role=receiver event=listen", 3000)
      const sender = start([
        "send",
        "--listen",
        `127.0.0.1:${senderPort}`,
        "--receiver",
        `127.0.0.1:${receiverPort}`,
        "--relays",
        relayEndpoints.join(","),
        "--session",
        session,
        "--input",
        input,
        "--k",
        "2",
        "--n",
        "3",
        "--retx-after-ms",
        "500",
      ])
      procs.push(sender)
      const code = await Promise.race([
        stopped(sender),
        sleep(15000).then(() => {
          throw new Error(`sender timed out\n${sender.output()}\n${sender.errors()}\n${receiver.errors()}`)
        }),
      ])
      assert.equal(code, 0, `${sender.output()}\n${sender.errors()}`)
      await waitFor(receiver, "role=receiver event=done", 3000)
      assert.match(sender.output(), /role=sender event=done bytes=\d+ .* blocks=\d+ tesserae=\d+ retransmits=\d+/)
      assert.match(receiver.output(), /role=receiver event=done bytes=\d+ sha256=[0-9a-f]{64} blocks=\d+ partial=\d+ acks=\d+ nacks=\d+ latency-ms=\d+\.\d/)
      assert.deepEqual(await readFile(output), payload)
      await stop(relays[1]!)
      assert.match(relays[1]!.output(), /role=relay event=done forwarded=\d+ loss=0 blackhole=0 denied=0 invalid=0/)
    } finally {
      for (const proc of procs) await stop(proc)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("transfers hello world through one relay on a reachable address", async (t) => {
    const lan = lanIPv4()
    if (!lan) {
      t.skip("no non-loopback IPv4 address")
      return
    }
    const dir = await mkdtemp(join(tmpdir(), "tesera-hello-"))
    const input = join(dir, "hello.txt")
    const output = join(dir, "out.txt")
    const payload = Buffer.from("Hello world\n")
    await writeFile(input, payload)
    const session = `session:${randomBytes(32).toString("hex")}`
    const senderPort = await reservePort()
    const receiverPort = await reservePort()
    const procs: Proc[] = []
    try {
      const relay = start([
        "relay",
        "--listen",
        "0.0.0.0:0",
        "--allow-remote",
        "--allow-dest",
        `${lan}/32`,
        "--log-level",
        "debug",
      ])
      procs.push(relay)
      await waitFor(relay, "role=relay event=listen", 3000)
      const port = relay.output().match(/role=relay event=listen addr=\S+:(\d+)/)?.[1]
      if (!port) throw new Error(`no listen line: ${relay.output()}`)
      const relayEndpoint = `${lan}:${port}`
      const receiver = start([
        "recv",
        "--listen",
        `0.0.0.0:${receiverPort}`,
        "--sender",
        `${lan}:${senderPort}`,
        "--relays",
        relayEndpoint,
        "--session",
        session,
        "--output",
        output,
      ])
      procs.push(receiver)
      await waitFor(receiver, "role=receiver event=listen", 3000)
      const sender = start([
        "send",
        "--listen",
        `0.0.0.0:${senderPort}`,
        "--receiver",
        `${lan}:${receiverPort}`,
        "--relays",
        relayEndpoint,
        "--session",
        session,
        "--input",
        input,
        "--k",
        "1",
        "--n",
        "1",
      ])
      procs.push(sender)
      const code = await Promise.race([
        stopped(sender),
        sleep(8000).then(() => {
          throw new Error(`sender timed out\n${sender.output()}\n${sender.errors()}\n${receiver.output()}\n${receiver.errors()}`)
        }),
      ])
      assert.equal(code, 0, `${sender.output()}\n${sender.errors()}`)
      await waitFor(receiver, "role=receiver event=done", 3000)
      assert.match(sender.output(), /tesserae=\d+/)
      assert.match(receiver.output(), /acks=\d+ nacks=\d+/)
      assert.match(relay.output(), /event=block-in /)
      assert.match(relay.output(), /event=block-ack /)
      await stop(relay)
      assert.match(relay.output(), /role=relay event=done forwarded=[1-9]\d*/)
      assert.equal((await readFile(output)).toString(), "Hello world\n")
    } finally {
      for (const proc of procs) await stop(proc)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("prints a relay id and the relay process proves it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-id-"))
    const secret = join(dir, "relay.secret")
    const procs: Proc[] = []
    try {
      const created = start(["id", "--out", secret])
      const code = await stopped(created)
      assert.equal(code, 0, created.errors())
      const id = created.output().trim()
      assert.match(id, /^relay:[a-z2-7]{52}$/)
      assert.equal((await stat(secret)).mode & 0o777, 0o600)
      const relay = start(["relay", "--listen", "127.0.0.1:0", "--identity", secret])
      procs.push(relay)
      await waitFor(relay, "role=relay event=id", 3000)
      assert.ok(relay.output().includes(id))
      const port = relay.output().match(/role=relay event=listen addr=\S+:(\d+)/)?.[1]
      if (!port) throw new Error(`no listen line: ${relay.output()}`)
      await confirmRelay({ host: "127.0.0.1", port: Number(port) }, id, { attempts: 1, timeoutMs: 500 })
    } finally {
      for (const proc of procs) await stop(proc)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("rejects an unknown relay log level", async () => {
    const proc = start(["relay", "--listen", "127.0.0.1:0", "--log-level", "loud"])
    const code = await stopped(proc)
    assert.notEqual(code, 0)
    assert.match(proc.errors(), /--log-level/)
  })

  it("rejects open access without an identity and keeps it for private relays", async () => {
    const open = start(["relay", "--listen", "127.0.0.1:0", "--access", "open"])
    assert.notEqual(await stopped(open), 0)
    assert.match(open.errors(), /--access open needs --identity/)
    assert.doesNotMatch(open.output(), /event=listen/)

    const plain = start(["relay", "--listen", "127.0.0.1:0", "--access", "private"])
    try {
      await waitFor(plain, "role=relay event=listen", 3000)
    } finally {
      await stop(plain)
    }
  })

  it("refuses removed flags instead of ignoring them", async () => {
    for (const [args, message] of [
      [["relay", "--listen", "127.0.0.1:0", "--browser", ":4433"], /--browser is now --webtransport/],
      [["relay", "--listen", "127.0.0.1:0", "--browser-cert", "c.pem"], /--browser-cert is now --webtransport-cert/],
      [["api", "--listen", "127.0.0.1:0", "--udp-ports", "4400-4401"], /--udp-ports was for the removed \/v0 transfer API/],
    ] as const) {
      const proc = start([...args])
      assert.equal(await stopped(proc), 1)
      assert.match(proc.errors(), message)
      assert.doesNotMatch(proc.output(), /event=listen/)
    }
  })

  it("refuses --webtransport, --allow, --block, and --policy-file without an identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-policy-"))
    try {
      const policy = join(dir, "policy.json")
      for (const [flag, value] of [
        ["--allow", `relay:${"a".repeat(52)}`],
        ["--block", `relay:${"a".repeat(52)}`],
        ["--policy-file", policy],
      ] as const) {
        const proc = start(["relay", "--listen", "127.0.0.1:0", flag, value])
        assert.equal(await stopped(proc), 1)
        assert.match(proc.errors(), new RegExp(`${flag} decides which relays may join, so it needs --identity`))
        assert.doesNotMatch(proc.output(), /event=listen/)
      }
      const browser = start(["relay", "--listen", "127.0.0.1:0", "--webtransport", "127.0.0.1:0"])
      assert.equal(await stopped(browser), 1)
      assert.match(browser.errors(), /--webtransport needs --identity/)
      assert.doesNotMatch(browser.output(), /event=(listen|webtransport-listen)/)
      const kept = start(["relay", "--listen", "127.0.0.1:0", "--identity", "33".repeat(32), "--policy-file", policy])
      try {
        await waitFor(kept, "role=relay event=listen", 3000)
      } finally {
        await stop(kept)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("cli help", () => {
  const commands = ["session", "id", "relay", "info", "allow", "block", "unblock", "forget", "api", "send", "recv", "stats"]

  it("lists every command", async () => {
    for (const args of [["--help"], ["-h"], ["help"], []]) {
      const proc = start(args)
      assert.equal(await stopped(proc), 0)
      for (const name of commands) assert.match(proc.output(), new RegExp(`^  ${name} `, "m"))
    }
  })

  it("prints each command's help and does nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tesera-help-"))
    try {
      for (const name of commands) {
        for (const args of [[name, "--help"], [name, "-h"], ["help", name], [name, "--out", join(dir, "id"), "--help"]]) {
          const proc = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"], cwd: dir })
          let out = ""
          let err = ""
          proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
          proc.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
          const code = await new Promise<number | null>((resolve) => proc.once("exit", resolve))
          assert.equal(code, 0, `${args.join(" ")}: ${err}`)
          assert.equal(err, "", `${args.join(" ")} wrote to stderr`)
          assert.ok(out.startsWith(`tesera ${name}`), `${args.join(" ")} printed ${out}`)
          assert.doesNotMatch(out, /secret [0-9a-f]{64}|session:[0-9a-f]{64}|relay:[a-z2-7]{52}|event=listen/)
        }
      }
      await assert.rejects(stat(join(dir, "id")), "tesera id --help wrote an identity")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("refuses help for an unknown command", async () => {
    const proc = start(["peers", "--help"])
    assert.equal(await stopped(proc), 1)
    assert.match(proc.errors(), /unknown command peers\. run tesera --help/)
  })
})
