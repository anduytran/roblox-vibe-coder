import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { FileListing, FileView } from '@shared/types'
import { relativeInside } from './pathScope'

/**
 * The project's files for the Files tab: read-only. The window only ever names paths this module listed
 * itself, one folder at a time; links are never followed (a link could point anywhere on the computer) and
 * `.git` is never shown.
 *
 * Node can't open a file relative to an already-open folder, so a folder on the way could be swapped for a
 * link between the check and the read. Every read and listing therefore records which folders it walked
 * through (device and inode of each) before and after, and gives up if anything changed; the file itself is
 * opened without following a link and must be the very file the listing saw.
 */
const MAX_ENTRIES = 1000
/** How many names one folder listing reads at most, so a folder of 100,000 files can't stall the app. */
const MAX_SCAN = 20_000
/** The most of one file shown in the window. */
const MAX_TEXT_BYTES = 512 * 1024
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
/**
 * macOS 11+: open fails if any part of the path is a link (O_NOFOLLOW_ANY). Used to confirm, at the moment of use,
 * that a listed entry is reached with no link on the way, which before/after checks alone can't guarantee.
 * 0 where it isn't available (other systems, older macOS): checked once by opening "/" with it.
 */
let nofollowAny: number | null = null
function NOFOLLOW_ANY(): number {
  if (nofollowAny === null) {
    nofollowAny = 0
    if (process.platform === 'darwin') {
      try {
        closeSync(openSync('/', fsConstants.O_RDONLY | 0x20000000))
        nofollowAny = 0x20000000
      } catch {
        // not supported here
      }
    }
  }
  return nofollowAny
}

/**
 * A name the window may use for one path part. Node doesn't expand ~, $VAR or %VAR%, so those are fine here;
 * refused are ".." and friends, `.git` in any case, and what Windows reads as another name: a colon (alternate
 * data streams), 8.3 short names (GIT~1) and a trailing dot or space.
 */
function okName(seg: string): boolean {
  return (
    seg !== '' &&
    seg !== '.' &&
    seg !== '..' &&
    seg.length <= 255 &&
    seg.toLowerCase() !== '.git' &&
    !/[\0\\/:]/.test(seg) &&
    !/~\d/.test(seg) &&
    !/[. ]$/.test(seg)
  )
}

function cleanRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length > 1000) return null
  if (rel === '') return ''
  const segs = rel.split('/')
  return segs.every(okName) ? rel : null
}

/** The project folder itself, resolved once (a project registered through a link still works). */
function realRoot(root: string): string | null {
  try {
    const real = realpathSync(root)
    return lstatSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** The folder at `rel` and the identity of every folder on the way, or null if one is missing or a link. */
function walk(root: string, rel: string): { dir: string; chain: string } | null {
  let cur = root
  const ids: string[] = []
  try {
    const top = lstatSync(root)
    if (!top.isDirectory()) return null
    ids.push(`${top.dev}:${top.ino}`)
    for (const seg of rel ? rel.split('/') : []) {
      cur = join(cur, seg)
      const st = lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
      ids.push(`${st.dev}:${st.ino}`)
    }
  } catch {
    return null
  }
  return relativeInside(root, cur) === rel ? { dir: cur, chain: ids.join('/') } : null
}

interface Seen {
  name: string
  st: Stats
}

interface Scan {
  root: string
  rel: string
  dir: string
  chain: string
  seen: Seen[]
  more: number
  capped: boolean
  skipped: number
}

/** True if the folders on the way are still the same ones (nothing swapped for a link meanwhile). */
function unchanged(s: Scan): boolean {
  return walk(s.root, s.rel)?.chain === s.chain
}

/** On macOS: the path opens with no link anywhere on the way, and is the same file or folder as `st`. */
function reachedDirectly(path: string, st: Stats): boolean {
  const any = NOFOLLOW_ANY()
  if (!any) return true
  let fd: number | null = null
  try {
    fd = openSync(path, fsConstants.O_RDONLY | any | (fsConstants.O_NONBLOCK ?? 0))
    const now = fstatSync(fd)
    return now.dev === st.dev && now.ino === st.ino
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * One folder: the first 1000 entries by name, folders first (links, `.git`, other kinds and names that can't
 * be opened are left out and counted). `want` lstat's just that one name instead (for a read).
 */
function scan(rootIn: string, relIn: unknown, want?: string): Scan | null {
  const rel = cleanRel(relIn)
  const root = rel === null ? null : realRoot(rootIn)
  if (rel === null || !root) return null
  const at = walk(root, rel)
  if (!at) return null
  const names: { name: string; dir: boolean }[] = []
  let skipped = 0
  let read = 0
  let capped = false
  try {
    const d = opendirSync(at.dir)
    try {
      for (let e = d.readSync(); e; e = d.readSync()) {
        if (++read > MAX_SCAN) {
          capped = true
          break
        }
        if (want !== undefined && e.name !== want) continue
        if (!okName(e.name) || !(e.isFile() || e.isDirectory())) skipped++
        else names.push({ name: e.name, dir: e.isDirectory() })
      }
    } finally {
      d.closeSync()
    }
  } catch {
    return null
  }
  names.sort((a, b) => Number(b.dir) - Number(a.dir) || collator.compare(a.name, b.name))
  const seen: Seen[] = []
  for (const n of names.slice(0, MAX_ENTRIES)) {
    try {
      const path = join(at.dir, n.name)
      const st = lstatSync(path)
      // Each entry must also be reachable right now with no link on the way: a folder swapped for a link while it
      // was read (and swapped back before the checks) would otherwise put another folder's names in the list.
      if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory()) || !reachedDirectly(path, st)) skipped++
      else seen.push({ name: n.name, st })
    } catch {
      skipped++
    }
  }
  const s: Scan = { root, rel, dir: at.dir, chain: at.chain, seen, more: Math.max(0, names.length - MAX_ENTRIES), capped, skipped }
  return unchanged(s) ? s : null
}

const split = (rel: string): [string, string] => {
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? ['', rel] : [rel.slice(0, cut), rel.slice(cut + 1)]
}

/** A folder's contents: folders first, then files, by name. */
export function listProjectDir(root: string, rel: unknown): FileListing {
  const s = scan(root, rel)
  if (!s) throw new Error('That folder is not in the project (or is a link).')
  return {
    path: s.rel,
    entries: s.seen.map(({ name, st }) => ({
      name,
      path: s.rel ? `${s.rel}/${name}` : name,
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.isFile() ? st.size : 0,
      mtime: st.mtimeMs
    })),
    more: s.more,
    capped: s.capped,
    skipped: s.skipped
  }
}

/** Where a listed file or folder is on disk (for "Show in Finder"), or null if it isn't one. */
export function projectEntryPath(root: string, rel: unknown): string | null {
  const clean = cleanRel(rel)
  if (clean === null) return null
  if (clean === '') {
    const s = scan(root, '')
    return s ? s.dir : null
  }
  const [parent, name] = split(clean)
  const s = scan(root, parent, name)
  const found = s?.seen.find((x) => x.name === name)
  return s && found && reachedDirectly(join(s.dir, name), found.st) && unchanged(s) ? join(s.dir, name) : null
}

/** A listed file's text (up to 512 KB), or why it isn't shown. */
export function readProjectFile(root: string, rel: unknown): FileView {
  const clean = cleanRel(rel)
  if (!clean) throw new Error('That file is not in the project (or is a link).')
  const [parent, name] = split(clean)
  const s = scan(root, parent, name)
  const found = s?.seen.find((x) => x.name === name && x.st.isFile())
  if (!s || !found) throw new Error('That file is not in the project (or is a link).')
  const path = join(s.dir, name)
  // Not following a link anywhere on the way (macOS) or at least at the end, and not waiting on a pipe.
  // (macOS refuses the two "no link" flags together, so it's one or the other.)
  const fd = openSync(path, fsConstants.O_RDONLY | (NOFOLLOW_ANY() || (fsConstants.O_NOFOLLOW ?? 0)) | (fsConstants.O_NONBLOCK ?? 0))
  try {
    const st = fstatSync(fd)
    const same = (x: Stats): boolean => x.dev === found.st.dev && x.ino === found.st.ino
    // The file opened is the one listed, it's still there under that name, and no folder above it was swapped.
    if (!st.isFile() || !same(st) || !same(lstatSync(path)) || !unchanged(s)) throw new Error('That file changed while it was being read. Try again.')
    const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT_BYTES))
    const n = buf.length ? readSync(fd, buf, 0, buf.length, 0) : 0
    const bytes = buf.subarray(0, n)
    const base = { path: clean, size: st.size, mtime: st.mtimeMs }
    if (isBinary(bytes)) return { ...base, kind: 'binary', text: null, truncated: false }
    // Cut at 512 KB, a character split in two is left off (streaming decode) rather than shown as a broken mark.
    const truncated = st.size > MAX_TEXT_BYTES
    return { ...base, kind: 'text', text: new TextDecoder('utf-8').decode(bytes, { stream: truncated }), truncated }
  } finally {
    closeSync(fd)
  }
}

/** Binary if the start has a NUL byte, or isn't mostly text. */
function isBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return true
  let odd = 0
  for (const b of head) if (b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f) odd++
  return head.length > 0 && odd / head.length > 0.1
}
