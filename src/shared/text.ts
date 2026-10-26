/**
 * Text helpers shared by the main process and the window.
 */

/**
 * Invisible, look-alike-blank or direction-changing characters that can make an approval card lie:
 * control characters (C0, DEL, C1), zero-width and bidi controls, soft hyphen, Arabic letter mark,
 * Hangul fillers, line/paragraph separators, BOM, and Unicode tag characters (\"ASCII smuggling\").
 * Written as escapes on purpose, so this file contains no invisible characters itself.
 */
export const DECEPTIVE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\u2800\u3000\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u

/** Make hidden characters visible as ⟦U+202E⟧, so text (a command, a file name) shows what it really is. */
export function revealHidden(text: string): string {
  return text.replace(new RegExp(DECEPTIVE_CHARS.source, 'gu'), (c) => `⟦U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`)
}

/**
 * The characters that can make code look different from how it runs ("Trojan Source"): control characters,
 * bidi overrides and isolates, zero-width spaces and marks, BOM and tag characters. Narrower than
 * DECEPTIVE_CHARS on purpose, so emoji (zero-width joiner, variation selectors) and CJK text in code show normally.
 */
export const CODE_HIDDEN_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u

/** Code line with only CODE_HIDDEN_CHARS made visible. */
export function revealCodeHidden(text: string): string {
  return text.replace(new RegExp(CODE_HIDDEN_CHARS.source, 'gu'), (c) => `⟦U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`)
}

/** True if the text has any hidden character. */
export function hasHidden(text: string): boolean {
  return new RegExp(DECEPTIVE_CHARS.source, 'u').test(text)
}

/** Remove hidden characters, keeping tabs and line breaks. */
export function stripHidden(text: string): string {
  return text.replace(new RegExp(DECEPTIVE_CHARS.source, 'gu'), '')
}

/**
 * The only links Hangar will offer to open in your browser: https, no user name or password in the
 * address, and a real host. Returns the normalised URL, or null.
 */
export function safeExternalUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null
  return u.href
}

/**
 * First meaningful line of a report or summary, for one-line previews: Markdown heading, list and quote
 * markers dropped, hidden characters removed, capped at 140 characters.
 */
export function firstLine(text: string): string {
  const lines = stripHidden(text).split('\n')
  const clean = (l: string): string => l.replace(/^[#>*\-+\s]+/, '').replace(/^\d+[.)]\s+/, '').replace(/\*\*/g, '').trim()
  // Section headings ("## Built", "**Built:**") say nothing on their own: prefer the first real line under them.
  const heading = (l: string): boolean => /^\s*#{1,6}\s/.test(l) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(l)
  const line = lines.filter((l) => !heading(l)).map(clean).find(Boolean) ?? lines.map(clean).find(Boolean) ?? ''
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/**
 * "---" front matter at the top of a Markdown file: the same rule roles.ts uses to read a role's tools, model and
 * mode, so what Hangar shows as front matter is exactly what agents get as settings. Anchored, so linear.
 */
export const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

/** Obsidian note text made readable in Hangar: front matter dropped, [[Note|alias]] links shown as their names. */
export function readableNote(text: string): string {
  const body = text.replace(FRONT_MATTER, '')
  return body.replace(/\[\[([^\]|\n]{1,200})(?:\|([^\]\n]{1,200}))?\]\]/g, (_, name: string, alias?: string) => alias ?? name)
}
