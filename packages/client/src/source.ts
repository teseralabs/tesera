/**
 * What a transfer reads from. A `File` is a `Blob`. Anything else that yields bytes in order can be
 * wrapped as a `ReadableStream` or an async iterable, such as a Node.js readable stream.
 */
export type Source = Blob | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array

/** The client reads at most this much from a source at once, so one huge chunk cannot pin memory. */
export const CHUNK_BYTES = 64 * 1024

export interface ChunkReader {
  /** Total bytes, when the source knows them up front. */
  readonly size: number | undefined
  /** The next chunk of at most CHUNK_BYTES, or null at the end. */
  next(): Promise<Uint8Array | null>
  /** Stop reading and release the source. */
  cancel(): Promise<void>
}

export function readSource(source: Source): ChunkReader {
  if (source instanceof Uint8Array) return bytesReader(source)
  if (typeof Blob !== "undefined" && source instanceof Blob) return streamReader(source.stream(), source.size)
  if (typeof ReadableStream !== "undefined" && source instanceof ReadableStream) return streamReader(source, undefined)
  if (source && typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    return iterableReader(source as AsyncIterable<Uint8Array>)
  }
  throw new TypeError("a source must be a Blob, a ReadableStream, an async iterable of bytes, or a Uint8Array")
}

function bytesReader(bytes: Uint8Array): ChunkReader {
  let at = 0
  return {
    size: bytes.length,
    next: async () => {
      if (at >= bytes.length) return null
      const chunk = bytes.subarray(at, at + CHUNK_BYTES)
      at += chunk.length
      return chunk
    },
    cancel: async () => {
      at = bytes.length
    },
  }
}

function streamReader(stream: ReadableStream<Uint8Array>, size: number | undefined): ChunkReader {
  const reader = stream.getReader()
  return rechunk(
    async () => {
      const { value, done } = await reader.read()
      return done ? null : value
    },
    async () => {
      await reader.cancel().catch(() => {})
    },
    size,
  )
}

function iterableReader(iterable: AsyncIterable<Uint8Array>): ChunkReader {
  const iterator = iterable[Symbol.asyncIterator]()
  return rechunk(
    async () => {
      const { value, done } = await iterator.next()
      return done ? null : value
    },
    async () => {
      await iterator.return?.().catch(() => {})
    },
    undefined,
  )
}

/** Splits whatever the source yields into chunks of at most CHUNK_BYTES, holding one source chunk at a time. */
function rechunk(pull: () => Promise<Uint8Array | null>, release: () => Promise<void>, size: number | undefined): ChunkReader {
  let held: Uint8Array | null = null
  let ended = false
  return {
    size,
    async next() {
      while (!held || held.length === 0) {
        if (ended) return null
        const value = await pull()
        if (value === null) {
          ended = true
          return null
        }
        if (!(value instanceof Uint8Array)) throw new TypeError("a source yielded something other than bytes")
        held = value
      }
      const chunk: Uint8Array = held.subarray(0, CHUNK_BYTES)
      held = held.length > CHUNK_BYTES ? held.subarray(CHUNK_BYTES) : null
      return chunk
    },
    async cancel() {
      ended = true
      held = null
      await release()
    },
  }
}
