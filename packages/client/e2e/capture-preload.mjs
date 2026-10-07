// Loaded with `node --import` into a relay process for the leak scan. When TESERA_E2E_CAPTURE names a
// file, every UDP datagram the process sends or receives is appended to it as
// tag u8 (0 in, 2 out) | length u32 | to or from: IPv4 4 bytes, port u16 | bytes.
// It wraps node:dgram, so it records a CLI relay or an older release the same way, without changing either.
import dgram from "node:dgram"
import { openSync, writeSync } from "node:fs"

const path = process.env.TESERA_E2E_CAPTURE
if (path) {
  const fd = openSync(path, "w")
  const record = (tag, bytes, host, port) => {
    const head = Buffer.alloc(11)
    head.writeUInt8(tag, 0)
    head.writeUInt32BE(bytes.length, 1)
    const parts = String(host ?? "0.0.0.0").split(".").map(Number)
    for (let i = 0; i < 4; i++) head.writeUInt8((parts[i] ?? 0) & 255, 5 + i)
    head.writeUInt16BE(Number(port ?? 0) & 0xffff, 9)
    writeSync(fd, head)
    writeSync(fd, bytes)
  }
  const send = dgram.Socket.prototype.send
  dgram.Socket.prototype.send = function (msg, ...rest) {
    const bytes = Array.isArray(msg) ? Buffer.concat(msg.map((m) => Buffer.from(m))) : Buffer.from(msg)
    // send(msg, port, host, cb) or send(msg, offset, length, port, host, cb)
    const [port, host] = typeof rest[1] === "number" ? [rest[2], rest[3]] : [rest[0], rest[1]]
    record(2, bytes, host, port)
    return send.call(this, msg, ...rest)
  }
  const emit = dgram.Socket.prototype.emit
  dgram.Socket.prototype.emit = function (event, ...rest) {
    if (event === "message") record(0, Buffer.from(rest[0]), rest[1]?.address, rest[1]?.port)
    return emit.call(this, event, ...rest)
  }
}
