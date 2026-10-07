# testing @tesera/client

the tests run the bundled package in Node.js 20, against tesera's native code and real attachment relays, so build the repository first

```sh
(cd ../.. && npm run build) && npm test
```

`npm test` also typechecks the readme's examples in a strict browser project with no `@types/node`

## browser runs

these need Chrome, and Firefox for `--send-browser firefox`. the UDP relays run an older release, built at `tmp/v021` in the repository

```sh
node e2e/build.mjs
node e2e/run.mjs --mode crypto
node e2e/run.mjs --size 100mb --kill
node e2e/run.mjs --size 10mb --capture --send-browser firefox
```

`run.mjs` puts 2 browsers on either side of 2 attachment relays and 3 UDP relays. `--kill` stops one coded path a third of the way through. `--capture` records every datagram at both attachment relays and checks it for the secret, the keys, and the plaintext

## control plane runs

these start every process from the CLI: 1 attachment relay, older UDP relays, and `tesera api`, and give 2 Chrome pages only the control plane's URL

```sh
node e2e/control.mjs --size 100mb
node e2e/control.mjs --udp 2 --kill-relay --capture
node e2e/control.mjs --reverse --kill-relay --capture
node e2e/control.mjs --entries 2 --separate
node e2e/control.mjs --kill-api
node e2e/control.mjs --late 75
```

- `--udp 2` runs 2 UDP relays, so the attachment relay is the third coded path
- `--kill-relay` stops the offer's first path that isn't an attachment relay
- `--entries 2` lists a second attachment relay, and `--separate` puts the receiver on it
- `--reverse` swaps which Chrome sends
- `--capture` records every UDP datagram at every relay

each run records every request to the control plane and the page server, and every log line, and checks them for the secret, the keys, and the data. it checks the offer's paths follow `codedPaths`, and that the sender is handed only ACK, NACK, and SAMPLE frames and the receiver only DATA

rerun `node e2e/build.mjs` after changing the client, or the pages run the old bundle
