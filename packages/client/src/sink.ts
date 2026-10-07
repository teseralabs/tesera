import { TeseraError } from "./errors.js"

/**
 * Where a transfer writes. A `WritableStream` covers a file from the File System Access API
 * (`showSaveFilePicker` or the origin private file system), which writes straight to disk.
 * Each write resolves before the next is made, so a slow sink slows the transfer instead of
 * queueing output in memory.
 */
export type Sink = WritableStream<Uint8Array> | SinkWriter

export interface SinkWriter {
  write(chunk: Uint8Array): void | Promise<void>
  /** Called once after the last chunk. */
  close?(): void | Promise<void>
  /** Called instead of `close` when the transfer fails or is cancelled. */
  abort?(reason: unknown): void | Promise<void>
}

export type OpenSink = {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  abort(reason: unknown): Promise<void>
}

export function writeSink(sink: Sink): OpenSink {
  if (typeof WritableStream !== "undefined" && sink instanceof WritableStream) {
    const writer = sink.getWriter()
    return {
      write: async (chunk) => {
        await writer.ready
        await writer.write(chunk)
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }
  }
  if (!sink || typeof (sink as SinkWriter).write !== "function") {
    throw new TeseraError("invalid", "a sink must be a WritableStream or have a write method")
  }
  const writer = sink as SinkWriter
  return {
    write: async (chunk) => {
      await writer.write(chunk)
    },
    close: async () => {
      await writer.close?.()
    },
    abort: async (reason) => {
      await writer.abort?.(reason)
    },
  }
}

/** Parts this large are folded into the Blob, so the browser, not the JavaScript heap, holds them. */
const FOLD_BYTES = 8 * 1024 * 1024

/**
 * The fallback for a browser with no streaming file sink: collect the transfer into a `Blob`.
 *
 * This holds the whole transfer in memory. The bytes move out of the JavaScript heap into the
 * browser's blob storage every 8 MiB, which Chrome may page to disk, but other browsers keep in RAM.
 * `maxBytes` is required because the practical limit depends on the device; a write past it fails
 * the transfer with a `sink` error rather than exhausting memory.
 */
export function memorySink(opts: { maxBytes: number; type?: string }): { sink: SinkWriter; blob(): Blob } {
  if (!(opts.maxBytes > 0)) throw new TeseraError("invalid", "memorySink needs a positive maxBytes")
  let folded = new Blob([], { type: opts.type ?? "" })
  let parts: Uint8Array[] = []
  let pending = 0
  let total = 0
  const fold = () => {
    folded = new Blob([folded, ...(parts as BlobPart[])], { type: opts.type ?? "" })
    parts = []
    pending = 0
  }
  return {
    sink: {
      write(chunk) {
        total += chunk.length
        if (total > opts.maxBytes) throw new TeseraError("sink", `the transfer is larger than this memory sink's ${opts.maxBytes} bytes`)
        parts.push(chunk.slice())
        pending += chunk.length
        if (pending >= FOLD_BYTES) fold()
      },
      close: fold,
      abort() {
        parts = []
        folded = new Blob([])
      },
    },
    blob: () => {
      if (parts.length > 0) fold()
      return folded
    },
  }
}
