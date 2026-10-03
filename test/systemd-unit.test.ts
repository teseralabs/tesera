import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

const bootstrap = "relay:es36gsfwxo2mcrmzl2neokxl6svtc4oowkb3j5xhcjgnxxyzkykq"

async function unit(name: string): Promise<string> {
  return readFile(new URL(`../../deploy/${name}`, import.meta.url), "utf8")
}

function execStart(text: string): string {
  const line = text.split("\n").find((entry) => entry.startsWith("ExecStart="))
  assert.ok(line, "no ExecStart")
  return line
}

for (const name of ["tesera-relay.service", "tesera-seed.service"]) {
  test(`${name} drops privileges, keeps the network, and restarts on failure`, async () => {
    const text = await unit(name)
    for (const line of [
      "User=tesera",
      "NoNewPrivileges=true",
      "StateDirectory=tesera",
      "ReadWritePaths=/var/lib/tesera",
      "ProtectSystem=strict",
      "ProtectHome=true",
      "PrivateTmp=true",
      "Restart=on-failure",
      "RestartSec=15",
    ]) {
      assert.match(text, new RegExp(`^${line}$`, "m"))
    }
    assert.doesNotMatch(text, /^PrivateNetwork=/m)
    assert.doesNotMatch(text, /^RestrictAddressFamilies=/m)
    assert.doesNotMatch(text, /^MemoryDenyWriteExecute=/m)
    assert.match(execStart(text), / --allow-remote /)
    assert.match(execStart(text), / --identity \/var\/lib\/tesera\/relay\.secret /)
  })
}

test("the relay unit joins the pinned bootstrap relay and stays private", async () => {
  const exec = execStart(await unit("tesera-relay.service"))
  assert.match(exec, new RegExp(` --join ${bootstrap}@relay\\.tesera\\.net( |$)`))
  assert.doesNotMatch(exec, /--access open|--peers-file|--policy-file/)
})

test("the seed unit is open and keeps joined relays across a restart", async () => {
  const exec = execStart(await unit("tesera-seed.service"))
  assert.match(exec, / --access open /)
  assert.match(exec, / --peers-file \/var\/lib\/tesera\/peers\.json /)
  assert.doesNotMatch(exec, /--join/)
})
