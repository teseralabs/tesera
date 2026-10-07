# security

tesera is experimental and unaudited

don't use it to transfer anything you need to keep private or secure, and don't rely on it for production security

## report a vulnerability

if you find a vulnerability that could affect the confidentiality, integrity, or availability of a transfer or relay, please report it privately

an ordinary bug, failed transfer, or documentation mistake can be reported through a public issue

report security vulnerabilities through GitHub private vulnerability reporting on this repository

open the security tab and choose report a vulnerability

please give us a reasonable chance to investigate before you disclose a vulnerability publicly

this project has not set a response time, a supported-version period, or a bug bounty

## what tesera tries to protect

the 2 endpoints of a transfer share a 32-byte secret. with [@tesera/client](packages/client), the sender makes it and the receiver gets it from the link's fragment, which a browser doesn't send in requests. with the CLI, it's the session secret you share yourself

each transfer derives its keys from that secret, and blocks are encrypted and authenticated with ChaCha20-Poly1305 before they're coded. relays, the control plane, and the web server see ciphertext, never the secret, the plaintext, or the file name

tesera doesn't hide metadata. relays can see addresses, timing, and traffic volume. the control plane also sees the offer, which holds the relays, the sender's address, and the size

## sensitive areas

a report in any of these is especially useful:

- **endpoint crypto**: key derivation, nonces, and authentication, in [src/crypto](src/crypto) and the client's use of them
- **coding and integrity**: Reed-Solomon coding, and how a changed or misplaced tessera is caught, in [src/coding](src/coding) and [src/transport](src/transport)
- **attachment claims and routing**: how a browser receiver claims a session id at its attachment relay, and how frames reach the right browser, in [src/attach](src/attach)
- **compatibility forwarding**: bare frames that reach an attachment relay over UDP and are handed to the attached browser, which is the one hop that isn't enveloped
- **rendezvous**: room ids, sender tokens, and the first-answer rule, in [src/control/rendezvous.ts](src/control/rendezvous.ts)
- **signed transport statements**: what a relay signs about its WebTransport listener, and how the control plane checks it before listing an entry, in [src/attach/statement.ts](src/attach/statement.ts) and [src/control/discovery.ts](src/control/discovery.ts)
- **relay forwarding**: envelopes, destination rules, the new-destination allowance, and limits, in [src/relay](src/relay) and [src/protocol](src/protocol)
- **discovery and trust boundaries**: signed records, peer tables, joins, and what a seed can make a relay or client believe, in [src/identity](src/identity)

## known issues

these are known and not yet fixed. a report that makes one worse is still welcome

- **a corrupted tessera stops a transfer.** a changed tessera is caught and never written, so it can't change the file. but today the receiver stops the transfer instead of discarding that tessera and using the others, so anyone on a path can end a transfer
- **rendezvous answers aren't authenticated.** someone who learns a room id can answer before the real receiver. they can't decrypt anything, since the secret isn't in the room, but the real receiver can no longer join
- **the page serves its own code.** on tesera.net, the code that encrypts runs from tesera.net. whoever controls the site, or its hosting, could serve code that leaks the secret. this is true of any web app that encrypts in the browser
- **one attachment relay.** a browser's transfer depends on its attachment relay, which sees its addresses and timing, and can end the transfer
