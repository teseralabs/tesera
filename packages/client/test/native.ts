// Loads tesera's native build from the repository's dist, with node:crypto and real UDP relays, so
// a test can set the client's bundled code against it. Run `npm run build` at the repository root first.
const root = new URL("../../../../dist/src/", import.meta.url)

export async function native<T = Record<string, any>>(path: string): Promise<T> {
  return (await import(new URL(path, root).href)) as T
}

export const rootDir = new URL("../../../../", import.meta.url)
