/**
 * Reads a sprint check-in. Autopilot asks the Lead for four sections:
 *   ## Built   ## Try it   ## Next sprint   ## Questions for you
 * This splits them so the Overview can show each one, list the plan as items you can reorder, and give every
 * question its own answer box. Pure; anything it can't recognise is left to the plain-text fallback.
 */
import { stripHidden } from './text'

export interface Checkin {
  /** Anything the Lead wrote before the first section. */
  intro: string
  built: string
  tryIt: string
  /** Next sprint's plan, one item per entry, in the Lead's order. */
  next: string[]
  questions: string[]
  /** False when the report doesn't have the expected sections (show it as plain text instead). */
  structured: boolean
}

type Section = 'built' | 'tryIt' | 'next' | 'questions'

function sectionOf(heading: string): Section | null {
  const h = heading.toLowerCase()
  if (/^built\b|^what (was |we )?built/.test(h)) return 'built'
  if (/^try it|^how to (try|test|play)/.test(h)) return 'tryIt'
  if (/^next( sprint)?\b|^plan\b/.test(h)) return 'next'
  if (/^questions?\b|^open questions/.test(h)) return 'questions'
  return null
}

// Linear patterns only (no lazy group before an optional tail): long lines can't make them backtrack.
const HEADING = /^\s{0,3}(?:#{1,6}[ \t]+(.*)|\*\*([^*\n]{1,200})\*\*:?[ \t]*)$/
const ITEM = /^(\s{0,12})(?:[-*+]|\d{1,3}[.)])\s+(.*)$/

/** A "---" / "***" / "___" divider line. */
function isRule(t: string): boolean {
  const c = t.replace(/\s/g, '')
  return c.length >= 3 && /^(?:-+|\*+|_+)$/.test(c)
}

/** A ``` or ~~~ line that opens or closes a code block. */
const isFence = (t: string): boolean => t.startsWith('```') || t.startsWith('~~~')

/** "**text**" or "**text**:" as plain text (a whole line in bold says nothing more than the text). */
function unbold(t: string): string {
  const end = t.endsWith('**:') ? t.length - 3 : t.endsWith('**') ? t.length - 2 : -1
  return t.startsWith('**') && end > 2 ? t.slice(2, end).trim() + (t.endsWith(':') ? ':' : '') : t
}

interface Line {
  text: string
  /** True for a list item, false for a plain line of text. */
  item: boolean
}

/**
 * A section's lines. Continuation lines join the line above; more-indented sub-items join their parent after a dash;
 * dividers and code blocks are left out (they're in the full report).
 */
function lines(body: string): Line[] {
  const out: Line[] = []
  let base = -1
  let fence = false
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (isFence(t)) {
      fence = !fence
      continue
    }
    if (fence || !t || isRule(t)) continue
    const m = ITEM.exec(line)
    const last = out[out.length - 1]
    if (m) {
      const indent = m[1]!.length
      if (base < 0) base = indent
      const text = unbold(m[2]!.trim())
      if (indent > base && last) last.text += ` — ${text}`
      else out.push({ text, item: true })
    } else if (last && /^\s{2,}\S/.test(line)) last.text += ` ${t}`
    else out.push({ text: unbold(t), item: false })
  }
  return out.filter((l) => l.text)
}

/** The plan, one entry per item. A lead-in line ending in ':' before the list is dropped. */
function planItems(body: string): string[] {
  const all = lines(body)
  const firstItem = all.findIndex((l) => l.item)
  return all
    .filter((l, i) => !(firstItem >= 0 && i < firstItem && !l.item && l.text.endsWith(':')))
    .map((l) => l.text)
    .slice(0, 30)
}

/**
 * The questions, one entry each. A question followed by a list of answers that aren't questions themselves
 * ("Should gliding cost stamina?" then "- Yes" "- No") is one question with its options; a lead-in line
 * ending in ':' before a list of questions is dropped.
 */
function questionItems(body: string): string[] {
  const all = lines(body)
  const out: string[] = []
  for (let i = 0; i < all.length; i++) {
    const l = all[i]!
    let j = i + 1
    while (j < all.length && all[j]!.item) j++
    const list = l.item ? [] : all.slice(i + 1, j)
    const asks = l.text.endsWith('?') || l.text.endsWith(':')
    if (list.length && asks && !list.some((x) => x.text.endsWith('?'))) {
      const options = list.map((x) => x.text).join(' / ')
      out.push(l.text.endsWith('?') ? `${l.text} (${options})` : `${l.text} ${options}`)
      i = j - 1
    } else if (!(list.length && !l.item && l.text.endsWith(':'))) out.push(l.text)
  }
  return out.slice(0, 30)
}

/** Heading text without trailing spaces and closing '#'s (a loop, so a long run of '#' stays linear). */
function trimClosing(s: string): string {
  let end = s.length
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t' || s[end - 1] === '#')) end--
  return s.slice(0, end).trim()
}

/** How deep a heading is: its number of '#', or below every '#' level for a bold line. */
function levelOf(line: string): number {
  const t = line.trimStart()
  let n = 0
  while (n < t.length && t[n] === '#') n++
  return n || 7
}

/** "None", "No questions", "N/A": a plan item that says there's nothing. */
const NOTHING = /^(none|no( open)? questions?( (right now|for now|this (time|sprint)))?|n\/a|nothing( yet)?)[.!]?$/i
/** "None — keep going!", "No decisions needed this sprint.": a question line that isn't a question. */
const NO_QUESTIONS = /^[*_]*(none|nothing|n\/a|no (open )?(questions|decisions))\b[^?]{0,60}$/i

export function parseCheckin(raw: string): Checkin {
  const text = stripHidden(String(raw ?? '')).replace(/\r\n?/g, '\n').slice(0, 50_000)
  const parts: Record<Section, string[]> = { built: [], tryIt: [], next: [], questions: [] }
  const intro: string[] = []
  const found = new Set<Section>()
  let current: Section | null = null
  let level = 0
  // Inside a code block a '#' line is a comment, not a heading.
  let fence = false
  for (const line of text.split('\n')) {
    if (isFence(line.trim())) fence = !fence
    const h = fence ? null : HEADING.exec(line)
    // A bold or '#' line that asks something is a question, not a heading.
    const title = h ? trimClosing(h[1] ?? h[2] ?? '') : ''
    if (h && !title.endsWith('?')) {
      const s = sectionOf(title)
      const lvl = levelOf(line)
      if (s) {
        current = s
        level = lvl
        found.add(s)
        continue
      }
      // Another heading at the same level or above ("## Notes" after "## Built") ends the section.
      if (current && lvl <= level) {
        current = null
        continue
      }
      // The report's own title ("# Sprint 2 report") repeats the card's.
      if (!found.size) continue
    }
    if (current) parts[current].push(line)
    else if (!found.size) intro.push(line)
  }
  const body = (s: Section): string => parts[s].join('\n').trim()
  return {
    intro: intro.join('\n').trim(),
    built: body('built'),
    tryIt: body('tryIt'),
    next: planItems(body('next')).filter((q) => !NOTHING.test(q)),
    questions: questionItems(body('questions')).filter((q) => !NOTHING.test(q) && !NO_QUESTIONS.test(q)),
    structured: found.size >= 2
  }
}

/**
 * The product owner's reply as the one feedback text autopilot already takes: each answer under its
 * question, the plan if it was changed, then anything else.
 */
export function composeCheckinFeedback(opts: { questions: string[]; answers: string[]; plan: string[]; planChanged: boolean; notes: string }): string {
  const parts: string[] = []
  const answered = opts.questions.map((q, i) => ({ q, a: (opts.answers[i] ?? '').trim() })).filter((x) => x.a)
  if (answered.length) parts.push(`Answers to your questions:\n${answered.map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n\n')}`)
  if (opts.planChanged && opts.plan.length) parts.push(`Plan for this sprint, in this order (the product owner edited it):\n${opts.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}`)
  else if (opts.planChanged) parts.push("The product owner removed every item from your proposed plan for this sprint: don't do them. Choose this sprint's tasks from the notes below and the roadmap instead.")
  if (opts.notes.trim()) parts.push(`Other notes:\n${opts.notes.trim()}`)
  return parts.join('\n\n')
}
