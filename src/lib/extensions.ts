import { isValidLabel, normalizeLabel } from './domain.ts'

/** Default set used when the request does not specify extensions. */
export const SUPPORTED_EXTENSIONS = ['com', 'net', 'org', 'io', 'dev', 'app', 'id']

export type ResolvedExtensions = {
  /** Ordered, deduplicated extensions: the one from `name` first, then the requested order. */
  extensions: string[]
  /** Requested entries that are not valid extension labels. */
  invalid: string[]
}

export function resolveExtensions(
  fromName: string | null,
  requested: readonly string[] | null,
): ResolvedExtensions {
  const source = requested && requested.length > 0 ? requested : SUPPORTED_EXTENSIONS
  const extensions: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  const push = (raw: string) => {
    const ext = normalizeLabel(raw)
    if (!isValidLabel(ext)) {
      invalid.push(raw)
      return
    }
    if (!seen.has(ext)) {
      seen.add(ext)
      extensions.push(ext)
    }
  }

  if (fromName) push(fromName)
  for (const raw of source) push(raw)

  return { extensions, invalid }
}
