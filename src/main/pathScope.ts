import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Resolve symlinks for the deepest part of the path that exists, so links can't escape the project. */
function realish(p: string): string {
  let current = p
  const tail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return p
    tail.unshift(current.slice(parent.length).replace(/^[\\/]/, ''))
    current = parent
  }
  try {
    return resolve(realpathSync(current), ...tail)
  } catch {
    return p
  }
}

/** True if `target` (absolute, or relative to `root`) is inside `root` or is `root` itself. */
export function isInsideRoot(root: string, target: string): boolean {
  const realRoot = realish(resolve(root))
  const abs = realish(isAbsolute(target) ? resolve(target) : resolve(root, target))
  const rel = relative(realRoot, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const

/** Paths a tool call will touch, taken from its known input fields. */
export function pathsFromToolInput(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of PATH_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.trim() !== '') out.push(v)
  }
  return out
}
