<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/mark-white.svg" />
    <img src=".github/mark.svg" alt="" width="28" height="28" />
  </picture>
  tesera
</h1>

tesera is a new way for computers to send data to each other, even when parts of the network are slow, unreliable, or unavailable

unlike a typical data transfer on the internet, tesera encrypts data, breaks it into many pieces called tesserae, and sends them across multiple paths through computers called relays. once the receiving computer collects enough tesserae, it can reconstruct the original data

anyone can run a relay and contribute bandwidth to tesera. because the data is encrypted, relays can move it without being able to read the original data being transferred

[tesera.net](https://tesera.net)

## the parts

tesera is open-source software: a protocol, relays, a CLI, and a JavaScript client. this repository has all of them

- **relays** carry tesserae over UDP. anyone can run one with `tesera relay`. this is the data plane
- **attachment relays** are relays started with `--webtransport`. they also accept attachments over WebTransport, since a browser can't send UDP, and pass an endpoint's tesserae on to other relays. an attachment relay is still an ordinary relay, and can carry a coded path
- **a control plane** is `tesera api`. its `/v1` API lists relays, which is discovery, and passes one offer and one answer between the 2 ends of a transfer, in a room. it never carries file data
- **@tesera/client** is the JavaScript library applications use to send and receive over tesera, in a browser or Node.js, see [packages/client](packages/client)
- **the CLI** sends and receives files from a terminal with `tesera send` and `tesera recv`

tesera labs runs tesera.net, the transfer page built on @tesera/client, api.tesera.net, the control plane that page uses, and relay.tesera.net, the bootstrap relay other relays join. you can run every part yourself

```text
page ── WebTransport ── attachment relay ──┬── relay ──┐
                                           ├── relay ──┼── attachment relay ── WebTransport ── page
                                        └── relay ──┘
          control plane: discovery and rooms, no file data
```

## how it works

tesera splits a stream into blocks. each block is encrypted and then coded into redundant pieces called tesserae

by default, tesera uses 2-of-3 coding. this means each block becomes 3 tesserae, but the receiver only needs 2 of them to reconstruct the block

```text
sender
  │
  ├── tessera 1 ── relay A ──┐
  ├── tessera 2 ── relay B ──┼── any 2 ── receiver
  └── tessera 3 ── relay C ──┘
```

if one tessera is lost, delayed, or its path becomes unavailable, the receiver can continue once the other two arrive

a single coded piece is called a tessera. the plural is tesserae

each tessera of a block takes a different relay, a coded path. a transfer can lose one of its 3 coded paths and continue

that's redundancy across coded paths, not across everything. a browser reaches tesera through one attachment relay, and if that relay goes offline, its transfer stops. the coded paths can also share an operator, a machine, or a network, because tesera doesn't measure or choose relays for that yet

## why

erasure coding and multipath transmission already exist. tesera is experimenting with what happens when they become the normal way of moving a stream of data

instead of treating multiple paths as a fallback, tesera can use them at the same time. this can increase useful throughput when the paths have independent capacity and lets a transfer continue when individual paths stop working

more paths aren't always better. paths can share the same bottleneck, experience the same failures, or simply be too slow to help. part of the work on tesera is figuring out when paths are actually useful and when it's better not to use them

## experimental software

tesera is still experimental. transfers are encrypted, but the code has not been independently audited

don't rely on tesera yet for sensitive or critical data

## limitations

this repository contains the current research implementation

right now:

- relays are run by whoever starts them, and the network is small
- one reachable seed can introduce relays that have joined it
- relay discovery only goes one hop
- NAT traversal is not implemented
- the wire currently uses IPv4
- tesera looks up a hostname once and then uses that IPv4 address
- Safari hasn't been tested with @tesera/client or the transfer page

a seed only knows about itself and the relays that joined it. statistics reported by a seed are its view of the network, not a count of every tesera relay that may exist

## security

tesera is unaudited

each transfer derives its own encryption and control keys, and transferred blocks are encrypted and authenticated with ChaCha20-Poly1305

relays used to carry the transfer only receive encrypted data rather than the original plaintext

tesera does not provide anonymity. relays and other network observers may still be able to see metadata about a transfer, including addresses, timing, and traffic volume

a session secret created by `tesera session` has to be shared through a channel you already trust. tesera does not currently provide a way to exchange that secret for you

with @tesera/client, as on the tesera.net transfer page, the secret is made on the sending device and travels to the receiver in the link's fragment, which browsers keep out of every request. relays, the control plane, and the web server never receive it, and see the files only as ciphertext

a changed tessera is caught before anything is written, and today it stops the transfer, it can't change the file

room answers aren't authenticated yet, so someone who learns a room id can join before the real receiver. they can't read the transfer, but the real receiver can't join it anymore

[SECURITY.md](SECURITY.md) lists the security-sensitive parts and how to report a problem

## install

the CLI and ordinary relays need Node.js 20 or newer

```bash
npm ci
npm test
npm run build
```

`npm test` compiles first

the CLI can be run with:

```bash
npm run tesera -- …
```

`tesera --help` lists the commands, and `tesera COMMAND --help` describes one

### for an attachment relay

`--webtransport` needs the optional packages `@fails-components/webtransport` and `@fails-components/webtransport-transport-http3-quiche`. install them on Node.js 20.17 or newer. tesera labs runs its relays on Node.js 22

on older Node.js 20 releases, npm skips them without an error. a relay without them still runs as an ordinary relay, and refuses to start with `--webtransport`

the transport downloads a prebuilt binary for:

- Linux on x64 or arm64, with glibc 2.38 or newer
- macOS 26 or newer on arm64, or macOS 15 or newer on x64
- Windows on x64

on any other platform it builds from source, which needs git, CMake, and a C++ compiler, and can take more than 20 minutes

on Linux with an older glibc, such as Debian 12, the prebuilt binary still installs but can't load, so the relay refuses `--webtransport`. Ubuntu 24.04 and Debian 13 are new enough

## run a relay

a relay usually listens on UDP port 4101

first, create an identity for it:

```bash
npm run tesera -- id --out relay.secret
```

then start the relay:

```bash
npm run tesera -- relay \
  --listen 0.0.0.0:4101 \
  --allow-remote \
  --identity relay.secret
```

the identity contains the key used to identify the relay. the secret stays in `relay.secret` and should not be shared

the identity file is how you supply a relay identity. `tesera id --out` writes that file so only your user can read it

a raw identity secret passed on the command line can show up in shell history or the process list

`--allow-remote` lets the relay forward data to addresses outside of the local machine. without it, the relay only forwards to loopback

without `--access open`, the relay is private, and the default caps stay on

### systemd

[deploy/tesera-relay.service](deploy/tesera-relay.service) is a sample unit for a public relay that joins the tesera bootstrap relay, with that relay's id pinned

[deploy/tesera-seed.service](deploy/tesera-seed.service) is a sample unit for a seed that other relays join. it passes `--access open` and keeps joined relays in a peers file

both run as user `tesera`, keep their files under `/var/lib/tesera`, drop privileges, and restart 15 seconds after a failure

a relay you start without `--access open` stays private, and the default caps stay on

### join the network

another relay can join a reachable seed by hostname or `host:port`

```bash
npm run tesera -- relay \
  --listen 0.0.0.0:4101 \
  --allow-remote \
  --identity relay.secret \
  --join relay:es36gsfwxo2mcrmzl2neokxl6svtc4oowkb3j5xhcjgnxxyzkykq@relay.tesera.net
```

a hostname without a port uses port 4101

`relay:ID@` pins the seed's relay id. the relay checks the id that signed the seed's peer table and refuses a seed with any other id. without it, the relay joins whichever seed answers at that address

joining a seed on another machine needs `--allow-remote`

if the first join fails, the relay tries again for 60 seconds, then exits with an error

once joined, the relay reads the seed's signed peer table every minute. if the seed no longer lists it, the relay joins again, looking the hostname up again first. while the seed doesn't answer, the checks slow down to one every 5 minutes

### attachment relays

an attachment relay is an ordinary relay that also accepts attachments over WebTransport, from browsers and other clients. it needs the optional packages in [for an attachment relay](#for-an-attachment-relay)

```bash
npm run tesera -- relay \
  --listen 0.0.0.0:4101 \
  --allow-remote \
  --identity relay.secret \
  --advertise 203.0.113.10:4101 \
  --webtransport :4433 \
  --api 127.0.0.1:4180
```

`--webtransport HOST:PORT` is the UDP port clients reach over HTTP/3. open it in the firewall alongside `--listen`

`--identity` is required, because the relay signs a statement of what it serves with that key. `--advertise` is the UDP address other relays and the control plane reach it at

without `--webtransport-cert` and `--webtransport-key`, the relay makes its own 10-day self-signed certificates and rotates them. the next one is published days before the switch, so browsers that pinned both keep connecting

`GET /v1/transports` on the relay's `--api` returns the signed statement: the WebTransport certificate hashes and attach version. a control plane reads it there

browsers find an attachment relay once a control plane lists it in its entries file, see [control plane](#control-plane)

if the WebTransport packages are missing, or the listener can't start, the relay exits with an error. it never signs a statement for a listener that isn't running

an attachment relay forwards each of its attachments' tesserae and the acknowledgements coming back, so it needs a higher `--bandwidth` than a relay that only carries coded paths, see [operator policy](#operator-policy)

## relay options

`--log-level info` prints listen, join, and shutdown events

`debug` also prints each block the relay forwards

`error` only prints failures

### metrics

`--metrics-file FILE` stores aggregate counters for the relay so they can continue across restarts and upgrades

```bash
--metrics-file /var/lib/tesera/metrics.json
```

these counters include forwarded bytes and completed transfers

a transfer is counted after the same relay has forwarded both the data and an acknowledgement

a seed can include totals reported by relays joined to it. those totals are only that seed's current view of the network

### remembered relays

when a relay stops reporting to a seed, the seed can remember it for a while instead of immediately removing it from discovery

`--peer-ttl` controls how long a relay is remembered after it goes quiet. the default is 30 days

```bash
--peer-ttl 30d
```

durations can be given in days, hours, minutes, or seconds:

```text
30d
12h
20m
45s
```

a bare number is treated as days

setting the ttl to `0s` forgets a relay as soon as it goes quiet. the relay will need to join the seed again before it can be discovered

remembered relays are not counted as online. the relay count only includes the seed and relays heard from within the last few seconds

bytes and transfers previously reported by a quiet relay remain in the seed's snapshot until that relay is forgotten

`--peers-file FILE` keeps that memory across a restart of the seed

```bash
--peers-file /var/lib/tesera/peers.json
```

without it, remembered relays stay in memory, and restarting the seed clears them

### relay record

a relay with `--identity` signs a small record describing itself

the record includes the relay's public key, advertised addresses, implementation and software version, wire version, capabilities, sequence number, and freshness information

`--advertise HOST:PORT` adds an address to the record and can be repeated:

```bash
npm run tesera -- relay \
  --listen 0.0.0.0:4101 \
  --allow-remote \
  --identity relay.secret \
  --advertise 203.0.113.10:4101 \
  --name north
```

`--name TEXT` adds an optional name of up to 64 bytes

names are not unique or verified by tesera. the relay id remains the identity

#### sequence and freshness

each signed record has a sequence number

the sequence starts at one and increases when a new record is signed. restarting the relay keeps the current sequence as long as the record file is still there

by default, the record is stored beside the identity as `relay.secret.record`

`--record-file FILE` chooses another path

`--record-ttl SECONDS` controls how long a record stays fresh. the default is one day

losing or deleting the record file starts the sequence at one again. a verifier that has already accepted a higher sequence for that relay id will keep the higher record, so the reset record cannot replace it

using a new relay identity is the current way to recover from a lost sequence

#### what the signature proves

the signature proves that the relay identity created the record and made the claims inside it

it does not prove that the relay is running an official or unmodified tesera build. the implementation, software version, addresses, capabilities, and name are claims made by the relay

capabilities describe behavior the relay says it supports. unknown capabilities are ignored, and capabilities cannot relax wire checks or operator limits

#### inspect a relay

`tesera info` fetches a relay's record, verifies its signature, and asks the address to prove that it holds the relay key:

```bash
npm run tesera -- info relay:ID@203.0.113.10:4101
```

a valid signature and a reachable address are separate checks. a record can have a valid signature even when its advertised address cannot currently prove reachability

`--json` returns the signed packet and the fields decoded from that packet

`GET /v1/record` on the relay API returns the same signed record

### operator policy

a relay starts private and with lower limits. this keeps a new relay from immediately accepting unknown peers or using too much of the computer or network it is running on

`--access private` only accepts joins from relay identities you have allowed

`--access open` accepts joins from any relay that can prove its identity, unless that relay has been blocked

by default, a relay is limited to:

```text
bandwidth        5 megabits per second
sessions         8
new peers        6 per minute
datagrams        2000 per second
```

bandwidth is counted in bits, so 5 megabits is about 625,000 bytes a second. it counts whole forwarded datagrams, tessera data and control alike, without IP and UDP headers, and it's shared by every transfer through the relay

the datagram limit counts every forwarded datagram too, including samples, acknowledgements, and negative acknowledgements

a dropped datagram looks like loss to the sender, which slows down and sends again later

for scale, one measurement: a 20 MB `tesera send` over 3 relays on these defaults, all on one machine over loopback, ran at about 1.20 MB/s of file data. each relay forwarded about 10.7 MB, and about 9% of datagrams were dropped at the limit. that's one run, not a promise

an attachment relay forwards everything its attachments send, so with the defaults, a browser sender behind it gets well under 625,000 bytes a second. give attachment relays a higher `--bandwidth`

a bare bandwidth value is treated as megabits per second. values can also include a unit, such as `500kbps` or `50mbps`. use `0` to remove the limit

limits can be changed when the relay starts:

```bash
--access open \
--bandwidth 50mbps \
--max-sessions 32 \
--peer-rate 0 \
--datagram-rate 0
```

setting a rate limit to `0` removes that limit

### who may join

allow, block, and forget apply to relay identities rather than addresses. if a relay later appears at a different address, the same policy still applies to it

`--policy-file FILE` stores these decisions across restarts. a running relay checks the file for changes about once a second

```bash
npm run tesera -- allow relay:ID --policy-file /var/lib/tesera/policy.json
npm run tesera -- block relay:ID --policy-file /var/lib/tesera/policy.json
npm run tesera -- unblock relay:ID --policy-file /var/lib/tesera/policy.json
npm run tesera -- forget relay:ID --policy-file /var/lib/tesera/policy.json
```

`allow` lets a relay join when running with `--access private`

`block` refuses future joins from that relay and stops forwarding traffic from the address where it was last seen

`unblock` removes the block

`forget` removes a relay from the remembered peer list without blocking it. if the relay joins again later, it can be learned again

allowed and blocked identities stored in the policy file remain that way after a restart

peers can also be allowed or blocked when starting a relay:

```bash
--allow relay:ID
--block relay:ID
```

`--allow`, `--block`, and `--policy-file` decide which relays may join, so a relay refuses them without `--identity`, since a relay without an identity can't answer joins

### where packets may go

with `--allow-remote`, forwarded packets can go to public IPv4 addresses. private, local, reserved, and other special-use ranges are refused by default

```text
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.0.2.0/24
192.168.0.0/16
198.18.0.0/15
198.51.100.0/24
203.0.113.0/24
224.0.0.0/4
240.0.0.0/4
255.255.255.255/32
```

`--allow-dest CIDR` allows forwarding to a specific range that would otherwise be refused. use this when a relay needs to reach a tailnet or another private network

the flag can be repeated:

```bash
--allow-dest 100.64.0.0/10 \
--allow-dest 10.1.0.0/16
```

`--join` is an address chosen by the operator and is not filtered by these rules

a new destination can receive up to 8192 bytes before tesera requires a datagram back from the same host and port. starting another transfer does not reset this allowance

if the destination sees no forwarded traffic and sends no reply for 60 seconds, the allowance resets

forwarded datagrams larger than one maximum tessera and its envelope are dropped

peer tables are larger and use a separate exchange. the first lookup receives a small challenge, and the peer table is only sent after that challenge is returned from the same address

### api

`--api HOST:PORT` exposes relay statistics over HTTP

```bash
npm run tesera -- relay \
  --listen 0.0.0.0:4101 \
  --allow-remote \
  --identity relay.secret \
  --log-level info \
  --metrics-file /var/lib/tesera/metrics.json \
  --api 127.0.0.1:4180
```

there are currently 5 endpoints:

```text
GET /v1/stats
GET /v1/relay
GET /v1/peers
GET /v1/record
GET /v1/transports
```

they are for the operator and the control plane, not for browsers, so they send no CORS headers

`/v1/transports` lists the relay's signed transport statements, empty unless it's a running [attachment relay](#attachment-relays)

`/v1/stats` returns the seed's current snapshot:

```json
{
  "relays": 1,
  "bytes": 0,
  "transfers": 0
}
```

`/v1/relay` describes only the current relay process, including uptime, forwarded datagrams and bytes, data frames, acknowledgements, negative acknowledgements, repeated tesserae, and datagrams that were refused or could not be parsed

`limited` counts datagrams an operator limit dropped. `limitedBy` splits that count by `session`, `datagram`, `bandwidth`, `destination`, and `table`. the relay also prints `event=limited` with the same split at most every 30 seconds while drops continue

`/v1/peers` lists the relays this seed knows. each one has its id, address, whether it is online, when it was last heard, and the bytes and transfers it reported

a quiet relay stays in that list and is marked offline. `seen` is milliseconds since the epoch

```json
{
  "relays": [
    {
      "id": "relay:...",
      "host": "127.0.0.1",
      "port": 4101,
      "online": true,
      "seen": 0,
      "bytes": 0,
      "transfers": 0
    }
  ]
}
```

`GET /v1/record` returns this relay's signed record when the relay has an identity

`packet` contains the complete signed record as base64

`record` contains the fields decoded from that packet for convenience

```json
{
  "packet": "<base64>",
  "record": {
    "id": "relay:...",
    "seq": "1",
    "issuedAt": 1700000000,
    "ttl": 86400,
    "wire": 2,
    "implementation": "tesera",
    "software": "0.3.0-beta",
    "build": "",
    "manifest": "",
    "capabilities": ["discover", "forward"],
    "addresses": ["203.0.113.10:4101"],
    "name": ""
  }
}
```

`seq` is the record's sequence number, encoded as a decimal string

`issuedAt` is the time the record was signed, in unix seconds

`ttl` is how long the record stays fresh, in seconds

the signature proves that the relay identity created the record and made the claims inside it. it does not independently verify claims such as the software version or name

a program that relies on these claims should verify `packet` and use the fields decoded from the verified packet rather than trusting `record` on its own

without an identity, `/v1/record` returns `404`

if only software on the same machine needs the API, bind it to loopback

you can also ask a seed for its current statistics through the CLI:

```bash
npm run tesera -- stats --via relay.tesera.net
npm run tesera -- stats --via relay.tesera.net --json
```

## send and receive

first, create a session secret:

```bash
SESSION=$(npm run tesera -- session)
```

share this secret with the other person through a channel you already trust

a session secret contains 32 random bytes, encoded as 64 hexadecimal characters

it can also be made with openssl:

```bash
echo "session:$(openssl rand -hex 32)"
```

the receiver can then listen for the transfer:

```bash
npm run tesera -- recv \
  --listen 0.0.0.0:4200 \
  --sender HOST:4300 \
  --discover relay.tesera.net \
  --session "$SESSION" \
  --output out.bin
```

and the sender can send:

```bash
npm run tesera -- send \
  --listen 0.0.0.0:4300 \
  --receiver HOST:4200 \
  --discover relay.tesera.net \
  --session "$SESSION" \
  --input in.bin
```

`--discover` points to one reachable seed

`--relays` can be used when you want to provide every relay yourself

a pinned relay uses:

```text
relay:ID@host:port
```

the default coding is 2-of-3. any 2 tesserae can reconstruct a block

when only one relay is available, use:

```text
--k 1 --n 1
```

## control plane

`tesera api` is the control plane applications use with [@tesera/client](packages/client). tesera labs runs one at `api.tesera.net`, as a beta service with no availability promise

```text
GET    /
GET    /v1/relays
POST   /v1/rooms
GET    /v1/rooms/ROOM
DELETE /v1/rooms/ROOM
POST   /v1/rooms/ROOM/answer
GET    /v1/rooms/ROOM/answer
```

`GET /` returns a JSON description of the control plane, its version, wire version, endpoints, and documentation URL

`/v1/relays` is discovery. it lists the seed's UDP relays, each confirmed by a handshake with its identity key, and the attachment relays in `--entries`, each with a WebTransport statement the relay signed

`/v1/rooms` holds one offer and one answer, so 2 endpoints can find each other. a room lasts 10 minutes, and the first answer wins

the offer holds a session id, the sender's address, the relays, the coding, and the size. the secret isn't part of it. it stays with the 2 endpoints, in the link's fragment

file data never goes through the control plane. it goes between the endpoints and relays. there is no `/v1/send`: an application sends with @tesera/client, which encrypts on the device

an entries file lists the attachment relays to offer:

```json
{
  "entries": [
    {
      "relay": "relay:ID",
      "url": "https://edge.example.net:4433",
      "statement": "http://127.0.0.1:4180/v1/transports"
    }
  ]
}
```

`statement` is where the control plane reads that relay's `/v1/transports`. an entry whose statement doesn't verify against its relay id isn't listed

```bash
npm run tesera -- api \
  --listen 127.0.0.1:4190 \
  --discover relay:ID@203.0.113.10:4101 \
  --entries entries.json
```

`--discover` sets the seed whose relays `/v1/relays` lists. the seed contributes itself and the relays that have joined it

`--trust-proxy` names a loopback reverse proxy on this machine, such as `127.0.0.1`. a request may take its client address from `X-Forwarded-For` only when the socket peer is that proxy. the address used is the rightmost hop that is not itself a trusted proxy

any other connection is limited by the address on its socket. a caller that sends `X-Forwarded-For` directly does not choose its limit

keep this API listening on loopback, so the only program that can connect is that local proxy

`api.tesera.net` reaches this process through Caddy on `127.0.0.1`, so that server needs `--trust-proxy 127.0.0.1`

the control plane's `/v1` and a relay's `--api` `/v1` are separate APIs that may change version separately. neither is the wire protocol version, the attach version, the statement version, or the `v` in a discovery document

### errors

failed requests return JSON:

```json
{
  "error": "not_found"
}
```

possible error codes are:

```text
method
not_found
room
document
option
size
token
answered
session
busy
rate_limit
unavailable
```

`not_found` means the room is unknown, closed, or expired. `answered` means another receiver answered first. `busy` means the control plane holds as many rooms as it allows

`rate_limit` means the caller has exceeded a public API limit. the response uses HTTP 429 and includes `Retry-After` when the server knows when the allowance will become available again

### limits

the public API limits request rate so that one caller cannot consume the whole service

the current anonymous limits are:

- 120 requests per minute per IP
- 10 new rooms per minute per IP

these are public service limits and may change

### access

the tesera public API does not currently require an account or API key

room responses are returned with `Cache-Control: no-store`

running it yourself is covered in [packages/client](packages/client#running-your-own)

## license

tesera is Apache-2.0

the terms are in [LICENSE](LICENSE)