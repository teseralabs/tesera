// A Probe for benchmarks, the same in the page and in Node. Each note keeps a count, a sum, and a
// log-scale histogram, so percentiles come out without keeping every value. Each block step keeps
// one time per block, so lifecycles can be measured block by block. Some notes also go into
// 250 ms bins, for a view over time.

const BUCKETS = 200
/** 8 buckets per doubling, from 1 microsecond. */
const bucketOf = (value) => Math.max(0, Math.min(BUCKETS - 1, Math.floor(Math.log2(Math.max(value, 1e-3) * 1000 + 1) * 8)))
const bucketValue = (bucket) => (2 ** ((bucket + 0.5) / 8) - 1) / 1000
const BIN_MS = 250
const SERIES = new Set(["sender.inflight", "sender.open-window", "receiver.resident", "sender.sample-rtt", "sender.send", "wt.send"])

export function createProbe() {
  const notes = new Map()
  const steps = new Map()
  const series = new Map()
  const origin = performance.now()
  let blocks = 0
  const note = (name, value) => {
    let found = notes.get(name)
    if (!found) notes.set(name, (found = { count: 0, sum: 0, min: Infinity, max: -Infinity, hist: new Uint32Array(BUCKETS) }))
    found.count++
    found.sum += value
    if (value < found.min) found.min = value
    if (value > found.max) found.max = value
    found.hist[bucketOf(value)]++
    if (SERIES.has(name)) {
      const bin = Math.floor((performance.now() - origin) / BIN_MS)
      let list = series.get(name)
      if (!list) series.set(name, (list = []))
      const at = list[bin] ?? (list[bin] = [0, 0])
      at[0] += value
      at[1]++
    }
  }
  const step = (blockId, name, at) => {
    let list = steps.get(name)
    if (!list) steps.set(name, (list = { times: new Float64Array(1024) }))
    if (blockId >= list.times.length) {
      const grown = new Float64Array(Math.max(blockId + 1, list.times.length * 2))
      grown.set(list.times)
      list.times = grown
    }
    if (list.times[blockId] === 0) list.times[blockId] = at
    if (blockId + 1 > blocks) blocks = blockId + 1
  }
  return {
    note,
    step,
    /** Times are relative to performance.timeOrigin, so two processes on one machine can be compared. */
    summary() {
      const out = { notes: {}, lifecycles: {}, series: {}, blocks }
      for (const [name, found] of notes) out.notes[name] = describe(found)
      const pairs = [
        ["sender.open-to-sent", "open", "sent"],
        ["sender.sent-to-acked", "sent", "acked"],
        ["sender.open-to-acked", "open", "acked"],
        ["receiver.first-to-k", "first", "k"],
        ["receiver.k-to-ack", "k", "ack"],
        ["receiver.first-to-delivered", "first", "delivered"],
      ]
      for (const [name, from, to] of pairs) {
        const a = steps.get(from)?.times
        const b = steps.get(to)?.times
        if (!a || !b) continue
        const found = { count: 0, sum: 0, min: Infinity, max: -Infinity, hist: new Uint32Array(BUCKETS) }
        for (let id = 0; id < Math.min(a.length, b.length); id++) {
          if (!a[id] || !b[id]) continue
          const value = b[id] - a[id]
          found.count++
          found.sum += value
          if (value < found.min) found.min = value
          if (value > found.max) found.max = value
          found.hist[bucketOf(value)]++
        }
        if (found.count) out.lifecycles[name] = describe(found)
      }
      for (const [name, list] of series) out.series[name] = Array.from(list, (at) => (at ? round(at[0] / at[1]) : null))
      const rate = (name) => {
        const times = steps.get(name)?.times
        if (!times) return null
        const bins = []
        for (let id = 0; id < times.length; id++) {
          if (!times[id]) continue
          const bin = Math.floor((times[id] - origin) / BIN_MS)
          bins[bin] = (bins[bin] ?? 0) + 1
        }
        return Array.from(bins, (count) => count ?? 0)
      }
      out.series["blocks-acked"] = rate("acked")
      out.series["blocks-delivered"] = rate("delivered")
      out.epoch = {}
      for (const [name, list] of steps) {
        const times = []
        for (let id = 0; id < blocks; id += 16) times.push(list.times[id] ? round(performance.timeOrigin + list.times[id]) : 0)
        out.epoch[name] = times
      }
      return out
    },
  }
}

function describe(found) {
  const at = (share) => {
    const want = found.count * share
    let seen = 0
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      seen += found.hist[bucket]
      if (seen >= want) return round(bucketValue(bucket))
    }
    return round(found.max)
  }
  return { count: found.count, sum: round(found.sum), mean: round(found.sum / found.count), min: round(found.min), p50: at(0.5), p90: at(0.9), p99: at(0.99), max: round(found.max) }
}

const round = (value) => Math.round(value * 1000) / 1000
