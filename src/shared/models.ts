/**
 * The Claude models Hangar offers, in one place: every model picker (Settings, New game, Project, roles) lists these,
 * and model names saved by hand ("claude-opus-5.5", "Opus 5.5", "opus") are read as the model they mean.
 */
export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'fast and capable, the everyday choice' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'most capable, costs more' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'quickest and cheapest' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'writing and design' }
] as const

export type ModelId = (typeof MODELS)[number]['id']

export const DEFAULT_MODEL: ModelId = 'claude-sonnet-5-5'

/** "Opus 5.5 (most capable, costs more)", or the name itself for one Hangar doesn't know. */
export function modelLabel(id: string): string {
  const m = MODELS.find((x) => x.id === id)
  return m ? `${m.label} (${m.hint})` : id
}

/**
 * A saved model name as the model it means: dots and spaces read as dashes, "Opus 5.5" and plain "opus" work too.
 * Empty or "inherit" means none (use the default). A name Hangar doesn't know is kept as written (a newer model
 * may be fine), trimmed and cut to a sensible length.
 */
export function normalizeModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text || /^inherit$/i.test(text)) return null
  const key = text
    .toLowerCase()
    .replace(/^anthropic[/.]/, '')
    .replace(/[\s._]+/g, '-')
  const id = key.startsWith('claude-') ? key : `claude-${key}`
  const known = MODELS.find((m) => m.id === id)
  if (known) return known.id
  // A bare family name ("opus", "claude-sonnet") means the one Hangar offers.
  const family = MODELS.find((m) => `claude-${m.id.split('-')[1]}` === id)
  if (family) return family.id
  return text.slice(0, 100)
}

export function isKnownModel(id: string | null | undefined): boolean {
  return !!id && MODELS.some((m) => m.id === id)
}
