const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export type ParsedName = {
  name: string
  extension: string | null
}

export function isValidLabel(label: string): boolean {
  return label.length > 0 && label.length <= 63 && LABEL_RE.test(label)
}

/** Lowercase, trim, strip leading/trailing dots. */
export function normalizeLabel(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
}

/**
 * " Example.COM. " -> { name: "example", extension: "com" }
 * "example"        -> { name: "example", extension: null }
 * Invalid input    -> null
 */
export function parseName(raw: string): ParsedName | null {
  const input = normalizeLabel(raw)
  if (!input || input.length > 253) return null

  const labels = input.split('.')
  const extension = labels.length > 1 ? labels.pop()! : null

  if (extension !== null && !isValidLabel(extension)) return null
  if (labels.length < 1 || !labels.every(isValidLabel)) return null

  return { name: labels.join('.'), extension }
}
