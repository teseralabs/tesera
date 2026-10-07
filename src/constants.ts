/** Wire version for forward envelopes, frames, and identity headers. */
export const PROTOCOL_VERSION = 2
export const SESSION_ID_LEN = 16
export const MAC_LEN = 16
export const TAG_LEN = 16
/** flags byte + send timestamp (u64). Covered by the block AEAD. */
export const INNER_HEADER_LEN = 9
export const MAX_N = 32
/** Keeps one tessera, plus headers, under a conservative UDP payload. */
export const MAX_SHARD = 1100
export const DEFAULT_SHARD = 1024
export const DEFAULT_WINDOW = 32
export const DEFAULT_MAX_SENDS = 24
export const DEFAULT_NACK_AFTER_MS = 40
export const DEFAULT_RETX_AFTER_MS = 120
/** Longest wait between resends of one block. Each resend doubles the wait up to this. */
export const MAX_RETX_BACKOFF_MS = 2_000
/** Smallest congestion window, in blocks. Loss that is not congestion cannot push the sender below it. */
export const MIN_WINDOW = 4
/** The sender gives up when no block has been acknowledged for this long. */
export const DEFAULT_IDLE_MS = 60_000
/** How long a receiver keeps acknowledging repeats after the stream ends. */
export const DEFAULT_ACK_GRACE_MS = 2_000
export const DEFAULT_TICK_MS = 20
export const MAX_AHEAD = 256
export const DATA_HEADER_LEN = 29
export const CRC_LEN = 4
export const ENVELOPE_LEN = 11
/**
 * Largest TESR datagram a relay accepts. One maximum tessera plus its envelope.
 * A peer table is larger and is not a forwarded frame, so this ceiling does not apply to it.
 */
export const MAX_FORWARD_DATAGRAM = ENVELOPE_LEN + DATA_HEADER_LEN + MAX_SHARD + CRC_LEN
/** Envelope, data header, and CRC around one shard. A data datagram is this plus the shard. */
export const DATAGRAM_OVERHEAD = ENVELOPE_LEN + DATA_HEADER_LEN + CRC_LEN
/** The largest shard whose data datagram fits in `maxPacketSize`, clamped to the protocol maximum. */
export function shardForPacketSize(maxPacketSize: number): number {
  const shard = Math.min(MAX_SHARD, maxPacketSize - DATAGRAM_OVERHEAD)
  if (shard < 1) throw new Error(`transport packet limit ${maxPacketSize} is too small for a tesera datagram`)
  return shard
}
/** Bytes forwarded to one address before it sends a valid tesera datagram back. */
export const UNVERIFIED_DEST_BYTES = 8192
/** Unverified and verified destinations remembered at once. */
export const UNVERIFIED_DEST_MAX = 256
/** How long a destination entry lives after its last forward or reply. */
export const UNVERIFIED_DEST_TTL_MS = 60_000
/** How long a peer-table nonce stays valid. */
export const TABLE_NONCE_TTL_MS = 5_000
/** How long a source may receive a peer table without a new handshake. */
export const TABLE_READY_TTL_MS = 60_000
/** Sources waiting to prove they received the small peer-table reply. */
export const TABLE_PENDING_MAX = 256
export const FRAME_DATA = 1
export const FRAME_ACK = 2
export const FRAME_NACK = 3
/** Path sample. Sent back through the relay that delivered the tessera. */
export const FRAME_SAMPLE = 4

export function assertCode(k: number, n: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || n < k || n > MAX_N) {
    throw new Error(`invalid code k=${k} n=${n}; need 1 <= k <= n <= ${MAX_N}`)
  }
}

export function assertShardSize(shardSize: number): void {
  if (!Number.isInteger(shardSize) || shardSize < 1 || shardSize > MAX_SHARD) {
    throw new Error(`shard size must be an integer from 1 to ${MAX_SHARD}`)
  }
}

/** Plaintext body bytes in a block that fills every shard exactly. */
export function fullBlockBodySize(k: number, shardSize: number): number {
  assertCode(k, k)
  assertShardSize(shardSize)
  const capacity = k * shardSize - INNER_HEADER_LEN - TAG_LEN
  if (capacity <= 0) {
    throw new Error(`shard size ${shardSize} is too small for k=${k}`)
  }
  return capacity
}
