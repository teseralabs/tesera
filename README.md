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

- **relays** carry tesserae over UDP. anyone can run one with `tesera relay`
- **attachment relays** are relays started with `--webtransport`. a browser can't send UDP, so it attaches to one over WebTransport, and that relay passes its tesserae on to other relays. an attachment relay is still an ordinary relay
- **a control plane** is `tesera api`. it lists relays, which is discovery, and passes one offer and one answer between the 2 ends of a transfer. it never carries file data
- **@tesera/client** is the JavaScript library applications use to send and receive over tesera, in a browser or Node.js, see [packages/client](packages/client)
- **the CLI** sends and receives files from a terminal with `tesera send` and `tesera recv`

tesera.net runs a public transfer page, control plane, and bootstrap relay. you can run every part yourself

```text
page ── WebTransport ── attachment relay ──┬── relay ──┐
                                           ├── relay ──┼── attachment relay ── WebTransport ── page
                                           └── relay ──┘
          control plane: discovery and rooms, no file data
```

browser transfers work in chrome and firefox, and in safari with a compatible attachment relay

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

tesera doesn't provide anonymity. relays and other observers can still see addresses, timing, and how much data moves

[SECURITY.md](SECURITY.md) lists the security-sensitive parts and how to report a problem

## install

the CLI and ordinary relays need Node.js 20 or newer

```bash
git clone https://github.com/teseralabs/tesera.git
cd tesera
npm ci
npm run build
```

`npm test` compiles and runs the tests

run the CLI from the checkout with:

```bash
npm run tesera -- …
```

`npm run tesera -- --help` lists the commands, and `npm run tesera -- COMMAND --help` describes one

when you save a command's output in a shell variable, use `npm run -s tesera --`, so npm's own lines stay out of it

### for an attachment relay

`--webtransport` needs Node.js 20.17 or newer and the optional packages `@fails-components/webtransport` and `@fails-components/webtransport-transport-http3-quiche`, which `npm ci` installs

the transport has prebuilt binaries for:

- Linux on x64 or arm64, with glibc 2.38 or newer, such as Ubuntu 24.04 or Debian 13
- macOS 26 or newer on arm64, or macOS 15 or newer on x64
- Windows on x64

on any other platform it builds from source, which needs git, CMake, and a C++ compiler. on an older glibc, the binary installs but can't load

without the packages, a relay still runs as an ordinary relay, and refuses to start with `--webtransport`

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

the identity is the relay's key, and its relay id comes from it. `--out` writes the secret so only your user can read it. keep it private, and start the relay with the same file so it keeps its id

`--allow-remote` lets the relay forward data to addresses outside of the local machine. without it, the relay only forwards to loopback

without `--access open`, the relay is private, and the default caps stay on

[tesera.net/docs](https://tesera.net/docs#relay) walks through running a relay, and [networking](https://tesera.net/docs#networking) covers making it reachable from home, behind CGNAT, or in the cloud

### systemd

[deploy/tesera-relay.service](deploy/tesera-relay.service) is a sample unit for a public relay that joins the tesera bootstrap relay, with that relay's id pinned

[deploy/tesera-seed.service](deploy/tesera-seed.service) is a sample unit for a seed that other relays join. it passes `--access open` and keeps joined relays in a peers file

both run as user `tesera`, keep their files under `/var/lib/tesera`, and restart after a failure. [keep it running](https://tesera.net/docs#keep-running) has the install steps

### join the network

another relay can join a reachable seed by hostname or `host:port`

```bash
npm run tesera -- relay \
  --listen 0.0.0.0:4101 \
  --allow-remote \
  --identity relay.secret \
  --advertise 203.0.113.10:4101 \
  --join relay:es36gsfwxo2mcrmzl2neokxl6svtc4oowkb3j5xhcjgnxxyzkykq@relay.tesera.net
```

a hostname without a port uses port 4101

`relay:ID@` pins the seed's relay id. the relay checks the id that signed the seed's peer table and refuses a seed with any other id. without it, the relay joins whichever seed answers at that address

`--advertise` is the UDP address other relays and the control plane reach it at, signed into its record

if the relay can't join at startup, it exits with an error. once joined, it joins again whenever the seed stops listing it

### attachment relays

an attachment relay is an ordinary relay that also accepts attachments over WebTransport, from browsers and other clients. it needs the packages in [for an attachment relay](#for-an-attachment-relay)

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

`--identity` is required, because the relay signs a statement of what it serves with that key. `--advertise` is required when the relay listens on every interface

without `--webtransport-cert` and `--webtransport-key`, the relay makes its own short-lived self-signed certificates and rotates them, publishing the next one before the switch so browsers that pinned it keep connecting

`GET /v1/transports` on the relay's `--api` returns the signed statement: the WebTransport certificate hashes and attach version. a control plane reads it there, and browsers find the relay once a control plane lists it, see [control plane](#control-plane)

if the WebTransport packages are missing, or the listener can't start, the relay exits with an error

an attachment relay forwards everything its attachments send, so give it a higher `--bandwidth` than the default, see [operator policy](#operator-policy)

safari needs an attachment relay whose WebTransport implementation advertises one session per connection. the published `@fails-components/webtransport-transport-http3-quiche` 1.6.8 binaries don't support this yet

## relay options

`--log-level info` prints listen, join, and shutdown events. `debug` also prints each block the relay forwards, and `error` only prints failures. [logs](https://tesera.net/docs#logs) lists the events

### metrics

`--metrics-file FILE` stores the relay's forwarded bytes and completed transfers, so they continue across restarts and upgrades

```bash
--metrics-file /var/lib/tesera/metrics.json
```

a seed can include totals reported by relays joined to it. those totals are only that seed's current view of the network

### remembered relays

when a relay stops reporting to a seed, the seed remembers it for a while instead of removing it from discovery right away

`--peer-ttl` sets how long, 30 days by default. it takes days, hours, minutes, or seconds, such as `30d`, `12h`, `20m`, or `45s`, and a bare number is days. `0s` forgets a relay as soon as it goes quiet

```bash
--peer-ttl 30d
```

remembered relays are not counted as online

`--peers-file FILE` keeps that memory across a restart of the seed

```bash
--peers-file /var/lib/tesera/peers.json
```

### relay record

a relay with `--identity` signs a small record describing itself: its id, advertised addresses, software and wire version, capabilities, and an optional name

```bash
npm run tesera -- relay \
  --listen 0.0.0.0:4101 \
  --allow-remote \
  --identity relay.secret \
  --advertise 203.0.113.10:4101 \
  --name north
```

`--advertise HOST:PORT` can be repeated. `--name TEXT` adds a name of up to 64 bytes. names are not unique or verified, and the relay id remains the identity

the record is stored beside the identity as `relay.secret.record`. `--record-file FILE` chooses another path, and `--record-ttl SECONDS` how long it stays fresh, one day by default. keep the record file with the identity, since it carries the record's sequence number

the signature proves which relay identity made the record. it doesn't prove the claims inside it are true, or that the relay runs an official build. [relay records](https://tesera.net/docs#record) covers sequence numbers and what the signature proves

`tesera info` fetches a relay's record, verifies its signature, and asks the address to prove that it holds the relay key:

```bash
npm run tesera -- info relay:ID@203.0.113.10:4101
```

`--json` returns the signed packet and the fields decoded from it

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

bandwidth is counted in bits, so 5 megabits is about 625,000 bytes a second. it counts every forwarded datagram, tessera data and control alike, and it's shared by every transfer through the relay

a bare bandwidth value is treated as megabits per second. values can also include a unit, such as `500kbps` or `50mbps`

limits can be changed when the relay starts:

```bash
--access open \
--bandwidth 50mbps \
--max-sessions 32 \
--peer-rate 0 \
--datagram-rate 0
```

setting a limit to `0` removes it

### who may join

allow, block, and forget apply to relay identities rather than addresses. if a relay later appears at a different address, the same policy still applies to it

`--policy-file FILE` stores these decisions across restarts, and a running relay picks up changes to it

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

peers can also be allowed or blocked when starting a relay:

```bash
--allow relay:ID
--block relay:ID
```

these flags need `--identity`, since a relay without an identity can't answer joins

### where packets may go

with `--allow-remote`, forwarded packets can go to public IPv4 addresses. private, local, reserved, and other special-use ranges are refused by default, [destinations](https://tesera.net/docs#destinations) lists them

`--allow-dest CIDR` allows forwarding to a range that would otherwise be refused, such as a tailnet or another private network. it can be repeated:

```bash
--allow-dest 100.64.0.0/10 \
--allow-dest 10.1.0.0/16
```

`--join` is an address chosen by the operator and is not filtered by these rules

### api

`--api HOST:PORT` exposes relay statistics over HTTP

```bash
npm run tesera -- relay \
  --listen 0.0.0.0:4101 \
  --allow-remote \
  --identity relay.secret \
  --metrics-file /var/lib/tesera/metrics.json \
  --api 127.0.0.1:4180
```

```text
GET /v1/stats
GET /v1/relay
GET /v1/peers
GET /v1/record
GET /v1/transports
```

they are for the operator and the control plane, not for browsers, so they send no CORS headers. if only software on the same machine needs them, bind the API to loopback

- `/v1/stats` returns the seed's current snapshot: relays, bytes, and transfers
- `/v1/relay` describes the current relay process: uptime, forwarded datagrams and bytes, and datagrams that were refused or dropped by a limit
- `/v1/peers` lists the relays this seed knows, with whether each is online and what it reported
- `/v1/record` returns the relay's signed record, or `404` without an identity
- `/v1/transports` lists its signed transport statements, empty unless it's a running [attachment relay](#attachment-relays)

`/v1/record` returns the signed packet as base64, and the fields decoded from it:

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
    "software": "0.3.2-beta",
    "build": "",
    "manifest": "",
    "capabilities": ["discover", "forward"],
    "addresses": ["203.0.113.10:4101"],
    "name": ""
  }
}
```

a program that relies on the record should verify `packet` and use the fields decoded from it, rather than trusting `record` on its own

you can also ask a seed for its current statistics through the CLI:

```bash
npm run tesera -- stats --via relay.tesera.net
npm run tesera -- stats --via relay.tesera.net --json
```

## send and receive

a transfer needs a sender, a receiver, and at least one relay. tesera doesn't traverse NAT yet, so the relays have to reach both computers on the UDP ports they listen on

first, create a session secret:

```bash
SESSION=$(npm run -s tesera -- session)
```

share this secret with the other person through a channel you already trust. tesera doesn't exchange it for you, and anyone who has it can read the transfer

a session secret contains 32 random bytes, encoded as 64 hexadecimal characters

it can also be made with openssl:

```bash
echo "session:$(openssl rand -hex 32)"
```

the receiver can then listen for the transfer. replace HOST with the sender's IPv4 address:

```bash
npm run tesera -- recv \
  --listen 0.0.0.0:4200 \
  --sender HOST:4300 \
  --discover relay.tesera.net \
  --session "$SESSION" \
  --output out.bin
```

and the sender can send, with HOST as the receiver's IPv4 address:

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

`tesera api` is the control plane applications use with [@tesera/client](packages/client). tesera.net runs one at `api.tesera.net`, as a beta service with no availability promise

```text
GET    /
GET    /v1/relays
POST   /v1/rooms
GET    /v1/rooms/ROOM
DELETE /v1/rooms/ROOM
POST   /v1/rooms/ROOM/answer
GET    /v1/rooms/ROOM/answer
```

`/v1/relays` is discovery. it lists the seed's UDP relays and the attachment relays in `--entries`, each with a WebTransport statement the relay signed

`/v1/rooms` holds one offer and one answer, so 2 endpoints can find each other. a room lasts 10 minutes, and the first answer wins. the offer doesn't hold the secret, which stays with the 2 endpoints

file data never goes through the control plane. an application sends with @tesera/client, which encrypts on the device

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

`--discover` sets the seed whose relays `/v1/relays` lists, relay.tesera.net by default

keep the API on loopback behind a reverse proxy. `--trust-proxy 127.0.0.1` lets it limit each caller by the address that proxy forwards, instead of the proxy's own

[api](https://tesera.net/docs#api) covers each endpoint, its errors, and the rate limits. running your own with @tesera/client is in [packages/client](packages/client#running-your-own)

## license

tesera is Apache-2.0

the terms are in [LICENSE](LICENSE)
