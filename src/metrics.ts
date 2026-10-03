export type RelayStats = {
  forwarded: number
  /** Bytes in datagrams this relay actually forwarded. */
  forwardedBytes: number
  droppedLoss: number
  droppedBlackhole: number
  droppedDenied: number
  droppedInvalid: number
  /** Dropped because an operator cap was already full. The sum of `limitedBy`. */
  droppedLimited: number
  limitedBy: LimitedBy
}

/** Drops by the cap that was full. */
export type LimitedBy = {
  /** `--max-sessions` was full and this was a new session. */
  session: number
  /** `--datagram-rate` was spent. */
  datagram: number
  /** `--bandwidth` was spent. */
  bandwidth: number
  /** A destination that has not replied used up its allowance. */
  destination: number
  /** Too many peer-table lookups were waiting for their second packet. */
  table: number
}

export function emptyLimitedBy(): LimitedBy {
  return { session: 0, datagram: 0, bandwidth: 0, destination: 0, table: 0 }
}

export function emptyRelayStats(): RelayStats {
  return {
    forwarded: 0,
    forwardedBytes: 0,
    droppedLoss: 0,
    droppedBlackhole: 0,
    droppedDenied: 0,
    droppedInvalid: 0,
    droppedLimited: 0,
    limitedBy: emptyLimitedBy(),
  }
}

export type SenderStats = {
  inputBytes: number
  blocks: number
  dataWireBytes: number
  tesseraSends: number
  tesseraRetransmissions: number
  encryptMs: number
  encodeMs: number
}

export function emptySenderStats(): SenderStats {
  return {
    inputBytes: 0,
    blocks: 0,
    dataWireBytes: 0,
    tesseraSends: 0,
    tesseraRetransmissions: 0,
    encryptMs: 0,
    encodeMs: 0,
  }
}

export type ReceiverStats = {
  outputBytes: number
  blocksDecoded: number
  blocksWithoutAllTesserae: number
  blocksMissingSystematic: number
  nacksSent: number
  acksSent: number
  maxBufferedBlocks: number
  decodeMs: number
  decryptMs: number
  controlWireBytes: number
  latencySumMs: number
  latencyCount: number
  maxBlockLatencyMs: number
}

export function emptyReceiverStats(): ReceiverStats {
  return {
    outputBytes: 0,
    blocksDecoded: 0,
    blocksWithoutAllTesserae: 0,
    blocksMissingSystematic: 0,
    nacksSent: 0,
    acksSent: 0,
    maxBufferedBlocks: 0,
    decodeMs: 0,
    decryptMs: 0,
    controlWireBytes: 0,
    latencySumMs: 0,
    latencyCount: 0,
    maxBlockLatencyMs: 0,
  }
}

export type TransferMetrics = {
  inputBytes: number
  outputBytes: number
  dataWireBytes: number
  controlWireBytes: number
  blocks: number
  blocksWithoutAllTesserae: number
  blocksMissingSystematic: number
  tesseraSends: number
  tesseraRetransmissions: number
  nacksSent: number
  acksSent: number
  maxBufferedBlocks: number
  encryptMs: number
  encodeMs: number
  decodeMs: number
  decryptMs: number
  elapsedMs: number
  throughputMbps: number
  dataOverhead: number
  meanBlockLatencyMs: number
  maxBlockLatencyMs: number
  relays: RelayStats[]
}

export function buildMetrics(
  sender: SenderStats,
  receiver: ReceiverStats,
  relays: RelayStats[],
  elapsedMs: number,
): TransferMetrics {
  const inputBytes = sender.inputBytes
  return {
    inputBytes,
    outputBytes: receiver.outputBytes,
    dataWireBytes: sender.dataWireBytes,
    controlWireBytes: receiver.controlWireBytes,
    blocks: sender.blocks,
    blocksWithoutAllTesserae: receiver.blocksWithoutAllTesserae,
    blocksMissingSystematic: receiver.blocksMissingSystematic,
    tesseraSends: sender.tesseraSends,
    tesseraRetransmissions: sender.tesseraRetransmissions,
    nacksSent: receiver.nacksSent,
    acksSent: receiver.acksSent,
    maxBufferedBlocks: receiver.maxBufferedBlocks,
    encryptMs: sender.encryptMs,
    encodeMs: sender.encodeMs,
    decodeMs: receiver.decodeMs,
    decryptMs: receiver.decryptMs,
    elapsedMs,
    throughputMbps: elapsedMs > 0 ? (inputBytes * 8) / elapsedMs / 1000 : 0,
    dataOverhead: inputBytes > 0 ? sender.dataWireBytes / inputBytes : 0,
    meanBlockLatencyMs: receiver.latencyCount > 0 ? receiver.latencySumMs / receiver.latencyCount : 0,
    maxBlockLatencyMs: receiver.maxBlockLatencyMs,
    relays,
  }
}
