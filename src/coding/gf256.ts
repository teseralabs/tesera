const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
const MUL = new Uint8Array(256 * 256)

let x = 1
for (let i = 0; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x <<= 1
  if ((x & 0x100) !== 0) x ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] ?? 0

for (let a = 0; a < 256; a++) {
  for (let b = 0; b < 256; b++) {
    MUL[(a << 8) | b] = a === 0 || b === 0 ? 0 : (EXP[(LOG[a] ?? 0) + (LOG[b] ?? 0)] ?? 0)
  }
}

export function gfMul(a: number, b: number): number {
  return MUL[(a << 8) | b] ?? 0
}

export function gfInv(a: number): number {
  if (a === 0) throw new Error("inverse of zero in GF(256)")
  return EXP[255 - (LOG[a] ?? 0)] ?? 0
}

export function gfPow(a: number, exponent: number): number {
  if (exponent === 0) return 1
  if (a === 0) return 0
  return EXP[((LOG[a] ?? 0) * exponent) % 255] ?? 0
}

/** Gauss-Jordan inverse over GF(256). Input must be square; it is not mutated. */
export function invertMatrix(source: number[][]): number[][] {
  const n = source.length
  if (n === 0 || source.some((row) => row.length !== n)) {
    throw new Error("matrix must be square")
  }
  const a = source.map((row, i) => {
    const augmented = row.slice()
    for (let j = 0; j < n; j++) augmented.push(i === j ? 1 : 0)
    return augmented
  })
  const width = n * 2
  for (let col = 0; col < n; col++) {
    let pivot = col
    while (pivot < n && a[pivot]?.[col] === 0) pivot++
    const pivotRow = a[pivot]
    if (pivot === n || !pivotRow) throw new Error("singular matrix")
    if (pivot !== col) a[pivot] = a[col] ?? pivotRow
    a[col] = pivotRow
    const scale = gfInv(pivotRow[col] ?? 0)
    for (let j = 0; j < width; j++) pivotRow[j] = gfMul(pivotRow[j] ?? 0, scale)
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const current = a[row]
      if (!current) throw new Error("singular matrix")
      const factor = current[col] ?? 0
      if (factor === 0) continue
      for (let j = 0; j < width; j++) {
        current[j] = (current[j] ?? 0) ^ gfMul(factor, pivotRow[j] ?? 0)
      }
    }
  }
  return a.map((row) => row.slice(n))
}
