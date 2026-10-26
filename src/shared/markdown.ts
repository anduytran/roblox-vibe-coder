/**
 * A small, safe Markdown reader for text agents write (reports, check-ins, idea text, vault notes).
 *
 * It produces plain data (blocks and inline runs), never HTML: the window turns it into React
 * elements, so nothing an agent writes can become markup, a script, an image or a live link.
 * Supported: headings, paragraphs, bullet and numbered lists, block quotes, fenced code, rules,
 * **bold**, *italic*, `code`, [label](https://…) and bare https links. Everything else stays text.
 */
import { safeExternalUrl, stripHidden } from './text'

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; v: Inline[] }
  | { t: 'italic'; v: Inline[] }
  | { t: 'code'; v: string }
  /** `url` is already checked with safeExternalUrl; the label is shown, the real address on hover and in the open prompt. */
  | { t: 'link'; label: string; url: string }

export type Block =
  | { t: 'heading'; level: 1 | 2 | 3; v: Inline[] }
  | { t: 'para'; v: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { t: 'quote'; v: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'rule' }

/** Longer input is cut, so a runaway report can't freeze the window. */
export const MAX_MARKDOWN = 200_000

const BULLET = /^\s{0,6}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,6}(\d{1,6})[.)]\s+(.*)$/
// Every pattern here is linear: no nested or overlapping quantifiers that could backtrack on long lines.
const HEADING = /^(#{1,6})[ \t]+(.*)$/
// A backtick fence has no backtick in its info string (```lua opens a fence, ```code``` is inline code).
// Any indentation is allowed (fences inside list items); indented code blocks aren't a thing here.
const FENCE = /^(\s*)(`{3,}(?=[^`]*$)|~{3,})/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/

export function parseMarkdown(input: string): Block[] {
  const text = stripHidden(String(input ?? '').slice(0, MAX_MARKDOWN)).replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length) blocks.push({ t: 'para', v: parseInline(para.join('\n')) })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = FENCE.exec(line)
    if (fence) {
      flushPara()
      const indent = fence[1]!.length
      const marker = fence[2]!
      const body: string[] = []
      i++
      // Body lines lose the fence's own indentation (a fence inside a list item is indented).
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) {
        const l = lines[i++]!
        // Same indentation as the opener (spaces or tabs) comes off exactly; otherwise up to that many spaces.
        body.push(l.startsWith(fence[1]!) ? l.slice(indent) : l.replace(new RegExp(`^ {0,${indent}}`), ''))
      }
      blocks.push({ t: 'code', v: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      flushPara()
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      flushPara()
      blocks.push({ t: 'heading', level: Math.min(3, h[1]!.length) as 1 | 2 | 3, v: parseInline(headingText(h[2]!)) })
      continue
    }
    if (RULE.test(line)) {
      flushPara()
      blocks.push({ t: 'rule' })
      continue
    }
    if (line.trimStart().startsWith('>')) {
      flushPara()
      const quote: string[] = []
      while (i < lines.length && lines[i]!.trimStart().startsWith('>')) quote.push(lines[i++]!.trimStart().replace(/^>\s?/, ''))
      i--
      blocks.push({ t: 'quote', v: parseInline(quote.join('\n')) })
      continue
    }
    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    if (bullet || numbered) {
      flushPara()
      const ordered = !bullet
      const start = numbered ? Math.min(999_999, parseInt(numbered[1]!, 10)) : 1
      const items: string[] = []
      while (i < lines.length) {
        const l = lines[i]!
        // A code fence ends the list; it becomes its own code block.
        if (FENCE.test(l)) break
        const b = BULLET.exec(l)
        const n = NUMBERED.exec(l)
        if ((ordered ? n : b) !== null) {
          items.push((ordered ? n![2] : b![1])!)
        } else if (l.trim() && /^\s{2,}\S/.test(l) && items.length) {
          // An indented continuation line belongs to the item above.
          items[items.length - 1] += `\n${l.trim()}`
        } else break
        i++
      }
      i--
      blocks.push({ t: 'list', ordered, start, items: items.map(parseInline) })
      continue
    }
    para.push(line)
  }
  flushPara()
  return blocks
}

/** Heading text without an optional closing run of '#' ("## Title ##" → "Title"; "C#" keeps its '#'). */
function headingText(raw: string): string {
  const t = raw.trimEnd()
  let j = t.length
  while (j > 0 && t[j - 1] === '#') j--
  if (j === t.length) return t
  // Only a run that stands alone (after a space, or the whole text) is a closing sequence.
  return j === 0 ? '' : t[j - 1] === ' ' || t[j - 1] === '\t' ? t.slice(0, j).trimEnd() : t
}

// Link targets may hold one level of balanced parentheses (Wikipedia-style URLs).
const LINK = /\[([^\]\n]{1,300})\]\(((?:[^()\s]|\([^()\s]{0,200}\)){1,2000})\)/y
const BARE = /https:\/\/[^\s<>"'`\]]{1,2000}/y
/** Emphasis and code spans close on the same line, within this many characters and candidate markers. Keeps scanning fast. */
const SPAN_WINDOW = 400
const SPAN_CANDIDATES = 64

/** Trailing punctuation and unbalanced ')' are not part of a bare URL ("(see https://x.com/a)."). One backward pass. */
function trimBareUrl(u: string): string {
  let open = 0
  let close = 0
  for (let k = 0; k < u.length; k++) {
    if (u[k] === '(') open++
    else if (u[k] === ')') close++
  }
  let end = u.length
  while (end > 0) {
    const ch = u[end - 1]!
    if (`.,;:!?'"`.includes(ch)) end--
    else if (ch === ')' && close > open) {
      close--
      end--
    } else break
  }
  return u.slice(0, end)
}

const isWord = (c: string | undefined): boolean => c !== undefined && /\w/.test(c)
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)

/** Inline runs: `code`, **bold**, *italic*, [label](url), bare https URLs. Unmatched markers stay text. */
export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = []
  let text = ''
  const push = (node: Inline): void => {
    if (text) out.push({ t: 'text', v: text })
    text = ''
    out.push(node)
  }
  // Works by position (no slicing per character), so long text stays linear.
  let i = 0
  // Closing markers are only looked for on the same line, within SPAN_WINDOW characters: every search is
  // bounded, so the whole pass stays linear however the text is shaped.
  const limit = (from: number): number => {
    const end = Math.min(s.length, from + SPAN_WINDOW)
    for (let k = from; k < end; k++) if (s.charCodeAt(k) === 10) return k
    return end
  }
  /** For the backtick run at k: its length and where its closing run starts (-1 if none). Cached per call. */
  const spans = new Map<number, [number, number]>()
  const codeSpan = (k: number): [number, number] => {
    const hit = spans.get(k)
    if (hit) return hit
    let n = 1
    while (s[k + n] === '`' && n < SPAN_WINDOW) n++
    const stop = limit(k + n)
    let close = -1
    for (let j = k + n; j < stop; ) {
      if (s[j] !== '`') {
        j++
        continue
      }
      let r = 1
      while (s[j + r] === '`') r++
      if (r === n) {
        close = j
        break
      }
      j += r
    }
    const res: [number, number] = [n, close]
    spans.set(k, res)
    return res
  }
  /**
   * First `marker` at or after `from` (before the limit) for which `ok` holds, or -1. Markers inside a code
   * span don't count: "*Only `*.luau` files*" closes on the last star, not the one in the code.
   */
  const findClose = (marker: string, from: number, ok: (at: number) => boolean): number => {
    const stop = limit(from)
    let tries = 0
    let seen = from
    // indexOf stops at the next marker; every opener is itself a marker, so these searches stay short.
    for (let at = s.indexOf(marker, from); at >= 0 && at + marker.length <= stop && tries < SPAN_CANDIDATES; at = s.indexOf(marker, at + 1), tries++) {
      while (seen < at) {
        if (s.charCodeAt(seen) !== 96) {
          seen++
          continue
        }
        const [n, close] = codeSpan(seen)
        // A lone run of backticks (no matching close) is plain text.
        seen = close >= 0 ? close + n : seen + n
      }
      if (seen > at) continue
      if (ok(at)) return at
    }
    return -1
  }
  /** A '*' that can close an italic: the last star of an odd-length run (a run of 2 is a bold marker). */
  const starClose = (at: number): boolean => {
    if (s[at + 1] === '*') return false
    let b = at
    while (b > 0 && s[b - 1] === '*') b--
    return (at - b + 1) % 2 === 1 && !isSpace(s[b - 1])
  }
  while (i < s.length) {
    const c = s[i]!
    if (c === '`') {
      // A code span opened by N backticks closes on a run of exactly N (so ``a`b`` holds a backtick).
      const [n, close] = codeSpan(i)
      if (close > i + n - 1) {
        let v = s.slice(i + n, close)
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1)
        push({ t: 'code', v })
        i = close + n
        continue
      }
      text += s.slice(i, i + n)
      i += n
      continue
    }
    if (depth < 4 && s.startsWith('**', i) && !isSpace(s[i + 2])) {
      let end = findClose('**', i + 2, (at) => at > i + 2 && !isSpace(s[at - 1]))
      // "**bold *italic***": the bold closes on the last two stars, after the italic's.
      if (end > 0 && s[end + 2] === '*' && s[end + 3] !== '*' && /(^|[^*])\*([^*]|$)/.test(s.slice(i + 2, end))) end += 1
      if (end > 0) {
        push({ t: 'bold', v: parseInline(s.slice(i + 2, end), depth + 1) })
        i = end + 2
        continue
      }
    }
    if (s.startsWith('__', i)) {
      // __bold__ only at word edges, so Luau's __index and __newindex stay as written.
      if (depth < 4 && !isWord(s[i - 1]) && !isSpace(s[i + 2])) {
        const end = findClose('__', i + 2, (at) => at > i + 2 && !isSpace(s[at - 1]) && !isWord(s[at + 2]))
        if (end > 0) {
          push({ t: 'bold', v: parseInline(s.slice(i + 2, end), depth + 1) })
          i = end + 2
          continue
        }
      }
      text += '__'
      i += 2
      continue
    }
    if (depth < 4 && (c === '*' || c === '_')) {
      const next = s[i + 1]
      // _snake_case_ words are not italics: an underscore must not sit inside a word.
      if (!isSpace(next) && next !== c && (c === '*' || !isWord(s[i - 1]))) {
        const end = findClose(c, i + 1, (at) => at > i + 1 && (c === '*' ? starClose(at) : !isSpace(s[at - 1]) && !isWord(s[at + 1])))
        if (end > 0) {
          push({ t: 'italic', v: parseInline(s.slice(i + 1, end), depth + 1) })
          i = end + 1
          continue
        }
      }
    }
    if (c === '[') {
      LINK.lastIndex = i
      const m = LINK.exec(s)
      if (m) {
        const url = safeExternalUrl(m[2]!)
        // The label's own formatting (`code`, **bold**) is dropped to plain text; it's never a nested link.
        if (url) push({ t: 'link', label: inlineText(parseInline(m[1]!, depth + 1)), url })
        // Not an https link (javascript:, file:, http:…): keep the whole thing as plain text.
        else text += m[0]
        i += m[0].length
        continue
      }
    }
    if (c === 'h' && s.startsWith('https://', i)) {
      BARE.lastIndex = i
      const m = BARE.exec(s)
      if (m) {
        const clean = trimBareUrl(m[0])
        const url = safeExternalUrl(clean)
        if (url) {
          push({ t: 'link', label: clean, url })
          i += clean.length
          continue
        }
      }
    }
    text += c
    i++
  }
  if (text) out.push({ t: 'text', v: text })
  return out
}

/** Plain text of inline runs (for titles and tests). */
export function inlineText(v: Inline[]): string {
  return v.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'link' ? n.label : inlineText(n.v))).join('')
}
