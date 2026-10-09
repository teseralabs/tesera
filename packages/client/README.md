# @tesera/client

@tesera/client sends and receives files and streams over tesera from browsers and Node.js

it is a beta. the API may change before 1.0, and tesera hasn't been audited

## install

it isn't on npm yet. build it from a checkout of this repository

```sh
git clone https://github.com/teseralabs/tesera.git
cd tesera
npm ci
npm run build
cd packages/client
npm ci
npm run build
npm pack
```

then install the file `npm pack` made, from your application's directory

```sh
npm install /path/to/tesera/packages/client/tesera-client-0.1.1-beta.tgz
```

it depends on `@noble/ciphers`, `@noble/hashes`, and `buffer`, and has no native code. its types are web types, so a browser project doesn't need `@types/node`

a site with no build step can bundle it once into one module, with esbuild or a similar tool

## send

```js
import { discoveryTransport, httpControlPlane, shareTransfer, TeseraClient } from "@tesera/client"

const control = httpControlPlane("https://control.example")
const client = new TeseraClient({ transport: discoveryTransport(control) })

const share = await shareTransfer(client, control, file, { hash: true, onProgress })
showLink(`https://app.example/t/${share.room}#${share.secret}`)
const { bytes, sha256 } = await share.done
```

the source can be a `Blob` or `File`, a `ReadableStream<Uint8Array>`, an async iterable of `Uint8Array`, or a `Uint8Array`. a stream with no length takes `size` if you want progress to have a total

## receive

```js
import { discoveryTransport, httpControlPlane, joinTransfer, TeseraClient } from "@tesera/client"

const control = httpControlPlane("https://control.example")
const client = new TeseraClient({ transport: discoveryTransport(control) })

const room = location.pathname.split("/").pop() ?? ""
const secret = location.hash.slice(1)
const incoming = await joinTransfer(client, control, { room, secret, sink, hash: true })
const { bytes, sha256 } = await incoming.done
```

a browser keeps a link's fragment out of every request, so in `/t/<room>#<secret>` the room reaches your page server and the secret stays in the page. this package has no link format of its own

`hash: true` computes a SHA-256 of the whole stream at each end, for your application to compare

## control plane

a control plane is `tesera api`. `/v1/relays` lists relays, and `/v1/rooms` holds one offer and one answer for 10 minutes. it never carries file data or the secret

- `discoveryTransport` attaches to the first attachment relay discovery lists that works, pinning the certificate hashes listed for it. if none works, it reads discovery once more and tries again
- `shareTransfer` makes a room, waits for the answer, closes the room, and then doesn't need the control plane
- `joinTransfer` reads the offer, attaches, claims the session, and posts the answer
- `share.expiresAt` is when the room ends. the first answer wins
- a receiver that wants a different attachment relay from the sender's passes `avoidSenderEntry: true`

tesera.net runs one at `https://api.tesera.net`, as a beta service with no availability promise

`ControlPlane` is an interface, so an application can carry the offer and the answer another way and still use `shareTransfer` and `joinTransfer`

## without a control plane

you choose the attachment relay and the UDP relays, and carry the offer and the answer yourself

```js
import { TeseraClient, webTransport } from "@tesera/client"

const client = new TeseraClient({
  transport: webTransport({ url: "https://relay-a.example:4433", certificateHash: "9f86d0…" }),
})

const transfer = await client.send(file, {
  relays: [
    { host: "203.0.113.10", port: 4101 },
    { host: "203.0.113.11", port: 4101 },
    { host: "203.0.113.12", port: 4101 },
  ],
  hash: true,
  onProgress: ({ bytes, total, done }) => render(bytes, total, done),
})

share(transfer.offer, transfer.secret)
const answer = await answerFromReceiver()
const { bytes, sha256 } = await transfer.start(answer)
```

```js
import { TeseraClient, webTransport } from "@tesera/client"

const client = new TeseraClient({
  transport: webTransport({ url: "https://relay-e.example:4433", certificateHash: "2c26b4…" }),
})

const transfer = await client.receive({ offer, secret, sink, hash: true })
sendBack(transfer.answer)
const { bytes, sha256 } = await transfer.done
```

the receiver has an `answer` only after it claims the offer's session at its attachment relay. if another receiver holds it, `receive` fails with a `claim` error

## streams and sinks

neither end holds the whole file. the sender reads 64 KiB at a time, when its window has room. the receiver writes each block to the sink in order, as it is rebuilt

a sink is a `WritableStream<Uint8Array>`, or any object with `write` and optional `close` and `abort`

when the sink falls behind, the receiver holds its acknowledgements once `maxBufferedBytes` are waiting, 2 MiB by default, and the sender waits. a sink stalled for about 40 s ends the transfer

`memorySink({ maxBytes })` keeps a file in memory as a `Blob`, up to `maxBytes`, for a browser with no file the page can write

`onProgress` reports file bytes, not coding or retransmission. it comes at most every 50 ms, and `done` is true once, at the end

## cancellation

pass an `AbortSignal` as `signal`, or call `cancel()`, on a transfer or a share

it stops reading and writing, aborts the sink, closes the attachment, and releases the session at the relay. `done` or `start` rejects with a `cancelled` error. a cancel after `done` resolves changes nothing

the other end isn't told. it stops when its timers run out

## relays and coded paths

by default, each block becomes 3 tesserae, each sent through a different UDP relay. the receiver only needs 2 to reconstruct the block. [how it works](../../README.md#how-it-works) has the picture

a browser can't send UDP, so each end attaches to an attachment relay, a tesera relay started with `--webtransport`. if it goes away, that end's transfer stops. both ends may use the same one

`codedPaths` takes the UDP relays that aren't attachment relays first, then the attachment relays' UDP addresses, in the order discovery lists them. with attachment relay A and relays B, C, and D listed, a transfer codes across B, C, and D. with A, B, and C, it codes across B, C, and A

nothing measures relays or knows who runs them, so 3 paths may share an operator, a machine, or a network

`coding: { k, n }` changes the 2-of-3 coding

## transports and runtimes

`webTransport` and `discoveryTransport` are the transports this package ships. `ClientTransport` is an interface, if you need another. `webTransportSupported()` says whether the page can use WebTransport

browser transfers work in chrome and firefox, and in safari with a compatible attachment relay. a page has to be served over HTTPS, or from `localhost`

Node.js 20 or newer needs a WebTransport implementation passed as `WebTransport`, such as `@fails-components/webtransport` 1.6.8, which needs Node.js 20.17 or newer

`certificateHash` pins an attachment relay's certificate by its SHA-256, in hex, and takes one hash or a list. browsers pin only certificates valid for 14 days or less, so relays rotate them. discovery lists the next hash before the switch. without a control plane you need the current hash yourself. a relay with a certificate from a public authority needs no hash

## errors

every failure is a `TeseraError` with a `code`

- `unsupported`: no WebTransport here
- `connection`: the attachment relay can't be reached, its certificate doesn't match, or the connection closed
- `incompatible`: a different attach version, or an offer or answer from a different version
- `claim`: the receiver's relay already holds the session, or as many as it allows
- `path`: the attachment relay can't reach an address in the offer
- `transfer`: the transfer stopped making progress, or a block failed its checks
- `cancelled`: you cancelled it
- `source`: reading the source failed
- `sink`: writing the sink failed
- `invalid`: an argument, offer, answer, or secret is malformed
- `control`: the control plane refused or couldn't be reached. `reason` is `unreachable`, `malformed`, `expired`, `no_relays`, or the control plane's error code, such as `not_found`, `answered`, `rate_limit`, or `size`

## security and metadata

the secret is made on the sending device, and the keys come from it at each end. relays, the control plane, and the page server never get it, and see file data only as ciphertext

anyone who has the secret can read the transfer, so share it through a channel you already trust

every block is checked as it is decrypted. a changed tessera stops the transfer before anything is written, so it can't change the file

room answers aren't authenticated yet. someone who learns a room id could answer first. they can't read the transfer, but the real receiver can't join

a page's code comes from the site that serves it, so its users trust that site

tesera doesn't claim anonymity. relays see addresses, timing, and sizes, and a control plane also sees the offer and the answer

## running your own

an attachment relay needs an identity, an address other relays can reach, and Node.js 20.17 or newer. run these from a tesera checkout

```sh
npm run tesera -- id --out relay.secret
npm run tesera -- relay --listen 0.0.0.0:4101 --allow-remote --identity relay.secret --advertise 203.0.113.10:4101 --webtransport :4433 --api 127.0.0.1:4180
```

it logs `event=webtransport-listen` with its certificate `hash`, and serves its signed statement at `/v1/transports`

a control plane lists it from an entries file, and lists the UDP relays its seed knows

```json
{ "entries": [{ "relay": "relay:ID", "url": "https://relay.example:4433", "statement": "http://127.0.0.1:4180/v1/transports" }] }
```

```sh
npm run tesera -- api --listen 127.0.0.1:4190 --discover relay:ID@203.0.113.10:4101 --entries entries.json
```

put HTTPS in front of it for pages. [attachment relays](https://tesera.net/docs#attach) and [api](https://tesera.net/docs#api) cover both in more detail

the published WebTransport binaries don't support safari yet. safari requires an attachment relay with a compatible WebTransport implementation

## versions

this package has its own version, in [CHANGELOG.md](CHANGELOG.md). it speaks tesera wire version 2, the same as the CLI and relays

## development

[TESTING.md](TESTING.md) has the tests and the browser runs
