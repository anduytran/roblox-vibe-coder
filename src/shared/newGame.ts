/**
 * New game helpers shared by the wizard and the tests: a name guessed from the idea, and which checks
 * the tools on this computer allow.
 */
import { DECEPTIVE_CHARS } from './text'

const MAX_TITLE = 40
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length
/** Letters, digits, spaces and a little punctuation; no hidden characters or markdown. */
const tidy = (s: string): string =>
  s
    .replace(new RegExp(DECEPTIVE_CHARS.source, 'gu'), '')
    .replace(/[*_`#>[\]"“”]/g, '')
    .replace(/[^\p{L}\p{N} '!&.,:–—-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.,:–—-]+$/, '')

/** A design doc's own title: its first top heading, without "Game design document:" and the like. */
function docTitle(doc: { name: string; text: string }): string {
  const heading = doc.text
    .split('\n', 40)
    .map((l) => /^#{1,2}\s+(.+)$/.exec(l.trim())?.[1])
    .find(Boolean)
  const generic = /^(game\s+)?(design(\s+doc(ument)?)?|gdd|brief|game\s+brief|readme|notes?|doc(ument)?|game|draft|final|v\d+)$/i
  const strip = (s: string): string =>
    tidy(s)
      .replace(/^(game\s+design\s+document|game\s+design|design\s+document|design\s+doc|gdd|game\s+brief|brief|design)\s*[:—–-]\s*/i, '')
      .replace(/\s*[—–-]\s*(game\s+design\s+document|game\s+design|design\s+document|design\s+doc|gdd|brief)$/i, '')
  const fromHeading = heading ? strip(heading) : ''
  if (fromHeading && !generic.test(fromHeading) && fromHeading.length <= MAX_TITLE && words(fromHeading) <= 6) return fromHeading
  const fromFile = strip(doc.name.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[-_]+/g, ' '))
    .split(' ')
    .filter((w) => !generic.test(w))
    .join(' ')
  if (!fromFile || fromFile.length > MAX_TITLE) return ''
  // sky-courier.md reads better as "Sky Courier".
  return fromFile === fromFile.toLowerCase() ? fromFile.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()) : fromFile
}

/** A title the user put at the start of the idea: "Sky Courier: glide between islands…", or a short first line. */
function ideaTitle(idea: string): string {
  const lines = idea.split('\n').map((l) => l.trim())
  const first = lines.findIndex(Boolean)
  if (first < 0) return ''
  const line = lines[first]!.replace(/^[#>*\s-]+/, '')
  const lead = /^(.{2,40}?)(?::|\s+[-–—])\s+\S/.exec(line)?.[1]
  if (lead && words(lead) <= 5) return tidy(lead)
  const more = lines.slice(first + 1).some(Boolean)
  if (more && line.length <= MAX_TITLE && words(line) <= 6 && !/[.!?,;]$/.test(line)) return tidy(line)
  return ''
}

/** A name for the game when the user hasn't typed one, or '' when nothing in the idea looks like a title. */
export function suggestGameName(idea: string, doc: { name: string; text: string } | null = null): string {
  return ideaTitle(idea) || (doc ? docTitle(doc) : '')
}

/** The checks a new game gets, each kept only when its tool is installed (matches what the main process sets up). */
export const NEW_GAME_CHECKS = [
  { name: 'Format', tool: 'stylua' },
  { name: 'Lint', tool: 'selene' },
  { name: 'Build', tool: 'rojo' }
] as const

export function checksFor(tools: { rojo: boolean; selene: boolean; stylua: boolean }): { on: string[]; missing: string[] } {
  return {
    on: NEW_GAME_CHECKS.filter((c) => tools[c.tool]).map((c) => c.name),
    missing: NEW_GAME_CHECKS.filter((c) => !tools[c.tool]).map((c) => c.tool)
  }
}
