/** Run `fn` over `items` with at most `limit` in flight, preserving input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (cursor < items.length) {
        const i = cursor++
        results[i] = await fn(items[i])
      }
    },
  )

  await Promise.all(workers)
  return results
}
