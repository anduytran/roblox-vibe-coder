import { revealHidden } from './text'

/**
 * Splits a unified git diff into one entry per file, so the window can show each file on its own
 * (with +/− counts and a jump list) instead of one long scroll. Pure: no git, no DOM.
 */

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface DiffFile {
  /** The file's path after the change (before it, for a deleted file). */
  path: string
  /** Set for a rename: where it came from. */
  oldPath: string | null
  status: 'added' | 'deleted' | 'renamed' | 'copied' | 'modified'
  /** Git couldn't show the contents (an image, a place file…): only that it changed. */
  binary: boolean
  added: number
  removed: number
  /** Every line of this file's section, header included, in order. */
  lines: DiffLine[]
}

export interface SplitDiff {
  files: DiffFile[]
  /** Lines that belong to no file (for example "could not diff …" notes). */
  notes: string[]
}

/** Undo git's C-style quoting of unusual paths ("b/new name \303\251.txt" → b/new name é.txt). */
export function unquoteGitPath(raw: string): string {
  // No trim: a leading or trailing invisible character is part of the name and must stay visible.
  const s = raw
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s
  const bytes: number[] = []
  const body = s.slice(1, -1)
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c !== '\\') {
      for (const b of new TextEncoder().encode(c)) bytes.push(b)
      continue
    }
    const next = body[i + 1] ?? ''
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0]
      bytes.push(parseInt(oct, 8) & 0xff)
      i += oct.length
    } else if (next in simple) {
      bytes.push(simple[next]!)
      i += 1
    } else {
      bytes.push(92)
    }
  }
  // ignoreBOM keeps a leading U+FEFF, which is a real (hidden) character of the name.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes))
}

/** "a/foo" → "foo"; "/dev/null" (and Windows "NUL") → null. */
function stripSide(raw: string): string | null {
  const p = unquoteGitPath(raw.replace(/\t.*$/, ''))
  if (p === '/dev/null' || p === 'NUL') return null
  return p.replace(/^[ab]\//, '')
}

/** Lines that can appear between "diff --git" and the first hunk. Anything else ends the file's section. */
const HEADER_LINE = /^(index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch|--- |\+\+\+ )/

/** Best guess from the "diff --git a/x b/y" line alone, used until --- / +++ or rename lines say better. */
function pathsFromHeader(line: string): { a: string | null; b: string | null } {
  const rest = line.slice('diff --git '.length)
  // Quoted forms: either side may be quoted.
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest)
  if (quoted && (quoted[1]!.startsWith('"') || quoted[2]!.startsWith('"'))) return { a: stripSide(quoted[1]!), b: stripSide(quoted[2]!) }
  // Unquoted paths with spaces: "a/x b/y b/x b/y". Without a rename both halves are the same path, so
  // split in the middle when that's the case; otherwise fall back to the first " b/".
  if (rest.startsWith('a/') && rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2
    if (rest[half] === ' ' && rest.slice(half + 1).startsWith('b/') && rest.slice(2, half) === rest.slice(half + 3)) {
      return { a: rest.slice(2, half), b: rest.slice(half + 3) }
    }
  }
  const mid = rest.indexOf(' b/')
  if (rest.startsWith('a/') && mid > 0) {
    const a = rest.slice(2, mid)
    const b = rest.slice(mid + 3)
    return { a, b }
  }
  return { a: null, b: null }
}

export function splitDiff(diff: string): SplitDiff {
  const files: DiffFile[] = []
  const notes: string[] = []
  let cur: DiffFile | null = null
  let inHunk = false
  let oldName: string | null = null

  const finish = (): void => {
    if (cur) {
      // The diff's final newline isn't a line of the file.
      while (cur.lines.length && cur.lines[cur.lines.length - 1]!.kind === 'ctx' && cur.lines[cur.lines.length - 1]!.text === '') cur.lines.pop()
      files.push(cur)
    }
    cur = null
    inHunk = false
    oldName = null
  }

  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) {
      finish()
      const { a, b } = pathsFromHeader(line)
      oldName = a
      cur = { path: b ?? a ?? '(unknown file)', oldPath: null, status: 'modified', binary: false, added: 0, removed: 0, lines: [{ kind: 'meta', text: line }] }
      continue
    }
    if (!cur) {
      if (line.trim()) notes.push(line)
      continue
    }
    const file: DiffFile = cur
    if (inHunk) {
      const c = line[0]
      if (c === '+') {
        file.added++
        file.lines.push({ kind: 'add', text: line })
        continue
      }
      if (c === '-') {
        file.removed++
        file.lines.push({ kind: 'del', text: line })
        continue
      }
      if (c === ' ' || c === '\\' || line === '') {
        file.lines.push({ kind: 'ctx', text: line })
        continue
      }
      if (line.startsWith('@@')) {
        file.lines.push({ kind: 'hunk', text: line })
        continue
      }
      // Anything else ends this file's section (a note appended after it, for example).
      finish()
      if (line.trim()) notes.push(line)
      continue
    }
    // Header lines of the current file.
    if (line.startsWith('@@')) {
      inHunk = true
      file.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (!HEADER_LINE.test(line)) {
      // Not part of a file header (for example a note appended after a binary or empty file).
      finish()
      if (line.trim()) notes.push(line)
      continue
    }
    file.lines.push({ kind: 'meta', text: line })
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = unquoteGitPath(line.slice('rename from '.length))
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed'
      file.path = unquoteGitPath(line.slice('rename to '.length))
    } else if (line.startsWith('copy from ')) {
      file.status = 'copied'
      file.oldPath = unquoteGitPath(line.slice('copy from '.length))
    } else if (line.startsWith('copy to ')) {
      file.status = 'copied'
      file.path = unquoteGitPath(line.slice('copy to '.length))
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      // Keeps "New" / "Deleted" when that's what happened; binary is shown alongside.
      file.binary = true
    } else if (line.startsWith('--- ')) {
      const p = stripSide(line.slice(4))
      if (p === null) file.status = 'added'
      else oldName = p
    } else if (line.startsWith('+++ ')) {
      const p = stripSide(line.slice(4))
      if (p === null) {
        file.status = 'deleted'
        if (oldName) file.path = oldName
      } else file.path = p
    }
  }
  finish()
  return { files, notes }
}

/** Totals across files. */
export function diffTotals(files: DiffFile[]): { added: number; removed: number; lines: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed, lines: t.lines + f.lines.length }), { added: 0, removed: 0, lines: 0 })
}

/**
 * Identity of each file section, stable across refreshes of the same change. Status is part of it, and a
 * repeat gets a counter: a type change or `git rm --cached` shows the same path twice (deleted + new).
 */
export function fileKeys(files: DiffFile[]): string[] {
  const seen = new Map<string, number>()
  return files.map((f) => {
    const base = `${f.status}\u0000${f.oldPath ?? ''}\u0000${f.path}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return n ? `${base}\u0000${n}` : base
  })
}

/** Short, distinct labels for the jump list: the file name, plus as many folders as it takes to tell them apart. */
export function chipLabels(files: DiffFile[]): string[] {
  const parts = files.map((f) => f.path.split('/'))
  const depth = parts.map(() => 1)
  for (let round = 0; round < 8; round++) {
    const labels = parts.map((p, i) => p.slice(-depth[i]!).join('/'))
    const counts = new Map<string, number>()
    for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)
    let changed = false
    labels.forEach((l, i) => {
      if (counts.get(l)! > 1 && depth[i]! < parts[i]!.length) {
        depth[i]!++
        changed = true
      }
    })
    if (!changed) break
  }
  return parts.map((p, i) => revealHidden(p.slice(-depth[i]!).join('/')))
}
