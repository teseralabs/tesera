/**
 * Places the k required tesserae on the lowest-cost relays whose delay is
 * within 2× of the best, sharing a relay when the others are slower. Parity
 * goes out only on a spare relay inside that same band. Every 16th spread
 * assignment probes one spare relay so a path that recovers can be found again.
 *
 * Before any sample, every relay looks the same and the block spreads out.
 * Cost then follows a smoothed per-tessera round trip. A lower round trip
 * does not take the block: every path inside the band still shares it.
 * A path that never answers is dropped immediately. A path that keeps
 * dropping, once that is clear from several tesserae, falls out of the band
 * even when other tesserae already finished the block. One late tessera does not.
 *
 * A later tessera on another relay of the same block is slower when those
 * relays share one queue. Delay alone is not that signal: a relay with its own
 * pipe also looks slower while it is busy, and a slower relay looks slow even
 * when it is sent first. While the queue is shared, the k data tesserae keep
 * rotating across different relays and parity waits until a relay misses.
 *
 * If every path used by a block fails together, and no block has failed on
 * only some of its paths, later blocks stay on the best path and parity is
 * skipped. A later block that fails on only some of its paths resumes sharing.
 */

const UNKNOWN_MS = 30
const MIN_JOINT_TRIALS = 4
const JOINT_RATE = 0.6
const LOSS_EVIDENCE = 8
/** Later-tessera gap, in ms, that means the relays are in one queue. */
const QUEUE_ENTER_MS = 0.75
const QUEUE_LEAVE_MS = 0.2
const QUEUE_EVIDENCE = 6
const QUEUE_GAPS = 40

type Cohort = { paths: Set<number>; ok: Set<number>; bad: Set<number>; open: number }

type Load = { cohort: number; seq: number; base: number }

type CohortSample = { relay: number; seq: number; rtt: number; base: number }

export class PathScheduler {
  private readonly rtt: number[]
  private readonly delivered: number[]
  private readonly lost: number[]
  private readonly openLoss = new Map<number, number>()
  private nextToken = 1
  private readonly inflight: number[]
  private readonly sent: number[]
  private readonly strikes: number[]
  private readonly cohorts = new Map<number, Cohort>()
  private anyObserved = false
  private plans = 0
  private nextCohort = 0
  private activeCohort = -1
  private coupled = false
  private joint = 0
  private split = 0
  private seq = 0
  private spin = 0
  private queueShared = false
  private readonly loadQ: Load[][]
  private readonly cohortSamples = new Map<number, CohortSample[]>()
  private readonly cohortExpected = new Map<number, number>()
  private readonly cohortDone = new Map<number, number>()
  private readonly gaps: number[] = []

  constructor(
    private readonly pathCount: number,
    private readonly k: number,
    private readonly n: number,
  ) {
    if (!Number.isInteger(pathCount) || pathCount < 1) throw new Error("need at least one relay")
    if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || n < k) {
      throw new Error(`invalid code k=${k} n=${n}`)
    }
    const zeros = () => Array.from({ length: pathCount }, () => 0)
    this.rtt = zeros()
    this.delivered = zeros()
    this.lost = zeros()
    this.inflight = zeros()
    this.sent = zeros()
    this.strikes = zeros()
    this.loadQ = Array.from({ length: pathCount }, () => [])
  }

  get hasObservation(): boolean {
    return this.anyObserved
  }

  /** True once blocks are failing on every path at once. */
  get sharesFate(): boolean {
    return this.coupled
  }

  /** True once later tesserae on other relays are waiting in the same queue. */
  get sharesQueue(): boolean {
    return this.queueShared
  }

  /** Relay per tessera index. null means skip that parity tessera. */
  plan(): Array<number | null> {
    if (this.coupled || this.lossCoupled()) {
      this.coupled = true
      this.activeCohort = -1
      return this.soloPlan()
    }
    const cohort = this.nextCohort++
    this.activeCohort = cohort
    this.cohorts.set(cohort, { paths: new Set(), ok: new Set(), bad: new Set(), open: 0 })
    if (this.queueShared) {
      const striped = this.stripePlan()
      if (striped) return striped
    }
    return this.spreadPlan()
  }

  /** How long a covered tessera may stay quiet before it counts as loss. */
  lossWaitMs(relay: number): number {
    this.at(relay)
    const rtt = this.rtt[relay] ?? 0
    if (rtt <= 0) return 40
    return Math.max(30, rtt * 8)
  }

  /**
   * How long a tessera may sit unanswered before a resend. Zero until a
   * round trip has been measured. Three trips covers a queue that grew
   * after the static timer was chosen.
   */
  repairHoldMs(relay: number): number {
    this.at(relay)
    const rtt = this.rtt[relay] ?? 0
    if (rtt <= 0) return 0
    return rtt * 3
  }

  /**
   * Relay a retransmission should use right now. A path that died keeps its old round trip
   * and sheds its queue with every miss, so it looks idle. A path that missed since its last
   * answer is used only when every path has.
   */
  best(): number {
    const extra = Array.from({ length: this.pathCount }, () => 0)
    const ceiling = this.bestBase() * 2
    const clear = (relay: number) => (this.strikes[relay] ?? 0) === 0
    return (
      this.pick(extra, (candidate) => clear(candidate) && this.base(candidate) <= ceiling) ??
      this.pick(extra, clear) ??
      this.pick(extra, (candidate) => this.base(candidate) <= ceiling) ??
      this.pick(extra, () => true) ??
      0
    )
  }

  /** Returns the block id used to tell a shared failure from a split one. */
  noteSend(relay: number, measure = true): number {
    this.at(relay)
    this.sent[relay] = (this.sent[relay] ?? 0) + 1
    this.inflight[relay] = (this.inflight[relay] ?? 0) + 1
    const cohort = measure ? this.activeCohort : -1
    let recorded = -1
    if (cohort >= 0) {
      const group = this.cohorts.get(cohort)
      if (group) {
        group.paths.add(relay)
        group.open++
        recorded = cohort
      }
    }
    if (recorded >= 0) this.cohortExpected.set(recorded, (this.cohortExpected.get(recorded) ?? 0) + 1)
    this.loadQ[relay]?.push({ cohort: recorded, seq: this.seq++, base: this.rtt[relay] ?? 0 })
    return recorded
  }

  observe(relay: number, rttMs: number, cohort = -1): void {
    this.release(relay)
    this.noteRtt(relay, rttMs, cohort)
  }

  /** Record a round trip after the send's inflight slot was already released. */
  noteRtt(relay: number, rttMs: number, cohort = -1, deliveredToken = 0): void {
    this.at(relay)
    const load = this.loadQ[relay]?.shift()
    const sample = Math.max(0.1, rttMs)
    if (load && load.cohort >= 0) {
      const list = this.cohortSamples.get(load.cohort) ?? []
      list.push({ relay, seq: load.seq, rtt: sample, base: load.base })
      this.cohortSamples.set(load.cohort, list)
    }
    const prev = this.rtt[relay] ?? 0
    this.rtt[relay] = prev === 0 ? sample : prev * 0.8 + sample * 0.2
    this.strikes[relay] = Math.max(0, (this.strikes[relay] ?? 0) - 1)
    this.anyObserved = true
    if (deliveredToken > 0) this.deliver(relay, deliveredToken)
    else this.delivered[relay] = (this.delivered[relay] ?? 0) + 1
    this.finish(cohort, relay, true)
    if (load && load.cohort >= 0) this.markCohort(load.cohort)
  }

  /** The block finished without a sample for this send. */
  release(relay: number): void {
    this.at(relay)
    this.inflight[relay] = Math.max(0, (this.inflight[relay] ?? 0) - 1)
  }

  /**
   * The block finished without this tessera. Shared fate ignores it.
   * The path is blamed only if the tessera never comes back.
   */
  dismiss(cohort: number): void {
    this.finish(cohort, -1, false, true)
  }

  /** A tessera was still missing after the block had already completed. No strike. */
  noteLost(relay: number): void {
    this.at(relay)
    this.lost[relay] = (this.lost[relay] ?? 0) + 1
  }

  /**
   * The block finished without this tessera. It counts as loss only if no
   * sample arrives before the path's wait expires.
   */
  noteUnanswered(relay: number): number {
    this.at(relay)
    const token = this.nextToken++
    this.openLoss.set(token, relay)
    return token
  }

  /** The sample for an unanswered tessera arrived. */
  deliver(relay: number, token: number): void {
    this.at(relay)
    if (token <= 0 || !this.openLoss.delete(token)) return
    this.delivered[relay] = (this.delivered[relay] ?? 0) + 1
  }

  /** The wait expired and the sample never arrived. */
  confirmLost(token: number): void {
    const relay = this.openLoss.get(token)
    if (relay === undefined) return
    this.openLoss.delete(token)
    this.lost[relay] = (this.lost[relay] ?? 0) + 1
    const load = this.loadQ[relay]?.shift()
    if (load && load.cohort >= 0) this.markCohort(load.cohort)
  }

  /** A sent tessera was still missing when we gave up waiting for it. */
  miss(relay: number, cohort = -1): void {
    this.at(relay)
    const load = this.loadQ[relay]?.shift()
    this.release(relay)
    this.strikes[relay] = (this.strikes[relay] ?? 0) + 1
    this.finish(cohort, relay, false)
    if (load && load.cohort >= 0) this.markCohort(load.cohort)
  }

  /**
   * Data tesserae rotate across relays that share a queue. Parity stays
   * back until a relay misses. Returns null when fewer than two relays
   * can take a tessera.
   */
  private stripePlan(): Array<number | null> | null {
    const ceiling = this.bestBase() * 2
    const usable: number[] = []
    for (let relay = 0; relay < this.pathCount; relay++) {
      if (this.base(relay) <= ceiling) usable.push(relay)
    }
    if (usable.length < 2) return null
    const out: Array<number | null> = Array.from({ length: this.n }, () => null)
    const start = this.spin % usable.length
    this.spin++
    const used = new Set<number>()
    for (let frag = 0; frag < this.k; frag++) {
      const relay = usable[(start + frag) % usable.length]
      if (relay === undefined) throw new Error("no relay for a required tessera")
      used.add(relay)
      out[frag] = relay
    }
    if (!this.anyStrike()) return out
    for (let frag = this.k; frag < this.n; frag++) {
      let spare: number | null = null
      for (let step = 0; step < this.pathCount; step++) {
        const relay = (start + this.k + step) % this.pathCount
        if (used.has(relay)) continue
        if (this.base(relay) > ceiling) continue
        spare = relay
        break
      }
      if (spare === null) break
      used.add(spare)
      out[frag] = spare
    }
    return out
  }

  private anyStrike(): boolean {
    return this.strikes.some((count) => count > 0)
  }

  private markCohort(cohort: number): void {
    const done = (this.cohortDone.get(cohort) ?? 0) + 1
    this.cohortDone.set(cohort, done)
    const expected = this.cohortExpected.get(cohort) ?? 0
    if (expected > 0 && done >= expected) this.closeCohort(cohort)
  }

  private closeCohort(cohort: number): void {
    const list = this.cohortSamples.get(cohort)
    this.cohortSamples.delete(cohort)
    this.cohortExpected.delete(cohort)
    this.cohortDone.delete(cohort)
    if (!list || list.length < 2) return
    const ordered = [...list].sort((a, b) => a.seq - b.seq)
    const heldParity = list.length <= this.k
    // With parity held back, two data tesserae no longer show the queue.
    // A later block that sends parity again is what may clear the decision.
    if (this.queueShared && heldParity) return
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1]
      const next = ordered[i]
      if (!prev || !next || prev.relay === next.relay) continue
      const gap = next.rtt - prev.rtt
      const scale = Math.max(prev.rtt, next.rtt, 1)
      if (Math.abs(gap) > 15 && Math.abs(gap) > scale * 0.5) continue
      const prevBase = prev.base
      const nextBase = next.base
      if (prevBase > 0 && nextBase > 0) {
        const hi = Math.max(prevBase, nextBase)
        const lo = Math.min(prevBase, nextBase)
        if (hi / lo > 1.5) continue
      }
      this.gaps.push(gap)
    }
    if (this.gaps.length > QUEUE_GAPS) this.gaps.splice(0, this.gaps.length - QUEUE_GAPS)
    this.judgeQueue()
  }

  private judgeQueue(): void {
    if (this.gaps.length < QUEUE_EVIDENCE) return
    const sorted = [...this.gaps].sort((a, b) => a - b)
    const mid = sorted[Math.floor(sorted.length / 2)] ?? 0
    if (!this.queueShared && mid >= QUEUE_ENTER_MS) this.queueShared = true
    else if (this.queueShared && mid < QUEUE_LEAVE_MS) this.queueShared = false
  }

  private soloPlan(): Array<number | null> {
    const relay = this.best()
    const out: Array<number | null> = Array.from({ length: this.n }, () => null)
    for (let frag = 0; frag < this.k; frag++) out[frag] = relay
    return out
  }

  private spreadPlan(): Array<number | null> {
    const probe = this.anyObserved && this.plans % 16 === 0
    this.plans++
    const extra = Array.from({ length: this.pathCount }, () => 0)
    const out: Array<number | null> = Array.from({ length: this.n }, () => null)
    const used = new Set<number>()
    const ceiling = this.bestBase() * 2
    for (let frag = 0; frag < this.k; frag++) {
      const relay = this.pick(extra, (candidate) => this.base(candidate) <= ceiling) ?? this.pick(extra, () => true)
      if (relay === null) throw new Error("no relay for a required tessera")
      extra[relay] = (extra[relay] ?? 0) + 1
      used.add(relay)
      out[frag] = relay
    }
    let probed = false
    for (let frag = this.k; frag < this.n; frag++) {
      const relax = probe && !probed
      const relay = this.pick(extra, (candidate) => {
        if (used.has(candidate)) return false
        if (relax) return true
        return this.base(candidate) <= ceiling
      })
      if (relay === null) break
      if (relax) probed = true
      extra[relay] = (extra[relay] ?? 0) + 1
      used.add(relay)
      out[frag] = relay
    }
    return out
  }

  private lossCoupled(): boolean {
    if (this.split === 0 && this.joint >= 1) return true
    const trials = this.joint + this.split
    return trials >= MIN_JOINT_TRIALS && this.joint / trials > JOINT_RATE
  }

  private finish(cohort: number, relay: number, ok: boolean, ignore = false): void {
    if (cohort < 0) return
    const group = this.cohorts.get(cohort)
    if (!group) return
    group.open = Math.max(0, group.open - 1)
    if (!ignore) {
      if (ok) group.ok.add(relay)
      else if (relay >= 0) group.bad.add(relay)
    }
    if (group.open > 0) return
    this.cohorts.delete(cohort)
    if (group.paths.size < 2 || group.bad.size === 0) return
    if (group.ok.size === 0) this.joint++
    else {
      this.split++
      for (const relay of group.bad) this.lost[relay] = (this.lost[relay] ?? 0) + 1
    }
    this.coupled = this.lossCoupled()
  }

  private pick(extra: number[], accept: (relay: number) => boolean): number | null {
    let chosen = -1
    let bestCost = Infinity
    for (let relay = 0; relay < this.pathCount; relay++) {
      if (!accept(relay)) continue
      const cost = this.cost(relay, extra[relay] ?? 0)
      if (cost < bestCost) {
        bestCost = cost
        chosen = relay
      }
    }
    return chosen < 0 ? null : chosen
  }

  private cost(relay: number, extra: number): number {
    const queued = (this.inflight[relay] ?? 0) + extra
    return this.base(relay) * (queued + 1)
  }

  /** A queued path has a large delay. Loss is not compared while any path looks queued. */
  private anySlow(): boolean {
    for (const sample of this.rtt) if (sample > 15) return true
    return false
  }

  /** Lowest scored loss. Paths still gathering evidence are left out of the comparison. */
  private bestDrop(): number {
    let best = 1
    let any = false
    for (let relay = 0; relay < this.pathCount; relay++) {
      const scored = (this.delivered[relay] ?? 0) + (this.lost[relay] ?? 0)
      if (scored < LOSS_EVIDENCE) continue
      any = true
      const rate = (this.lost[relay] ?? 0) / scored
      if (rate < best) best = rate
    }
    return any ? best : 0
  }

  /** Zero until several tesserae have been scored, so one miss is not a verdict. */
  private dropRate(relay: number): number {
    const delivered = this.delivered[relay] ?? 0
    const lost = this.lost[relay] ?? 0
    const scored = delivered + lost
    if (scored < LOSS_EVIDENCE) return 0
    return lost / scored
  }

  private base(relay: number): number {
    const rtt = this.rtt[relay] ?? 0
    const strikes = this.strikes[relay] ?? 0
    if (rtt > 0) {
      if (rtt <= 15 && !this.anySlow()) {
        const best = this.bestDrop()
        const gap = this.dropRate(relay) - best
        if (best < 0.05 && gap > 0.25) return rtt * (1 + gap * 8)
      }
      return rtt
    }
    if (strikes > 0) return UNKNOWN_MS * (1 + (this.sent[relay] ?? 0)) * (1 + strikes)
    if (!this.anyObserved) return UNKNOWN_MS
    return Math.max(UNKNOWN_MS, this.bestMeasured() * 2)
  }

  private bestBase(): number {
    let best = Infinity
    for (let relay = 0; relay < this.pathCount; relay++) {
      const base = this.base(relay)
      if (base < best) best = base
    }
    return best
  }

  private bestMeasured(): number {
    let best = 0
    for (const sample of this.rtt) {
      if (sample > 0 && (best === 0 || sample < best)) best = sample
    }
    return best
  }

  private at(relay: number): void {
    if (!Number.isInteger(relay) || relay < 0 || relay >= this.pathCount) {
      throw new Error("relay index out of range")
    }
  }
}
