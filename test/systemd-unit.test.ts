import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

test("the relay unit drops privileges and keeps the network", async () => {
  const text = await readFile(new URL("../../deploy/tesera-relay.service", import.meta.url), "utf8")
  for (const line of [
    "User=tesera",
    "NoNewPrivileges=true",
    "StateDirectory=tesera",
    "ReadWritePaths=/var/lib/tesera",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "PrivateTmp=true",
  ]) {
    assert.match(text, new RegExp(`^${line}$`, "m"))
  }
  assert.doesNotMatch(text, /^PrivateNetwork=/m)
  assert.doesNotMatch(text, /^RestrictAddressFamilies=/m)
  assert.doesNotMatch(text, /^MemoryDenyWriteExecute=/m)
})
