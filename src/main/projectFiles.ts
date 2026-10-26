import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import type { FileListing, FileView } from '@shared/types'
import { isSuspiciousPath, relativeInside } from './pathScope'

/**
 * The project's files for the Files tab: read-only. The window only ever names paths this module listed
 * itself, one folder at a time; links are never followed (a link could point anywhere on the computer)
 * and `.git` is never shown. Reading re-lists the folder, opens without following links, and checks it
 * got the very file the listing saw.
 */
const MAX_ENTRIES = 1000
/** The most of one file shown in the window. */
const MAX_TEXT_BYTES = 512 * 1024
const NEVER = new Set(['.git'])

/** A relative path the window may name: plain segments only (no "..", no empty or suspicious parts). */
function cleanRel(rel: string): string | null {
  if (typeof rel !== 'string' || rel.length > 1000 || rel.includes('\0') || rel.includes('\\')) return null
  if (rel === '') return ''
  if (rel.startsWith('/') || isSuspiciousPath(rel)) return null
  const segs = rel.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..' || NEVER.has(s.toLowerCase()))) return null
  return segs.join('/')
}

/** The folder at `rel` if it's a real folder inside the project with no links on the way, else null. */
function folder(root: string, rel: string): string | null {
  const clean = cleanRel(rel)
  if (clean === null) return null
  let cur = root
  try {
    if (!lstatSync(root).isDirectory()) return null
    for (const seg of clean ? clean.split('/') : []) {
      cur = join(cur, seg)
      const st = lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
    }
  } catch {
    return null
  }
  return relativeInside(root, cur) === (clean || '') ? cur : null
}

interface Seen {
  name: string
  st: Stats
}

/** One folder's entries as lstat saw them (links and `.git` left out, and counted). */
function scan(root: string, rel: string): { dir: string; seen: Seen[]; skipped: number } | null {
  const dir = folder(root, rel)
  if (!dir) return null
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const seen: Seen[] = []
  let skipped = 0
  for (const name of names) {
    if (NEVER.has(name.toLowerCase())) {
      skipped++
      continue
    }
    try {
      const st = lstatSync(join(dir, name))
      if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) skipped++
      else seen.push({ name, st })
    } catch {
      skipped++
    }
  }
  return { dir, seen, skipped }
}

/** A folder's contents: folders first, then files, by name. */
export function listProjectDir(root: string, rel: string): FileListing {
  const s = scan(root, rel)
  if (!s) throw new Error('That folder is not in the project (or is a link).')
  const base = cleanRel(rel)!
  const sorted = s.seen.sort((a, b) => Number(b.st.isDirectory()) - Number(a.st.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return {
    path: base,
    entries: sorted.slice(0, MAX_ENTRIES).map(({ name, st }) => ({
      name,
      path: base ? `${base}/${name}` : name,
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.isFile() ? st.size : 0,
      mtime: st.mtimeMs
    })),
    more: Math.max(0, sorted.length - MAX_ENTRIES),
    skipped: s.skipped
  }
}

/** Where a listed file or folder is on disk (for "Show in Finder"), or null if it isn't one. */
export function projectEntryPath(root: string, rel: string): string | null {
  const clean = cleanRel(rel)
  if (!clean) return clean === '' ? (folder(root, '') ?? null) : null
  const cut = clean.lastIndexOf('/')
  const s = scan(root, cut < 0 ? '' : clean.slice(0, cut))
  const name = clean.slice(cut + 1)
  return s?.seen.some((x) => x.name === name) ? join(s.dir, name) : null
}

/** A listed file's text (up to 512 KB), or why it isn't shown. */
export function readProjectFile(root: string, rel: string): FileView {
  const clean = cleanRel(rel)
  if (!clean) throw new Error('That file is not in the project.')
  const cut = clean.lastIndexOf('/')
  const s = scan(root, cut < 0 ? '' : clean.slice(0, cut))
  const name = clean.slice(cut + 1)
  const found = s?.seen.find((x) => x.name === name && x.st.isFile())
  if (!s || !found) throw new Error('That file is not in the project (or is a link).')
  // Opened without following a link at the end and without waiting on a pipe, then checked to be the file the
  // listing saw: a file (or a folder above it) swapped for a link in between can't be read through.
  const fd = openSync(join(s.dir, name), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.dev !== found.st.dev || st.ino !== found.st.ino) throw new Error('That file changed while it was being read. Try again.')
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
