# @tesera/client changelog

@tesera/client has its own version, separate from the tesera CLI and relays in this repository

each release names the tesera protocol version it speaks. it is in `package.json` as `tesera.protocol`, and a test keeps it equal to the protocol version the client is built from

a client works with any relay and control plane that speak the same protocol, whatever their own version

## versions

the version follows semver. while it is below 1.0.0, a minor version can change the API

a release is a commit on main that changes `version` here and adds its section below. the tag is `client-v` and the version, such as `client-v0.1.0-beta`, so it can't be confused with a tesera release

a change to the protocol version is called out in its section

## 0.1.1-beta

protocol 2

- a browser may hold 1024 incoming WebTransport datagrams, about a megabyte. Chrome's default of one drops a burst while the page is busy. the outgoing queue is unchanged
- when a send waits because the transport's own window is full, the sender leaves growth and cuts to that transport. a lost acknowledgement cuts the window to 0.9 of its size instead of 0.7

## 0.1.0-beta

protocol 2

not published yet

- `TeseraClient` sends and receives streams over a pluggable transport, with progress, cancellation, and an optional SHA-256
- `webTransport` reaches relays from a browser over WebTransport
- `shareTransfer` and `joinTransfer` find relays and meet the other end through a `/v1` control plane: `/v1/relays` and `/v1/rooms`
- `shareTransfer` codes across relays that aren't attachment relays first, then attachment relays, each in the order discovery lists them, as `codedPaths` returns
- the public types are plain web types, so a browser project doesn't need `@types/node`
- a cancel before the transfer finishes always ends it as cancelled, even during the last write
